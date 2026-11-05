"""A disabled Standard category retains its snapshot but is not a model instruction."""

import io
import json
from pathlib import Path

import pytest
from app import providers
from app.domain import Generation
from app.main import create_app
from app.media import PNG_METADATA_KEY
from app.providers import PromptComposer
from app.wire import resolve_controls
from fastapi.testclient import TestClient
from PIL import Image
from test_reference_generation import finish

FIXTURE = json.loads(
    (Path(__file__).parents[2] / "fixtures/api/control-application.json").read_text()
)


def test_disabled_category_is_excluded_from_mock_composition_but_saved_losslessly(
    tmp_path,
):
    controls = FIXTURE["controls"]
    body = {
        "prompt": "A small teal sphere",
        "controls": controls,
        "dimensions": "96x64",
        "idempotency_key": "disabled-standard",
    }
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        assert (
            client.get("/api/app-capabilities").json()["control_application"]
            == FIXTURE["capability"]
        )
        response = client.post("/api/generate-image", json=body)
        assert response.status_code == 202, response.text
        terminal = finish(client, response.json()["generation_job_id"])
        assert terminal["status"] == "complete", terminal
        result = terminal["result"]
        assert result["original_selected_controls"] == controls
        assert result["resolved_controls"] == FIXTURE["resolved_controls"]
        assert "Golden sunlight" not in result["final_prompt"]
        assert '"Lighting"' not in result["final_prompt"]
        assert '"Gloss"' in result["final_prompt"]
        encoded = client.get(result["image_url"]).content
        with Image.open(io.BytesIO(encoded)) as image:
            metadata = json.loads(image.info[PNG_METADATA_KEY])["image"]
        assert metadata["selected_controls"] == controls


def test_native_composer_never_receives_disabled_values(monkeypatch):
    composer = PromptComposer({"LLM_MODEL_ENDPOINT_1": "http://provider.invalid"})
    monkeypatch.setattr(composer, "model_id", lambda: "fixture-model")
    monkeypatch.setattr(composer, "visual_keywords", lambda _: {"keywords": []})
    calls = []

    def respond(_base, _path, body, **_kwargs):
        calls.append(body)
        return {"choices": [{"message": {"content": "A small matte teal sphere."}}]}

    monkeypatch.setattr(providers, "request", respond)
    controls = FIXTURE["controls"]
    draft = Generation(
        prompt="A teal sphere",
        idempotency_key="composer",
        selected_controls=controls,
        resolved_controls=resolve_controls(controls),
    )
    composer.compose(draft, [])
    payload = json.loads(calls[0]["messages"][1]["content"])
    assert payload["selected_controls"] == [
        {"kind": "binary", "label": "Gloss", "value": False, "display_value": "No"}
    ]
    assert "Golden sunlight" not in json.dumps(calls)
    assert "Lighting" not in json.dumps(calls)


def test_unused_invalid_value_is_kept_but_enabling_it_requires_valid_value(tmp_path):
    control = {
        "id": "amount",
        "kind": "slider",
        "label": "Amount",
        "value": "automatic",
        "apply_to_generation": False,
    }
    assert resolve_controls([control]) == [
        {
            "kind": "slider",
            "label": "Amount",
            "value": "automatic",
            "apply_to_generation": False,
        }
    ]
    with pytest.raises(ValueError, match="finite number"):
        resolve_controls([{**control, "apply_to_generation": True}])
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        response = client.post(
            "/api/generate-image",
            json={
                "prompt": "A blue sphere",
                "controls": [control],
                "dimensions": "96x64",
                "idempotency_key": "all-disabled",
            },
        )
        assert response.status_code == 202, response.text
        terminal = finish(client, response.json()["generation_job_id"])
        assert terminal["status"] == "complete", terminal
        assert "automatic" not in terminal["result"]["final_prompt"]
        assert terminal["result"]["original_selected_controls"] == [control]


@pytest.mark.parametrize("flag", ["false", 0, 1, None, []])
def test_application_flag_must_be_boolean(flag):
    with pytest.raises(ValueError, match="boolean"):
        resolve_controls([{**FIXTURE["controls"][0], "apply_to_generation": flag}])


def test_legacy_controls_are_enabled_and_edit_application_is_independent():
    control = {"kind": "binary", "label": "Gloss", "value": False}
    assert resolve_controls([control]) == [control]
    text_disabled = {**control, "apply_to_generation": False, "apply_to_edit": True}
    assert resolve_controls([text_disabled], for_edit=True) == [
        {**control, "apply_to_edit": True}
    ]
    assert resolve_controls([{**control, "apply_to_edit": False}], for_edit=True) == [
        {**control, "apply_to_edit": False}
    ]
