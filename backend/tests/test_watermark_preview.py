"""Bounded renderable summaries without image or provenance hydration."""

import base64
import json
from pathlib import Path

import pytest
from app.library_index import projection, write_projection
from app.main import create_app
from app.watermark_preview import (
    MAX_PREVIEW_SIDECAR_BYTES,
    compact_watermark_analysis,
    legacy_watermark_preview,
)
from fastapi.testclient import TestClient
from test_gallery_sessions import create, ready
from test_library import save_image


def test_shared_preview_fixture_matches_actual_analyzer_and_page(tmp_path):
    fixture = json.loads(
        (
            Path(__file__).resolve().parents[2] / "fixtures/api/watermark-preview.json"
        ).read_text()
    )
    record = fixture["source_record"]
    png = base64.b64decode(fixture["source_png_base64"])
    with TestClient(
        create_app(
            {
                "IMAGEDIALS_DATA_DIR": str(tmp_path),
                "INFERENCE_ENABLED": "false",
                "IMAGE_PROVIDER": "mock",
            }
        )
    ) as client:
        store = client.app.state.store
        source = tmp_path / (record["id"] + ".png")
        source.write_bytes(png)
        with store.write_transaction() as database:
            database.execute(
                "INSERT INTO images VALUES (?,?)", (record["id"], json.dumps(record))
            )
            write_projection(database, record, store.library_search_available)
            store.record_library_change(database, "saved")
        client.app.state.watermarks.analyze(store.image(record["id"]))
        assert (
            client.get("/api/images/library/page").json()["images"][0]
            == fixture["summary"]
        )
        assert source.read_bytes() == png


def test_preview_keeps_only_valid_renderer_inputs():
    analysis = {
        "position": {"corner": " TOP-RIGHT ", "unused": [1] * 1000},
        "presentation": {
            "gradient_start": None,
            "gradientStart": " #aBcD12 ",
            "gradient_end": "red",
            "gradientEnd": "#abcdef",
            "separation_color": "#012345",
            "glowColor": "#fedcba",
            "palette": ["large"] * 1000,
        },
        "provenance": {"palette": ["large"] * 1000},
    }
    assert compact_watermark_analysis(analysis) == {
        "position": {"corner": "top-right"},
        "presentation": {
            "gradient_start": "#aBcD12",
            "separation_color": "#012345",
            "glow_color": "#fedcba",
        },
    }
    assert compact_watermark_analysis({"position": {"corner": "invalid"}}) == {
        "position": {"corner": "bottom-left"},
        "presentation": {},
    }
    assert compact_watermark_analysis({}) is None
    summary, _ = projection({"id": "baked-example", "derivative_type": "watermarked"})
    assert summary["derivative_type"] == "watermarked"


@pytest.mark.parametrize(
    "content", [b"{broken", b"[]", b"\xff", b"x" * (MAX_PREVIEW_SIDECAR_BYTES + 1)]
)
def test_legacy_preview_rejects_invalid_or_oversize_sidecars(tmp_path, content):
    folder = tmp_path / "derivatives" / "preview-example"
    folder.mkdir(parents=True)
    (folder / "analysis.json").write_bytes(content)
    assert legacy_watermark_preview(tmp_path, "preview-example") is None
    assert legacy_watermark_preview(tmp_path, "../preview-example") is None


def test_legacy_preview_refuses_sidecar_symlink(tmp_path):
    folder = tmp_path / "derivatives" / "preview-example"
    folder.mkdir(parents=True)
    target = tmp_path / "other.json"
    target.write_text(json.dumps({"position": {"corner": "top-left"}}))
    try:
        (folder / "analysis.json").symlink_to(target)
    except OSError:
        pytest.skip("Creating symlinks is unavailable on this platform")
    assert legacy_watermark_preview(tmp_path, "preview-example") is None


def test_actual_analysis_reaches_pages_and_sessions_without_source_changes(
    tmp_path, monkeypatch
):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        record = save_image(client, "compact-preview")
        store = client.app.state.store
        source = tmp_path / record["filename"]
        original = source.read_bytes()
        with store.connect() as database:
            original_json = database.execute(
                "SELECT data FROM images WHERE id=?", (record["id"],)
            ).fetchone()[0]
        _, decorated = client.app.state.watermarks.analyze(record)
        expected = compact_watermark_analysis(decorated["print_watermark"])

        def forbidden(*args):
            raise AssertionError("Summary must not hydrate a generation record")

        monkeypatch.setattr(store, "images", forbidden)
        monkeypatch.setattr(client.app.state.watermarks, "record", forbidden)
        page = client.get("/api/images/library/page").json()
        summary = page["images"][0]
        assert summary["print_watermark"] == expected
        assert summary["watermark_preview_status"] == "available"
        assert "provenance" not in summary["print_watermark"]
        session = ready(client, create(client)).json()
        assert session["images"][0]["print_watermark"] == expected

        # An existing v3 projection has no compact field. Read only its bounded
        # analysis sidecar, without requiring a whole-catalog migration.
        with store.write_transaction() as database:
            database.execute(
                "UPDATE library_catalog SET summary=json_remove(summary,'$.print_watermark') WHERE id=?",
                (record["id"],),
            )
        assert (
            client.get("/api/images/library/page").json()["images"][0][
                "print_watermark"
            ]
            == expected
        )
        assert source.read_bytes() == original
        with store.connect() as database:
            assert (
                database.execute(
                    "SELECT data FROM images WHERE id=?", (record["id"],)
                ).fetchone()[0]
                == original_json
            )
