"""Contract tests shared with frontend consumers, independent of live providers."""

import hashlib
import io
import json
import time
from pathlib import Path

import pytest
from app.main import create_app
from app.media import PNG_METADATA_KEY
from app.wire import resolve_controls
from fastapi.testclient import TestClient
from PIL import Image

FIXTURE = Path(__file__).resolve().parents[2] / "fixtures/api/generation.json"


def wait_for_job(client, job_id):
    for _ in range(200):
        status = client.get(f"/api/generation-jobs/{job_id}").json()
        if status["status"] != "running":
            return status
        time.sleep(0.01)
    pytest.fail("Canonical generation did not finish")


def test_discovery_does_not_infer_and_aliases(tmp_path):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        assert client.get("/healthz").json() == {
            "status": "ok",
            "inference_enabled": True,
        }
        assert client.get("/api/healthz").status_code == 404
        for path in ["models", "app-capabilities", "controls/static"]:
            assert client.get("/api/" + path).json() == client.get("/" + path).json()
        exports = client.get("/api/app-capabilities").json()["exports"]
        assert not any(
            exports[name]
            for name in ["share_enabled", "email_enabled", "server_handoff_enabled"]
        )
        assert client.get("/api/models").json()["models"]["llm"] is None
        controls = client.get("/api/controls/static?generation_mode=TRELLIS").json()[
            "controls"
        ]
        assert controls[0]["label"] == "Material"


def test_canonical_generation_lossless_storage_and_idempotency(tmp_path):
    payload = json.loads(FIXTURE.read_text())
    settings = {"IMAGEDIALS_DATA_DIR": str(tmp_path)}
    with TestClient(create_app(settings)) as client:
        response = client.post(
            "/api/generate-image", json={**payload, "idempotency_key": "canonical"}
        )
        assert response.status_code == 202, response.text
        accepted = response.json()
        job_id = accepted["generation_job_id"]
        assert accepted["enrichment"]["status"] == "pending"
        status = wait_for_job(client, job_id)
        assert status["status"] == "complete", status
        result = status["result"]
        assert result["original_selected_controls"] == payload["controls"]
        assert (
            result["dynamic_controls_metadata"] == payload["dynamic_controls_metadata"]
        )
        resolved = result["resolved_controls"]
        assert [c["value"] for c in resolved] == [
            "smooth glass",
            0,
            False,
            "Rounded edges",
            {"nested": 0},
        ]
        assert result["actual_dimensions"] == {"width": 768, "height": 1152}
        assert result["dimensions"] == "768x1152"
        assert isinstance(result["created_at"], float)
        assert isinstance(result["created_at_iso"], int)
        assert result["original_prompt"] == payload["prompt"]
        assert result["must_have_terms"] == payload["must_have_terms"]
        content = client.get(result["image_url"]).content
        assert hashlib.sha256(content).hexdigest() == result["sha256"]
        with Image.open(io.BytesIO(content)) as image:
            metadata = json.loads(image.info[PNG_METADATA_KEY])["image"]
        assert metadata["must_have_terms"] == payload["must_have_terms"]
        detail = client.get(f"/api/images/library/record/{job_id}").json()
        assert detail["must_have_terms"] == payload["must_have_terms"]
        again = client.post(
            "/api/generate-image", json={**payload, "idempotency_key": "canonical"}
        )
        assert again.json()["generation_job_id"] == job_id
        assert client.get("/api/images").json()["total"] == 1
    with TestClient(create_app(settings)) as client:
        assert client.get(f"/api/generation-jobs/{job_id}").json() == status
        assert client.get(result["image_url"]).content == content


def test_dynamic_controls_append_and_preserve_metadata(tmp_path):
    controls = json.loads(FIXTURE.read_text())["controls"]
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        response = client.post(
            "/api/controls/dynamic",
            json={"prompt": "A glass bird", "controls": controls},
        )
        assert response.status_code == 200
        body = response.json()
        assert body["controls"][: len(controls)] == controls
        assert body["controls"][-1]["kind"] == "single-select"
        assert body["dynamic_controls_metadata"]["provider"] == "mock"
        assert client.post("/api/controls/dynamic", json={}).status_code == 400


@pytest.mark.parametrize(
    "changes",
    [
        {"controls": []},
        {"prompt": " "},
        {"dimensions": "bad"},
        {"dimensions": "9999x9999"},
        {"controls": [{"kind": "binary", "label": "Pattern", "value": 0}]},
    ],
)
def test_canonical_validation(tmp_path, changes):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        payload = {**json.loads(FIXTURE.read_text()), **changes}
        assert client.post("/api/generate-image", json=payload).status_code == 400


def test_disabled_inference_and_missing_job(tmp_path):
    with TestClient(
        create_app(
            {
                "IMAGEDIALS_DATA_DIR": str(tmp_path),
                "INFERENCE_ENABLED": "false",
                "SHARED_LIBRARY_ENABLED": "false",
            }
        )
    ) as client:
        assert client.get("/healthz").json()["inference_enabled"] is False
        assert client.get("/api/controls/static").status_code == 200
        assert (
            client.get("/api/app-capabilities").json()["history_source"]
            == "browser-private"
        )
        for endpoint in ["generate-image", "controls/dynamic"]:
            assert client.post("/api/" + endpoint, json={}).status_code == 503
        assert client.get("/api/generation-jobs/missing").status_code == 404


def test_all_choice_kinds_resolve_custom_and_object_values():
    controls = [
        {
            "kind": kind,
            "label": kind,
            "options": {"a": {"value": "Amber"}},
            "value": ["a", "custom"] if kind in {"multi-select", "checkbox"} else "a",
        }
        for kind in ["single-select", "dropdown", "radio", "multi-select", "checkbox"]
    ]
    assert [c["value"] for c in resolve_controls(controls)] == [
        "Amber",
        "Amber",
        "Amber",
        ["Amber", "custom"],
        ["Amber", "custom"],
    ]


def test_configured_dimensions_are_exposed_and_validated(tmp_path):
    settings = {
        "IMAGEDIALS_DATA_DIR": str(tmp_path),
        "IMAGE_LANDSCAPE_DIMENSIONS": "600x400",
    }
    with TestClient(create_app(settings)) as client:
        assert (
            client.get("/api/models").json()["supported_dimensions"]["3:2"] == "600x400"
        )
    with pytest.raises(ValueError, match="aspect ratio"):
        create_app({**settings, "IMAGE_LANDSCAPE_DIMENSIONS": "600x500"})


@pytest.mark.parametrize(
    "mode,original_ids",
    [
        ("standard", ["style", "color", "lighting", "composition"]),
        ("trellis", ["material", "finish", "form", "view"]),
    ],
)
def test_expanded_static_catalog_preserves_identity_and_does_not_select_new_constraints(
    tmp_path, mode, original_ids
):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        controls = client.get(
            "/api/controls/static", params={"generation_mode": mode}
        ).json()["controls"]
        assert len(controls) == 8
        assert [control["id"] for control in controls[:4]] == original_ids
        assert len({control["id"] for control in controls}) == len(controls)
        assert all(len(control["options"]) >= 12 for control in controls)
        assert all(
            control["value"] == ([] if control["kind"] == "multi-select" else None)
            for control in controls[4:]
        )
        for control in controls[:4]:
            values = (
                control["value"]
                if control["kind"] == "multi-select"
                else [control["value"]]
            )
            assert values and all(value in control["options"] for value in values)
        assert len(resolve_controls(controls)) == len(controls)


def test_multi_select_fixed_controls_compose_both_values_and_preserve_original_snapshot(
    tmp_path,
):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        standard = client.get("/api/controls/static").json()["controls"]
        by_id = {control["id"]: control for control in standard}
        for identity in (
            "style",
            "color",
            "lighting",
            "texture",
            "mood",
            "composition",
        ):
            assert by_id[identity]["kind"] == "multi-select"
            assert isinstance(by_id[identity]["value"], list)
        for identity in ("camera-angle", "background"):
            assert by_id[identity]["kind"] in {"dropdown", "single-select"}
        assert by_id["camera-angle"]["options"]["wide-shot"] == "Wide shot"
        by_id["color"]["value"] = ["warm", "cool"]
        by_id["lighting"]["value"] = ["rim-light", "moonlight"]
        payload = {
            **json.loads(FIXTURE.read_text()),
            "controls": standard,
            "idempotency_key": "mixed-palette",
        }
        accepted = client.post("/api/generate-image", json=payload)
        assert accepted.status_code == 202
        terminal = wait_for_job(client, accepted.json()["generation_job_id"])
        assert terminal["status"] == "complete"
        saved = terminal["result"]
        assert "Warm" in saved["final_prompt"] and "Cool" in saved["final_prompt"]
        assert (
            "Rim light" in saved["final_prompt"]
            and "Moonlight" in saved["final_prompt"]
        )
        assert saved["original_selected_controls"] == standard
        detail = client.get(f"/api/images/library/record/{saved['image_id']}").json()
        color = next(
            control
            for control in detail["selected_controls"]
            if control["id"] == "color"
        )
        assert color["value"] == ["warm", "cool"]
        # Older single-choice snapshots are still valid independent wire data.
        legacy_color = {**by_id["color"], "kind": "single-select", "value": "warm"}
        legacy = {
            **payload,
            "controls": [legacy_color],
            "idempotency_key": "historical-palette",
        }
        accepted = client.post("/api/generate-image", json=legacy)
        result = wait_for_job(client, accepted.json()["generation_job_id"])["result"]
        assert result["original_selected_controls"] == [legacy_color]


def test_asset_attributes_allow_mixed_materials_and_surface_treatments(tmp_path):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        controls = client.get("/api/controls/static?generation_mode=trellis").json()[
            "controls"
        ]
        by_id = {control["id"]: control for control in controls}
        for identity in (
            "material",
            "finish",
            "form",
            "color",
            "surface-detail",
            "construction",
            "lighting",
        ):
            assert by_id[identity]["kind"] == "multi-select"
            assert isinstance(by_id[identity]["value"], list)
        assert by_id["view"]["kind"] == "dropdown"
        assert by_id["view"]["options"]["wide-shot"] == "Wide shot"


def test_unknown_job_matches_canonical_error_contract_without_changing_legacy(tmp_path):
    shared = json.loads((FIXTURE.parent / "m1.json").read_text())["errors"]["not_found"]
    with TestClient(
        create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path), "APP_BASE_PATH": "/studio"})
    ) as client:
        for prefix in ["/api", "", "/studio/api", "/studio"]:
            response = client.get(prefix + "/generation-jobs/missing")
            assert response.status_code == 404
            assert response.json() == shared == {"error": "Generation job not found"}
        assert client.get("/api/generations/missing").json() == {
            "detail": "Generation not found"
        }
