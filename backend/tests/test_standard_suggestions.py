"""Optional Standard-category suggestions: validated alone, never fatal to controls."""

import copy
import json

import pytest
from app import providers
from app.domain import Draft
from app.main import create_app
from app.providers import ProviderError
from app.standard_suggestions import (
    ABSENT,
    MOCK_SUGGESTIONS,
    catalog_context,
    sanitize_standard_selections,
    standard_catalog,
    standard_selections_schema,
)
from control_fixtures import (
    FakeHttpResponse,
    chat_response,
    load_fixture,
    ordered_categories,
    unsupported_format_error,
)
from fastapi.testclient import TestClient

CASES = load_fixture("standard-selections.json")["cases"]
KINDS = load_fixture("initial-controls.json")["kinds"]
ENV = {"LLM_MODEL_ENDPOINT_1": "http://localhost", "LLM_MODEL_NAME": "fixture-model"}


def model_body(model_field=ABSENT, mode_kinds=KINDS):
    body = {"categories": ordered_categories(mode_kinds)}
    if model_field is not ABSENT:
        body["standard_selections"] = model_field
    return body


def case_field(case):
    return ABSENT if case.get("model_field_absent") else case["model_field"]


def stub_chat(monkeypatch, *bodies):
    """Replace only the transport, so parsing and validation run unchanged."""
    calls, queue = [], list(bodies)

    def respond(base, path, payload=None, **kwargs):
        calls.append(copy.deepcopy(payload))
        item = queue.pop(0) if len(queue) > 1 else queue[0]
        if isinstance(item, Exception):
            raise item
        return item

    monkeypatch.setattr(providers, "request", respond)
    return calls


@pytest.mark.parametrize("case", CASES, ids=[case["name"] for case in CASES])
def test_sanitizer_matches_fixture_contract(case):
    selections, report = sanitize_standard_selections(case_field(case), case["mode"])
    assert selections == case["expected_selections"]
    assert report == case["expected_validation"]
    # JSON null and an empty list stay different values after validation.
    for identifier, value in case["expected_selections"].items():
        assert (value is None) == (
            case["expected_validation"]["accepted"][identifier] == "model-decides"
        )


@pytest.mark.parametrize("case", CASES, ids=[case["name"] for case in CASES])
def test_provider_parses_fixture_once_and_keeps_good_categories(monkeypatch, case):
    calls = stub_chat(monkeypatch, chat_response(model_body(case_field(case))))
    provider = providers.ControlsProvider(ENV)
    mode = case["mode"]
    result = provider.controls_with_suggestions(Draft(prompt="A barn owl", mode=mode))
    generated = [c for c in result.categories if c.origin == "generated"]
    assert [c.type for c in generated] == KINDS
    assert result.standard_selections == case["expected_selections"]
    assert result.metadata["suggestion_validation"] == case["expected_validation"]
    assert len(calls) == 1  # no suggestion round trip and no retry
    # Raw evidence stays once, verbatim, in opaque metadata.
    raw = json.loads(result.metadata["raw_response"])
    assert result.metadata["response"] == raw
    assert ("standard_selections" in raw) == (not case.get("model_field_absent"))
    # The compatible two-tuple view is unchanged.
    categories, metadata = provider.controls_with_metadata(
        Draft(prompt="A barn owl", mode=mode)
    )
    assert len(categories) == len(result.categories) and "response" in metadata


def test_truncated_whole_response_still_fails_without_partial_suggestions(monkeypatch):
    whole = json.dumps(model_body({"style": ["photography"]}))
    calls = stub_chat(monkeypatch, chat_response(whole[: len(whole) // 2]))
    with pytest.raises(ProviderError, match="invalid controls"):
        providers.ControlsProvider(ENV).controls_with_suggestions(
            Draft(prompt="A barn owl")
        )
    assert len(calls) == 1


def test_invalid_categories_still_fail_even_when_suggestions_are_valid(monkeypatch):
    stub_chat(
        monkeypatch, chat_response(model_body({"style": ["photography"]}, KINDS[:-1]))
    )
    with pytest.raises(ProviderError, match="invalid controls"):
        providers.ControlsProvider(ENV).controls_with_suggestions(
            Draft(prompt="A barn owl")
        )


def test_explicit_unsupported_schema_validates_suggestions_identically(monkeypatch):
    field = {
        "style": ["photography", "photography", "cinematic", "pastel"],
        "mood": ["nope"],
    }
    calls = stub_chat(
        monkeypatch,
        unsupported_format_error(),
        chat_response(model_body(field)),
    )
    result = providers.ControlsProvider(ENV).controls_with_suggestions(
        Draft(prompt="A barn owl")
    )
    assert len(calls) == 2
    assert calls[0]["response_format"]["type"] == "json_schema"
    assert "response_format" not in calls[1]
    assert calls[0]["messages"] == calls[1]["messages"]
    assert result.metadata["schema_fallback"] is True
    assert result.standard_selections == {"style": ["photography", "cinematic"]}
    assert result.metadata["suggestion_validation"]["rejected"] == [
        {"id": "mood", "reason": "no-valid-options"}
    ]


def test_real_transport_parse_path_with_stubbed_urlopen(monkeypatch):
    """Exercise providers.request itself; no socket is opened."""
    sent = []

    def urlopen(req, timeout=None):
        sent.append(json.loads(req.data))
        return FakeHttpResponse(
            chat_response(model_body({"camera-angle": "low-angle", "texture": None}))
        )

    monkeypatch.setattr(providers.urllib.request, "urlopen", urlopen)
    result = providers.ControlsProvider(ENV).controls_with_suggestions(
        Draft(prompt="A barn owl")
    )
    assert result.standard_selections == {"camera-angle": "low-angle", "texture": None}
    assert len(sent) == 1 and sent[0]["max_tokens"] == 4000


def test_suggestions_never_alter_fixed_catalog_or_generated_order(monkeypatch):
    order = [
        "binary",
        "text",
        "range",
        "single",
        "radio",
        "multi",
        "checkbox",
        "select",
    ]
    stub_chat(monkeypatch, chat_response(model_body({"style": ["watercolor"]}, order)))
    draft = Draft(prompt="A barn owl")
    result = providers.ControlsProvider(ENV).controls_with_suggestions(draft)
    fixed = [c for c in result.categories if c.origin == "fixed"]
    from app.domain import fixed_controls

    assert [c.model_dump() for c in fixed] == [
        c.model_dump() for c in fixed_controls("image")
    ]


def test_mock_provider_is_deterministic_valid_and_covers_semantics():
    provider = providers.ControlsProvider({})
    for mode, suggestions in MOCK_SUGGESTIONS.items():
        first = provider.controls_with_suggestions(Draft(prompt="Any idea", mode=mode))
        second = provider.controls_with_suggestions(Draft(prompt="Any idea", mode=mode))
        assert first.standard_selections == second.standard_selections == suggestions
        assert first.metadata["suggestion_validation"]["status"] == "valid"
        assert (
            first.metadata["suggestion_anchor"] == second.metadata["suggestion_anchor"]
        )
        assert (
            provider.controls_with_metadata(Draft(prompt="Any idea", mode=mode))[1][
                "provider"
            ]
            == "mock"
        )
        values = list(first.standard_selections.values())
        assert (
            None in values and [] in values and any(isinstance(v, str) for v in values)
        )
        assert (
            first.standard_selections is not suggestions
        )  # callers cannot mutate the constant
    fixture = load_fixture("standard-selections.json")["mock_responses"]
    assert fixture["image"]["standard_selections"] == MOCK_SUGGESTIONS["image"]
    assert (
        fixture["asset-image"]["standard_selections"] == MOCK_SUGGESTIONS["asset-image"]
    )


def test_catalog_block_is_server_owned_stable_and_mode_specific(monkeypatch):
    calls = stub_chat(monkeypatch, chat_response(model_body()))
    provider = providers.ControlsProvider(ENV)
    history = ["earlier idea"]
    custom = [
        {
            "id": "secret-custom",
            "label": "Client expanded",
            "kind": "dropdown",
            "options": {"leaked-option": "Leaked option"},
            "value": "leaked-option",
        }
    ]
    provider.controls_with_suggestions(Draft(prompt="First idea"), history, custom)
    provider.controls_with_suggestions(
        Draft(prompt="A completely different idea"), [], []
    )
    provider.controls_with_suggestions(Draft(prompt="Asset idea", mode="asset-image"))
    first, second, asset = (call["messages"][0]["content"] for call in calls)
    assert first == second  # nothing per-request is in the stable prefix
    assert catalog_context("image") in first and catalog_context("asset-image") in asset
    assert "camera-angle" in first and "camera-angle" not in asset
    assert "surface-detail" in asset and "surface-detail" not in first
    assert "leaked-option" not in first and "First idea" not in first
    # Every catalog ID and option label appears; labels explain slugged IDs.
    assert '"bird-s-eye":"Bird\'s-eye"' in first
    assert '"scope":"Viewpoint relative to the subject."' in first
    user = json.loads(calls[0]["messages"][1]["content"])
    assert user["current_categories"] == [
        {"id": "secret-custom", "label": "Client expanded", "kind": "dropdown"}
    ]
    assert "options" not in json.dumps(user["current_categories"])


def test_reference_instructions_follow_the_stable_prefix(monkeypatch):
    from app.reference_types import ReferenceContext

    calls = stub_chat(monkeypatch, chat_response(model_body()))
    provider = providers.ControlsProvider(ENV)
    provider.controls_with_suggestions(Draft(prompt="Edit idea"))
    draft = Draft(
        prompt="Edit idea",
        reference_context=[
            ReferenceContext(id="ref-1", role="Source", description="An owl")
        ],
    )
    provider.controls_with_suggestions(draft)
    plain, referenced = (call["messages"][0]["content"] for call in calls)
    assert referenced.startswith(plain) and len(referenced) > len(plain)
    assert "Reference images are supplied" in referenced[len(plain) :]


def test_instructions_state_suggestion_policy_without_conflict_rules(monkeypatch):
    calls = stub_chat(monkeypatch, chat_response(model_body()))
    providers.ControlsProvider(ENV).controls_with_suggestions(
        Draft(prompt="A barn owl")
    )
    system = calls[0]["messages"][0]["content"]
    for term in [
        "standard_selections",
        "STANDARD CATALOG",
        "at most two",
        "empty array",
        "Use null",
        "deliberate contrasts",
        "only when the idea leaves the medium open",
        "never against an explicit",
    ]:
        assert term in system
    # Policy is guidance only: no hard Warm/Cool or material conflict rule exists.
    assert "conflict" not in system.lower()


def test_schema_constrains_suggestions_to_the_catalog_and_stays_optional():
    from app.control_schema import generated_controls_schema

    for mode in ("image", "asset-image"):
        schema = generated_controls_schema(mode)
        assert schema["required"] == ["categories"]
        selections = schema["properties"]["standard_selections"]
        assert selections == standard_selections_schema(mode)
        catalog = {item["id"]: item for item in standard_catalog(mode)}
        assert set(selections["properties"]) == set(catalog)
        for identifier, item in catalog.items():
            options, null = selections["properties"][identifier]["anyOf"]
            assert null == {"type": "null"}
            if item["kind"] in {"multi", "checkbox"}:
                assert options["type"] == "array" and options["maxItems"] == 2
                assert options["items"]["enum"] == list(item["options"])
            else:
                assert options == {"type": "string", "enum": list(item["options"])}


def test_endpoint_returns_optional_field_beside_unchanged_controls(
    tmp_path, monkeypatch
):
    field = {"style": ["photography"], "texture": None, "mood": [], "camera-angle": 5}
    stub_chat(monkeypatch, chat_response(model_body(field)))
    env = {"IMAGEDIALS_DATA_DIR": str(tmp_path), **ENV}
    with TestClient(create_app(env)) as client:
        response = client.post("/api/controls/dynamic", json={"prompt": "A barn owl"})
        assert response.status_code == 200
        body = response.json()
        assert body["standard_selections"] == {
            "style": ["photography"],
            "texture": None,
            "mood": [],
        }
        # JSON null and [] reach the client as distinct values, rejected kinds do not.
        assert "camera-angle" not in body["standard_selections"]
        assert [c["kind"] for c in body["controls"] if c["origin"] == "generated"] == [
            "slider",
            "single-select",
            "multi-select",
            "dropdown",
            "radio",
            "checkbox",
            "text-input",
            "binary",
        ]
        metadata = body["dynamic_controls_metadata"]
        assert metadata["suggestion_validation"]["status"] == "partial"
        assert len(metadata["suggestion_anchor"]) == 16
        # Without usable suggestions the response is exactly the old shape.
        stub_chat(monkeypatch, chat_response(model_body("not-an-object")))
        old = client.post("/api/controls/dynamic", json={"prompt": "A barn owl"}).json()
        assert set(old) == {"controls", "dynamic_controls_metadata"}
        stub_chat(monkeypatch, chat_response(model_body()))
        absent = client.post(
            "/api/controls/dynamic", json={"prompt": "A barn owl"}
        ).json()
        assert set(absent) == {"controls", "dynamic_controls_metadata"}
        assert (
            absent["dynamic_controls_metadata"]["suggestion_validation"]["status"]
            == "absent"
        )


def test_endpoint_mock_suggestions_and_old_clients(tmp_path):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        standard = client.post(
            "/api/controls/dynamic", json={"prompt": "A glass bird"}
        ).json()
        asset = client.post(
            "/api/controls/dynamic",
            json={"prompt": "A glass bird", "generation_mode": "trellis"},
        ).json()
        fixture = load_fixture("standard-selections.json")["mock_responses"]
        assert (
            standard["standard_selections"] == fixture["image"]["standard_selections"]
        )
        assert (
            asset["standard_selections"]
            == fixture["asset-image"]["standard_selections"]
        )
        # Existing mock controls and the old three-key-free contract are untouched.
        assert standard["controls"][-1]["kind"] == "single-select"
        assert standard["dynamic_controls_metadata"]["provider"] == "mock"
        assert client.post("/api/controls/dynamic", json={}).status_code == 400
        # The old fields of the response are all still present and unchanged in meaning.
        old = load_fixture("standard-selections.json")["old_response_shape"]
        assert set(old) <= set(standard)


def test_suggestions_are_not_added_to_additive_endpoints(tmp_path):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        current = client.get("/api/controls/static").json()["controls"]
        summaries = [
            {k: v for k, v in c.items() if k in {"id", "label", "kind", "description"}}
            for c in current
        ]
        more = client.post(
            "/api/controls/additional",
            json={"prompt": "A glass bird", "categories": summaries},
        ).json()
        assert "standard_selections" not in more
        assert len(more["controls"]) == 3  # additive batches keep their own count rules


def test_context_size_stays_within_estimated_output_budget():
    """Offline estimate only: no tokenizer or model is involved."""
    from app.control_schema import generated_controls_schema
    from app.providers import CONTROL_OUTPUT_TOKENS

    assert CONTROL_OUTPUT_TOKENS == 4000
    for mode in ("image", "asset-image"):
        # Input-side stable block: well below the 4k characters Astra measured.
        assert len(catalog_context(mode)) < 4000
        assert len(json.dumps(standard_selections_schema(mode))) < 3000
        assert len(json.dumps(generated_controls_schema(mode))) < 60000
        selections = {
            item["id"]: list(item["options"])[:2]
            if item["kind"] in {"multi", "checkbox"}
            else list(item["options"])[0]
            for item in standard_catalog(mode)
        }
        # Longest valid suggestion output: every category, two ids each.
        suggestion_chars = len(json.dumps({"standard_selections": selections}))
        assert suggestion_chars < 800
        # Deliberately heavy but guidance-compliant categories: every optional field
        # populated, five 28-character options, long descriptions and labels.
        categories = []
        for template in ordered_categories(KINDS):
            heavy = {
                **template,
                "label": "L" * 24,
                "description": "D" * 160,
                "placeholder": "P" * 60,
                "true_label": "T" * 40,
                "false_label": "F" * 40,
                "origin": "generated",
                "min": 0,
                "max": 100,
                "step": 1,
            }
            if heavy["type"] in {"single", "multi", "select", "radio", "checkbox"}:
                heavy["options"] = [
                    {"id": f"option-{index}-" + "x" * 16, "label": "O" * 28}
                    for index in range(5)
                ]
                heavy["value"] = (
                    [heavy["options"][0]["id"]]
                    if heavy["type"] in {"multi", "checkbox"}
                    else heavy["options"][0]["id"]
                )
            categories.append(heavy)
        total = len(
            json.dumps({"categories": categories, "standard_selections": selections})
        )
        # Pessimistic 2.5 characters per token still leaves at least 25% headroom.
        assert total / 2.5 < CONTROL_OUTPUT_TOKENS * 0.75, total


@pytest.mark.parametrize("raw", [{"style": ["photography"]}, "bad", None])
def test_sanitizer_never_mutates_or_raises(raw):
    snapshot = copy.deepcopy(raw)
    sanitize_standard_selections(raw, "image")
    assert raw == snapshot
