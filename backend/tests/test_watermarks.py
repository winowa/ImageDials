import hashlib
import io
import json
import time
from pathlib import Path

import pytest
from app.main import create_app
from app.watermark_analysis import analyze_watermark, watermark_geometry
from app.watermark_settings import normalize_settings, settings_response, validate_svg
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw
from test_canonical import FIXTURE, wait_for_job

SHARED = json.loads(
    (Path(__file__).resolve().parents[2] / "fixtures/api/watermark.json").read_text()
)


@pytest.mark.parametrize("case", SHARED["geometry_cases"])
def test_shared_safe_rectangle_geometry(case):
    actual = watermark_geometry(case["width"], case["height"], case["corner"])
    assert {key: actual[key] for key in case["expected"]} == case["expected"]
    assert 0 <= actual["x"] <= case["width"] - actual["size"]
    assert 0 <= actual["y"] <= case["height"] - actual["size"]


@pytest.mark.parametrize("case", SHARED["legacy_geometry_cases"])
def test_legacy_safe_rectangle_geometry_is_unchanged(case):
    policy = SHARED["legacy_geometry_policy"]
    actual = watermark_geometry(case["width"], case["height"], case["corner"], policy)
    assert {key: actual[key] for key in case["expected"]} == case["expected"]


def test_current_geometry_insets_equally_from_the_image_edges():
    for width, height in [(1800, 1200), (1200, 1800), (1200, 1200), (3000, 1000)]:
        left = watermark_geometry(width, height, "top-left")
        right = watermark_geometry(width, height, "bottom-right")
        assert left["x"] == left["y"] == left["inset"]
        assert width - right["x"] - right["size"] == right["inset"]
        assert height - right["y"] - right["size"] == right["inset"]


@pytest.mark.parametrize("case", SHARED["unicode_text_cases"])
def test_shared_unicode_text_limits(case):
    if case["valid"]:
        result = normalize_settings({"type": "text", "text": case["text"]})
        assert result["text"] == case.get("normalized", case["text"])
    else:
        with pytest.raises(ValueError):
            normalize_settings({"type": "text", "text": case["text"]})


@pytest.mark.parametrize(
    "format,orientation,quiet_corner",
    [("PNG", 1, "top-left")]
    + [
        ("JPEG", orientation, corner)
        for orientation, corner in [
            (1, "top-left"),
            (2, "top-right"),
            (3, "bottom-right"),
            (4, "bottom-left"),
            (5, "top-left"),
            (6, "top-right"),
            (7, "bottom-right"),
            (8, "bottom-left"),
        ]
    ],
)
def test_pixel_analysis_chooses_quiet_region_and_preserves_bytes(
    format, orientation, quiet_corner
):
    image = Image.new("RGB", (300, 200), "white")
    draw = ImageDraw.Draw(image)
    for corner in ["bottom-left", "bottom-right", "top-right"]:
        box = watermark_geometry(300, 200, corner)
        for row in range(box["y"], box["y"] + box["size"]):
            for column in range(box["x"], box["x"] + box["size"]):
                draw.point((column, row), fill="black" if (row + column) % 2 else "red")
    output = io.BytesIO()
    exif = image.getexif()
    exif[274] = orientation
    options = (
        {"exif": exif, "quality": 100, "subsampling": 0} if format == "JPEG" else {}
    )
    image.save(output, format=format, **options)
    data = output.getvalue()
    analysis = analyze_watermark(data)
    assert analysis == analyze_watermark(data)
    assert analysis["position"]["corner"] == quiet_corner
    assert len(analysis["provenance"]["corner_scores"]) == 4
    assert analysis["provenance"]["source_sha256"] == hashlib.sha256(data).hexdigest()
    contrast = analysis["provenance"]["contrast"]
    assert contrast["target_met"] is True
    for endpoint in ("gradient_start", "gradient_end"):
        assert contrast[endpoint]["minimum_material_ratio"] >= contrast["target_ratio"]
    assert output.getvalue() == data


@pytest.mark.parametrize(
    "markup",
    [
        '<svg viewBox="0 0 10 10"><script>alert(1)</script></svg>',
        '<svg viewBox="0 0 10 10" onload="alert(1)"></svg>',
        '<svg viewBox="0 0 10 10"><use href="https://example.invalid/a.svg"/></svg>',
        '<svg viewBox="0 0 10 10"><path style="fill:url(https://example.invalid/a)"/></svg>',
        '<svg viewBox="0 0 10 10"><path style="fill:u\\72l(javascript:alert(1))"/></svg>',
        '<svg viewBox="0 0 10 10" xml:base="../outside.svg"><use href="#x"/></svg>',
        '<!DOCTYPE svg [<!ENTITY x "boom">]><svg viewBox="0 0 10 10">&x;</svg>',
        "<svg></svg>",
        '<svg viewBox="0 0 0 10"/>',
    ],
)
def test_svg_rejects_active_external_and_invalid_geometry(markup):
    with pytest.raises(ValueError):
        validate_svg(markup)


def test_svg_internal_resources_and_active_content_fingerprint():
    normalized = normalize_settings(
        {
            "type": "svg",
            "svg_markup": '<svg viewBox="0 0 10 10"><defs><linearGradient id="g"><stop offset="0" stop-color="#123456"/></linearGradient></defs><path fill="url(#g)" d="M0 0h10v10z"/></svg>',
        }
    )
    assert "linearGradient" in normalized["svg_markup"]
    settings = normalize_settings(SHARED["text_request"])
    first = settings_response(settings)["fingerprint"]
    assert (
        settings_response({**settings, "svg_markup": "inactive", "svg_recolor": False})[
            "fingerprint"
        ]
        == first
    )
    assert settings_response({**settings, "text": "Changed"})["fingerprint"] != first


def saved(client, key):
    payload = {
        **json.loads(FIXTURE.read_text()),
        "dimensions": "300x200",
        "idempotency_key": key,
    }
    accepted = client.post("/api/generate-image", json=payload).json()
    terminal = wait_for_job(client, accepted["generation_job_id"])
    assert terminal["status"] == "complete", terminal
    return terminal["result"]


def prepared_bytes(width=300, height=200):
    image = Image.new("RGB", (width, height), "blue")
    output = io.BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


def upload(client, record, key, data):
    return client.post(
        "/api/images/library/print-ready",
        data={
            "storage_id": "local-0",
            "filename": record["filename"],
            "watermark_key": key,
        },
        files={"file": ("prepared.png", data, "image/png")},
    )


def test_settings_analysis_prepared_version_and_original_integrity(tmp_path):
    settings = {"IMAGEDIALS_DATA_DIR": str(tmp_path)}
    with TestClient(create_app(settings)) as client:
        record = saved(client, "watermark")
        source = client.get(record["image_url"]).content
        identity = {"storage_id": "local-0", "filename": record["filename"]}
        initial = client.get("/api/watermark/settings").json()
        analyzed = client.post("/api/images/library/watermark", json=identity)
        assert analyzed.status_code == 200, analyzed.text
        assert analyzed.json()["status"] == "generated"
        key = analyzed.json()["image"]["print_watermark_key"]
        assert key
        analysis = analyzed.json()["print_watermark"]
        assert (
            client.post("/api/images/library/watermark", json=identity).json()["status"]
            == "existing"
        )
        regenerated = client.post(
            "/api/images/library/watermark", json={**identity, "force": True}
        ).json()
        assert regenerated["status"] == "regenerated"
        assert regenerated["image"]["print_watermark_key"] != key
        data = prepared_bytes()
        assert upload(client, record, key, data).status_code == 409
        key = regenerated["image"]["print_watermark_key"]
        analysis = regenerated["print_watermark"]
        response = upload(client, record, key, data)
        assert response.status_code == 200, response.text
        url = response.json()["image"]["print_ready_url"]
        assert url
        assert client.get(url).content == data
        assert client.get(record["image_url"]).content == source
        changed = client.put("/api/watermark/settings", json=SHARED["text_request"])
        assert changed.status_code == 200
        assert changed.json()["fingerprint"] != initial["fingerprint"]
        listed = client.get("/api/images/library").json()["images"][0]
        assert listed["print_watermark"] == analysis
        assert listed["print_ready"] and listed["print_ready_url"] is None
        assert client.get(url).status_code == 404
        assert (
            client.get(
                url.split("?")[0] + "?v=" + listed["print_watermark_key"]
            ).status_code
            == 404
        )
        assert upload(client, record, key, data).status_code == 409
        current = upload(client, record, listed["print_watermark_key"], data)
        assert current.status_code == 200
        assert client.get(record["image_url"]).content == source
    with TestClient(create_app(settings)) as client:
        assert client.get("/api/watermark/settings").json()["text"] == "Studio\n2026"
        assert client.get(current.json()["image"]["print_ready_url"]).content == data


def test_prepared_upload_rejects_invalid_and_oversized_requests(tmp_path):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        record = saved(client, "invalid-prepared")
        analyzed = client.post(
            "/api/images/library/watermark",
            json={"storage_id": "local-0", "filename": record["filename"]},
        ).json()
        key = analyzed["image"]["print_watermark_key"]
        assert upload(client, record, key, b"not PNG").status_code == 422
        assert upload(client, record, key, prepared_bytes(32, 32)).status_code == 422
        assert upload(client, record, "", prepared_bytes()).status_code == 400
        assert (
            client.post(
                "/api/images/library/print-ready",
                content=b"x",
                headers={"Content-Length": str(66 * 1024 * 1024)},
            ).status_code
            == 413
        )
        assert client.post("/api/images/library/watermark", json={}).status_code == 400
        assert (
            client.post(
                "/api/images/library/watermark",
                json={
                    "storage_id": "local-0",
                    "filename": record["filename"],
                    "force": "yes",
                },
            ).status_code
            == 400
        )


def test_shared_settings_independent_of_library_and_queued_analysis(tmp_path):
    with TestClient(
        create_app(
            {"IMAGEDIALS_DATA_DIR": str(tmp_path), "SHARED_LIBRARY_ENABLED": "false"}
        )
    ) as client:
        assert client.get("/api/watermark/settings").status_code == 200
        assert (
            client.put(
                "/api/watermark/settings", json=SHARED["svg_request"]
            ).status_code
            == 200
        )
        assert (
            client.post("/api/images/library/watermarks/backfill", json={}).status_code
            == 403
        )
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        saved(client, "batch")
        response = client.post("/api/images/library/watermarks/backfill", json={})
        assert response.status_code == 200, response.text
        assert (
            response.json()["status"] == "queued"
            and response.json()["queued_count"] == 1
        )
        for _ in range(100):
            library = client.get("/api/images/library").json()
            if library["watermark_backfill"]["status"] not in {"queued", "running"}:
                break
            time.sleep(0.01)
        assert library["watermark_backfill"]["completed_count"] == 1
        assert library["images"][0]["print_watermark"] is not None
        assert library["images"][0]["print_ready_url"] is None
        assert library["watermark_backfill"]["completion_scope"] == "analysis"


def test_historical_missing_hash_and_size_can_prepare_without_rewriting_original(
    tmp_path,
):
    import sqlite3

    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        record = saved(client, "historical-watermark")
        source = client.get(record["image_url"]).content
        identity = {"storage_id": "local-0", "filename": record["filename"]}
        with sqlite3.connect(tmp_path / "library.sqlite3") as database:
            raw = json.loads(
                database.execute(
                    "SELECT data FROM images WHERE id=?", (record["id"],)
                ).fetchone()[0]
            )
            for key in ["sha256", "width", "height"]:
                raw.pop(key)
            database.execute(
                "UPDATE images SET data=? WHERE id=?", (json.dumps(raw), record["id"])
            )
        assert (
            client.get("/api/images/library").json()["images"][0]["dimensions"] is None
        )
        analyzed = client.post("/api/images/library/watermark", json=identity)
        assert analyzed.status_code == 200, analyzed.text
        assert analyzed.json()["status"] == "generated"
        assert (
            client.post("/api/images/library/watermark", json=identity).json()["status"]
            == "existing"
        )
        key = analyzed.json()["image"]["print_watermark_key"]
        assert key
        assert upload(client, record, key, prepared_bytes(32, 32)).status_code == 422
        response = upload(client, record, key, prepared_bytes())
        assert response.status_code == 200, response.text
        assert response.json()["image"]["print_ready"]["dimensions"] == {
            "width": 300,
            "height": 200,
        }
        assert (
            client.get(response.json()["image"]["print_ready_url"]).status_code == 200
        )
        assert client.get(record["image_url"]).content == source
        # Derived analysis does not silently rewrite historical source metadata.
        with sqlite3.connect(tmp_path / "library.sqlite3") as database:
            current = json.loads(
                database.execute(
                    "SELECT data FROM images WHERE id=?", (record["id"],)
                ).fetchone()[0]
            )
        assert current == raw


def test_reused_analysis_still_rejects_changed_original_bytes(tmp_path):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        record = saved(client, "changed-source")
        identity = {"storage_id": "local-0", "filename": record["filename"]}
        analyzed = client.post("/api/images/library/watermark", json=identity)
        assert analyzed.status_code == 200
        analysis_file = tmp_path / "derivatives" / record["id"] / "analysis.json"
        analysis = analysis_file.read_bytes()
        source = tmp_path / record["filename"]
        source.write_bytes(source.read_bytes() + b"changed bytes")
        response = client.post("/api/images/library/watermark", json=identity)
        assert response.status_code == 422
        assert "no longer match" in response.json()["detail"]
        assert analysis_file.read_bytes() == analysis
        assert (
            upload(
                client,
                record,
                analyzed.json()["image"]["print_watermark_key"],
                prepared_bytes(),
            ).status_code
            == 422
        )


def test_watermark_storage_failures_have_controlled_responses(tmp_path, monkeypatch):
    import sqlite3

    app = create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})
    with TestClient(app) as client:
        record = saved(client, "storage-errors")
        identity = {"storage_id": "local-0", "filename": record["filename"]}

        def broken(*args):
            raise sqlite3.OperationalError("unavailable")

        with monkeypatch.context() as patch:
            patch.setattr(app.state.store, "setting", broken)
            assert client.get("/api/watermark/settings").status_code == 502
        with monkeypatch.context() as patch:
            patch.setattr(app.state.store, "image", broken)
            assert (
                client.post("/api/images/library/watermark", json=identity).status_code
                == 502
            )
            assert (
                client.get(
                    f"/api/images/library/print-ready/local-0/{record['filename']}"
                ).status_code
                == 502
            )
        with monkeypatch.context() as patch:
            patch.setattr(app.state.watermarks, "record", broken)
            assert (
                client.get(
                    f"/api/images/library/print-ready/local-0/{record['filename']}"
                ).status_code
                == 502
            )


def test_metadata_directory_cannot_follow_symlink_outside_storage(tmp_path):
    with TestClient(
        create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path / "library")})
    ) as client:
        record = saved(client, "symlink-metadata")
        outside = tmp_path / "outside"
        outside.mkdir()
        marker = outside / "analysis.json"
        marker.write_text('{"private":"outside metadata"}')
        derivatives = tmp_path / "library" / "derivatives"
        derivatives.mkdir(exist_ok=True)
        try:
            (derivatives / record["id"]).symlink_to(outside, target_is_directory=True)
        except OSError:
            pytest.skip("Symbolic links unavailable on this platform")
        response = client.post(
            "/api/images/library/watermark",
            json={"storage_id": "local-0", "filename": record["filename"]},
        )
        assert response.status_code == 502
        assert marker.read_text() == '{"private":"outside metadata"}'
        assert client.get("/api/images/library").status_code == 502


def test_prepared_upload_enforces_real_file_and_chunked_request_boundaries(tmp_path):
    from app.media import MEBIBYTE, PREPARED_FILE_MAX_BYTES, PREPARED_REQUEST_MAX_BYTES

    assert PREPARED_FILE_MAX_BYTES == 64 * MEBIBYTE
    assert PREPARED_REQUEST_MAX_BYTES == 65 * MEBIBYTE
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        record = saved(client, "prepared-byte-boundaries")
        identity = {"storage_id": "local-0", "filename": record["filename"]}
        current = client.post("/api/images/library/watermark", json=identity).json()[
            "image"
        ]
        original = client.get(record["image_url"]).content
        boundary = "independent-upload-boundary"
        fields = {**identity, "watermark_key": current["print_watermark_key"]}
        header = (
            "".join(
                f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'
                for name, value in fields.items()
            )
            + f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="prepared.png"\r\nContent-Type: image/png\r\n\r\n'
        )

        def chunks(file_bytes):
            yield header.encode()
            remaining = file_bytes
            while remaining:
                size = min(remaining, MEBIBYTE)
                yield b"x" * size
                remaining -= size
            yield f"\r\n--{boundary}--\r\n".encode()

        cases = [
            (PREPARED_FILE_MAX_BYTES, 422, "valid PNG"),
            (PREPARED_FILE_MAX_BYTES + 1, 422, "file byte limit"),
            (PREPARED_REQUEST_MAX_BYTES + 1, 413, "too large"),
        ]
        for size, status, message in cases:
            response = client.post(
                "/api/images/library/print-ready",
                content=chunks(size),
                headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
            )
            assert response.status_code == status, response.text
            assert message.lower() in response.text.lower()
        assert client.get(record["image_url"]).content == original
        assert (
            client.get("/api/images/library").json()["images"][0]["print_ready_url"]
            is None
        )
