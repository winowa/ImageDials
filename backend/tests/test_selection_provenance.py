"""Per-control selection_provenance is validated at the boundary and stored losslessly."""

import copy
import io
import json

import pytest
from app.main import create_app
from app.media import PNG_METADATA_KEY
from app.selection_provenance import validate_selection_provenance
from app.wire import resolve_controls
from control_fixtures import load_fixture
from fastapi.testclient import TestClient
from PIL import Image
from test_canonical import wait_for_job

FIXTURE = load_fixture("selection-provenance.json")


@pytest.mark.parametrize("case", FIXTURE["valid"], ids=lambda c: c["name"])
def test_valid_records_pass(case):
    validate_selection_provenance(case["provenance"])


@pytest.mark.parametrize("case", FIXTURE["invalid"], ids=lambda c: c["name"])
def test_invalid_records_are_rejected(case):
    with pytest.raises(ValueError):
        validate_selection_provenance(case["provenance"])


def test_resolution_ignores_provenance_but_never_sends_it_to_composition():
    controls = FIXTURE["generate_request"]["controls"]
    before = copy.deepcopy(controls)
    resolved = resolve_controls(controls)
    assert controls == before  # input is not mutated
    assert "selection_provenance" not in json.dumps(resolved)
    assert "x_future_field" not in json.dumps(resolved)
    off = next(row for row in resolved if row["label"] == "Camera angle")
    assert off == {
        "kind": "single-select",
        "label": "Camera angle",
        "value": "eye-level",
        "apply_to_generation": False,
    }
    empty = next(row for row in resolved if row["label"] == "Mood")
    assert empty["value"] == []
    # Old controls without the field resolve exactly as before.
    legacy = resolve_controls(FIXTURE["legacy_generate_request"]["controls"])
    assert [row["value"] for row in legacy] == [["Photography"], False]


def test_malformed_provenance_is_a_client_error_on_both_endpoints(tmp_path):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        for case in FIXTURE["invalid"]:
            payload = copy.deepcopy(FIXTURE["generate_request"])
            payload["controls"][0]["selection_provenance"] = case["provenance"]
            assert client.post("/api/generate-image", json=payload).status_code == 400
            dynamic = client.post(
                "/api/controls/dynamic",
                json={"prompt": "A barn owl", "controls": payload["controls"]},
            )
            assert dynamic.status_code == 400


def test_provenance_survives_request_snapshot_record_and_png(tmp_path):
    payload = {
        **copy.deepcopy(FIXTURE["generate_request"]),
        "idempotency_key": "provenance",
    }
    settings = {"IMAGEDIALS_DATA_DIR": str(tmp_path)}
    with TestClient(create_app(settings)) as client:
        accepted = client.post("/api/generate-image", json=payload)
        assert accepted.status_code == 202, accepted.text
        job_id = accepted.json()["generation_job_id"]
        status = wait_for_job(client, job_id)
        assert status["status"] == "complete", status
        result = status["result"]
        assert result["original_selected_controls"] == payload["controls"]
        assert (
            result["dynamic_controls_metadata"] == payload["dynamic_controls_metadata"]
        )
        # Composition saw values only; the opaque future provenance and unknown fields stayed out.
        assert "selection_provenance" not in json.dumps(result["resolved_controls"])
        detail = client.get(f"/api/images/library/record/{job_id}").json()
        assert detail["selected_controls"] == payload["controls"]
        assert (
            detail["dynamic_controls_metadata"] == payload["dynamic_controls_metadata"]
        )
        content = client.get(result["image_url"]).content
        with Image.open(io.BytesIO(content)) as image:
            embedded = json.loads(image.info[PNG_METADATA_KEY])["image"]
        assert embedded["selected_controls"] == payload["controls"]
        assert (
            embedded["dynamic_controls_metadata"]
            == payload["dynamic_controls_metadata"]
        )
    # A restarted app reads the same stored snapshot.
    with TestClient(create_app(settings)) as client:
        again = client.get(f"/api/generation-jobs/{job_id}").json()["result"]
        assert again["original_selected_controls"] == payload["controls"]


def test_records_without_provenance_remain_valid(tmp_path):
    payload = {
        **copy.deepcopy(FIXTURE["legacy_generate_request"]),
        "idempotency_key": "old",
    }
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        job_id = client.post("/api/generate-image", json=payload).json()[
            "generation_job_id"
        ]
        result = wait_for_job(client, job_id)["result"]
        assert result["original_selected_controls"] == payload["controls"]
        assert "selection_provenance" not in json.dumps(
            result["original_selected_controls"]
        )
        assert client.get(f"/api/images/library/record/{job_id}").status_code == 200
