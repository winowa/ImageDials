"""Import visual choices are atomic, strict and grounded in bounded pixel input."""

import base64
import copy
import hashlib
import io
import json
import urllib.error

import pytest
from app import vision_controls
from app.imports import ImageDescriptionProvider
from app.main import create_app
from app.providers import ProviderError
from fastapi.testclient import TestClient
from PIL import Image, PngImagePlugin


def pixels(color="red", size=(1800, 1200), *, comfy=False):
    output = io.BytesIO()
    info = PngImagePlugin.PngInfo()
    if comfy:
        info.add_text(
            "prompt",
            json.dumps(
                {
                    "1": {
                        "class_type": "CLIPTextEncode",
                        "inputs": {"text": "A violet paper bird"},
                    },
                    "2": {"class_type": "KSampler", "inputs": {"positive": ["1", 0]}},
                }
            ),
        )
    Image.new("RGB", size, color).save(output, format="PNG", pnginfo=info)
    return output.getvalue()


CONTEXT = {
    "action": "image-controls",
    "revision": 7,
    "request_id": "owned-request",
    "provider_id": "fixture",
}


def test_actual_bounded_jpeg_catalog_schema_choices_and_no_blob_trace(
    tmp_path, monkeypatch
):
    data = pixels()
    captured = []

    def answer(base, path, payload, **kwargs):
        captured.append(payload)
        url = payload["messages"][1]["content"][1]["image_url"]["url"]
        jpeg = base64.b64decode(url.split(",", 1)[1])
        with Image.open(io.BytesIO(jpeg)) as image:
            assert image.format == "JPEG"
            assert max(image.size) == 1280
            assert image.getpixel((10, 10))[0] > 240
        return {
            "choices": [
                {
                    "message": {
                        "content": json.dumps(vision_controls.mock_observations(jpeg))
                    }
                }
            ]
        }

    monkeypatch.setattr(vision_controls, "request", answer)
    monkeypatch.setattr(
        ImageDescriptionProvider, "describe", lambda self, jpeg: "A red square"
    )
    with TestClient(
        create_app(
            {
                "IMAGEDIALS_DATA_DIR": str(tmp_path),
                "DESCRIPTION_MODEL_ENDPOINT": "http://localhost:12345",
                "DESCRIPTION_MODEL_NAME": "fixture-vision",
                "DESCRIPTION_MAX_EDGE_PIXELS": "2400",
            }
        )
    ) as client:
        response = client.post(
            "/api/images/import-analysis",
            files={"image": ("red.png", data, "image/png")},
            data={"context": json.dumps(CONTEXT)},
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["source_sha256"] == hashlib.sha256(data).hexdigest()
        assert body["binding"] == CONTEXT
        controls = body["image_controls"]
        assert controls["status"] == "ready"
        assert next(c for c in controls["controls"] if c["id"] == "color")["value"] == [
            "warm"
        ]
        multi = next(c for c in controls["controls"] if c["kind"] == "checkbox")
        assert multi["value"] == ["warm"]
        assert "data:image" not in json.dumps(controls)
        assert "omitted" in json.dumps(controls)
        assert client.get("/api/images/library").json()["count"] == 0
    assert len(captured) == 1
    assert (
        vision_controls.catalog_context("image")
        in captured[0]["messages"][0]["content"]
    )
    assert (
        captured[0]["response_format"]["json_schema"]["schema"]
        == vision_controls.vision_schema()
    )
    assert "untrusted" in captured[0]["messages"][0]["content"]


@pytest.mark.parametrize(
    "mutate",
    [
        lambda p: p["categories"].pop("binary"),
        lambda p: p["categories"]["radio"].update(type="single"),
        lambda p: p["categories"]["multi"].update(value=["unknown"]),
        lambda p: p["categories"]["checkbox"].update(value=["warm", "warm"]),
        lambda p: p["categories"]["range"].update(id="style"),
        lambda p: p["standard_selections"].update(color=["warm", "unknown"]),
        lambda p: p["standard_selections"].update(
            style=["photography", "watercolor", "illustration"]
        ),
        lambda p: p["standard_selections"].update(unknown="warm"),
        lambda p: p["standard_selections"].pop("texture"),
    ],
)
def test_malformed_observations_fail_closed(mutate):
    parsed = copy.deepcopy(vision_controls.mock_observations(pixels()))
    mutate(parsed)
    with pytest.raises(ValueError):
        vision_controls.validate_observations(parsed)


def test_network_failure_keeps_description_redacts_http_and_retry_is_description_free(
    tmp_path, monkeypatch
):
    secret = "fixture-secret-token"
    calls = []

    def fail(*args, **kwargs):
        error = ProviderError("Cannot connect " + secret)
        error.__cause__ = urllib.error.HTTPError(
            "http://localhost",
            503,
            "Unavailable",
            {},
            io.BytesIO((' {"error":"' + secret + '"}\n').encode()),
        )
        raise error

    monkeypatch.setattr(vision_controls, "request", fail)
    monkeypatch.setattr(
        ImageDescriptionProvider,
        "describe",
        lambda *args: calls.append("description") or "A red square",
    )
    with TestClient(
        create_app(
            {
                "IMAGEDIALS_DATA_DIR": str(tmp_path),
                "DESCRIPTION_MODEL_ENDPOINT": "http://localhost:12345",
                "DESCRIPTION_MODEL_KEY": secret,
                "DESCRIPTION_MODEL_NAME": "fixture",
            }
        )
    ) as client:
        for action in ("image-controls", "retry-controls"):
            response = client.post(
                "/api/images/import-analysis",
                files={"image": ("red.png", pixels(), "image/png")},
                data={"context": json.dumps({**CONTEXT, "action": action})},
            )
            assert response.status_code == 200, response.text
            body = response.json()
            assert body["image_controls"]["status"] == "error"
            assert secret not in response.text
            failure = body["image_controls"]["details"]["failure"]
            assert failure["http_status"] == 503
            assert failure["body"] == ' {"error":"[redacted]"}\n'
            if action == "image-controls":
                assert body["description"]["text"] == "A red square"
        assert calls == ["description"]


def test_description_only_never_chooses_and_comfy_prompt_wins(tmp_path, monkeypatch):
    with TestClient(
        create_app(
            {"IMAGEDIALS_DATA_DIR": str(tmp_path), "IMAGE_DESCRIPTION_PROVIDER": "mock"}
        )
    ) as client:
        body = client.post(
            "/api/images/import-analysis",
            files={"image": ("comfy.png", pixels(comfy=True), "image/png")},
            data={"context": json.dumps(CONTEXT)},
        ).json()
        assert body["prompt"] == "A violet paper bird"
        assert body["image_controls"]["status"] == "ready"
        monkeypatch.setattr(
            vision_controls,
            "mock_observations",
            lambda *args: pytest.fail("description retry requested controls"),
        )
        body = client.post(
            "/api/images/import-analysis",
            files={"image": ("red.png", pixels(), "image/png")},
            data={"context": json.dumps({**CONTEXT, "action": "description-only"})},
        ).json()
        assert body["description"]["status"] == "ready"
        assert "image_controls" not in body


def test_exact_metadata_skips_visual_guesses_and_disabled_inference_is_honest(
    tmp_path, monkeypatch
):
    from app.media import PNG_METADATA_KEY
    from test_imports import canonical_snapshot, png_with

    def unexpected(*args):
        pytest.fail("Exact metadata must not be visually reselected")

    monkeypatch.setattr(vision_controls, "mock_observations", unexpected)
    with TestClient(
        create_app(
            {
                "IMAGEDIALS_DATA_DIR": str(tmp_path),
                "IMAGE_DESCRIPTION_PROVIDER": "mock",
                "INFERENCE_ENABLED": "false",
            }
        )
    ) as client:
        snapshot = canonical_snapshot(width=24, height=16)
        response = client.post(
            "/api/images/import-analysis",
            files={
                "image": (
                    "saved.png",
                    png_with({PNG_METADATA_KEY: json.dumps(snapshot)}),
                    "image/png",
                )
            },
            data={"context": json.dumps(CONTEXT)},
        )
        body = response.json()
        assert body["mode"] == "metadata"
        assert body["image_controls"] == {"status": "restored"}
        assert (
            body["image"]["selected_controls"] == snapshot["image"]["selected_controls"]
        )
        assert body["description"]["status"] == "unavailable"
        body = client.post(
            "/api/images/import-analysis",
            files={"image": ("red.png", pixels(), "image/png")},
            data={"context": json.dumps(CONTEXT)},
        ).json()
        assert body["image_controls"]["status"] == "unavailable"
        assert not body["prompt"]


def test_split_import_phases_call_each_provider_once_and_bind_identical_source(
    tmp_path, monkeypatch
):
    calls = []
    original = vision_controls.mock_observations
    monkeypatch.setattr(
        ImageDescriptionProvider,
        "describe",
        lambda self, jpeg: calls.append("description") or "A red square",
    )

    def observations(jpeg):
        calls.append("controls")
        return original(jpeg)

    monkeypatch.setattr(vision_controls, "mock_observations", observations)
    data = pixels(comfy=True)
    with TestClient(
        create_app(
            {"IMAGEDIALS_DATA_DIR": str(tmp_path), "IMAGE_DESCRIPTION_PROVIDER": "mock"}
        )
    ) as client:
        answers = []
        for action in ("description-only", "retry-controls"):
            binding = {**CONTEXT, "action": action}
            response = client.post(
                "/api/images/import-analysis",
                files={"image": ("red.png", data, "image/png")},
                data={"context": json.dumps(binding)},
            )
            assert response.status_code == 200, response.text
            body = response.json()
            assert body["binding"] == binding
            assert body["source_sha256"] == hashlib.sha256(data).hexdigest()
            assert body["prompt_source"] == "comfyui-workflow"
            assert body["prompt"] == "A violet paper bird"
            answers.append(body)
            if action == "description-only":
                assert calls == ["description"]
                assert "image_controls" not in body
                assert body["description"]["text"] == "A red square"
        assert calls == ["description", "controls"]
        assert answers[1]["description"]["status"] == "not-requested"
        assert answers[1]["image_controls"]["status"] == "ready"
        assert client.get("/api/images/library").json()["count"] == 0
