"""Typed schemas for initial and additive control generation."""

import copy

from .domain import MAX_RANGE_LABEL_CHARACTERS, Category
from .standard_suggestions import standard_selections_schema

GENERATED_CONTROL_TYPES = (
    "range",
    "single",
    "multi",
    "select",
    "radio",
    "checkbox",
    "text",
    "binary",
)


def typed_category_schemas():
    category = Category.model_json_schema()
    definitions = category.pop("$defs", {})
    variants = []
    for kind in GENERATED_CONTROL_TYPES:
        item = copy.deepcopy(category)
        item["properties"]["type"] = {"type": "string", "const": kind}
        item["required"] = [*item["required"], "type"]
        if kind in {"single", "multi", "select", "radio", "checkbox"}:
            item["properties"]["options"]["minItems"] = 3
            item["properties"]["options"]["maxItems"] = 5
            item["required"].append("options")
        if kind in {"multi", "checkbox"}:
            value = {"type": "array", "items": {"type": "string"}}
        elif kind == "range":
            value = {"type": "number"}
            for name in ("min_label", "max_label"):
                item["properties"][name] = {
                    "type": "string",
                    "maxLength": MAX_RANGE_LABEL_CHARACTERS,
                }
        elif kind == "binary":
            value = {"type": "boolean"}
        elif kind == "text":
            value = {"type": "string"}
        else:
            value = {"anyOf": [{"type": "string"}, {"type": "null"}]}
        if kind != "range":
            # Endpoint labels only describe a range; other kinds stay unchanged.
            item["properties"].pop("min_label", None)
            item["properties"].pop("max_label", None)
        item["properties"]["value"] = value
        variants.append(item)
    return definitions, variants


def generated_controls_schema(mode="image"):
    """Named typed slots enforce one of each kind; relevance controls UI order."""
    definitions, variants = typed_category_schemas()
    slots = {}
    for kind, variant in zip(GENERATED_CONTROL_TYPES, variants):
        variant["properties"]["id"]["pattern"] = (
            f"^generated_{kind}_[a-z][a-z0-9_]{{0,50}}$"
        )
        variant["properties"]["relevance"] = {
            "type": "integer",
            "minimum": 0,
            "maximum": 100,
        }
        variant["required"].append("relevance")
        slots[kind] = variant
    return {
        "type": "object",
        "properties": {
            "categories": {
                "type": "object",
                "properties": slots,
                "required": list(GENERATED_CONTROL_TYPES),
                "additionalProperties": False,
            },
            "standard_selections": standard_selections_schema(mode),
        },
        "required": ["categories"],
        "additionalProperties": False,
        "$defs": definitions,
    }


def additional_controls_schema(count):
    """Additive batches: any kinds and repeats; never the initial eight-kind rule."""
    definitions, variants = typed_category_schemas()
    return {
        "type": "object",
        "properties": {
            "categories": {
                "type": "array",
                "items": {"anyOf": variants},
                "minItems": count,
                "maxItems": count,
            }
        },
        "required": ["categories"],
        "additionalProperties": False,
        "$defs": definitions,
    }
