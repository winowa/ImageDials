"""Optional model suggestions for the fixed Standard categories.

The server owns the catalog (IDs, kinds and labels), so suggestions are validated
here and never trusted from the client. A suggestion is advisory: nothing in this
module can fail a valid set of generated categories, and absence of a usable
suggestion is never a request to disable anything.
"""

import hashlib
import json

from .domain import fixed_controls

# Automatic suggestions only. Manual and restored selections are never capped.
MAX_SUGGESTED_MULTI_OPTIONS = 2
MAX_REPORTED_REJECTIONS = 16
MULTIPLE = frozenset({"multi", "checkbox"})

# Deterministic mock suggestions. They exercise every semantic (single value, list,
# empty list, explicit null) so mock-only runs and fixtures cover them; they say
# nothing about real model quality.
MOCK_SUGGESTIONS = {
    "image": {
        "style": ["photography"],
        "color": ["natural"],
        "lighting": ["soft-daylight"],
        "composition": ["balanced"],
        "camera-angle": "eye-level",
        "texture": None,
        "mood": [],
        "background": "plain",
    },
    "asset-image": {
        "material": ["ceramic"],
        "finish": ["matte"],
        "form": ["rounded"],
        "view": "three-quarter",
        "color": ["natural"],
        "surface-detail": None,
        "construction": [],
        "lighting": ["studio"],
    },
}


def standard_catalog(mode):
    """Stable, ordered descriptors of the mode's fixed categories."""
    return [
        {
            "id": control.id,
            "label": control.label,
            "kind": control.type,
            "scope": control.description,
            "options": {option.id: option.label for option in control.options},
        }
        for control in fixed_controls(mode)
    ]


def catalog_context(mode):
    """Compact catalog text for the stable system prefix (identical per mode)."""
    return json.dumps(standard_catalog(mode), ensure_ascii=False, separators=(",", ":"))


def standard_selections_schema(mode):
    """Optional, enum-constrained structured-output shape for the same catalog."""
    properties = {}
    for category in standard_catalog(mode):
        identifiers = list(category["options"])
        if category["kind"] in MULTIPLE:
            value = {
                "type": "array",
                "items": {"type": "string", "enum": identifiers},
                "maxItems": MAX_SUGGESTED_MULTI_OPTIONS,
            }
        else:
            value = {"type": "string", "enum": identifiers}
        properties[category["id"]] = {"anyOf": [value, {"type": "null"}]}
    return {
        "type": "object",
        "properties": properties,
        "additionalProperties": False,
    }


def suggestion_anchor(mode, prompt, raw_response):
    """Short identity linking per-control provenance to the raw evidence."""
    digest = hashlib.sha256(
        json.dumps(
            {"mode": mode, "prompt": prompt, "response": raw_response},
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    )
    return digest.hexdigest()[:16]


ABSENT = object()


def sanitize_standard_selections(raw, mode):
    """Return ``(selections, report)`` without ever raising.

    Pass ``ABSENT`` when the response had no such key. ``selections`` maps a catalog category ID to a validated option ID, a validated
    option-ID list (possibly empty) or ``None`` ("let the composer decide"). A
    category with no usable suggestion is simply absent. Wrong shapes are rejected,
    never coerced; unknown IDs are dropped.
    """
    rejected = []

    def reject(identifier, reason):
        if len(rejected) < MAX_REPORTED_REJECTIONS:
            rejected.append({"id": identifier, "reason": reason})

    if raw is ABSENT:
        return {}, {"status": "absent", "accepted": {}, "rejected": []}
    if not isinstance(raw, dict):
        reject(None, "not-object")
        return {}, {"status": "invalid", "accepted": {}, "rejected": rejected}
    catalog = {category["id"]: category for category in standard_catalog(mode)}
    for identifier in raw:
        if identifier not in catalog:
            reject(str(identifier)[:80], "unknown-category")
    selections, accepted, capped = {}, {}, []
    for identifier, category in catalog.items():
        if identifier not in raw:
            continue
        value = raw[identifier]
        options = category["options"]
        if value is None:
            selections[identifier] = None
            accepted[identifier] = "model-decides"
        elif category["kind"] in MULTIPLE:
            if not isinstance(value, list):
                reject(identifier, "wrong-kind")
            elif not value:
                selections[identifier] = []
                accepted[identifier] = "empty"
            else:
                valid = []
                for item in value:
                    if isinstance(item, str) and item in options and item not in valid:
                        valid.append(item)
                if not valid:
                    reject(identifier, "no-valid-options")
                else:
                    if len(valid) > MAX_SUGGESTED_MULTI_OPTIONS:
                        capped.append(identifier)
                    selections[identifier] = valid[:MAX_SUGGESTED_MULTI_OPTIONS]
                    accepted[identifier] = "value"
        elif not isinstance(value, str):
            reject(identifier, "wrong-kind")
        elif value not in options:
            reject(identifier, "unknown-option")
        else:
            selections[identifier] = value
            accepted[identifier] = "value"
    status = (
        "valid"
        if accepted and not rejected
        else "partial"
        if accepted
        else "none-usable"
    )
    report = {"status": status, "accepted": accepted, "rejected": rejected}
    if capped:
        report["capped"] = capped
    return selections, report
