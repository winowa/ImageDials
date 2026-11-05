"""Additional categories are bounded, additive and distinct from initial generation."""

import copy
import hashlib
import io
import json
from pathlib import Path

import pytest
from app.additional_controls import MAX_ADDITIONAL_REQUEST_BYTES
from app.creation import CreationToolsProvider
from app.domain import Category, Draft, Generation, choices
from app.main import create_app
from app.media import PNG_METADATA_KEY
from app.providers import ProviderError
from fastapi.testclient import TestClient
from PIL import Image
from test_canonical import wait_for_job

PATH = "/api/controls/additional"


def summaries(controls):
    return [
        {
            key: value
            for key, value in item.items()
            if key in {"id", "label", "kind", "description"}
        }
        for item in controls
    ]


def test_repeated_additions_preserve_existing_controls_and_stop_at_capacity(tmp_path):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        current = client.get("/api/controls/static").json()["controls"]
        original = copy.deepcopy(current)
        request = {
            "prompt": "A ceramic diving helmet",
            "categories": summaries(current),
        }
        first = client.post(PATH, json=request)
        assert first.status_code == 200
        assert len(first.json()["controls"]) == 3
        current += first.json()["controls"]
        second = client.post(PATH, json={**request, "categories": summaries(current)})
        assert second.status_code == 200
        current += second.json()["controls"]
        assert current[: len(original)] == original
        assert len({item["id"] for item in current}) == len(current)
        assert len({item["label"] for item in current}) == len(current)
        assert all(item["origin"] == "generated" for item in current[len(original) :])
        crowded = [
            {"id": f"old-{i}", "label": f"Old category {i}", "kind": "binary"}
            for i in range(28)
        ]
        response = client.post(
            PATH, json={**request, "categories": crowded, "count": 5}
        )
        assert response.status_code == 200 and len(response.json()["controls"]) == 2
        full = crowded + summaries(response.json()["controls"])
        assert (
            client.post(PATH, json={**request, "categories": full}).status_code == 400
        )


def test_provider_context_is_value_free_and_accepts_repeated_kinds(monkeypatch):
    captured = []
    candidates = [
        choices(label, ["Fine", "Medium", "Coarse"], "generated", "multi").model_dump()
        for label in ("Lens etching", "Base wear", "Screw patina")
    ]

    def generate(self, instructions, data, **kwargs):
        captured.append((instructions, data, kwargs["schema"]))
        if "proposed_categories" in data:
            return {"keep_ids": [item["id"] for item in data["proposed_categories"]]}
        return {"categories": candidates}

    monkeypatch.setattr(CreationToolsProvider, "generate_json", generate)
    provider = CreationToolsProvider(
        {"LLM_MODEL_ENDPOINT_1": "http://localhost", "LLM_MODEL_NAME": "fixture-model"}
    )
    context = [
        {
            "id": "lens",
            "label": "Lens position",
            "kind": "slider",
            "value": 0,
            "options": {"secret": "not model context"},
        }
    ]
    controls, metadata = provider.additional_controls(
        Draft(prompt="An antique microscope"), context
    )
    assert len(controls) == 3 and {control.type for control in controls} == {"multi"}
    instructions, data, schema = captured[0]
    assert (
        "one and only one" not in instructions and "exactly eight" not in instructions
    )
    assert data["current_categories"] == [
        {"id": "lens", "label": "Lens position", "kind": "slider"}
    ]
    assert "not model context" not in json.dumps(data)
    array = schema["properties"]["categories"]
    assert "prefixItems" not in array and len(array["items"]["anyOf"]) == 8
    assert metadata["attempts"] == [
        {
            "request": data,
            "response": {"categories": candidates},
            "review": {
                "request": captured[1][1],
                "response": {"keep_ids": [item["id"] for item in candidates]},
            },
        }
    ]


def test_duplicate_and_invalid_proposals_retry_only_missing_categories(monkeypatch):
    calls = []
    one = choices("Rim pattern", ["Fine", "Medium", "Broad"], "generated").model_dump()
    two = Category(
        id="rim-height", label="Rim height", type="range", value=0
    ).model_dump()
    three = Category(
        id="show-seal", label="Visible seal", type="binary", value=False
    ).model_dump()
    duplicate = {**one, "id": "alias", "label": " RIM---PATTERN "}
    responses = iter(({"categories": [one, duplicate, two]}, {"categories": [three]}))

    def generate(self, instructions, data, **kwargs):
        if "proposed_categories" in data:
            return {"keep_ids": [item["id"] for item in data["proposed_categories"]]}
        calls.append(data)
        return next(responses)

    monkeypatch.setattr(CreationToolsProvider, "generate_json", generate)
    provider = CreationToolsProvider(
        {"LLM_MODEL_ENDPOINT_1": "http://localhost", "LLM_MODEL_NAME": "fixture-model"}
    )
    controls, _ = provider.additional_controls(Draft(prompt="A ceramic helmet"), [])
    assert [control.id for control in controls] == [one["id"], two["id"], three["id"]]
    assert calls[1]["count"] == 1
    assert calls[1]["previous_rejections"][0]["id"] == "alias"
    assert [item["id"] for item in calls[1]["current_categories"]] == [
        one["id"],
        two["id"],
    ]


def test_repeated_or_malformed_model_output_never_becomes_a_partial_success(
    monkeypatch,
):
    calls = []

    def invalid(*args, **kwargs):
        calls.append(1)
        return {"categories": [{"id": "bad", "type": "range", "value": False}]}

    monkeypatch.setattr(CreationToolsProvider, "generate_json", invalid)
    provider = CreationToolsProvider({"LLM_MODEL_ENDPOINT_1": "http://localhost"})
    with pytest.raises(ProviderError, match="distinct additional controls"):
        provider.additional_controls(Draft(prompt="A ceramic helmet"), [])
    assert len(calls) == 2


def test_invalid_selection_feedback_can_recover_without_guessing_a_value(monkeypatch):
    candidate = choices(
        "Objective count", ["One", "Two", "Three"], "generated"
    ).model_dump()
    invalid = {**candidate, "value": "3"}
    calls = []

    def generate(self, instructions, data, **kwargs):
        if "proposed_categories" in data:
            return {"keep_ids": [item["id"] for item in data["proposed_categories"]]}
        calls.append(data)
        return {
            "categories": [
                invalid if len(calls) == 1 else {**candidate, "value": "three"}
            ]
        }

    monkeypatch.setattr(CreationToolsProvider, "generate_json", generate)
    provider = CreationToolsProvider(
        {"LLM_MODEL_ENDPOINT_1": "http://localhost", "LLM_MODEL_NAME": "fixture-model"}
    )
    controls, metadata = provider.additional_controls(
        Draft(prompt="A microscope with three objectives"), [], 1
    )
    assert controls[0].value == "three"
    assert "declared option ID" in calls[1]["previous_rejections"][0]["reason"]
    assert len(metadata["attempts"]) == 2


def test_separate_scope_review_discards_synonyms_and_retries_the_missing_count(
    monkeypatch,
):
    slide = choices(
        "Specimen type", ["Plant", "Animal", "Mineral"], "generated"
    ).model_dump()
    count = Category(
        id="lens-count", label="Lens count", type="range", value=3
    ).model_dump()
    key = Category(
        id="key-angle", label="Key angle", type="range", value=0
    ).model_dump()
    generations, reviews = [], []

    def generate(self, instructions, data, **kwargs):
        if "proposed_categories" in data:
            reviews.append(data)
            return {"keep_ids": ["lens-count"] if len(reviews) == 1 else ["key-angle"]}
        generations.append(data)
        return {"categories": [slide, count] if len(generations) == 1 else [key]}

    monkeypatch.setattr(CreationToolsProvider, "generate_json", generate)
    provider = CreationToolsProvider(
        {"LLM_MODEL_ENDPOINT_1": "http://localhost", "LLM_MODEL_NAME": "fixture-model"}
    )
    existing = [
        {
            "id": "slide",
            "label": "Glass slide content",
            "kind": "dropdown",
            "description": "Specimen visible on the slide.",
        }
    ]
    controls, metadata = provider.additional_controls(
        Draft(prompt="A microscope"), existing, 2
    )
    assert [item.id for item in controls] == ["lens-count", "key-angle"]
    assert len(generations) == len(reviews) == 2
    assert generations[1]["count"] == 1
    assert "overlaps" in generations[1]["previous_rejections"][0]["reason"]
    assert metadata["attempts"][0]["review"]["response"] == {"keep_ids": ["lens-count"]}


def test_invalid_scope_review_never_silently_accepts_candidates(monkeypatch):
    candidate = Category(
        id="angle", label="Lens angle", type="range", value=0
    ).model_dump()

    def generate(self, instructions, data, **kwargs):
        return (
            {"keep_ids": ["invented"]}
            if "proposed_categories" in data
            else {"categories": [candidate]}
        )

    monkeypatch.setattr(CreationToolsProvider, "generate_json", generate)
    provider = CreationToolsProvider(
        {"LLM_MODEL_ENDPOINT_1": "http://localhost", "LLM_MODEL_NAME": "fixture-model"}
    )
    with pytest.raises(ProviderError, match="scope review"):
        provider.additional_controls(Draft(prompt="A microscope"), [], 1)


@pytest.mark.parametrize(
    "body",
    [
        None,
        [],
        {},
        {"prompt": ""},
        {"prompt": "Cup", "categories": "bad"},
        {"prompt": "Cup", "categories": [], "count": False},
        {"prompt": "Cup", "categories": [], "count": 0},
        {"prompt": "Cup", "categories": [], "count": 6},
    ],
)
def test_invalid_addition_request_is_rejected_before_inference(
    tmp_path, monkeypatch, body
):
    calls = []
    monkeypatch.setattr(
        CreationToolsProvider, "generate_json", lambda *args, **kwargs: calls.append(1)
    )
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        assert client.post(PATH, json=body).status_code == 400
        assert not calls


def test_addition_limits_disabled_inference_and_provider_failures_are_explicit(
    tmp_path, monkeypatch
):
    request = {"prompt": "A ceramic helmet", "categories": []}
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        assert (
            client.post(
                PATH, content=b" " * (MAX_ADDITIONAL_REQUEST_BYTES + 1)
            ).status_code
            == 413
        )

        def failed(*args):
            raise ProviderError("Owned provider failure")

        monkeypatch.setattr(client.app.state.creation, "additional_controls", failed)
        assert client.post(PATH, json=request).status_code == 502
    with TestClient(
        create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path), "INFERENCE_ENABLED": "false"})
    ) as client:
        assert client.post(PATH, json=request).status_code == 503


def test_addition_provenance_survives_generation_png_and_library_without_changing_initial_metadata(
    tmp_path,
):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        result = client.post(
            PATH, json={"prompt": "A ceramic helmet", "categories": []}
        ).json()
        initial = {"opaque": {"false": False, "zero": 0}}
        additions = [
            {
                **result["additional_controls_metadata"],
                "unknown": {"false": False, "zero": 0},
            }
        ]
        request = {
            "prompt": "A ceramic helmet",
            "controls": result["controls"],
            "dimensions": "1152x768",
            "idempotency_key": "additional-provenance",
            "dynamic_controls_metadata": initial,
            "additional_controls_metadata": additions,
        }
        accepted = client.post("/api/generate-image", json=request)
        assert accepted.status_code == 202
        completed = wait_for_job(client, accepted.json()["generation_job_id"])
        assert completed["status"] == "complete", completed
        saved = completed["result"]
        detail = client.get(f"/api/images/library/record/{saved['image_id']}").json()
        assert detail["additional_controls_metadata"] == additions
        assert detail["dynamic_controls_metadata"] == initial
        with Image.open(io.BytesIO(client.get(saved["image_url"]).content)) as image:
            metadata = json.loads(image.info[PNG_METADATA_KEY])
        assert metadata["image"]["additional_controls_metadata"] == additions
        assert (
            client.post("/api/generate-image", json=request).json()["generation_job_id"]
            == saved["image_id"]
        )


def test_empty_additive_metadata_preserves_prior_idempotency_fingerprint(tmp_path):
    request = {"prompt": "A glass buoy", "idempotency_key": "pre-additional-controls"}
    original_payload = Generation.model_validate(request).model_dump_json(
        exclude={"additional_controls_metadata"}
    )
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        accepted = client.post("/api/generations", json=request)
        assert accepted.status_code == 202
        with client.app.state.store.connect() as database:
            fingerprint = database.execute(
                "SELECT fingerprint FROM jobs WHERE key=?",
                (request["idempotency_key"],),
            ).fetchone()[0]
        assert fingerprint == hashlib.sha256(original_payload.encode()).hexdigest()
        assert (
            client.post("/api/generations", json=request).json()["id"]
            == accepted.json()["id"]
        )
        assert (
            client.post(
                "/api/generations",
                json={**request, "additional_controls_metadata": [{"new": True}]},
            ).status_code
            == 409
        )


def test_shared_addition_fixture_matches_native_endpoint(tmp_path):
    fixture = json.loads(
        (
            Path(__file__).resolve().parents[2]
            / "fixtures/api/additional-controls.json"
        ).read_text()
    )
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        assert (
            client.get("/api/controls/static").json()["controls"]
            == fixture["source_controls"]
        )
        for key in ("first", "second", "asset", "invalid", "at_capacity"):
            response = client.post(PATH, json=fixture[key]["request"])
            assert response.status_code == fixture[key]["status"]
            assert response.json() == fixture[key]["response"]
