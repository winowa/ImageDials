"""Earlier controls compose from their wires, independently of newer raw evidence."""

import copy
import json

import pytest
from app import providers
from app.domain import Generation
from app.providers import PromptComposer
from app.wire import resolve_controls
from control_fixtures import load_fixture

FIXTURE = load_fixture("retained-controls.json")


@pytest.mark.parametrize("for_edit", [False, True])
@pytest.mark.parametrize("new_metadata", [None, FIXTURE["new_metadata"]])
def test_composer_resolves_earlier_controls_without_matching_dynamic_metadata(
    monkeypatch, for_edit, new_metadata
):
    controls = copy.deepcopy(FIXTURE["controls"])
    before = copy.deepcopy(controls)
    composer = PromptComposer({"LLM_MODEL_ENDPOINT_1": "http://provider.invalid"})
    monkeypatch.setattr(composer, "model_id", lambda: "fixture-model")
    monkeypatch.setattr(composer, "visual_keywords", lambda _: {"keywords": []})
    calls = []

    def respond(_base, _path, payload, **_kwargs):
        calls.append(payload)
        return {
            "choices": [{"message": {"content": "Preserve the shape of the image."}}]
        }

    monkeypatch.setattr(providers, "request", respond)
    draft = Generation(
        prompt="A ceramic bowl",
        idempotency_key="earlier-controls",
        selected_controls=controls,
        resolved_controls=resolve_controls(controls, for_edit=for_edit),
        dynamic_controls_metadata=new_metadata,
        reference_context=(
            [{"id": "source", "role": "base", "description": "A ceramic bowl"}]
            if for_edit
            else []
        ),
    )
    composer.compose(draft, [])
    assert len(calls) == 1
    selections = json.loads(calls[0]["messages"][1]["content"])["selected_controls"]
    assert selections[0]["value"] == ["Amber outer glaze", "Cobalt inner glaze"]
    assert selections[1]["value"] is False
    assert selections[1]["display_value"] == "Smooth interior"
    assert not any(row["label"] == "Unused lettering" for row in selections)
    assert any(row["label"] == "Source pattern" for row in selections) != for_edit
    assert "New shape" not in json.dumps(calls)
    assert "selection_provenance" not in json.dumps(calls)
    assert controls == before
    assert draft.selected_controls == before
    assert draft.dynamic_controls_metadata == new_metadata
