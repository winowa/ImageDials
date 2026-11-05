"""Effective reference-editing capability of one image provider selection.

Two limits are deliberately distinct:

- `MAX_REFERENCE_SLOTS` is the absolute request/storage envelope shared by
  every reference path. It never advertises support.
- The effective limit is the selected model's documented maximum, bounded by
  the adapter's genuine slot bound and optionally lowered by the deployment.
  Discovery, upload parsing, analysis context, rendering and the client all
  read this one value from the provider that will actually run the request.
"""

from .reference_types import (
    MAX_REFERENCE_BYTES,
    MAX_REFERENCE_SLOTS,
    MAX_REFERENCE_TOTAL_BYTES,
)

REFERENCE_LIMIT_SETTING = "IMAGE_EDIT_MAX_REFERENCES"
EDIT_TRANSPORT = "multipart-generation-v1"


def reference_limit(env, strategy, adapter_slots):
    """(effective limit, configured?) for `strategy` through one adapter.

    A model without a documented maximum gets no slots: editing stays
    unavailable instead of guessing. A configured value may only lower the
    documented bound; anything else fails clearly at startup.
    """
    documented = strategy.max_references
    if not documented:
        return 0, False
    bound = min(documented, adapter_slots, MAX_REFERENCE_SLOTS)
    raw = (env.get(REFERENCE_LIMIT_SETTING) or "").strip()
    if not raw:
        return bound, False
    problem = (
        f"{REFERENCE_LIMIT_SETTING} must be a whole number from 1 to {bound} "
        f"for {strategy.model}"
    )
    try:
        value = int(raw)
    except ValueError:
        raise ValueError(problem) from None
    if not 1 <= value <= bound:
        raise ValueError(problem)
    return value, True


def editing_capability(renderer, inference_enabled):
    """Public capability of `renderer`; no slots are offered when it cannot edit."""
    strategy = renderer.reference_strategy
    ready = bool(inference_enabled and renderer.editing_ready)
    limit = renderer.max_references if ready else 0
    return {
        "enabled": ready and limit > 0,
        "transport": EDIT_TRANSPORT,
        "model": strategy.model,
        "max_references": limit,
        "model_max_references": strategy.max_references,
        "limit_source": "configured"
        if renderer.reference_limit_configured
        else "model",
        "max_image_bytes": MAX_REFERENCE_BYTES,
        "max_total_bytes": MAX_REFERENCE_TOTAL_BYTES,
        "geometry": "first-reference",
        "analysis_url": "/api/images/reference-analysis",
        "prompting": strategy.capability(limit),
    }


def too_many_references(renderer, count):
    """Why `count` ordered references exceed the selected model, or None."""
    limit = renderer.max_references
    if count <= limit:
        return None
    model = renderer.reference_strategy.model
    return (
        f"{model} accepts at most {limit} reference image"
        f"{'' if limit == 1 else 's'} here; this request has {count}."
    )
