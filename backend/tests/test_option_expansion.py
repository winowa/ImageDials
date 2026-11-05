"""Each explicit expansion appends exactly five distinct, alphabetized choices."""

import copy

import pytest
from app.creation import EXPANSION_MAX_ATTEMPTS, CreationToolsProvider, option_identity
from app.main import create_app
from app.providers import ProviderError
from fastapi.testclient import TestClient

CONTROL = {
    "id": "surface",
    "kind": "multi-select",
    "label": "Surface",
    "value": ["rough"],
    "options": {"rough": {"value": "Rough stone", "description": "Irregular"}},
    "extension": {"zero": 0, "false": False},
}


def test_repeated_expansions_append_batches_without_reordering_existing_choices(
    tmp_path,
):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        current = copy.deepcopy(CONTROL)
        for _ in range(4):
            before = copy.deepcopy(current)
            response = client.post("/api/add-control-options", json=current)
            assert response.status_code == 200
            current = response.json()
            previous_keys = list(before["options"])
            keys = list(current["options"])
            assert keys[: len(previous_keys)] == previous_keys
            assert len(keys) == len(previous_keys) + 5
            assert {key: current["options"][key] for key in previous_keys} == before[
                "options"
            ]
            labels = [value["value"] for value in current["options"].values()]
            assert len({option_identity(label) for label in labels}) == len(labels)
            batch = labels[-5:]
            assert batch == sorted(batch, key=str.casefold)
            assert current["value"] == CONTROL["value"]
            assert current["extension"] == CONTROL["extension"]


def test_partial_model_results_retry_only_missing_choices_and_preserve_input(
    monkeypatch,
):
    calls = []
    responses = iter(
        [
            {
                "options": {
                    "different-key": "ROUGH-STONE",
                    "ROUGH": "Do not replace the existing key",
                    "bad": {"value": 0},
                    "new": "Zulu finish",
                    "same-label": "zulu finish",
                }
            },
            {
                "options": {
                    "amber": "Ámber finish",
                    "beta": "Beta finish",
                    "delta": "Delta finish",
                    "echo": "Echo finish",
                    "extra": "Not needed sixth choice",
                }
            },
        ]
    )

    def generate(self, instructions, body, **kwargs):
        assert kwargs["schema"]["properties"]["options"]["minItems"] in {4, 5}
        calls.append((instructions, copy.deepcopy(body)))
        return next(responses)

    monkeypatch.setattr(CreationToolsProvider, "generate_json", generate)
    provider = CreationToolsProvider({"LLM_MODEL_ENDPOINT_1": "http://localhost"})
    source = copy.deepcopy(CONTROL)
    expanded = provider.expand_options(
        source, [{"label": "Lighting", "kind": "multi-select"}]
    )
    assert source == CONTROL
    assert list(expanded["options"])[1:] == ["amber", "beta", "delta", "echo", "new"]
    assert expanded["value"] == ["rough"]
    assert "exactly 5" in calls[0][0] and "exactly 4" in calls[1][0]
    assert calls[1][1]["control"]["options"]["new"] == "Zulu finish"
    assert calls[1][1]["control"]["options"]["rough"] == CONTROL["options"]["rough"]
    assert calls[0][1]["categories"] == [{"label": "Lighting", "kind": "multi-select"}]
    assert all("one and only one" not in instructions for instructions, _ in calls)


@pytest.mark.parametrize(
    "result", [{}, {"options": []}, {"options": {"again": "rough stone"}}]
)
def test_incomplete_or_duplicate_provider_output_fails_after_a_bounded_attempt_count(
    monkeypatch, result
):
    calls = []

    def generate(*args, **kwargs):
        calls.append(args)
        return result

    monkeypatch.setattr(CreationToolsProvider, "generate_json", generate)
    provider = CreationToolsProvider({"LLM_MODEL_ENDPOINT_1": "http://localhost"})
    original = copy.deepcopy(CONTROL)
    with pytest.raises(ProviderError, match="5 distinct"):
        provider.expand_options(original)
    assert len(calls) == EXPANSION_MAX_ATTEMPTS
    assert original == CONTROL


def test_typed_rows_are_normalized_without_exposing_the_model_envelope(monkeypatch):
    def generate(self, instructions, body, *, schema):
        assert schema["properties"]["options"]["minItems"] == 5
        assert schema["properties"]["options"]["maxItems"] == 5
        return {
            "options": [
                {"key": key, "value": value, "description": "A visual finish"}
                for key, value in [
                    ("z", "Zulu"),
                    ("b", "Beta"),
                    ("a", "Alpha"),
                    ("d", "Delta"),
                    ("e", "Echo"),
                ]
            ]
        }

    monkeypatch.setattr(CreationToolsProvider, "generate_json", generate)
    provider = CreationToolsProvider({"LLM_MODEL_ENDPOINT_1": "http://localhost"})
    expanded = provider.expand_options(CONTROL)
    assert list(expanded["options"]) == ["rough", "a", "b", "d", "e", "z"]
    assert "key" not in expanded["options"]["a"]
    assert expanded["options"]["a"]["value"] == "Alpha"
