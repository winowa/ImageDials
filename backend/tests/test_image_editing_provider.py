import copy
import hashlib
import io
import json
import struct

import pytest
from app import providers
from app.image_editing import (
    MAX_REFERENCE_BYTES,
    MAX_REFERENCE_DESCRIPTION_CHARACTERS,
    MAX_REFERENCE_SLOTS,
    MAX_REFERENCE_TOTAL_BYTES,
    QWEN_ENCODER_CLASS,
    REFERENCE_MARKER,
    normalize_references,
)
from app.providers import ImageProvider, ProviderError
from PIL import Image, PngImagePlugin


def png_bytes(size=(12, 8), color=(20, 80, 160, 255)):
    buffer = io.BytesIO()
    Image.new("RGBA", size, color).save(buffer, "PNG")
    return buffer.getvalue()


def reference(data=None, filename="source.png", role="subject", description="source"):
    return {
        "data": png_bytes() if data is None else data,
        "filename": filename,
        "role": role,
        "description": description,
    }


def edit_graph(marker=True):
    inputs = {"prompt": "$prompt"}
    if marker:
        inputs[REFERENCE_MARKER] = True
    return {
        "5": {"class_type": QWEN_ENCODER_CLASS, "inputs": inputs},
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


def comfy_provider(path):
    return ImageProvider(
        {
            "IMAGE_PROVIDER": "comfyui",
            "IMAGE_MODEL_ENDPOINT_1": "http://provider.invalid",
            "IMAGE_EDIT_WORKFLOW_PATH": str(path),
            "GENERATION_TIMEOUT_SECONDS": "1",
        }
    )


@pytest.mark.parametrize("count", [1, 2, 4, 10])
def test_reference_edit_uploads_in_order_links_encoder_and_uses_encoder_latent(
    tmp_path, monkeypatch, count
):
    workflow_file = tmp_path / "edit.json"
    workflow_file.write_text(json.dumps(edit_graph()), encoding="utf-8")
    uploaded = []
    prompt_calls = []

    def upload(base, filename, data, **kwargs):
        uploaded.append((filename, data))
        return {"name": filename, "subfolder": "", "type": "temp"}

    result = b"generated png bytes"

    def request(base, path, payload=None, **kwargs):
        if path == "/prompt":
            prompt_calls.append(copy.deepcopy(payload["prompt"]))
            return {"prompt_id": "edit-job"}
        if path.startswith("/history/"):
            return {
                "edit-job": {
                    "outputs": {"out": {"images": [{"filename": "out.png"}]}},
                    "status": {"status_str": "success"},
                }
            }
        if path.startswith("/view?"):
            return result
        raise AssertionError(path)

    monkeypatch.setattr(providers, "upload_reference", upload)
    monkeypatch.setattr(providers, "request", request)
    refs = [
        reference(filename=f"ref-{index}.png", role=f"role-{index}")
        for index in range(count)
    ]
    provider = comfy_provider(workflow_file)
    assert provider.editing_ready
    data, diagnostics = provider.render("Edit <image1>", 768, 1152, references=refs)
    assert data == result
    graph = prompt_calls[0]
    encoder = graph["5"]["inputs"]
    assert REFERENCE_MARKER not in encoder
    for index, (filename, normalized_bytes) in enumerate(uploaded, start=1):
        assert filename.startswith("imagedials-ref-") and filename.endswith(".png")
        loader_id = str(7 + index)
        assert graph[loader_id] == {
            "class_type": "LoadImage",
            "inputs": {"image": f"{filename} [temp]"},
        }
        assert encoder[f"images.image_{index}"] == [loader_id, 0]
        with Image.open(io.BytesIO(normalized_bytes)) as normalized:
            assert normalized.format == "PNG"
    assert graph["7"]["inputs"]["latent_image"] == ["5", 2]
    assert [entry["role"] for entry in diagnostics["references"]] == [
        f"role-{index}" for index in range(count)
    ]
    assert all(
        "data" not in entry and "endpoint" not in entry
        for entry in diagnostics["references"]
    )


def test_reference_normalization_orients_strips_metadata_and_preserves_original():
    buffer = io.BytesIO()
    image = Image.new("RGB", (2, 3), "red")
    # IFD0 holds Orientation and a GPS IFD pointer. GPSInfo contains version data.
    tiff = b"II*\0" + struct.pack("<I", 8)
    tiff += struct.pack("<H", 2)
    tiff += struct.pack("<HHI4s", 0x0112, 3, 1, b"\x06\x00\x00\x00")
    tiff += struct.pack("<HHII", 0x8825, 4, 1, 38)
    tiff += struct.pack("<I", 0)
    tiff += struct.pack("<H", 1)
    tiff += struct.pack("<HHI4s", 0x0000, 1, 4, b"\x02\x03\x00\x00")
    tiff += struct.pack("<I", 0)
    png_info = PngImagePlugin.PngInfo()
    png_info.add_text("PrivateDescription", "do not send source metadata")
    image.save(
        buffer,
        "PNG",
        pnginfo=png_info,
        exif=b"Exif\0\0" + tiff,
        icc_profile=b"private-icc-profile",
    )
    original = buffer.getvalue()
    original_hash = hashlib.sha256(original).hexdigest()
    with Image.open(io.BytesIO(original)) as source:
        assert source.info["PrivateDescription"] == "do not send source metadata"
        assert source.info["icc_profile"] == b"private-icc-profile"
        assert source.getexif().get_ifd(0x8825)[0] == b"\x02\x03\x00\x00"
    prepared = normalize_references([reference(original, "portrait.png")])[0]
    assert hashlib.sha256(original).hexdigest() == original_hash
    assert prepared["sha256"] == original_hash
    with Image.open(io.BytesIO(prepared["data"])) as oriented:
        assert oriented.format == "PNG"
        assert oriented.size == (3, 2)
        assert not oriented.info
        assert not list(oriented.getexif().items())
    assert prepared["normalized_sha256"] == hashlib.sha256(prepared["data"]).hexdigest()


def test_supplied_reference_digest_must_match_bytes():
    ref = reference()
    ref["sha256"] = "0" * 64
    with pytest.raises(ProviderError, match="checksum does not match"):
        normalize_references([ref])


def test_invalid_graph_is_rejected_before_any_reference_upload(tmp_path, monkeypatch):
    workflow_file = tmp_path / "invalid.json"
    workflow_file.write_text(json.dumps(edit_graph(marker=False)), encoding="utf-8")
    uploads = []
    monkeypatch.setattr(
        providers, "upload_reference", lambda *args, **kwargs: uploads.append(args)
    )
    provider = comfy_provider(workflow_file)
    with pytest.raises(ProviderError, match="one reference marker"):
        provider.render("Edit", 768, 1152, references=[reference()])
    assert uploads == []


@pytest.mark.parametrize(
    "mutate, message",
    [
        (
            lambda graph: graph["7"]["inputs"].update(latent_image=["6", 0]),
            "encoder latent",
        ),
        (
            lambda graph: graph.update(
                {"6": {"class_type": "EmptySD3LatentImage", "inputs": {}}}
            ),
            "separate latent path",
        ),
        (
            lambda graph: graph["5"].update(class_type="OtherEncoder"),
            "Qwen image encoder",
        ),
    ],
)
def test_wrong_encoder_or_latent_graph_is_rejected_before_upload(
    tmp_path, monkeypatch, mutate, message
):
    graph = edit_graph()
    mutate(graph)
    workflow_file = tmp_path / "invalid.json"
    workflow_file.write_text(json.dumps(graph), encoding="utf-8")
    uploads = []
    monkeypatch.setattr(
        providers, "upload_reference", lambda *args, **kwargs: uploads.append(args)
    )
    with pytest.raises(ProviderError, match=message):
        comfy_provider(workflow_file).render(
            "Edit", 768, 1152, references=[reference()]
        )
    assert uploads == []


def test_editing_without_configured_workflow_does_not_fall_back_to_text_generation(
    monkeypatch,
):
    calls = []
    monkeypatch.setattr(
        providers, "request", lambda *args, **kwargs: calls.append(args)
    )
    provider = ImageProvider(
        {
            "IMAGE_PROVIDER": "comfyui",
            "IMAGE_MODEL_ENDPOINT_1": "http://provider.invalid",
            "IMAGE_WORKFLOW_PATH": "text-only.json",
        }
    )
    assert provider.ready
    assert not provider.editing_ready
    with pytest.raises(ProviderError, match="does not support reference editing"):
        provider.render("Edit", 768, 1152, references=[reference()])
    assert calls == []


@pytest.mark.parametrize(
    "bad_response",
    [
        {"name": "../outside.png", "subfolder": "", "type": "temp"},
        {"name": "imagedials-ref-x.png", "subfolder": "../outside", "type": "temp"},
        {"name": "imagedials-ref-x.png", "subfolder": "", "type": "output"},
        {"name": "imagedials-ref-x.png", "subfolder": "", "type": "input"},
    ],
)
def test_upload_response_rejects_untrusted_paths(bad_response):
    with pytest.raises(ProviderError, match="unsafe upload path"):
        ImageProvider._validate_upload_response(bad_response, "imagedials-ref-x.png")


def test_reference_upload_uses_comfy_multipart_and_existing_bearer_key(monkeypatch):
    captured = {}

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self, _limit):
            return b'{"name":"imagedials-ref-a.png","subfolder":"","type":"temp"}'

    def open_request(req, timeout):
        captured["url"] = req.full_url
        captured["authorization"] = req.get_header("Authorization")
        captured["content_type"] = req.get_header("Content-type")
        captured["body"] = req.data
        captured["timeout"] = timeout
        return Response()

    monkeypatch.setattr(providers.urllib.request, "urlopen", open_request)
    result = providers.upload_reference(
        "http://provider.invalid/", "imagedials-ref-a.png", b"png", key="secret"
    )
    assert result["type"] == "temp"
    assert captured["url"] == "http://provider.invalid/upload/image"
    assert captured["authorization"] == "Bearer secret"
    assert captured["content_type"].startswith("multipart/form-data; boundary=")
    assert b'name="image"; filename="imagedials-ref-a.png"' in captured["body"]
    assert b'name="type"' in captured["body"] and b"\r\n\r\ntemp" in captured["body"]
    assert captured["timeout"] == 60


def test_upload_refusal_does_not_submit_edit_or_fall_back_to_text(
    tmp_path, monkeypatch
):
    workflow_file = tmp_path / "edit.json"
    workflow_file.write_text(json.dumps(edit_graph()), encoding="utf-8")
    prompt_calls = []

    def refused(*_args, **_kwargs):
        raise ProviderError("Image reference upload failed")

    monkeypatch.setattr(providers, "upload_reference", refused)
    monkeypatch.setattr(
        providers,
        "request",
        lambda *args, **kwargs: prompt_calls.append(args),
    )
    with pytest.raises(ProviderError, match="upload failed"):
        comfy_provider(workflow_file).render(
            "Edit", 768, 1152, references=[reference()]
        )
    assert prompt_calls == []


def test_reference_limits_and_decoded_pixel_limit(monkeypatch):
    import app.image_editing as editing

    with pytest.raises(ProviderError, match="At most 16 reference images"):
        normalize_references([reference()] * (MAX_REFERENCE_SLOTS + 1))
    with pytest.raises(ProviderError, match="At most 10 reference images"):
        normalize_references([reference()] * 11, max_count=10)
    monkeypatch.setattr(editing, "MAX_REFERENCE_BYTES", 10)
    with pytest.raises(ProviderError, match="32 MiB limit"):
        normalize_references([reference(b"x" * 11)])
    monkeypatch.setattr(editing, "MAX_REFERENCE_BYTES", MAX_REFERENCE_BYTES)
    monkeypatch.setattr(editing, "MAX_REFERENCE_TOTAL_BYTES", 20)
    data = png_bytes()
    with pytest.raises(ProviderError, match="64 MiB total limit"):
        normalize_references([reference(data), reference(data)])
    monkeypatch.setattr(editing, "MAX_REFERENCE_TOTAL_BYTES", MAX_REFERENCE_TOTAL_BYTES)
    with pytest.raises(ProviderError, match="decoded pixel limit"):
        normalize_references([reference()], max_pixels=1)


def test_mock_reference_edit_changes_pixels_and_identifies_mock():
    data = png_bytes()
    provider = ImageProvider({"IMAGE_PROVIDER": "mock"})
    edited, diagnostics = provider.render(
        "Change the scene", 12, 8, references=[reference(data)]
    )
    assert edited != data
    assert diagnostics["provider_mode"] == "mock-reference-edit"
    assert diagnostics["references"][0]["sha256"] == hashlib.sha256(data).hexdigest()


def test_reference_description_limit_matches_supported_vision_descriptions():
    refs = normalize_references(
        [reference(description="x" * MAX_REFERENCE_DESCRIPTION_CHARACTERS)]
    )
    assert len(refs[0]["description"]) == MAX_REFERENCE_DESCRIPTION_CHARACTERS
    with pytest.raises(ProviderError, match="description"):
        normalize_references(
            [reference(description="x" * (MAX_REFERENCE_DESCRIPTION_CHARACTERS + 1))]
        )


def test_mock_editing_observes_configured_pixel_limit():
    provider = ImageProvider(
        {"IMAGE_PROVIDER": "mock", "IMAGE_MAX_DECODED_PIXELS": "1"}
    )
    with pytest.raises(ProviderError, match="pixel limit"):
        provider.render("Edit the image", 12, 8, references=[reference()])
