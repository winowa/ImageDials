"""UX02 Option B (typed union, exactly eight, relevance order) and UX09 range labels."""

import copy
import json

import pytest
from app import providers
from app.control_schema import (
    GENERATED_CONTROL_TYPES,
    additional_controls_schema,
    generated_controls_schema,
)
from app.domain import Category, Draft, fixed_controls
from app.main import create_app
from app.providers import ProviderError
from app.wire import control_from_category
from control_fixtures import (
    chat_response,
    load_fixture,
    ordered_categories,
    unsupported_format_error,
)
from fastapi.testclient import TestClient

FIXTURE = load_fixture("initial-controls.json")
ENV = {"LLM_MODEL_ENDPOINT_1": "http://localhost", "LLM_MODEL_NAME": "fixture-model"}


def stub_chat(monkeypatch, *items):
    calls, queue = [], list(items)

    def respond(base, path, payload=None, **kwargs):
        calls.append(copy.deepcopy(payload))
        item = queue.pop(0) if len(queue) > 1 else queue[0]
        if isinstance(item, Exception):
            raise item
        return item

    monkeypatch.setattr(providers, "request", respond)
    return calls


def controls_for(categories, monkeypatch):
    stub_chat(monkeypatch, chat_response({"categories": categories}))
    return providers.ControlsProvider(ENV).controls_with_suggestions(
        Draft(prompt="A barn owl")
    )


def test_schema_requires_one_named_slot_per_kind_without_display_positions():
    for mode in ("image", "asset-image"):
        slots = generated_controls_schema(mode)["properties"]["categories"]
        assert slots["type"] == "object"
        assert slots["required"] == list(GENERATED_CONTROL_TYPES)
        assert slots["additionalProperties"] is False
        variants = list(slots["properties"].values())
        for kind, variant in slots["properties"].items():
            assert variant["properties"]["id"]["pattern"].startswith(
                f"^generated_{kind}_"
            )
            assert "relevance" in variant["required"]
        assert [v["properties"]["type"]["const"] for v in variants] == list(
            GENERATED_CONTROL_TYPES
        )
        by_kind = {v["properties"]["type"]["const"]: v for v in variants}
        assert by_kind["range"]["properties"]["value"] == {"type": "number"}
        assert by_kind["multi"]["properties"]["value"]["type"] == "array"
        assert by_kind["binary"]["properties"]["value"] == {"type": "boolean"}
        assert by_kind["single"]["properties"]["options"]["minItems"] == 3
    # Exactly-eight belongs to the initial schema only; additive batches keep their count.
    for count in (1, 3, 5):
        additive = additional_controls_schema(count)["properties"]["categories"]
        assert additive["minItems"] == additive["maxItems"] == count
        assert len(additive["items"]["anyOf"]) == 8
        assert (
            "standard_selections" not in additional_controls_schema(count)["properties"]
        )


def test_no_destructive_label_limits_in_schema_or_model():
    schema = generated_controls_schema()
    for variant in schema["properties"]["categories"]["properties"].values():
        assert variant["properties"]["label"]["maxLength"] == 100
    # 24/28 characters are prompt guidance only; the long-standing limits are unchanged.
    properties = Category.model_json_schema()
    assert properties["properties"]["label"]["maxLength"] == 100
    assert properties["$defs"]["Option"]["properties"]["label"]["maxLength"] == 200


def test_named_slots_publish_relevance_order_and_preserve_raw_response(monkeypatch):
    entries = ordered_categories(FIXTURE["kinds"])
    slots = {
        entry["type"]: {**entry, "relevance": index * 10}
        for index, entry in enumerate(entries)
    }
    result = controls_for(slots, monkeypatch)
    assert [c.type for c in result.categories[:8]] == list(reversed(FIXTURE["kinds"]))
    assert result.metadata["response"]["categories"] == slots


@pytest.mark.parametrize(
    "defect", ["missing", "wrong_type", "bad_relevance", "collision"]
)
def test_invalid_named_slots_still_fail_validation(monkeypatch, defect):
    slots = {
        entry["type"]: {**entry, "relevance": 50}
        for entry in ordered_categories(FIXTURE["kinds"])
    }
    if defect == "missing":
        del slots["binary"]
    elif defect == "wrong_type":
        slots["binary"]["type"] = "multi"
    elif defect == "bad_relevance":
        slots["range"]["relevance"] = True
    else:
        slots["range"]["id"] = "style"
    with pytest.raises(ProviderError, match="invalid controls"):
        controls_for(slots, monkeypatch)


@pytest.mark.parametrize("order", FIXTURE["valid_orders"])
def test_any_relevance_order_is_accepted_and_preserved(monkeypatch, order):
    result = controls_for(ordered_categories(order), monkeypatch)
    generated = [c for c in result.categories if c.origin == "generated"]
    assert [c.type for c in generated] == order
    assert [c.id for c in generated] == [FIXTURE["templates"][k]["id"] for k in order]
    assert [c.origin for c in result.categories[8:]] == ["fixed"] * 8


def test_endpoint_preserves_response_order_without_sorting(tmp_path, monkeypatch):
    order = FIXTURE["valid_orders"][2]
    stub_chat(monkeypatch, chat_response({"categories": ordered_categories(order)}))
    with TestClient(
        create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path), **ENV})
    ) as client:
        body = client.post(
            "/api/controls/dynamic", json={"prompt": "A barn owl"}
        ).json()
    ids = [c["id"] for c in body["controls"] if c["origin"] == "generated"]
    templates = FIXTURE["templates"]
    assert ids == [templates[kind]["id"] for kind in order]


@pytest.mark.parametrize("name", list(FIXTURE["invalid_sets"]))
def test_missing_duplicate_or_extra_kinds_are_rejected(monkeypatch, name):
    kinds = FIXTURE["invalid_sets"][name]
    categories = ordered_categories(kinds, suffix="n")
    with pytest.raises(ProviderError, match="invalid controls"):
        controls_for(categories, monkeypatch)


def test_duplicate_ids_and_fixed_id_collisions_are_rejected(monkeypatch):
    categories = ordered_categories(FIXTURE["kinds"])
    categories[1]["id"] = categories[0]["id"]
    with pytest.raises(ProviderError, match="invalid controls"):
        controls_for(categories, monkeypatch)
    categories = ordered_categories(FIXTURE["kinds"])
    categories[0]["id"] = fixed_controls("image")[0].id
    with pytest.raises(ProviderError, match="invalid controls"):
        controls_for(categories, monkeypatch)


def test_value_and_type_validation_is_unchanged(monkeypatch):
    categories = ordered_categories(FIXTURE["kinds"])
    categories[0]["value"] = 99  # outside the declared range
    with pytest.raises(ProviderError, match="invalid controls"):
        controls_for(categories, monkeypatch)
    categories = ordered_categories(FIXTURE["kinds"])
    categories[1]["value"] = "missing-option"
    with pytest.raises(ProviderError, match="invalid controls"):
        controls_for(categories, monkeypatch)


def test_long_unicode_labels_survive_without_trimming(monkeypatch):
    categories = ordered_categories(FIXTURE["kinds"])
    categories[1]["label"] = "Gefieder-Farbverlauf überall " * 3 + "Ende"
    categories[1]["options"][0]["label"] = "Ö" * 150 + " ✓"
    result = controls_for(categories, monkeypatch)
    generated = {c.id: c for c in result.categories}
    assert generated[categories[1]["id"]].label == categories[1]["label"]
    assert generated[categories[1]["id"]].options[0].label.endswith(" ✓")


def test_unsupported_schema_retries_once_with_identical_messages(monkeypatch):
    calls = stub_chat(
        monkeypatch,
        unsupported_format_error(),
        chat_response({"categories": ordered_categories(FIXTURE["valid_orders"][1])}),
    )
    result = providers.ControlsProvider(ENV).controls_with_suggestions(
        Draft(prompt="A barn owl")
    )
    assert len(calls) == 2
    assert "response_format" in calls[0] and "response_format" not in calls[1]
    assert calls[0]["messages"] == calls[1]["messages"]
    assert [c.type for c in result.categories if c.origin == "generated"] == list(
        reversed(FIXTURE["kinds"])
    )
    # The downgraded response is held to the same one-of-each rule.
    stub_chat(
        monkeypatch,
        unsupported_format_error(),
        chat_response({"categories": ordered_categories(FIXTURE["kinds"][:-1])}),
    )
    with pytest.raises(ProviderError, match="invalid controls"):
        providers.ControlsProvider(ENV).controls_with_suggestions(
            Draft(prompt="A barn owl")
        )


@pytest.mark.parametrize("status", [401, 503])
def test_other_failures_are_not_downgraded(monkeypatch, status):
    import io
    import urllib.error

    cause = urllib.error.HTTPError(
        "http://localhost", status, "x", {}, io.BytesIO(b"down")
    )
    error = ProviderError("failed")
    error.__cause__ = cause
    calls = stub_chat(monkeypatch, error)
    with pytest.raises(ProviderError):
        providers.ControlsProvider(ENV).controls_with_suggestions(
            Draft(prompt="A barn owl")
        )
    assert len(calls) == 1


def test_instructions_ask_for_relevance_order_concise_labels_and_idea_defaults(
    monkeypatch,
):
    calls = stub_chat(
        monkeypatch, chat_response({"categories": ordered_categories(FIXTURE["kinds"])})
    )
    providers.ControlsProvider(ENV).controls_with_suggestions(
        Draft(prompt="A barn owl")
    )
    system = calls[0]["messages"][0]["content"]
    for term in [
        "by relevance to this idea, most useful first",
        "about 24 characters or fewer",
        "about 28 characters or fewer",
        "without dropping the distinguishing words",
        "rather than defaulting to the first option",
        "leave the value empty unless the idea itself asks for lettering",
        "min_label and max_label",
        "mutually distinct",
        "exactly eight",
        "one and only one",
    ]:
        assert term in system
    assert calls[0]["max_tokens"] == 4000


@pytest.mark.parametrize("case", FIXTURE["range_labels"], ids=lambda c: c["name"])
def test_range_endpoint_labels_round_trip(case):
    base = {
        "id": "wing-span",
        "label": "Wing span",
        "type": "range",
        "min": 0,
        "max": 10,
        "step": 1,
        "value": 6,
    }
    category = Category.model_validate({**base, **case["category"]})
    wire = control_from_category(category)
    for name in ("minLabel", "maxLabel"):
        assert wire.get(name) == case["wire"].get(name)
        assert (name in wire) == (name in case["wire"])
    assert "min_label" not in wire and "max_label" not in wire
    for key in ("min", "max", "step", "value"):
        if key in case["wire"]:
            assert wire[key] == case["wire"][key] and wire[key] is not False
    # Legacy category dumps re-validate to the same labels.
    again = Category.model_validate(category.model_dump())
    assert (
        again.min_label == category.min_label and again.max_label == category.max_label
    )
    assert ("min_label" in category.model_dump()) == ("minLabel" in case["wire"])


def test_range_labels_are_bounded_and_only_described_for_range_schema():
    from app.domain import MAX_RANGE_LABEL_CHARACTERS

    with pytest.raises(ValueError):
        Category(
            id="a",
            label="A",
            type="range",
            value=1,
            min_label="x" * (MAX_RANGE_LABEL_CHARACTERS + 1),
        )
    variants = list(
        generated_controls_schema()["properties"]["categories"]["properties"].values()
    )
    for variant in variants:
        has = "min_label" in variant["properties"]
        assert has == (variant["properties"]["type"]["const"] == "range")
    range_variant = variants[0]["properties"]
    assert range_variant["min_label"]["maxLength"] == MAX_RANGE_LABEL_CHARACTERS


def test_range_labels_survive_the_real_provider_and_endpoint(tmp_path, monkeypatch):
    categories = ordered_categories(FIXTURE["kinds"])
    stub_chat(monkeypatch, chat_response({"categories": categories}))
    with TestClient(
        create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path), **ENV})
    ) as client:
        body = client.post(
            "/api/controls/dynamic", json={"prompt": "A barn owl"}
        ).json()
    slider = next(c for c in body["controls"] if c["kind"] == "slider")
    assert (slider["minLabel"], slider["maxLabel"]) == ("Folded", "Fully spread")
    assert slider["min"] == 0 and slider["value"] == 6
    # Other kinds, and fixed controls, gain no label keys.
    assert not any("minLabel" in c for c in body["controls"] if c["kind"] != "slider")
    # A range without labels stays unlabeled rather than receiving empty strings.
    del categories[0]["min_label"], categories[0]["max_label"]
    stub_chat(monkeypatch, chat_response({"categories": categories}))
    with TestClient(
        create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path), **ENV})
    ) as client:
        body = client.post(
            "/api/controls/dynamic", json={"prompt": "A barn owl"}
        ).json()
    slider = next(c for c in body["controls"] if c["kind"] == "slider")
    assert "minLabel" not in slider and "maxLabel" not in slider


def test_legacy_category_snapshots_with_and_without_labels_become_wire_controls():
    from app.wire import image_record

    labeled = Category.model_validate(
        {**ordered_categories(["range"])[0], "origin": "generated"}
    ).model_dump()
    plain = Category.model_validate(ordered_categories(["single"])[0]).model_dump()
    snapshot = {
        "id": "legacy",
        "width": 8,
        "height": 8,
        "created_at": 1.0,
        "categories": [labeled, plain],
    }
    controls = image_record(snapshot)["selected_controls"]
    assert controls[0]["minLabel"] == "Folded" and "minLabel" not in controls[1]
    assert json.loads(json.dumps(controls)) == controls


def test_additive_batches_still_accept_repeated_kinds_and_five_options():
    from app.additional_controls import unique_controls

    batch = []
    for index in range(3):
        item = ordered_categories(["multi"])[0]
        item["id"] = f"extra-{index}"
        item["label"] = f"Extra {index}"
        item["options"] = [{"id": f"o{n}", "label": f"Option {n}"} for n in range(5)]
        item["value"] = ["o0"]
        batch.append(item)
    selected = unique_controls(batch, [], 3)
    assert [c.id for c in selected] == ["extra-0", "extra-1", "extra-2"]
    assert all(c.type == "multi" and len(c.options) == 5 for c in selected)
