"""Browser defaults and request isolation without persisting credentials."""

import base64
import io
import json
from concurrent.futures import ThreadPoolExecutor

import pytest
from app.browser_settings import (
    PROVIDER_OVERRIDE_HEADER,
    override_environment,
    selected_providers,
)
from app.main import create_app
from app.providers import PromptComposer
from app.watermark_settings import MAX_SETTINGS_JSON_BYTES
from fastapi.testclient import TestClient
from PIL import Image
from test_canonical import FIXTURE, wait_for_job


def headers(changes):
    return {
        PROVIDER_OVERRIDE_HEADER: base64.b64encode(
            json.dumps(changes).encode()
        ).decode()
    }


def test_defaults_never_return_keys_and_reset_is_omitting_an_override(tmp_path):
    env = {
        "IMAGEDIALS_DATA_DIR": str(tmp_path),
        "APP_BASE_PATH": "/studio",
        "LLM_MODEL_ENDPOINT_1": "https://language.example.invalid/v1",
        "LLM_MODEL_KEY_1": "server-only-secret",
        "LLM_MODEL_NAME": "server-model",
        "WATERMARK_DEFAULT_TEXT": "Initial text",
    }
    with TestClient(create_app(env)) as client:
        for prefix in ("/api", "", "/studio/api", "/studio"):
            response = client.get(prefix + "/browser-settings/defaults")
            assert response.status_code == 200
            assert response.headers["cache-control"] == "no-store"
            assert "server-only-secret" not in response.text
            data = response.json()
            assert data["providers"]["LLM_MODEL_NAME"] == "server-model"
            assert data["keys_configured"]["LLM_MODEL_KEY_1"] is True
            assert data["watermark"]["text"] == "Initial text"
        customized = client.get(
            "/api/models", headers=headers({"LLM_MODEL_NAME": "browser-model"})
        )
        assert customized.json()["llm_model"] == "browser-model"
        assert client.get("/api/models").json()["llm_model"] == "server-model"


def test_new_endpoint_never_inherits_another_endpoints_secret():
    env = {
        "LLM_MODEL_ENDPOINT_1": "https://old.example.invalid/v1",
        "LLM_MODEL_KEY_1": "server-only",
    }
    changed = override_environment(
        env,
        headers({"LLM_MODEL_ENDPOINT_1": "https://new.example.invalid/v1"})[
            PROVIDER_OVERRIDE_HEADER
        ],
    )
    assert changed["LLM_MODEL_KEY_1"] == ""
    assert env["LLM_MODEL_KEY_1"] == "server-only"
    changed = override_environment(
        env,
        headers(
            {
                "LLM_MODEL_ENDPOINT_1": "https://new.example.invalid/v1",
                "LLM_MODEL_KEY_1": "browser-only",
            }
        )[PROVIDER_OVERRIDE_HEADER],
    )
    assert selected_providers(changed).controls.key == "browser-only"
    changed["DESCRIPTION_MODEL_ENDPOINT"] = "https://vision.example.invalid/v1"
    assert selected_providers(changed).description.key == ""


@pytest.mark.parametrize(
    "changes",
    [
        {"IMAGE_WORKFLOW_PATH": "not-allowed"},
        {"LLM_MODEL_ENDPOINT_1": "file:///not-allowed"},
        {"LLM_MODEL_ENDPOINT_1": "https://" + "name:secret" + "@example.invalid"},
        {"LLM_MODEL_ENDPOINT_1": "https://example.invalid?key=secret"},
        {"IMAGE_PROVIDER": "unsupported"},
        {"LLM_MODEL_KEY_1": "line\nbreak"},
        {"LLM_MODEL_KEY_1": False},
    ],
)
def test_invalid_overrides_fail_without_echoing_values(tmp_path, changes):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        response = client.get("/api/models", headers=headers(changes))
        assert response.status_code == 400
        assert "secret" not in response.text


def test_malformed_and_oversize_header_are_bounded(tmp_path):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        for value in ("bad-base64!", "x" * 6145, base64.b64encode(b"[]").decode()):
            assert (
                client.get(
                    "/api/models", headers={PROVIDER_OVERRIDE_HEADER: value}
                ).status_code
                == 400
            )


def test_parallel_browsers_do_not_change_server_or_each_other(tmp_path):
    app = create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path), "LLM_MODEL_NAME": "server"})
    with TestClient(app) as client, ThreadPoolExecutor(max_workers=4) as pool:

        def read(index):
            name = f"browser-{index}"
            return name, client.get(
                "/api/models", headers=headers({"LLM_MODEL_NAME": name})
            ).json()["llm_model"]

        assert all(expected == actual for expected, actual in pool.map(read, range(20)))
        assert client.get("/api/models").json()["llm_model"] == "server"
        assert app.state.provider_environment["LLM_MODEL_NAME"] == "server"


def test_accepted_job_captures_provider_choices_without_saving_keys(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(
        PromptComposer,
        "compose",
        lambda self, draft, categories: ("Original test prompt", {"model": self.model}),
    )
    monkeypatch.setattr(
        PromptComposer,
        "enrich",
        lambda self, draft, final: {
            "title": self.model or "default",
            "alt_text": "A test image",
        },
    )
    env = {"IMAGEDIALS_DATA_DIR": str(tmp_path), "LLM_MODEL_NAME": "server-model"}
    with TestClient(create_app(env)) as client:
        body = {**json.loads(FIXTURE.read_text()), "idempotency_key": "browser-job"}
        custom = headers(
            {
                "LLM_MODEL_NAME": "browser-model",
                "LLM_MODEL_KEY_1": "browser-secret-not-persisted",
            }
        )
        accepted = client.post("/api/generate-image", json=body, headers=custom)
        assert accepted.status_code == 202, accepted.text
        job = wait_for_job(client, accepted.json()["generation_job_id"])
        assert job["status"] == "complete", job
        assert job["result"]["title"] == "browser-model"
        assert client.get("/api/models").json()["llm_model"] == "server-model"
        replay = client.post("/api/generate-image", json=body, headers=custom)
        assert (
            replay.json()["generation_job_id"] == accepted.json()["generation_job_id"]
        )
        assert (
            client.post(
                "/api/generate-image",
                json=body,
                headers=headers({"LLM_MODEL_NAME": "different"}),
            ).status_code
            == 409
        )
    for path in tmp_path.rglob("*"):
        if path.is_file():
            assert b"browser-secret-not-persisted" not in path.read_bytes()


def test_browser_watermark_validation_and_analysis_never_change_shared_settings(
    tmp_path,
):
    app = create_app(
        {"IMAGEDIALS_DATA_DIR": str(tmp_path), "SHARED_LIBRARY_ENABLED": "false"}
    )
    output = io.BytesIO()
    Image.new("RGB", (120, 80), "blue").save(output, format="PNG")
    with TestClient(app) as client:
        before = client.get("/api/watermark/settings").json()
        content = {"type": "text", "text": "Browser only"}
        validated = client.post(
            "/api/browser-settings/watermark/validate", json=content
        )
        assert validated.status_code == 200
        assert validated.json()["text"] == "Browser only"
        response = client.post(
            "/api/watermark/analyze-image",
            files={"image": ("original.png", output.getvalue(), "image/png")},
            data={"watermark_settings": json.dumps(content)},
        )
        assert response.status_code == 200, response.text
        assert (
            response.json()["watermark_settings"]["fingerprint"]
            == validated.json()["fingerprint"]
        )
        assert client.get("/api/watermark/settings").json() == before
        assert app.state.store.images() == []
        invalid = {"type": "svg", "svg_markup": "<svg><script>bad()</script></svg>"}
        assert (
            client.post(
                "/api/browser-settings/watermark/validate", json=invalid
            ).status_code
            == 400
        )


def test_local_watermark_validation_body_limits_cover_prefixes(tmp_path):
    with TestClient(
        create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path), "APP_BASE_PATH": "/studio"})
    ) as client:
        for prefix in ("/api", "", "/studio/api", "/studio"):
            assert (
                client.post(
                    prefix + "/browser-settings/watermark/validate",
                    content=b"x" * (MAX_SETTINGS_JSON_BYTES + 1),
                ).status_code
                == 413
            )
