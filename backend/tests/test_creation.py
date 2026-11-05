import copy
import json

import pytest
from app import creation, providers
from app.main import create_app
from app.providers import ProviderError
from fastapi.testclient import TestClient

CONTROL = {
    "kind": "single-select",
    "label": "Surface",
    "value": "custom",
    "options": {"rough": {"value": "Rough stone", "description": "Irregular"}},
    "extension": {"zero": 0, "false": False},
}


def test_mock_suggestions_and_bare_control_expansion(tmp_path):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        for mode in ["standard", "trellis"]:
            response = client.get("/api/prompt-suggestions?generation_mode=" + mode)
            assert response.status_code == 200
            body = response.json()
            assert body["provider"] == "mock"
            assert len(body["suggestions"]) == len(set(body["suggestions"])) == 5
            assert all(len(idea.split()) <= 20 for idea in body["suggestions"])
        response = client.post("/api/add-control-options", json=CONTROL)
        assert response.status_code == 200
        control = response.json()
        assert control["value"] == "custom"
        assert control["extension"] == CONTROL["extension"]
        assert control["options"]["rough"] == CONTROL["options"]["rough"]
        assert len(control["options"]) == len(CONTROL["options"]) + 5
        assert (
            client.post(
                "/api/add-control-options", json={"control": CONTROL}
            ).status_code
            == 400
        )
        assert client.post("/api/add-control-options", json={}).status_code == 400


def test_real_adapter_requests_and_preserves_original(monkeypatch):
    calls = []

    def respond(base, path, payload=None, **kwargs):
        calls.append(payload)
        content = {
            "options": {
                "rough": "Do not overwrite",
                "polished": {"value": "Polished stone", "description": "Reflective"},
                "honed": "Honed stone",
                "etched": "Etched stone",
                "tumbled": "Tumbled stone",
                "glazed": "Glazed stone",
            }
        }
        return {
            "choices": [
                {"message": {"content": json.dumps(content)}, "finish_reason": "stop"}
            ]
        }

    monkeypatch.setattr(providers, "request", respond)
    provider = creation.CreationToolsProvider(
        {"LLM_MODEL_ENDPOINT_1": "http://localhost", "LLM_MODEL_NAME": "fixture-model"}
    )
    original = copy.deepcopy(CONTROL)
    result = provider.expand_options(original)
    assert original == CONTROL
    assert result["options"]["rough"] == CONTROL["options"]["rough"]
    assert result["options"]["polished"]["value"] == "Polished stone"
    assert result["value"] == "custom"
    assert json.loads(calls[0]["messages"][1]["content"]) == CONTROL
    assert calls[0]["model"] == "fixture-model"


@pytest.mark.parametrize(
    "suggestions",
    [[], ["Same"] * 5, ["Word " * 21, "B", "C", "D", "E"], ["A", "B", "C", "D", None]],
)
def test_invalid_suggestions_do_not_fall_back(monkeypatch, suggestions):
    monkeypatch.setattr(
        creation.CreationToolsProvider,
        "generate_json",
        lambda *args: {"suggestions": suggestions},
    )
    provider = creation.CreationToolsProvider(
        {"LLM_MODEL_ENDPOINT_1": "http://localhost"}
    )
    with pytest.raises(ProviderError):
        provider.suggestions("standard")


def test_failures_and_disabled_inference(tmp_path, monkeypatch):
    app = create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})
    with TestClient(app) as client:

        def broken(*args):
            raise ProviderError("Provider unavailable")

        monkeypatch.setattr(app.state.creation, "suggestions", broken)
        monkeypatch.setattr(app.state.creation, "expand_options", broken)
        assert client.get("/api/prompt-suggestions").status_code == 502
        assert client.post("/api/add-control-options", json=CONTROL).status_code == 502
        assert client.post("/api/ideas").status_code == 502
    with TestClient(
        create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path), "INFERENCE_ENABLED": "false"})
    ) as client:
        assert client.get("/api/prompt-suggestions").status_code == 503
        assert client.post("/api/add-control-options", json=CONTROL).status_code == 503
        assert client.post("/api/ideas").status_code == 503
        assert (
            client.post("/api/controls", json={"prompt": "A bird"}).status_code == 503
        )


def test_expansion_context_contains_categories_without_other_options_or_type_restriction(
    monkeypatch,
):
    captured = []

    def respond(base, path, payload=None, **kwargs):
        captured.append(payload)
        return {
            "choices": [
                {
                    "message": {
                        "content": json.dumps(
                            {
                                "options": {
                                    "polished": "Polished stone",
                                    "honed": "Honed stone",
                                    "etched": "Etched stone",
                                    "tumbled": "Tumbled stone",
                                    "glazed": "Glazed stone",
                                }
                            }
                        )
                    }
                }
            ]
        }

    monkeypatch.setattr(providers, "request", respond)
    provider = creation.CreationToolsProvider(
        {"LLM_MODEL_ENDPOINT_1": "http://localhost", "LLM_MODEL_NAME": "fixture-model"}
    )
    categories = [
        {
            "id": "light",
            "label": "Lighting",
            "kind": "multi-select",
            "description": "Light sources",
            "value": ["window"],
            "options": {"window": "Do not forward other options"},
            "unknown": "Not category context",
        }
    ]
    original = copy.deepcopy(CONTROL)
    result = provider.expand_options(original, categories)
    assert original == CONTROL and result["extension"] == CONTROL["extension"]
    payload = json.loads(captured[0]["messages"][1]["content"])
    assert payload == {
        "control": CONTROL,
        "categories": [
            {
                "id": "light",
                "label": "Lighting",
                "kind": "multi-select",
                "description": "Light sources",
            }
        ],
    }
    instructions = captured[0]["messages"][0]["content"]
    assert (
        "one and only one" not in instructions and "exactly eight" not in instructions
    )
    assert "do not generate categories" in instructions


def test_context_envelope_and_bare_extension_compatibility(tmp_path):
    from pathlib import Path

    fixture = json.loads(
        (
            Path(__file__).resolve().parents[2] / "fixtures/api/control-context.json"
        ).read_text()
    )
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        expected = fixture["expansion"]
        response = client.post("/api/add-control-options", json=expected["request"])
        assert response.status_code == 200 and response.json() == expected["response"]
        bare = {**CONTROL, "control": {"future": True}, "categories": {"opaque": True}}
        response = client.post("/api/add-control-options", json=bare)
        assert response.status_code == 200
        assert (
            response.json()["control"] == bare["control"]
            and response.json()["categories"] == bare["categories"]
        )


@pytest.mark.parametrize(
    "categories",
    [
        None,
        {},
        [None],
        [{"label": "", "kind": "radio"}],
        [{"label": "Long", "kind": "x" * 81}],
        [{"label": "Known", "kind": "radio"}] * 31,
    ],
)
def test_invalid_context_is_a_clear_client_error(tmp_path, categories):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        assert (
            client.post(
                "/api/add-control-options",
                json={"control": CONTROL, "categories": categories},
            ).status_code
            == 400
        )
        assert (
            client.post(
                "/api/controls/dynamic",
                json={"prompt": "A blue paper circle", "categories": categories},
            ).status_code
            == 400
        )
