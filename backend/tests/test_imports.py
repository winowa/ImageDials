import io
import json

import pytest
from app import imports
from app.main import create_app
from app.media import PNG_METADATA_KEY
from fastapi.testclient import TestClient
from PIL import Image, PngImagePlugin
from test_canonical import FIXTURE, wait_for_job


def plain_image():
    output = io.BytesIO()
    Image.new("RGB", (24, 16), "blue").save(output, format="PNG")
    return output.getvalue()


def test_generated_png_import_round_trip_without_library_insertion(tmp_path):
    settings = {
        "IMAGEDIALS_DATA_DIR": str(tmp_path),
        "IMAGE_DESCRIPTION_PROVIDER": "mock",
    }
    with TestClient(create_app(settings)) as client:
        payload = json.loads(FIXTURE.read_text())
        accepted = client.post("/api/generate-image", json=payload).json()
        terminal = wait_for_job(client, accepted["generation_job_id"])
        assert terminal["status"] == "complete"
        saved = terminal["result"]
        original = client.get(saved["image_url"]).content
        with Image.open(io.BytesIO(original)) as source:
            embedded = json.loads(source.info[PNG_METADATA_KEY])
            assert embedded["image"]["selected_controls"] == payload["controls"]
            assert (
                embedded["image"]["dynamic_controls_metadata"]
                == payload["dynamic_controls_metadata"]
            )
        response = client.post(
            "/api/images/import-analysis",
            files={"image": ("original.png", original, "image/png")},
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["mode"] == "metadata"
        assert body["prompt_source"] == "imagedials-metadata"
        # The description is created for every valid import.
        assert body["description"]["status"] == "ready"
        assert body["description"]["text"]
        record = body["image"]
        assert record["storage_id"] == "dropped-image"
        assert record["storage_type"] == "browser-upload"
        assert record["image_url"] == ""
        assert record["selected_controls"] == payload["controls"]
        assert (
            record["dynamic_controls_metadata"] == payload["dynamic_controls_metadata"]
        )
        assert record["final_prompt"] == saved["final_prompt"]
        assert record["sha256"] == saved["sha256"]
        assert record["dimensions"] == saved["actual_dimensions"]
        assert client.get("/api/images/library").json()["count"] == 1
        assert client.get(saved["image_url"]).content == original
    # Metadata restore does not require model inference.
    with TestClient(create_app({**settings, "INFERENCE_ENABLED": "false"})) as client:
        body = client.post(
            "/api/images/import-analysis",
            files={"file": ("image.png", original, "image/png")},
        ).json()
        assert body["mode"] == "metadata"
        assert body["description"]["status"] == "unavailable"
        assert body["description"]["text"] is None


@pytest.mark.parametrize("field", ["image", "file"])
def test_plain_import_mock_description_has_no_storage_side_effect(tmp_path, field):
    with TestClient(
        create_app(
            {"IMAGEDIALS_DATA_DIR": str(tmp_path), "IMAGE_DESCRIPTION_PROVIDER": "mock"}
        )
    ) as client:
        response = client.post(
            "/api/images/import-analysis",
            files={field: ("picture.png", plain_image(), "image/png")},
        )
        assert response.status_code == 200, response.text
        assert response.json()["mode"] == "description"
        assert response.json()["provider"] == "mock"
        assert client.get("/api/images/library").json()["count"] == 0


def test_import_validation_limits_and_disabled_description(tmp_path):
    with TestClient(
        create_app(
            {
                "IMAGEDIALS_DATA_DIR": str(tmp_path),
                "IMAGE_DESCRIPTION_PROVIDER": "mock",
                "IMPORT_MAX_BYTES": "128",
                "IMAGE_MAX_DECODED_PIXELS": "100",
                # Import reads originals within the source envelope only.
                "IMAGE_MAX_SOURCE_PIXELS": "100",
                "IMAGE_LANDSCAPE_DIMENSIONS": "12x8",
                "IMAGE_PORTRAIT_DIMENSIONS": "8x12",
                "IMAGE_SQUARE_DIMENSIONS": "10x10",
            }
        )
    ) as client:
        endpoint = "/api/images/import-analysis"
        assert (
            client.post(
                endpoint, files={"image": ("empty.png", b"", "image/png")}
            ).status_code
            == 400
        )
        assert (
            client.post(
                endpoint, files={"image": ("invalid.png", b"bad", "image/png")}
            ).status_code
            == 400
        )
        assert (
            client.post(
                endpoint, files={"image": ("large.png", b"x" * 129, "image/png")}
            ).status_code
            == 413
        )
        assert (
            client.post(
                endpoint, files={"image": ("pixels.png", plain_image(), "image/png")}
            ).status_code
            == 400
        )
        assert client.post(endpoint, json={}).status_code == 400
        assert (
            client.post(
                endpoint, content=b"x", headers={"Content-Length": str(2 * 1024 * 1024)}
            ).status_code
            == 413
        )
        # No Content-Length: the installed middleware must count streamed chunks.
        response = client.post(
            endpoint,
            content=iter(
                [
                    b'--x\r\nContent-Disposition: form-data; name="image"; filename="large.png"\r\nContent-Type: image/png\r\n\r\n',
                    b"x" * (1024 * 1024),
                    b"x" * 512,
                    b"\r\n--x--\r\n",
                ]
            ),
            headers={"Content-Type": "multipart/form-data; boundary=x"},
        )
        assert response.status_code == 413
    with TestClient(
        create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path), "INFERENCE_ENABLED": "false"})
    ) as client:
        assert (
            client.post(
                "/api/images/import-analysis",
                files={"image": ("image.png", plain_image(), "image/png")},
            ).status_code
            == 503
        )
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        assert (
            client.post(
                "/api/images/import-analysis",
                files={"image": ("image.png", plain_image(), "image/png")},
            ).status_code
            == 503
        )


def png_with(chunks, size=(24, 16)):
    info = PngImagePlugin.PngInfo()
    for key, value in chunks.items():
        info.add_itxt(key, value if isinstance(value, str) else json.dumps(value))
    output = io.BytesIO()
    Image.new("RGB", size, "teal").save(output, format="PNG", pnginfo=info)
    return output.getvalue()


POSITIVE = "A brass telescope on a velvet cloth, warm window light"
NEGATIVE = "blurry, low quality, watermark"


def api_graph(positive=POSITIVE, negative=NEGATIVE):
    """A ComfyUI API prompt whose sampler reaches the positive text via a modifier."""
    return {
        "3": {
            "class_type": "KSampler",
            "inputs": {"positive": ["10", 0], "negative": ["7", 0], "seed": 4},
        },
        "6": {"class_type": "CLIPTextEncode", "inputs": {"text": positive}},
        "7": {"class_type": "CLIPTextEncode", "inputs": {"text": negative}},
        "10": {
            "class_type": "ConditioningSetArea",
            "inputs": {"conditioning": ["6", 0], "width": 64},
        },
        "11": {
            "class_type": "LoadImage",
            "inputs": {"image": "/etc/passwd", "upload": "image"},
        },
    }


def mock_client(tmp_path, **settings):
    return TestClient(
        create_app(
            {
                "IMAGEDIALS_DATA_DIR": str(tmp_path),
                "IMAGE_DESCRIPTION_PROVIDER": "mock",
                **settings,
            }
        )
    )


def analyze(client, data):
    return client.post(
        "/api/images/import-analysis",
        files={"image": ("image.png", data, "image/png")},
    )


def canonical_snapshot(**changes):
    """The embedded snapshot of the canonical metadata fixture PNG."""
    import base64
    from pathlib import Path

    m3 = json.loads(
        (Path(__file__).resolve().parents[2] / "fixtures/api/m3.json").read_text()
    )
    with Image.open(io.BytesIO(base64.b64decode(m3["metadata_png_base64"]))) as image:
        decoded = json.loads(image.info[PNG_METADATA_KEY])
    decoded["image"].update(changes)
    return decoded


MOCK_DESCRIPTION = (
    "A mock image description of a small crafted object on a plain background"
)


def test_invalid_embedded_metadata_falls_back_to_description_and_is_not_stored(
    tmp_path,
):
    for raw in ('{"version":99}', "{not json", '{"version":1,"image":{"prompt":""}}'):
        with mock_client(tmp_path) as client:
            response = analyze(client, png_with({PNG_METADATA_KEY: raw}))
            assert response.status_code == 200, response.text
            body = response.json()
            assert body["mode"] == "description"
            assert body["prompt"] == MOCK_DESCRIPTION
            assert body["description"]["status"] == "ready"
            assert body["metadata_notice"]
            assert "image" not in body
            assert client.get("/api/images/library").json()["count"] == 0
    # Without a description provider an unusable snapshot has no prompt at all.
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        response = analyze(client, png_with({PNG_METADATA_KEY: '{"version":99}'}))
        assert response.status_code == 503


def test_metadata_for_a_different_size_is_not_restored(tmp_path):
    snapshot = canonical_snapshot(
        prompt="A resized copy", original_prompt="A resized copy", width=240, height=160
    )
    with mock_client(tmp_path) as client:
        body = analyze(client, png_with({PNG_METADATA_KEY: snapshot})).json()
        assert body["mode"] == "description"
        assert "size" in body["metadata_notice"]
        snapshot["image"].update(width=24, height=16)
        body = analyze(client, png_with({PNG_METADATA_KEY: snapshot})).json()
        assert body["mode"] == "metadata"
        assert body["prompt"] == "A resized copy"


def test_oversized_metadata_remains_a_hard_failure(tmp_path):
    raw = json.dumps({"version": 1, "image": {"prompt": "x" * (1024 * 1024)}})
    with mock_client(tmp_path) as client:
        assert analyze(client, png_with({PNG_METADATA_KEY: raw})).status_code == 400


def test_comfyui_positive_prompt_is_used_and_negative_is_never_used(tmp_path):
    with mock_client(tmp_path) as client:
        response = analyze(client, png_with({"prompt": api_graph()}))
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["mode"] == "comfyui"
        assert body["prompt"] == POSITIVE
        assert body["prompt_source"] == "comfyui-workflow"
        assert body["description"]["status"] == "ready"
        assert body["description"]["text"] == MOCK_DESCRIPTION
        assert NEGATIVE not in json.dumps(body)
        assert client.get("/api/images/library").json()["count"] == 0


def test_comfyui_custom_sampler_guider_and_linked_string(tmp_path):
    graph = {
        "1": {"class_type": "PrimitiveStringMultiline", "inputs": {"value": POSITIVE}},
        "2": {"class_type": "CLIPTextEncode", "inputs": {"text": ["1", 0]}},
        "3": {"class_type": "CLIPTextEncode", "inputs": {"text": NEGATIVE}},
        "4": {
            "class_type": "CFGGuider",
            "inputs": {"positive": ["5", 0], "negative": ["3", 0], "cfg": 4},
        },
        "5": {"class_type": "FluxGuidance", "inputs": {"conditioning": ["2", 0]}},
        "9": {"class_type": "SamplerCustomAdvanced", "inputs": {"guider": ["4", 0]}},
    }
    with mock_client(tmp_path) as client:
        body = analyze(client, png_with({"prompt": graph})).json()
        assert (body["mode"], body["prompt"]) == ("comfyui", POSITIVE)


def test_comfyui_ui_workflow_is_a_fallback_when_no_api_prompt(tmp_path):
    workflow = {
        "nodes": [
            {
                "id": 6,
                "type": "CLIPTextEncode",
                "inputs": [],
                "widgets_values": [POSITIVE],
            },
            {
                "id": 7,
                "type": "CLIPTextEncode",
                "inputs": [],
                "widgets_values": [NEGATIVE],
            },
            {
                "id": 3,
                "type": "KSampler",
                "inputs": [
                    {"name": "negative", "type": "CONDITIONING", "link": 2},
                    {"name": "positive", "type": "CONDITIONING", "link": 1},
                ],
                "widgets_values": [1, "fixed", 20],
            },
        ],
        "links": [[1, 6, 0, 3, 1, "CONDITIONING"], [2, 7, 0, 3, 0, "CONDITIONING"]],
    }
    with mock_client(tmp_path) as client:
        body = analyze(client, png_with({"workflow": workflow})).json()
        assert (body["mode"], body["prompt"]) == ("comfyui", POSITIVE)


@pytest.mark.parametrize(
    "chunks",
    [
        {"prompt": "{not json"},
        {"prompt": ["not", "a", "graph"]},
        # Only negative conditioning reaches the sampler.
        {
            "prompt": {
                "3": {"class_type": "KSampler", "inputs": {"negative": ["7", 0]}},
                "7": {"class_type": "CLIPTextEncode", "inputs": {"text": NEGATIVE}},
            }
        },
        # A text encoder with no sampler is not assumed to be the prompt.
        {
            "prompt": {
                "6": {"class_type": "CLIPTextEncode", "inputs": {"text": POSITIVE}}
            }
        },
        # A cycle without text terminates.
        {
            "prompt": {
                "3": {"class_type": "KSampler", "inputs": {"positive": ["4", 0]}},
                "4": {
                    "class_type": "ConditioningCombine",
                    "inputs": {"conditioning_1": ["5", 0]},
                },
                "5": {
                    "class_type": "ConditioningCombine",
                    "inputs": {"conditioning_1": ["4", 0]},
                },
            }
        },
        # Text longer than the prompt limit is not used.
        {"prompt": api_graph(positive="x" * 4001)},
        {"parameters": "A1111-style text is not read", "unknown": "ignored"},
    ],
)
def test_comfyui_graph_without_usable_positive_text_falls_back(tmp_path, chunks):
    with mock_client(tmp_path) as client:
        body = analyze(client, png_with(chunks)).json()
        assert body["mode"] == "description"
        assert body["prompt"] == MOCK_DESCRIPTION
        assert NEGATIVE not in json.dumps(body)


def test_imagedials_metadata_takes_precedence_over_comfyui_prompt(tmp_path):
    snapshot = canonical_snapshot(
        prompt="The ImageDials snapshot",
        original_prompt="The ImageDials snapshot",
        width=24,
        height=16,
        future_field={"kept": True},
    )
    with mock_client(tmp_path) as client:
        body = analyze(
            client, png_with({PNG_METADATA_KEY: snapshot, "prompt": api_graph()})
        ).json()
        assert body["mode"] == "metadata"
        assert body["prompt"] == "The ImageDials snapshot"
        assert body["image"]["future_field"] == {"kept": True}
        assert body["description"]["text"] == MOCK_DESCRIPTION
        # Unusable ImageDials metadata yields to the ComfyUI prompt.
        body = analyze(
            client, png_with({PNG_METADATA_KEY: '{"version":2}', "prompt": api_graph()})
        ).json()
        assert (body["mode"], body["prompt"]) == ("comfyui", POSITIVE)
        assert body["metadata_notice"]


def test_description_failure_keeps_metadata_prompt_with_honest_status(
    tmp_path, monkeypatch
):
    from app.providers import ProviderError

    def fail(self, jpeg):
        raise ProviderError("Image description returned an invalid response")

    monkeypatch.setattr(imports.ImageDescriptionProvider, "describe", fail)
    with mock_client(tmp_path) as client:
        body = analyze(client, png_with({"prompt": api_graph()})).json()
        assert body["mode"] == "comfyui"
        assert body["description"] == {
            "status": "error",
            "text": None,
            "message": "Image description returned an invalid response",
            "provider": "mock",
            "model": "",
        }
        response = analyze(client, plain_image())
        assert response.status_code == 502
    # Inference disabled: a ComfyUI prompt is usable and no model is called.
    calls = []
    monkeypatch.setattr(
        imports.ImageDescriptionProvider,
        "describe",
        lambda self, jpeg: calls.append(jpeg) or "never",
    )
    with mock_client(tmp_path, INFERENCE_ENABLED="false") as client:
        body = analyze(client, png_with({"prompt": api_graph()})).json()
        assert body["mode"] == "comfyui"
        assert body["description"]["status"] == "unavailable"
        assert analyze(client, plain_image()).status_code == 503
    assert calls == []


def test_import_works_without_image_editing_support(tmp_path):
    with mock_client(
        tmp_path, IMAGE_PROVIDER="comfyui", IMAGE_MODEL_ENDPOINT_1=""
    ) as client:
        editing = client.get("/api/app-capabilities").json()["image_editing"]
        assert editing["enabled"] is False
        body = analyze(client, plain_image()).json()
        assert body["mode"] == "description"
        assert body["description"]["status"] == "ready"


def test_description_uses_native_image_message_and_validates(monkeypatch):
    calls = []

    def respond(base, path, payload=None, **kwargs):
        calls.append(payload)
        return {
            "choices": [
                {
                    "message": {"content": "A blue crafted object."},
                    "finish_reason": "stop",
                }
            ]
        }

    monkeypatch.setattr(imports, "request", respond)
    provider = imports.ImageDescriptionProvider(
        {
            "DESCRIPTION_MODEL_ENDPOINT": "http://localhost",
            "DESCRIPTION_MODEL_NAME": "fixture-vision",
        }
    )
    assert provider.describe(b"jpeg") == "A blue crafted object."
    content = calls[0]["messages"][1]["content"]
    assert content[1]["type"] == "image_url"
    assert content[1]["image_url"]["url"] == "data:image/jpeg;base64,anBlZw=="


def test_initial_png_normalizes_exif_before_recording_actual_dimensions():
    from app.media import prepare_original_png

    image = Image.new("RGB", (120, 80), "blue")
    exif = image.getexif()
    exif[274] = 6
    output = io.BytesIO()
    image.save(output, format="PNG", exif=exif)
    original = output.getvalue()
    snapshot = {"id": "orientation-fixture"}
    saved = prepare_original_png(original, snapshot)
    assert (snapshot["width"], snapshot["height"]) == (80, 120)
    with Image.open(io.BytesIO(saved)) as normalized:
        assert normalized.size == (80, 120)
        assert normalized.getexif().get(274, 1) == 1
    assert output.getvalue() == original


@pytest.mark.parametrize("name", ["import_description", "import_comfyui"])
def test_import_prompt_responses_match_shared_frontend_fixture(tmp_path, name):
    fixture = json.loads(FIXTURE.with_name("m3.json").read_text())[name]
    chunks = (
        {"prompt": api_graph(positive=fixture["prompt"])}
        if name == "import_comfyui"
        else {}
    )
    with mock_client(tmp_path) as client:
        response = analyze(client, png_with(chunks))
        assert response.status_code == 200, response.text
        assert response.json() == fixture
