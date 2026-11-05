import json
from pathlib import Path

import pytest
from app.main import create_app
from app.prompt_strategies import QWEN_IMAGE_21, reference_prompt_strategy
from app.providers import PromptComposer
from fastapi.testclient import TestClient
from test_reference_analysis import client_for, ordered_context, post_prompt

FIXTURE = json.loads(
    (
        Path(__file__).resolve().parents[2] / "fixtures/api/image-editing.json"
    ).read_text()
)


def test_qwen_labels_follow_actual_numeric_order_and_single_image_is_natural():
    assert QWEN_IMAGE_21.labels(1) == ["the image"]
    assert QWEN_IMAGE_21.labels(3) == ["<image1>", "<image2>", "<image3>"]
    assert QWEN_IMAGE_21.marker(1, 1) is None
    assert QWEN_IMAGE_21.marker(2, 2) == "<image2>"
    rules = QWEN_IMAGE_21.proposal_rules + QWEN_IMAGE_21.composition_rules
    assert "<image1>" in rules
    text = QWEN_IMAGE_21.deterministic_proposal(
        "Put the lamp on the table",
        [{"description": "A room"}, {"description": "A brass lamp"}],
    )
    assert text.startswith("Put the lamp on the table. Edit <image1> using <image2>.")
    assert "Preserve everything in <image1>" in text
    for wrong in ("<reference_1>", "Picture 1", "<Picture"):
        assert wrong not in text
    single = QWEN_IMAGE_21.deterministic_proposal("", [{"description": "A cat"}])
    assert "<image" not in single and "the image" in single


def test_strategy_selection_is_validated():
    assert reference_prompt_strategy({}) is QWEN_IMAGE_21
    assert reference_prompt_strategy({"IMAGE_EDIT_PROMPT_STRATEGY": "qwen-image-2.1"})
    with pytest.raises(ValueError, match="IMAGE_EDIT_PROMPT_STRATEGY"):
        reference_prompt_strategy({"IMAGE_EDIT_PROMPT_STRATEGY": "h3"})
    with pytest.raises(ValueError):
        create_app({"IMAGE_EDIT_PROMPT_STRATEGY": "unknown"})


def test_capability_publishes_labels_and_guidance(tmp_path):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        prompting = client.get("/api/app-capabilities").json()["image_editing"][
            "prompting"
        ]
    assert prompting == FIXTURE["capabilities"]["prompting"]
    assert prompting["labels"]["2"] == ["<image1>", "<image2>"]
    assert "{1}" in prompting["example_single"]
    assert "{2}" in prompting["example_multiple"]


def test_base_and_new_reference_proposal_uses_both_in_order(tmp_path, monkeypatch):
    with client_for(
        tmp_path, monkeypatch, IMAGE_DESCRIPTION_PROVIDER="mock", IMAGE_PROVIDER="mock"
    ) as client:
        response = post_prompt(
            client, ordered_context(2, "Keep the base layout and change the color.")
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert (
            "<image1>" in body["suggested_prompt"]
            and "<image2>" in body["suggested_prompt"]
        )
        assert body["reference_count"] == 2
        assert body["metadata"]["prompt"]["provider"] == "mock"
        assert body["prompt_strategy"] == "qwen-image-2.1"


def test_composer_labels_references_with_the_strategy():
    composer = PromptComposer({})
    from app.domain import PromptDraft

    draft = PromptDraft(
        prompt="Swap the lamp",
        reference_context=[
            {"id": "a", "description": "Room", "role": "base"},
            {"id": "b", "description": "Lamp", "role": "reference"},
        ],
    )
    prompt, metadata = composer.compose(draft, [])
    assert prompt.startswith("Edit <image1>, <image2>:")
    assert [row["label"] for row in metadata["reference_images"]] == [
        "<image1>",
        "<image2>",
    ]


def test_label_problem_rejects_natural_multi_image_prose_and_wrong_styles():
    problem = QWEN_IMAGE_21.label_problem
    assert problem("Put the lamp from the second image on the base image", 2)
    assert problem("Edit <Image1> using <image2>", 2)
    assert problem("Edit < image1 > using <image2>", 2)
    assert problem("Edit <image1> using <reference_2>", 2)
    assert problem("Edit <image1> using Picture 2 and <image2>", 2)
    assert problem("Edit <image1> <image2> <image3>", 2)
    assert problem("Edit <image1>", 1)
    assert problem("Put the lamp from <image2> in <image1>", 2) is None
    assert problem("Recolor the jacket in the image", 1) is None


PROSE = "Place the lamp from the second image on the table in the base image."
VALID = "Place the lamp from <image2> on the table in <image1>. Keep everything else in <image1>."


def proposal_client(tmp_path, monkeypatch, answers):
    from app.creation import CreationToolsProvider

    calls = []

    def compose(self, instructions, data, *, schema=None, jpeg=None):
        calls.append((instructions, data))
        return {"suggested_prompt": answers[len(calls) - 1]}

    monkeypatch.setattr(CreationToolsProvider, "generate_json", compose)
    client = client_for(
        tmp_path,
        monkeypatch,
        IMAGE_DESCRIPTION_PROVIDER="mock",
        IMAGE_PROVIDER="mock",
        LLM_MODEL_ENDPOINT_1="https://llm.example.invalid/v1",
        LLM_MODEL_NAME="fixture-model",
    )
    return client, calls


CONTEXT = {
    "prompt": "Put the lamp on the table",
    "reference_images": [{"id": "base", "description": "A room", "role": "base"}],
}


def test_proposal_without_markers_gets_one_corrective_retry(tmp_path, monkeypatch):
    client, calls = proposal_client(tmp_path, monkeypatch, [PROSE, VALID])
    with client:
        response = post_prompt(client, ordered_context(2, CONTEXT["prompt"]))
    assert response.status_code == 200, response.text
    assert response.json()["suggested_prompt"] == VALID
    assert len(calls) == 2
    first, second = calls
    assert first[1]["required_labels"] == ["<image1>", "<image2>"]
    assert "<image2>" in first[1]["label_example"]
    assert "rejected" in second[0] and "<image1>, <image2>" in second[0]


def test_proposal_still_invalid_after_retry_warns_without_failing(
    tmp_path, monkeypatch
):
    client, calls = proposal_client(tmp_path, monkeypatch, [PROSE, PROSE])
    with client:
        response = post_prompt(client, ordered_context(2, CONTEXT["prompt"]))
    # The reference is valid; only the optional suggestion is dropped, honestly.
    assert response.status_code == 200
    body = response.json()
    assert body["suggested_prompt"] is None
    assert body["reference_count"] == 2
    assert "<image1>" in body["warnings"][0]["detail"]
    assert len(calls) == 2


def composer_with(monkeypatch, answers):
    from app import providers
    from app.domain import PromptDraft

    calls = []
    composer = PromptComposer({"LLM_MODEL_ENDPOINT_1": "http://provider.invalid"})
    monkeypatch.setattr(composer, "model_id", lambda: "fixture-model")
    monkeypatch.setattr(composer, "visual_keywords", lambda _: {"keywords": []})

    def respond(_base, _path, body, **_kwargs):
        calls.append(json.loads(json.dumps(body)))
        return {"choices": [{"message": {"content": answers[len(calls) - 1]}}]}

    monkeypatch.setattr(providers, "request", respond)
    draft = PromptDraft(
        prompt=VALID,
        reference_context=[
            {"id": "a", "description": "Room", "role": "base"},
            {"id": "b", "description": "Lamp", "role": "reference"},
        ],
    )
    return composer, draft, calls


def test_composer_cannot_silently_erase_valid_markers(monkeypatch):
    composer, draft, calls = composer_with(monkeypatch, [PROSE, VALID])
    prompt, metadata = composer.compose(draft, [])
    assert prompt == VALID
    assert metadata["label_retry"] is True
    sent = json.loads(calls[0]["messages"][1]["content"])
    assert sent["required_labels"] == ["<image1>", "<image2>"]
    assert "Rejected" in calls[1]["messages"][-1]["content"]

    from app.providers import ProviderError

    composer, draft, calls = composer_with(monkeypatch, [PROSE, PROSE])
    with pytest.raises(ProviderError, match="image labels"):
        composer.compose(draft, [])
    assert len(calls) == 2
