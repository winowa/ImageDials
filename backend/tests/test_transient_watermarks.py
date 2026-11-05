"""Private/browser-only analysis uses real pixels without shared storage writes."""

import hashlib
import io
import json
from pathlib import Path

import pytest
from app.main import create_app
from app.media import MULTIPART_OVERHEAD_BYTES
from fastapi.testclient import TestClient
from PIL import Image


def image_bytes(format="PNG", size=(120, 80)):
    output = io.BytesIO()
    Image.new("RGB", size, (20, 90, 160)).save(output, format=format)
    return output.getvalue()


@pytest.mark.parametrize(
    "format,mime",
    [("PNG", "image/png"), ("JPEG", "image/jpeg"), ("WEBP", "image/webp")],
)
def test_transient_analysis_works_with_library_and_inference_disabled(
    tmp_path, monkeypatch, format, mime
):
    app = create_app(
        {
            "IMAGEDIALS_DATA_DIR": str(tmp_path),
            "SHARED_LIBRARY_ENABLED": "false",
            "INFERENCE_ENABLED": "false",
        }
    )
    with TestClient(app) as client:

        def no_inference(*args):
            raise AssertionError(
                "Transient watermark analysis must never invoke a model"
            )

        monkeypatch.setattr(app.state.controls, "controls", no_inference)
        monkeypatch.setattr(app.state.composer, "compose", no_inference)
        monkeypatch.setattr(app.state.description, "describe", no_inference)
        monkeypatch.setattr(app.state.renderer, "render", no_inference)
        before = {str(path.relative_to(tmp_path)) for path in tmp_path.rglob("*")}
        data = image_bytes(format)
        response = client.post(
            "/api/watermark/analyze-image", files={"image": ("input", data, mime)}
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["storage"] == "transient"
        assert body["source_sha256"] == hashlib.sha256(data).hexdigest()
        assert body["dimensions"] == {"width": 120, "height": 80}
        assert (
            body["print_watermark"]["provenance"]["method"]
            == "deterministic-python-pixels"
        )
        assert len(body["print_watermark"]["provenance"]["corner_scores"]) == 4
        assert len(body["print_watermark_key"]) == 64
        assert body["watermark_settings"]["fingerprint"]
        assert app.state.store.images() == []
        with app.state.store.connect() as database:
            assert database.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 0
        assert {
            str(path.relative_to(tmp_path)) for path in tmp_path.rglob("*")
        } == before
        assert client.get("/api/images/library").status_code == 403
        caps = client.get("/api/app-capabilities").json()
        assert caps["watermark"]["transient_analysis_enabled"] is True


def test_transient_key_tracks_settings_without_changing_analysis(tmp_path):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        data = image_bytes()
        first = client.post(
            "/api/watermark/analyze-image", files={"file": ("input.png", data)}
        ).json()
        assert (
            client.put(
                "/api/watermark/settings", json={"type": "text", "text": "Changed"}
            ).status_code
            == 200
        )
        second = client.post(
            "/watermark/analyze-image", files={"image": ("input.png", data)}
        ).json()
        assert first["print_watermark"] == second["print_watermark"]
        assert first["print_watermark_key"] != second["print_watermark_key"]
        assert second["watermark_settings"]["text"] == "Changed"
        assert client.get("/api/images/library").json()["count"] == 0


def test_transient_upload_bounds_and_prefix_aliases(tmp_path):
    settings = {
        "IMAGEDIALS_DATA_DIR": str(tmp_path),
        "APP_BASE_PATH": "/studio",
        "WATERMARK_ANALYSIS_MAX_BYTES": "16",
    }
    with TestClient(create_app(settings)) as client:
        for path in [
            "/api/watermark/analyze-image",
            "/watermark/analyze-image",
            "/studio/api/watermark/analyze-image",
            "/studio/watermark/analyze-image",
        ]:
            assert (
                client.post(path, files={"image": ("large.png", b"x" * 17)}).status_code
                == 413
            )
            assert (
                client.post(
                    path,
                    content=b"x",
                    headers={"Content-Length": str(17 + MULTIPART_OVERHEAD_BYTES)},
                ).status_code
                == 413
            )
            assert (
                client.post(path, files={"image": ("empty.png", b"")}).status_code
                == 400
            )
        assert (
            client.get("/api/app-capabilities").json()["uploads"][
                "watermark_analysis_max_bytes"
            ]
            == 16
        )


def test_transient_rejects_invalid_formats_and_pixel_budget(tmp_path):
    settings = {
        "IMAGEDIALS_DATA_DIR": str(tmp_path),
        "IMAGE_MAX_DECODED_PIXELS": "100",
        "IMAGE_LANDSCAPE_DIMENSIONS": "12x8",
        "IMAGE_PORTRAIT_DIMENSIONS": "8x12",
        "IMAGE_SQUARE_DIMENSIONS": "8x8",
    }
    with TestClient(create_app(settings)) as client:
        for data in [
            b"not an image",
            image_bytes("GIF", (8, 8)),
            image_bytes("PNG", (24, 16)),
        ]:
            assert (
                client.post(
                    "/api/watermark/analyze-image", files={"image": ("input", data)}
                ).status_code
                == 400
            )
        assert client.post("/api/watermark/analyze-image").status_code == 400


def test_shared_transient_fixture_matches_actual_analysis(tmp_path):
    fixture = json.loads(
        (
            Path(__file__).resolve().parents[2]
            / "fixtures/api/transient-watermark.json"
        ).read_text()
    )
    source = fixture["request"]["image"]
    output = io.BytesIO()
    Image.new("RGB", (source["width"], source["height"]), tuple(source["rgb"])).save(
        output, format=source["format"]
    )
    with TestClient(
        create_app(
            {
                "IMAGEDIALS_DATA_DIR": str(tmp_path),
                "SHARED_LIBRARY_ENABLED": "false",
                "INFERENCE_ENABLED": "false",
            }
        )
    ) as client:
        response = client.post(
            fixture["request"]["path"],
            files={
                fixture["request"]["multipart_field"]: (
                    "fixture.png",
                    output.getvalue(),
                    "image/png",
                )
            },
        )
        assert response.status_code == 200
        assert response.json() == fixture["response"]


@pytest.mark.parametrize("orientation", range(1, 9))
def test_exif_orientation_matches_display_geometry_without_changing_source(
    tmp_path, orientation
):
    from app.media import inspect_import
    from app.watermark_analysis import watermark_geometry

    image = Image.new("RGB", (120, 80), (20, 90, 160))
    exif = image.getexif()
    exif[274] = orientation
    output = io.BytesIO()
    image.save(output, format="JPEG", exif=exif)
    source = output.getvalue()
    expected = (80, 120) if orientation >= 5 else (120, 80)
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        response = client.post(
            "/api/watermark/analyze-image",
            files={"image": ("rotated.jpg", source, "image/jpeg")},
        )
        assert response.status_code == 200, response.text
        result = response.json()
        assert result["dimensions"] == {"width": expected[0], "height": expected[1]}
        assert result["source_sha256"] == hashlib.sha256(source).hexdigest()
        for region in result["print_watermark"]["provenance"]["corner_scores"]:
            assert region["geometry"] == watermark_geometry(*expected, region["corner"])
        assert client.get("/api/images/library").json()["count"] == 0
    embedded, dimensions, jpeg = inspect_import(source, 32000000, 1280)
    assert embedded is None
    assert dimensions == {"width": expected[0], "height": expected[1]}
    with Image.open(io.BytesIO(jpeg)) as description_input:
        assert description_input.size == expected
        assert description_input.getexif().get(274, 1) == 1
    assert output.getvalue() == source


def test_transient_reuses_analysis_across_content_changes_and_honors_force(
    tmp_path, monkeypatch
):
    import app.watermarks as watermarks

    original = watermarks.analyze_watermark
    calls = []

    def analyze(data):
        calls.append(hashlib.sha256(data).hexdigest())
        return original(data)

    monkeypatch.setattr(watermarks, "analyze_watermark", analyze)
    app = create_app(
        {"IMAGEDIALS_DATA_DIR": str(tmp_path), "INFERENCE_ENABLED": "false"}
    )
    with TestClient(app) as client:
        data = image_bytes()

        def upload(query=""):
            response = client.post(
                "/api/watermark/analyze-image" + query,
                files={"image": ("fixture.png", data)},
            )
            assert response.status_code == 200, response.text
            return response.json()

        first = upload()
        assert upload() == first
        assert len(calls) == 1
        assert (
            client.put(
                "/api/watermark/settings", json={"type": "text", "text": "New content"}
            ).status_code
            == 200
        )
        changed = upload()
        assert changed["print_watermark"] == first["print_watermark"]
        assert changed["print_watermark_key"] != first["print_watermark_key"]
        assert len(calls) == 1
        assert upload("?force=true") == changed
        assert len(calls) == 2
        assert app.state.store.images() == []


def test_transient_analysis_cache_is_bounded_metadata_and_isolates_returns(
    tmp_path, monkeypatch
):
    import app.watermarks as watermarks

    original = watermarks.analyze_watermark
    calls = []

    def analyze(data):
        calls.append(hashlib.sha256(data).hexdigest())
        return original(data)

    monkeypatch.setattr(watermarks, "analyze_watermark", analyze)
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        service = client.app.state.watermarks
        source = None
        for index in range(watermarks.TRANSIENT_ANALYSIS_CACHE_LIMIT + 1):
            output = io.BytesIO()
            Image.new("RGB", (24, 16), (index, 30, 80)).save(output, format="PNG")
            source = output.getvalue()
            if index == 0:
                oldest = source
            service.analyze_upload(source)
        assert (
            len(service.transient_analyses) == watermarks.TRANSIENT_ANALYSIS_CACHE_LIMIT
        )
        # JSON-serializable metadata only: uploaded bytes cannot be retained here.
        json.dumps(list(service.transient_analyses.items()))
        before = len(calls)
        response = service.analyze_upload(source)
        response["print_watermark"]["position"]["corner"] = "changed by caller"
        assert (
            service.analyze_upload(source)["print_watermark"]["position"]["corner"]
            != "changed by caller"
        )
        assert len(calls) == before
        service.analyze_upload(oldest)
        assert len(calls) == before + 1
        assert (
            len(service.transient_analyses) == watermarks.TRANSIENT_ANALYSIS_CACHE_LIMIT
        )
