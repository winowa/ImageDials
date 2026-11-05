import json
from types import SimpleNamespace

import pytest
from app import providers
from app.domain import ASSET_IMAGE_INSTRUCTIONS, PromptDraft, choices, compose


def test_asset_mock_composition_prioritizes_isolation_after_conflicting_controls():
    draft = PromptDraft(prompt="A ceramic fox in a forest", mode="asset-image")
    prompt = compose(draft, [choices("Background", ["Forest"])])
    assert prompt.endswith(ASSET_IMAGE_INSTRUCTIONS)
    assert "Background: Forest" in prompt
    assert "black, neutral gray, or white" in prompt
    assert "contrasts most" in prompt
    assert "fully visible" in prompt
    assert "No scenery, floor, horizon, gradients, cast shadows" in prompt
    assert ASSET_IMAGE_INSTRUCTIONS not in compose(PromptDraft(prompt=draft.prompt), [])


@pytest.mark.parametrize("references", [False, True])
@pytest.mark.parametrize("resolved", [None, []])
def test_mock_asset_constraint_applies_only_without_reference_edits(
    references, resolved
):
    draft = SimpleNamespace(
        prompt="A ceramic fox",
        mode="asset-image",
        reference_context=(
            [SimpleNamespace(role="base", description="A fox")] if references else []
        ),
        resolved_controls=resolved,
    )
    prompt, _ = providers.PromptComposer({}).compose(draft, [])
    assert prompt.count(ASSET_IMAGE_INSTRUCTIONS) == (0 if references else 1)
    assert prompt.endswith(ASSET_IMAGE_INSTRUCTIONS) is (not references)
    assert draft.mode == "asset-image"
    if references:
        assert prompt.startswith("Edit the supplied image:")


@pytest.mark.parametrize("references", [False, True])
@pytest.mark.parametrize("mode", ["image", "asset-image"])
def test_asset_llm_rules_never_override_reference_editing(
    monkeypatch, references, mode
):
    calls = []

    def respond(base, path, payload=None, **kwargs):
        calls.append(payload)
        return {
            "choices": [
                {
                    "message": {
                        "content": "Isolate the fox in the image on solid white."
                    },
                    "finish_reason": "stop",
                }
            ]
        }

    monkeypatch.setattr(providers, "request", respond)
    draft = PromptDraft(
        prompt="A ceramic fox",
        mode=mode,
        reference_context=(
            [{"id": "base", "role": "base", "description": "A fox"}]
            if references
            else []
        ),
    )
    composer = providers.PromptComposer(
        {"LLM_MODEL_ENDPOINT_1": "http://localhost", "LLM_MODEL_NAME": "test-model"}
    )
    composer.compose(draft, [])
    instructions = calls[0]["messages"][0]["content"]
    assert (ASSET_IMAGE_INSTRUCTIONS in instructions) == (
        mode == "asset-image" and not references
    )
    assert json.loads(calls[0]["messages"][1]["content"])["mode"] == (
        "image" if references else mode
    )
    assert draft.mode == mode
