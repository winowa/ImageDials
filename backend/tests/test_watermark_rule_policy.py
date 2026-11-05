"""Glyph-relative rendering changes PNG identity, not source pixel analysis."""

import hashlib
import json
from pathlib import Path

import pytest
from app.main import create_app
from app.watermark_policy import WATERMARK_POLICY, geometry_fingerprint
from app.watermark_settings import normalize_settings
from fastapi.testclient import TestClient
from test_watermark_metadata import preparation, submit

FIXTURE = json.loads(
    (
        Path(__file__).resolve().parents[2] / "fixtures/api/watermark-rule-spacing.json"
    ).read_text()
)


@pytest.mark.parametrize("case", FIXTURE["text_cases"])
def test_rule_contract_text_is_valid_and_preserves_line_count(case):
    normalized = normalize_settings({"type": "text", "text": case["text"]})
    assert normalized["text"] == case["text"]
    assert len(normalized["text"].splitlines()) == case["line_count"]


def test_current_renderer_policy_matches_contract_and_preserves_analysis_geometry(
    tmp_path,
):
    assert WATERMARK_POLICY == FIXTURE["rendering"]
    legacy = {**WATERMARK_POLICY, "rendererVersion": "square-watermark-v1"}
    legacy.pop("textRulePlacement")
    assert geometry_fingerprint(legacy) == geometry_fingerprint(WATERMARK_POLICY)
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        assert (
            client.get("/api/browser-settings/defaults").json()["watermark"][
                "rendering"
            ]
            == FIXTURE["rendering"]
        )


def test_legacy_render_key_is_rejected_without_regenerating_current_analysis(
    tmp_path, monkeypatch
):
    import app.watermarks as watermarks

    calls = []
    analyzer = watermarks.analyze_watermark

    def analyze(data):
        calls.append(hashlib.sha256(data).hexdigest())
        return analyzer(data)

    monkeypatch.setattr(watermarks, "analyze_watermark", analyze)
    with TestClient(
        create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path), "INFERENCE_ENABLED": "false"})
    ) as client:
        original, rendered, metadata = preparation(client)
        current_key = metadata["watermark_key"]
        legacy_policy = {**WATERMARK_POLICY, "rendererVersion": "square-watermark-v1"}
        legacy_policy.pop("textRulePlacement")
        legacy_policy_hash = hashlib.sha256(
            json.dumps(legacy_policy, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
        with monkeypatch.context() as legacy:
            legacy.setattr(watermarks, "RENDERER_VERSION", "square-watermark-v1")
            legacy.setattr(
                watermarks, "WATERMARK_POLICY_FINGERPRINT", legacy_policy_hash
            )
            legacy_key = watermarks.watermark_key(
                metadata["source_image"],
                metadata["print_watermark"],
                metadata["watermark_settings"],
            )
        assert legacy_key != current_key
        rejected = submit(client, rendered, {**metadata, "watermark_key": legacy_key})
        assert rejected.status_code == 409
        accepted = submit(client, rendered, metadata)
        assert accepted.status_code == 200
        again = client.post(
            "/api/watermark/analyze-image",
            files={"image": ("original.png", original, "image/png")},
            data={
                "watermark_settings": json.dumps(
                    {"type": "text", "text": "Browser mark"}
                )
            },
        )
        assert again.status_code == 200
        assert again.json()["print_watermark_key"] == current_key
        assert len(calls) == 1
        assert client.app.state.store.images() == []
