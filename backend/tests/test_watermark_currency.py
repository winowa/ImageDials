"""Analysis from another algorithm or geometry is never drawn or prepared again."""

import json

from app.main import create_app
from app.watermark_analysis import ANALYSIS_VERSION
from app.watermark_preview import compact_watermark_analysis
from fastapi.testclient import TestClient
from test_library import save_image
from test_watermark_metadata import preparation, submit

OLD_VERSION = "pixel-analysis-v3"
OLD_ANALYSIS = {
    "position": {"corner": "top-left"},
    "presentation": {
        "gradient_start": "#c7df20",
        "gradient_end": "#a7e652",
        "separation_color": "#faf9f6",
        "glow_color": "#a7e652",
    },
    "provenance": {
        "generator_version": OLD_VERSION,
        "geometry_policy_fingerprint": "0" * 64,
    },
}


def test_compact_previews_carry_only_current_versions():
    assert compact_watermark_analysis(OLD_ANALYSIS) is None
    current = {
        **OLD_ANALYSIS,
        "provenance": {"generator_version": ANALYSIS_VERSION},
    }
    assert compact_watermark_analysis(current)["analysis_version"] == ANALYSIS_VERSION


def test_stale_shared_analysis_is_hidden_until_analyzed_again(tmp_path):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        record = save_image(client, "stale-analysis")
        store = client.app.state.store
        service = client.app.state.watermarks
        source = (tmp_path / record["filename"]).read_bytes()
        folder = tmp_path / "derivatives" / record["id"]
        folder.mkdir(parents=True, exist_ok=True)
        stale = {
            **OLD_ANALYSIS,
            "provenance": {
                **OLD_ANALYSIS["provenance"],
                "source_sha256": record["sha256"],
            },
        }
        (folder / "analysis.json").write_text(json.dumps(stale))
        old_key = "a" * 64
        (folder / (old_key + ".png")).write_bytes(source)
        (folder / "print-ready.json").write_text(json.dumps({"watermark_key": old_key}))
        # A projection written before the upgrade: compact copy, no version.
        with store.write_transaction() as database:
            database.execute(
                "UPDATE library_catalog SET summary=json_set(summary,"
                "'$.print_watermark', json(?), '$.has_watermark_analysis', json('true'))"
                " WHERE id=?",
                (
                    json.dumps(
                        {
                            "position": stale["position"],
                            "presentation": stale["presentation"],
                        }
                    ),
                    record["id"],
                ),
            )

        detail = service.record(store.image(record["id"]))
        assert detail["print_watermark"] is None
        assert detail["print_watermark_key"] is None
        assert detail["print_ready_url"] is None
        summary = client.get("/api/images/library/page").json()["images"][0]
        assert summary["print_watermark"] is None
        assert summary["watermark_preview_status"] == "unavailable"

        status, refreshed = service.analyze(store.image(record["id"]))
        assert status == "regenerated"
        analysis = refreshed["print_watermark"]
        assert analysis["provenance"]["generator_version"] == ANALYSIS_VERSION
        assert analysis["presentation"]["gradient_start"] != "#c7df20"
        assert refreshed["print_watermark_key"] not in (None, old_key)
        assert refreshed["print_ready_url"] is None
        summary = client.get("/api/images/library/page").json()["images"][0]
        assert summary["print_watermark"]["analysis_version"] == ANALYSIS_VERSION
        assert (tmp_path / record["filename"]).read_bytes() == source


def test_browser_derivative_refuses_outdated_analysis(tmp_path):
    with TestClient(
        create_app(
            {"IMAGEDIALS_DATA_DIR": str(tmp_path), "SHARED_LIBRARY_ENABLED": "false"}
        )
    ) as client:
        _, rendered, metadata = preparation(client)
        outdated = json.loads(json.dumps(metadata))
        outdated["print_watermark"]["provenance"]["generator_version"] = OLD_VERSION
        assert submit(client, rendered, outdated).status_code == 409
        moved = json.loads(json.dumps(metadata))
        moved["print_watermark"]["provenance"]["geometry_policy_fingerprint"] = "0" * 64
        assert submit(client, rendered, moved).status_code == 409
        assert submit(client, rendered, metadata).status_code == 200


def test_current_compact_preview_survives_repeated_projection():
    analysis = {**OLD_ANALYSIS, "provenance": {"generator_version": ANALYSIS_VERSION}}
    compact = compact_watermark_analysis(analysis)
    assert compact_watermark_analysis(compact) == compact
    assert (
        compact_watermark_analysis({**compact, "analysis_version": OLD_VERSION}) is None
    )


def test_cancelled_partial_analysis_version_is_not_current():
    partial = {**OLD_ANALYSIS, "provenance": {"generator_version": "pixel-analysis-v4"}}
    assert compact_watermark_analysis(partial) is None
