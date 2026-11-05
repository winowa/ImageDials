"""Reference edits reach the selected editing endpoint; text-to-image never moves.

Every provider call is captured at the adapter boundary, so these tests prove
where requests actually went and which key they carried, without inference.
"""

import base64
import hashlib
import io
import json
import time

import pytest
from app import providers
from app.browser_settings import PROVIDER_OVERRIDE_HEADER, override_environment
from app.image_editing import QWEN_ENCODER_CLASS, REFERENCE_MARKER
from app.image_routing import (
    SEPARATE_ROUTE_DIAGNOSTIC,
    RoutedImageProvider,
    image_provider,
    validate_deployment,
)
from app.main import create_app
from fastapi.testclient import TestClient
from PIL import Image

GENERATION = "http://generation.example.invalid"
EDITING = "http://editing.example.invalid"
BROWSER_EDITING = "http://browser-editing.example.invalid"
SERVER_KEY = "server-generation-secret"
SERVER_EDIT_KEY = "server-editing-secret"


def encoded(changes):
    return base64.b64encode(json.dumps(changes).encode()).decode()


def headers(changes):
    return {PROVIDER_OVERRIDE_HEADER: encoded(changes)}


def png(color=(20, 30, 40), size=(40, 24)):
    output = io.BytesIO()
    Image.new("RGB", size, color).save(output, "PNG")
    return output.getvalue()


def write_workflows(tmp_path):
    text = tmp_path / "text.json"
    text.write_text(
        json.dumps(
            {
                "1": {
                    "class_type": "Fixture",
                    "inputs": {
                        "prompt": "$prompt",
                        "width": "$width",
                        "height": "$height",
                        "seed": "$seed",
                    },
                }
            }
        ),
        encoding="utf-8",
    )
    edit = tmp_path / "edit.json"
    edit.write_text(
        json.dumps(
            {
                "5": {
                    "class_type": QWEN_ENCODER_CLASS,
                    "inputs": {"prompt": "$prompt", REFERENCE_MARKER: True},
                },
                "7": {
                    "class_type": "KSampler",
                    "inputs": {
                        "positive": ["5", 0],
                        "negative": ["5", 1],
                        "latent_image": ["5", 2],
                        "seed": "$seed",
                    },
                },
            }
        ),
        encoding="utf-8",
    )
    return text, edit


@pytest.fixture
def calls(monkeypatch):
    """Captured (kind, base, key) tuples for every image provider call."""
    seen = []
    result = png((200, 10, 10), (96, 64))

    def request(base, path, payload=None, *, key="", raw=False, **kwargs):
        seen.append(("request", base, key))
        if path == "/prompt":
            return {"prompt_id": "fixture-job"}
        if path.startswith("/history/"):
            return {
                "fixture-job": {
                    "outputs": {"out": {"images": [{"filename": "out.png"}]}},
                    "status": {"status_str": "success"},
                }
            }
        if path.startswith("/view?"):
            return result
        raise AssertionError(path)

    def upload(base, filename, data, *, key="", **kwargs):
        seen.append(("upload", base, key))
        return {"name": filename, "subfolder": "", "type": "temp"}

    monkeypatch.setattr(providers, "request", request)
    monkeypatch.setattr(providers, "upload_reference", upload)
    return seen


def settings(tmp_path, **extra):
    text, edit = write_workflows(tmp_path)
    return {
        "IMAGEDIALS_DATA_DIR": str(tmp_path / "data"),
        "IMAGE_PROVIDER": "comfyui",
        "IMAGE_MODEL_ENDPOINT_1": GENERATION,
        "IMAGE_MODEL_KEY_1": SERVER_KEY,
        "IMAGE_WORKFLOW_PATH": str(text),
        "IMAGE_EDIT_WORKFLOW_PATH": str(edit),
        "GENERATION_TIMEOUT_SECONDS": "5",
        **extra,
    }


def edit_body(image, key):
    return {
        "prompt": "Recolor the base image",
        "controls": [],
        "dimensions": "96x64",
        "idempotency_key": key,
        "reference_images": [
            {
                "id": "reference-1",
                "sha256": hashlib.sha256(image).hexdigest(),
                "description": "A plain source",
                "role": "base",
            }
        ],
    }


def post_edit(client, key, extra_headers=None):
    image = png()
    return client.post(
        "/api/generate-image",
        data={"request": json.dumps(edit_body(image, key))},
        files=[("reference_1", ("source.png", image, "image/png"))],
        headers=extra_headers or {},
    )


def post_text(client, key, extra_headers=None):
    return client.post(
        "/api/generate-image",
        json={
            "prompt": "A small lantern on a stone",
            "controls": client.get("/api/controls/static").json()["controls"],
            "dimensions": "96x64",
            "idempotency_key": key,
        },
        headers=extra_headers or {},
    )


def finish(client, identity):
    for _ in range(400):
        result = client.get(f"/api/generation-jobs/{identity}").json()
        if result["status"] != "running":
            return result
        time.sleep(0.01)
    pytest.fail("Generation did not finish")


def routed(calls):
    return {(base, key) for _, base, key in calls}


def test_same_as_generation_is_the_default_and_follows_browser_generation(
    tmp_path, calls
):
    with TestClient(create_app(settings(tmp_path))) as client:
        defaults = client.get("/api/browser-settings/defaults").json()
        assert defaults["editing"]["route"] == "generation"
        assert defaults["keys_configured"]["IMAGE_EDIT_MODEL_KEY"] is False
        assert defaults["providers"]["IMAGE_EDIT_MODEL_ENDPOINT"] == ""
        job = post_edit(client, "same-default").json()
        assert finish(client, job["generation_job_id"])["status"] == "complete"
        assert routed(calls) == {(GENERATION, SERVER_KEY)}

        # Same-as follows the browser's generation choice, key included.
        calls.clear()
        browser = {
            "IMAGE_MODEL_ENDPOINT_1": "http://browser-generation.example.invalid",
            "IMAGE_MODEL_KEY_1": "browser-generation-key",
        }
        job = post_edit(client, "same-browser", headers(browser)).json()
        result = finish(client, job["generation_job_id"])
        assert result["status"] == "complete"
        assert routed(calls) == {
            ("http://browser-generation.example.invalid", "browser-generation-key")
        }
        record = client.get(f"/api/images/{job['generation_job_id']}").json()
        assert "image_route" not in json.dumps(record.get("diagnostics", {}))


def test_separate_browser_editing_endpoint_receives_edits_only(tmp_path, calls):
    choice = {
        "IMAGE_EDIT_ROUTE": "separate",
        "IMAGE_EDIT_MODEL_ENDPOINT": BROWSER_EDITING,
        "IMAGE_EDIT_MODEL_KEY": "browser-editing-key",
    }
    with TestClient(create_app(settings(tmp_path))) as client:
        job = post_edit(client, "separate-edit", headers(choice)).json()
        assert finish(client, job["generation_job_id"])["status"] == "complete"
        assert routed(calls) == {(BROWSER_EDITING, "browser-editing-key")}
        record = client.get(f"/api/images/{job['generation_job_id']}")
        assert SEPARATE_ROUTE_DIAGNOSTIC in record.text
        assert BROWSER_EDITING not in record.text
        assert "browser-editing-key" not in record.text

        # Text-to-image under the same browser choice stays on generation.
        calls.clear()
        job = post_text(client, "separate-text", headers(choice)).json()
        assert finish(client, job["generation_job_id"])["status"] == "complete"
        assert routed(calls) == {(GENERATION, SERVER_KEY)}


def test_custom_editing_endpoint_without_key_never_gets_a_server_key(tmp_path, calls):
    env = settings(
        tmp_path,
        IMAGE_EDIT_MODEL_ENDPOINT=EDITING,
        IMAGE_EDIT_MODEL_KEY=SERVER_EDIT_KEY,
    )
    with TestClient(create_app(env)) as client:
        defaults = client.get("/api/browser-settings/defaults")
        assert defaults.json()["editing"]["route"] == "separate"
        assert defaults.json()["providers"]["IMAGE_EDIT_MODEL_ENDPOINT"] == EDITING
        assert defaults.json()["keys_configured"]["IMAGE_EDIT_MODEL_KEY"] is True
        assert SERVER_EDIT_KEY not in defaults.text
        assert SERVER_KEY not in defaults.text

        # The deployment's own editing endpoint uses its own editing key.
        job = post_edit(client, "server-edit").json()
        assert finish(client, job["generation_job_id"])["status"] == "complete"
        assert routed(calls) == {(EDITING, SERVER_EDIT_KEY)}

        # A browser endpoint with a blank key gets no key at all.
        calls.clear()
        job = post_edit(
            client,
            "browser-edit",
            headers({"IMAGE_EDIT_MODEL_ENDPOINT": BROWSER_EDITING}),
        ).json()
        assert finish(client, job["generation_job_id"])["status"] == "complete"
        assert routed(calls) == {(BROWSER_EDITING, "")}

        # A browser may return editing to the generation route explicitly.
        calls.clear()
        job = post_edit(
            client, "browser-same", headers({"IMAGE_EDIT_ROUTE": "generation"})
        ).json()
        assert finish(client, job["generation_job_id"])["status"] == "complete"
        assert routed(calls) == {(GENERATION, SERVER_KEY)}


def test_generation_key_never_reaches_a_separate_route():
    env = {
        "IMAGE_MODEL_ENDPOINT_1": GENERATION,
        "IMAGE_MODEL_KEY_1": SERVER_KEY,
        "IMAGE_EDIT_WORKFLOW_PATH": "unused.json",
    }
    # Even pointing the editing route at the generation address sends no key.
    changed = override_environment(
        env,
        encoded(
            {"IMAGE_EDIT_ROUTE": "separate", "IMAGE_EDIT_MODEL_ENDPOINT": GENERATION}
        ),
    )
    provider = image_provider(changed)
    assert isinstance(provider, RoutedImageProvider)
    assert provider.editing.base == GENERATION
    assert provider.editing.key == ""
    assert provider.generation.key == SERVER_KEY
    assert env.get("IMAGE_EDIT_ROUTE") is None


@pytest.mark.parametrize(
    "changes",
    [
        {"IMAGE_EDIT_ROUTE": "separate"},
        {"IMAGE_EDIT_ROUTE": "elsewhere"},
        {"IMAGE_EDIT_MODEL_ENDPOINT": BROWSER_EDITING},
        {"IMAGE_EDIT_ROUTE": "generation", "IMAGE_EDIT_MODEL_KEY": "x"},
        {
            "IMAGE_EDIT_ROUTE": "separate",
            "IMAGE_EDIT_MODEL_ENDPOINT": "@".join(
                ("https://" + ":".join(("user", "hidden-pass")), "host.invalid")
            ),
        },
        {
            "IMAGE_EDIT_ROUTE": "separate",
            "IMAGE_EDIT_MODEL_ENDPOINT": "ftp://x.invalid",
        },
    ],
)
def test_unusable_editing_choices_fail_without_echoing_values(tmp_path, changes):
    with TestClient(create_app(settings(tmp_path))) as client:
        response = client.get("/api/models", headers=headers(changes))
        assert response.status_code == 400
        assert "hidden-pass" not in response.text
        assert BROWSER_EDITING not in response.text


def test_capabilities_describe_the_selected_editing_endpoint(tmp_path, calls):
    # Generation is unconfigured here; only the separate editing route can run.
    env = settings(tmp_path, IMAGE_MODEL_ENDPOINT_1="")
    choice = headers(
        {"IMAGE_EDIT_ROUTE": "separate", "IMAGE_EDIT_MODEL_ENDPOINT": BROWSER_EDITING}
    )
    with TestClient(create_app(env)) as client:
        assert (
            client.get("/api/app-capabilities").json()["image_editing"]["enabled"]
            is False
        )
        separate = client.get("/api/app-capabilities", headers=choice).json()
        assert separate["image_editing"]["enabled"] is True
        assert separate["image_editing"]["max_references"] == 10
        assert separate["region_editing"]["enabled"] is True
        models = client.get("/api/models", headers=choice).json()
        assert models["image_editing"]["enabled"] is True
        assert models["routing"]["image"]["configured"] is False
        # Text-to-image still reports the unconfigured generation provider.
        assert post_text(client, "text-blocked", choice).status_code == 503
        assert post_edit(client, "edit-allowed", choice).status_code == 202


def test_retries_keep_their_editing_identity(tmp_path, calls):
    first = headers(
        {"IMAGE_EDIT_ROUTE": "separate", "IMAGE_EDIT_MODEL_ENDPOINT": BROWSER_EDITING}
    )
    other = headers(
        {"IMAGE_EDIT_ROUTE": "separate", "IMAGE_EDIT_MODEL_ENDPOINT": EDITING}
    )
    with TestClient(create_app(settings(tmp_path))) as client:
        accepted = post_edit(client, "retry-key", first)
        assert accepted.status_code == 202
        repeated = post_edit(client, "retry-key", first)
        assert (
            repeated.json()["generation_job_id"] == accepted.json()["generation_job_id"]
        )
        # The same key with a different editing route is another request.
        assert post_edit(client, "retry-key", other).status_code == 409
        finish(client, accepted.json()["generation_job_id"])


def test_deployment_editing_settings_are_validated_at_startup(tmp_path):
    with pytest.raises(ValueError, match="IMAGE_EDIT_MODEL_ENDPOINT"):
        validate_deployment({"IMAGE_EDIT_MODEL_ENDPOINT": "not a url"})
    with pytest.raises(ValueError, match="IMAGE_EDIT_ROUTE"):
        validate_deployment({"IMAGE_EDIT_ROUTE": "separate"})
    with pytest.raises(ValueError):
        create_app(settings(tmp_path, IMAGE_EDIT_MODEL_ENDPOINT="ftp://x.invalid"))
