"""Downloaded derivatives embed content and analysis, never rewrite the source."""

import hashlib
import io
import json

import pytest
from app.main import create_app
from fastapi.testclient import TestClient
from PIL import Image


def png(color):
    output = io.BytesIO()
    Image.new("RGB", (120, 80), color).save(output, format="PNG")
    return output.getvalue()


def preparation(client):
    original = png("blue")
    analysis = client.post(
        "/api/watermark/analyze-image",
        files={"image": ("original.png", original, "image/png")},
        data={
            "watermark_settings": json.dumps({"type": "text", "text": "Browser mark"})
        },
    ).json()
    source = {
        "id": "independent-original",
        "image_id": "independent-original",
        "storage_id": "local-0",
        "filename": "independent-original.png",
        "prompt": "A blue paper circle",
        "original_selected_controls": [
            {"kind": "binary", "label": "Highlight", "value": False, "unknown": 0}
        ],
        "image_url": "blob:temporary-source",
        "sha256": hashlib.sha256(original).hexdigest(),
    }
    metadata = {
        "source_image": source,
        "source_sha256": analysis["source_sha256"],
        "print_watermark": analysis["print_watermark"],
        "watermark_settings": analysis["watermark_settings"],
        "watermark_key": analysis["print_watermark_key"],
        "dimensions": analysis["dimensions"],
    }
    return original, png("green"), metadata


def submit(client, rendered, metadata, prefix="/api"):
    return client.post(
        prefix + "/watermark/embed-metadata",
        files={"file": ("rendered.png", rendered, "image/png")},
        data={"metadata": json.dumps(metadata)},
    )


def test_derivative_download_contains_metadata_and_preserves_rendered_pixels(tmp_path):
    app = create_app(
        {"IMAGEDIALS_DATA_DIR": str(tmp_path), "SHARED_LIBRARY_ENABLED": "false"}
    )
    with TestClient(app) as client:
        before = client.get("/api/watermark/settings").json()
        original, rendered, metadata = preparation(client)
        original_hash = hashlib.sha256(original).hexdigest()
        response = submit(client, rendered, metadata)
        assert response.status_code == 200, response.text
        assert response.headers["content-type"] == "image/png"
        assert response.content != original
        with Image.open(io.BytesIO(response.content)) as image:
            assert image.getpixel((60, 40)) == (0, 128, 0)
            record = json.loads(image.info["ImageDials"])["image"]
        assert record["derivative_type"] == "watermarked"
        assert record["derivative_of"]["sha256"] == original_hash
        assert record["id"] != "independent-original"
        assert record["watermark_settings"]["text"] == "Browser mark"
        assert record["print_watermark"] == metadata["print_watermark"]
        assert record["print_watermark_key"] == metadata["watermark_key"]
        assert record["selected_controls"][0]["value"] is False
        assert record["selected_controls"][0]["unknown"] == 0
        assert "image_url" not in record and "sha256" not in record
        assert hashlib.sha256(original).hexdigest() == original_hash
        assert app.state.store.images() == []
        assert client.get("/api/watermark/settings").json() == before
        imported = client.post(
            "/api/images/import-analysis",
            files={"image": ("watermarked.png", response.content, "image/png")},
        )
        assert imported.status_code == 200, imported.text
        assert imported.json()["mode"] == "metadata"
        assert imported.json()["image"]["watermark_settings"]["text"] == "Browser mark"


@pytest.mark.parametrize("prefix", ["/api", "", "/studio/api", "/studio"])
def test_stateless_derivative_aliases(tmp_path, prefix):
    with TestClient(
        create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path), "APP_BASE_PATH": "/studio"})
    ) as client:
        _, rendered, metadata = preparation(client)
        assert submit(client, rendered, metadata, prefix).status_code == 200


def test_stale_key_wrong_dimensions_and_original_mismatch_do_not_fall_back(tmp_path):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        _, rendered, metadata = preparation(client)
        assert (
            submit(client, rendered, {**metadata, "watermark_key": "stale"}).status_code
            == 409
        )
        assert (
            submit(
                client, rendered, {**metadata, "dimensions": {"width": 1, "height": 1}}
            ).status_code
            == 422
        )
        assert (
            submit(
                client, rendered, {**metadata, "source_sha256": "0" * 64}
            ).status_code
            == 422
        )
        assert submit(client, b"not a PNG", metadata).status_code == 422
