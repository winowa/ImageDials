"""Public model descriptors are data, never a discovery or inference request."""

import json
from pathlib import Path

import pytest
from app import providers
from app.main import create_app
from app.model_metadata import (
    MAX_MODEL_METADATA_BYTES,
    MAX_MODEL_METADATA_ENTRIES,
    model_metadata,
)
from fastapi.testclient import TestClient
from test_browser_settings import headers

FIXTURE = json.loads(
    (
        Path(__file__).resolve().parents[2] / "fixtures/api/model-metadata.json"
    ).read_text()
)


def test_model_resources_use_exact_configured_names_without_provider_calls(
    tmp_path, monkeypatch
):
    def unexpected(*args, **kwargs):
        pytest.fail("Reading model resources must not contact a provider")

    monkeypatch.setattr(providers, "request", unexpected)
    env = {
        "IMAGEDIALS_DATA_DIR": str(tmp_path),
        "APP_BASE_PATH": "/studio",
        "IMAGE_MODEL_NAME": FIXTURE["image_model"],
        "LLM_MODEL_NAME": FIXTURE["llm_model"],
        "MODEL_METADATA_JSON": json.dumps(FIXTURE["metadata"]),
    }
    with TestClient(create_app(env)) as client:
        for prefix in ("/api", "", "/studio/api", "/studio"):
            response = client.get(prefix + "/models")
            assert response.status_code == 200
            assert response.json()["models"] == FIXTURE["models"]
            assert response.json()["image_model"] == FIXTURE["image_model"]
        custom = client.get(
            "/api/models", headers=headers({"LLM_MODEL_NAME": "AnotherLanguage-v1"})
        ).json()["models"]["llm"]
        assert custom["name"] == "AnotherLanguage-v1"
        assert custom["publisher"] is None and custom["url"] is None
        assert client.get("/api/models").json()["models"] == FIXTURE["models"]


@pytest.mark.parametrize("raw", [None, "", "{}"])
def test_missing_metadata_keeps_optional_fields_empty(raw):
    assert model_metadata({"MODEL_METADATA_JSON": raw}) == {}


@pytest.mark.parametrize(
    "value",
    [
        [],
        {"": {}},
        {"example": []},
        {"example": {"api_key": "must-not-appear"}},
        {"example": {"publisher": False}},
        {"example": {"detail": "x" * 2001}},
        {"example": {"url": "javascript:alert(1)"}},
        {"example": {"url": "data:text/plain,example"}},
        {"example": {"url": "//models.example.test/model"}},
        {
            "example": {
                "url": "https://" + "user:must-not-appear" + "@models.example.test"
            }
        },
        {"example": {"url": "https://models.example.test/invalid path"}},
        {"example": {"url": "https://models.example.test/invalid\u0000path"}},
        {"example": {"url": "https://models.example.test:70000/model"}},
        {"example": {"url": "https://[invalid/model"}},
        {"example": {"detail": "\ud800"}},
    ],
)
def test_invalid_public_metadata_fails_startup_without_echoing_values(tmp_path, value):
    with pytest.raises(ValueError) as error:
        create_app(
            {
                "IMAGEDIALS_DATA_DIR": str(tmp_path),
                "MODEL_METADATA_JSON": json.dumps(value),
            }
        )
    assert "must-not-appear" not in str(error.value)


def test_metadata_document_and_entry_limits():
    with pytest.raises(ValueError):
        model_metadata({"MODEL_METADATA_JSON": " " * (MAX_MODEL_METADATA_BYTES + 1)})
    with pytest.raises(ValueError):
        model_metadata(
            {
                "MODEL_METADATA_JSON": json.dumps(
                    {str(i): {} for i in range(MAX_MODEL_METADATA_ENTRIES + 1)}
                )
            }
        )


def test_invalid_json_and_trimmed_nullable_fields():
    with pytest.raises(ValueError):
        model_metadata({"MODEL_METADATA_JSON": "not-json"})
    assert model_metadata(
        {
            "MODEL_METADATA_JSON": json.dumps(
                {"example": {"publisher": "  Example  ", "detail": " ", "url": None}}
            )
        }
    ) == {"example": {"publisher": "Example", "detail": None, "url": None}}
