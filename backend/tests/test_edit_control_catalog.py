"""Editing instructions are explicit opt-ins; historical snapshots stay intact."""

import copy
import json
from pathlib import Path

from app.domain import Generation
from app.edit_control_catalog import edit_controls
from app.main import create_app
from app.providers import PromptComposer
from app.wire import resolve_controls
from fastapi.testclient import TestClient

FIXTURE = json.loads(
    (Path(__file__).parents[2] / "fixtures/api/edit-controls.json").read_text()
)


def test_edit_catalog_is_distinct_empty_and_available_without_inference(tmp_path):
    with TestClient(
        create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path), "INFERENCE_ENABLED": "false"})
    ) as client:
        text = client.get("/api/controls/static").json()["controls"]
        for mode in ("standard", "trellis"):
            response = client.get(
                "/api/controls/static",
                params={"generation_mode": mode, "image_edit": True},
            )
            assert response.status_code == 200
            assert response.json() == FIXTURE
    controls = FIXTURE["controls"]
    assert len(controls) == 6
    assert not {c["id"] for c in text} & {c["id"] for c in controls}
    assert all(c["apply_to_edit"] is False and c["value"] in ([], "") for c in controls)
    assert all(
        c.type in {"multi", "text"} and c.origin == "fixed" for c in edit_controls()
    )


def test_opt_in_instructions_resolve_without_provider_parameters_or_snapshot_mutation():
    controls = copy.deepcopy(FIXTURE["controls"])
    controls[0].update(
        value=["facial-features"], apply_to_edit=True, future={"retained": True}
    )
    controls[-1].update(value="Warm reflected light", apply_to_edit=True)
    before = copy.deepcopy(controls)
    resolved = resolve_controls(controls, for_edit=True)
    assert controls == before
    assert resolved[0]["value"] == ["Facial features"]
    assert resolved[-1]["value"] == "Warm reflected light"
    # The existing composer filters off controls. No model call or runtime change.
    references = [
        {
            "id": "base",
            "sha256": "a" * 64,
            "description": "Original",
            "role": "base",
            "filename": "base.png",
            "index": 1,
            "dimensions": {"width": 64, "height": 96},
            "content_type": "image/png",
        }
    ]
    draft = Generation(
        prompt="Warm the light",
        idempotency_key="edit-catalog-test",
        selected_controls=controls,
        resolved_controls=resolved,
        reference_images=references,
    )
    prompt, metadata = PromptComposer({}).compose(draft, [])
    assert "Warm reflected light" in prompt and "Facial features" in prompt
    assert "Preserve pose" not in prompt and "Background change" not in prompt
    assert metadata["provider"] == "mock"


def test_legacy_edit_controls_keep_unknown_fields_and_explicit_flags():
    old = {
        "id": "style",
        "label": "Style",
        "kind": "single-select",
        "value": "custom",
        "options": {"custom": {"label": "Personal", "value": "Soft ink"}},
        "apply_to_edit": True,
        "future": {"opaque": [1, 2]},
    }
    original = copy.deepcopy(old)
    assert resolve_controls([old], for_edit=True)[0]["value"] == "Soft ink"
    assert old == original
