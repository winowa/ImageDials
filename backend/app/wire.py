"""Canonical protocol adapters over the shared generation worker.

Wire controls stay intact. Resolution is a separate projection used only for prompt
composition; historical and future control fields are never discarded.
"""

import copy
import math
import re
import sqlite3
from datetime import datetime
from uuid import uuid4

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from .additional_controls import (
    DEFAULT_ADDITIONAL_CONTROL_COUNT,
    MAX_ADDITIONAL_CONTROL_COUNT,
)
from .browser_settings import current_providers
from .client_policy import client_policy
from .control_context import MAX_CONTEXT_CATEGORIES, category_summaries
from .domain import Category, Draft, Generation, fixed_controls
from .edit_control_catalog import edit_controls
from .library_facets import DEFAULT_EVENT_PAGE_SIZE, MAX_EVENT_PAGE_SIZE
from .library_pages import PAGE_DEFAULT_RECORDS, PAGE_MAX_RECORDS, PAGE_ORDERS
from .media import (
    DEFAULT_IMPORT_MAX_BYTES,
    DEFAULT_MAX_IMAGE_PIXELS,
    PREPARED_FILE_MAX_BYTES,
    image_pixel_limit,
    positive_integer,
    source_pixel_limit,
)
from .model_metadata import model_metadata
from .providers import ProviderError
from .reference_capability import editing_capability
from .reference_types import (
    MAX_REFERENCE_REQUEST_BYTES,
    MAX_REFERENCE_TOTAL_BYTES,
)
from .reference_uploads import generation_request
from .region_types import region_editing_capability
from .routing import canonical_routes, image_content_url
from .selection_provenance import (
    SELECTION_PROVENANCE_FIELD,
    validate_selection_provenance,
)
from .variation_types import MAX_VARIATION_COUNT

KIND_BY_TYPE = {
    "range": "slider",
    "single": "single-select",
    "multi": "multi-select",
    "select": "dropdown",
    "radio": "radio",
    "checkbox": "checkbox",
    "text": "text-input",
    "binary": "binary",
}
MAX_CONTROL_COUNT = MAX_CONTEXT_CATEGORIES
MAX_DIMENSION_PIXELS = 8192
MAX_IMAGE_PIXELS = DEFAULT_MAX_IMAGE_PIXELS


def configured_dimensions(env):
    max_pixels = image_pixel_limit(env)
    configured = {
        "3:2": dimensions_from_wire(
            env.get("IMAGE_LANDSCAPE_DIMENSIONS", "1152x768"), max_pixels
        ),
        "2:3": dimensions_from_wire(
            env.get("IMAGE_PORTRAIT_DIMENSIONS", "768x1152"), max_pixels
        ),
        "1:1": dimensions_from_wire(
            env.get("IMAGE_SQUARE_DIMENSIONS", "1024x1024"), max_pixels
        ),
    }
    for aspect, (width, height) in configured.items():
        numerator, denominator = map(int, aspect.split(":"))
        if width * denominator != height * numerator:
            raise ValueError(
                f"Configured {aspect} dimensions must preserve that aspect ratio"
            )
    return configured


def enabled(env, name, default=True):
    value = env.get(name, str(default)).strip().lower()
    if value not in {"true", "false", "1", "0"}:
        raise ValueError(f"{name} must be true or false")
    return value in {"true", "1"}


def normalize_mode(value):
    return (
        "trellis"
        if isinstance(value, str) and value.strip().lower() == "trellis"
        else "standard"
    )


def control_from_category(category):
    data = category.model_dump()
    data["kind"] = KIND_BY_TYPE[data.pop("type")]
    data["options"] = {option.id: option.label for option in category.options}
    data["trueLabel"] = data.pop("true_label")
    data["falseLabel"] = data.pop("false_label")
    # Optional range endpoint meanings: absent stays absent, never an empty string.
    for name, wire_name in (("min_label", "minLabel"), ("max_label", "maxLabel")):
        if name in data:
            data[wire_name] = data.pop(name)
    return data


def resolve_controls(controls, *, allow_empty=False, for_edit=False):
    if (
        not isinstance(controls, list)
        or not (0 if allow_empty else 1) <= len(controls) <= MAX_CONTROL_COUNT
    ):
        raise ValueError("Provide a nonempty controls array")
    resolved = []
    for control in controls:
        if (
            not isinstance(control, dict)
            or not isinstance(control.get("kind"), str)
            or not isinstance(control.get("label"), str)
        ):
            raise ValueError("Each control needs a kind and label")
        if SELECTION_PROVENANCE_FIELD in control:
            # Validated at the boundary but never copied into the composition projection.
            validate_selection_provenance(control[SELECTION_PROVENANCE_FIELD])
        if "apply_to_generation" in control:
            if type(control["apply_to_generation"]) is not bool:
                raise ValueError("Control application must be a boolean")
            if not for_edit and not control["apply_to_generation"]:
                # Keep the wire snapshot and this positional projection, but
                # neither validate an unused value nor send it to composition.
                resolved.append(
                    {
                        "kind": control["kind"],
                        "label": control["label"],
                        "value": copy.deepcopy(control.get("value")),
                        "apply_to_generation": False,
                    }
                )
                continue
        kind = control["kind"]
        value = copy.deepcopy(control.get("value"))
        options = control.get("options", {})
        if not isinstance(options, dict):
            raise ValueError("Control options must be an object")
        if kind == "slider":
            if type(value) not in {int, float} or not math.isfinite(value):
                raise ValueError("Slider value must be a finite number")
            minimum, maximum, step = (
                control.get("min", 0),
                control.get("max", 100),
                control.get("step", 1),
            )
            if (
                any(
                    type(v) not in {int, float} or not math.isfinite(v)
                    for v in (minimum, maximum, step)
                )
                or minimum >= maximum
                or step <= 0
                or not minimum <= value <= maximum
            ):
                raise ValueError("Slider bounds or value are invalid")
        elif kind == "binary" and type(value) is not bool:
            raise ValueError("Binary value must be a boolean")
        elif kind == "text-input" and not isinstance(value, str):
            raise ValueError("Text value must be a string")
        elif kind in {"multi-select", "checkbox"} and (
            not isinstance(value, list) or any(not isinstance(v, str) for v in value)
        ):
            raise ValueError("Multiple choice value must be an array of strings")
        elif (
            kind in {"single-select", "dropdown", "radio"}
            and value is not None
            and not isinstance(value, str)
        ):
            raise ValueError("Choice value must be a string or null")

        def option_value(key):
            option = options.get(key, key)
            return copy.deepcopy(
                option.get("value", key) if isinstance(option, dict) else option
            )

        if kind in {"multi-select", "checkbox"}:
            value = [option_value(key) for key in value]
        elif kind in {"single-select", "dropdown", "radio"} and value is not None:
            value = option_value(value)
        selection = {"kind": kind, "label": control["label"], "value": value}
        if for_edit and "apply_to_edit" in control:
            if type(control["apply_to_edit"]) is not bool:
                raise ValueError("Edit control application must be a boolean")
            selection["apply_to_edit"] = control["apply_to_edit"]
        resolved.append(selection)
    return resolved


def dimensions_from_wire(value, max_pixels=MAX_IMAGE_PIXELS):
    if not isinstance(value, str) or not re.fullmatch(
        r"[1-9][0-9]{0,3}x[1-9][0-9]{0,3}", value
    ):
        raise ValueError("Dimensions must be WIDTHxHEIGHT in pixels")
    width, height = map(int, value.split("x"))
    if max(width, height) > MAX_DIMENSION_PIXELS or width * height > max_pixels:
        raise ValueError("Requested image dimensions exceed the pixel limit")
    return width, height


def image_record(snapshot):
    image_id = snapshot["id"]
    created_at = snapshot.get("created_at")
    if isinstance(created_at, str):
        created_at = datetime.fromisoformat(created_at).timestamp()
    filename = image_id + ".png"
    original_controls = snapshot.get("selected_controls")
    if original_controls is None:
        from .domain import Category

        original_controls = [
            control_from_category(Category.model_validate(c))
            for c in snapshot.get("categories", [])
        ]
    return {
        **snapshot,
        "image_id": image_id,
        "storage_id": "local-0",
        "storage_type": "local",
        "storage_label": "Image library",
        "filename": filename,
        "event_id": snapshot.get("event_id"),
        "visibility": snapshot.get("visibility", "shared"),
        "title": snapshot.get("title"),
        "prompt": snapshot.get("prompt"),
        "original_prompt": snapshot.get("original_prompt", snapshot.get("prompt")),
        "final_prompt": snapshot.get("final_prompt"),
        "selected_controls": original_controls,
        "prompt_creation_request": (snapshot.get("composition") or {}).get(
            "prompt_creation_request"
        ),
        "dynamic_controls_metadata": snapshot.get("dynamic_controls_metadata"),
        "alt_text": snapshot.get("alt_text"),
        "dimensions": {"width": snapshot["width"], "height": snapshot["height"]}
        if snapshot.get("width") and snapshot.get("height")
        else snapshot.get("dimensions"),
        "created_at": created_at,
        "created_at_iso": int(created_at * 1_000_000_000)
        if created_at is not None
        else None,
        "print_watermark": None,
        "print_ready": None,
        "print_watermark_key": None,
        "print_ready_url": None,
        "generation_mode": "trellis"
        if snapshot.get("mode") == "asset-image"
        else "standard",
        "image_url": image_content_url(image_id),
    }


def snapshot_selections(snapshot, original_controls):
    resolved = snapshot.get("resolved_controls")
    return (
        resolved
        if resolved is not None
        else resolve_controls(
            original_controls, allow_empty=bool(snapshot.get("reference_images"))
        )
    )


def job_event(job):
    stage = job["stage"]
    status = stage if stage in {"complete", "failed"} else "running"
    result = image_record(job["result"]) if stage == "complete" else None
    if result is not None:
        requested = result.get("requested_dimensions") or result["dimensions"]
        result.update(
            original_selected_controls=result["selected_controls"],
            selected_controls=snapshot_selections(result, result["selected_controls"]),
            actual_dimensions=result["dimensions"],
            dimensions=f"{requested['width']}x{requested['height']}",
        )
    if stage == "failed":
        result = {"error": job["error"], "enrichment": {"status": "failed"}}
    if result is not None:
        result = {
            **result,
            "generation_job_id": job["id"],
            "enrichment": {"status": status},
        }
    event = {
        "event": status if status != "running" else "progress",
        "data": result or {"message": stage, "enrichment": {"status": "running"}},
    }
    if stage == "image-ready":
        preview = job["preview"]
        controls = preview.get("selected_controls")
        if controls is None:
            controls = [
                control_from_category(Category.model_validate(category))
                for category in preview.get("categories", [])
            ]
        requested = preview["requested_dimensions"]
        event = {
            "event": "image-ready",
            "data": {
                **preview,
                "original_prompt": preview["prompt"],
                "prompt_creation_request": (preview.get("composition") or {}).get(
                    "prompt_creation_request"
                ),
                "original_selected_controls": controls,
                "selected_controls": snapshot_selections(preview, controls),
                "dimensions": f"{requested['width']}x{requested['height']}",
                "actual_dimensions": {
                    "width": preview["width"],
                    "height": preview["height"],
                },
                "generation_mode": "trellis"
                if preview.get("mode") == "asset-image"
                else "standard",
                "image_data_url": None,
                "generation_job_id": job["id"],
                "enrichment": {"status": "running"},
            },
        }
    elif status == "running":
        event["data"].update(
            final_prompt=job.get("final_prompt"),
            prompt_creation_request=(job.get("composition") or {}).get(
                "prompt_creation_request"
            ),
        )
    return event


def job_status(job, updates=None):
    snapshots = updates or [job]
    events = [job_event(snapshot) for snapshot in snapshots]
    latest = events[-1]
    status = latest["event"] if latest["event"] in {"complete", "failed"} else "running"
    return {
        "generation_job_id": job["id"],
        "events": events,
        "latest_event": latest,
        "status": status,
        "result": latest["data"] if status != "running" else None,
    }


def register_canonical_routes(app, env, submit_generation, lookup_job):
    public_model_metadata = model_metadata(env)
    inference_enabled = enabled(env, "INFERENCE_ENABLED")
    shared_library_enabled = enabled(env, "SHARED_LIBRARY_ENABLED")
    browser_policy = client_policy(env)

    route = canonical_routes(app)
    # The same canonical generation URL supports JSON and reference multipart.
    # Streaming limits apply before parsing or accepting a generation job.
    from .imports import UploadBodyLimits
    from .media import MULTIPART_OVERHEAD_BYTES
    from .routing import canonical_paths

    app.add_middleware(
        UploadBodyLimits,
        limits={
            path: MAX_REFERENCE_TOTAL_BYTES
            + MAX_REFERENCE_REQUEST_BYTES
            + MULTIPART_OVERHEAD_BYTES
            for path in canonical_paths(app, "/generate-image")
        },
    )

    def require_inference():
        if not inference_enabled:
            raise HTTPException(503, "Inference is disabled")

    @app.get("/healthz")
    def healthz():
        return {"status": "ok", "inference_enabled": inference_enabled}

    @route("/app-capabilities")
    def capabilities():
        source = "shared-library" if shared_library_enabled else "browser-private"
        return {
            "environment": app.state.deployment.environment,
            "experience_profile": app.state.deployment.experience,
            "history_source": source,
            "gallery_source": source,
            "image_editing": editing_capability(
                current_providers(app).renderer, inference_enabled
            ),
            "variations": {
                "enabled": inference_enabled,
                "default_count": 1,
                "max_count": MAX_VARIATION_COUNT,
                "execution": "serial",
                "status_url": "/api/generation-groups/{group_id}",
                "retry": "failed-only",
            },
            "region_editing": region_editing_capability(
                inference_enabled
                and getattr(current_providers(app).renderer, "editing_ready", False),
                image_pixel_limit(env),
            ),
            "control_application": {
                "enabled": True,
                "text_flag": "apply_to_generation",
                "edit_flag": "apply_to_edit",
                "preserves_values": True,
            },
            "control_generation": {
                "max_controls": MAX_CONTROL_COUNT,
                "additional_controls": {
                    "enabled": inference_enabled,
                    "default_count": DEFAULT_ADDITIONAL_CONTROL_COUNT,
                    "max_count": MAX_ADDITIONAL_CONTROL_COUNT,
                },
            },
            "shared_library": {
                "enabled": shared_library_enabled,
                "polling_enabled": shared_library_enabled,
                "cloud_storage_enabled": False,
                "store": "local",
                "paging": {
                    "enabled": True,
                    "default_limit": PAGE_DEFAULT_RECORDS,
                    "max_limit": PAGE_MAX_RECORDS,
                    "orders": list(PAGE_ORDERS),
                    "backward_navigation_enabled": True,
                    "revision_tolerant_cursors": True,
                    "around_navigation_enabled": True,
                    "last_page_enabled": True,
                    "watermark_status_url": "/api/images/library/watermarks/status",
                    "indexed_search_enabled": app.state.store.library_search_available,
                    "event_facets": {
                        "enabled": shared_library_enabled,
                        "url": "/api/images/library/event-facets",
                        "default_limit": DEFAULT_EVENT_PAGE_SIZE,
                        "max_limit": MAX_EVENT_PAGE_SIZE,
                    },
                },
                "shuffle_sessions": {
                    "enabled": shared_library_enabled,
                    "max_count": app.state.gallery_sessions.max_count,
                    "max_records": app.state.gallery_sessions.max_records,
                    "ttl_seconds": app.state.gallery_sessions.ttl_seconds,
                    "max_limit": PAGE_MAX_RECORDS,
                    "first_image_enabled": True,
                    "renewal_enabled": True,
                },
            },
            "events": app.state.deployment.event_capabilities(),
            "exports": {
                "download_enabled": enabled(env, "DOWNLOAD_ENABLED"),
                "browser_print_enabled": enabled(env, "BROWSER_PRINT_ENABLED"),
                "share_enabled": False,
                "email_enabled": False,
                "server_handoff_enabled": False,
            },
            "retention": {"public_private_retention_enabled": False},
            "watermark": {
                "transient_analysis_enabled": True,
                "backfill": {
                    "async_preparation_enabled": shared_library_enabled,
                    "max_candidate_records": app.state.watermarks.batches.max_records,
                },
            },
            "client_policy": browser_policy,
            "uploads": {
                "image_grounded_controls": True,
                "import_max_bytes": positive_integer(
                    env, "IMPORT_MAX_BYTES", DEFAULT_IMPORT_MAX_BYTES
                ),
                "max_decoded_pixels": image_pixel_limit(env),
                # Larger reference uploads are refused; smaller ones over
                # max_decoded_pixels are sent as a prepared proportional copy.
                "max_source_pixels": source_pixel_limit(env),
                "watermark_analysis_max_bytes": positive_integer(
                    env, "WATERMARK_ANALYSIS_MAX_BYTES", DEFAULT_IMPORT_MAX_BYTES
                ),
                "print_ready_max_bytes": PREPARED_FILE_MAX_BYTES,
                "image_mime_types": ["image/png", "image/jpeg", "image/webp"],
            },
        }

    @route("/models")
    def models():
        providers = current_providers(app)
        model_env = providers.env

        def descriptor(name, role):
            return (
                {
                    "id": name,
                    "name": name,
                    "publisher": public_model_metadata.get(name, {}).get("publisher"),
                    "role": role,
                    "detail": public_model_metadata.get(name, {}).get("detail"),
                    "url": public_model_metadata.get(name, {}).get("url"),
                }
                if name
                else None
            )

        image_model = model_env.get("IMAGE_MODEL_NAME") or None
        llm_model = model_env.get("LLM_MODEL_NAME") or None
        image_parts = image_model.split("+") if image_model else []
        return {
            "image_model": image_model,
            "supported_dimensions": {
                aspect: f"{width}x{height}"
                for aspect, (width, height) in configured_dimensions(env).items()
            },
            "llm_model": llm_model,
            "inference_enabled": inference_enabled,
            # Scoped to the same provider selection as the image model above,
            # so a browser provider choice reads its own editing limit here.
            "image_editing": editing_capability(providers.renderer, inference_enabled),
            "routing": {
                "llm": {"configured": bool(model_env.get("LLM_MODEL_ENDPOINT_1"))},
                "image": {"configured": providers.renderer.ready},
            },
            "models": {
                "llm": descriptor(llm_model, "llm"),
                "image": descriptor(image_parts[0], "base") if image_parts else None,
                "image_loras": [descriptor(name, "lora") for name in image_parts[1:]],
            },
        }

    @route("/controls/static")
    def static_controls(generation_mode: str = "standard", image_edit: bool = False):
        mode = (
            "asset-image" if normalize_mode(generation_mode) == "trellis" else "image"
        )
        categories = edit_controls() if image_edit else fixed_controls(mode)
        return {
            "controls": [
                {
                    **control_from_category(c),
                    **({"apply_to_edit": False} if image_edit else {}),
                }
                for c in categories
            ]
        }

    @route("/controls/dynamic", ("POST",))
    async def dynamic_controls(request: Request):
        require_inference()
        try:
            body = await request.json()
            draft = Draft(
                prompt=body.get("prompt", ""),
                mode="asset-image"
                if normalize_mode(body.get("generation_mode")) == "trellis"
                else "image",
                reference_context=body.get("reference_context", []),
            )
            controls = body.get("controls", [])
            history = body.get("prompt_history", [])
            if (
                not isinstance(controls, list)
                or not isinstance(history, list)
                or any(not isinstance(p, str) for p in history)
            ):
                raise ValueError("Controls and prompt history must be arrays")
            if controls:
                resolve_controls(controls)
            categories = category_summaries(body.get("categories", controls))
        except (ValueError, ValidationError, AttributeError) as exc:
            raise HTTPException(
                400, "Provide a prompt and valid controls/history"
            ) from exc
        # Provider calls run outside the event loop so discovery/polling stay responsive.
        from starlette.concurrency import run_in_threadpool

        try:
            generated, metadata, suggestions = await run_in_threadpool(
                current_providers(app).controls.controls_with_suggestions,
                draft,
                history[-3:],
                categories,
            )
        except ProviderError as exc:
            if exc.evidence is None:
                raise HTTPException(502, str(exc)) from exc
            # The exchange that failed stays inspectable; it holds no credentials.
            return JSONResponse(
                {"detail": str(exc), "evidence": exc.evidence}, status_code=502
            )
        return {
            "controls": controls
            + [control_from_category(c) for c in generated if c.origin == "generated"],
            "dynamic_controls_metadata": metadata,
            # Optional and advisory; omitted when the model gave nothing usable so
            # older clients and older responses stay indistinguishable.
            **({"standard_selections": suggestions} if suggestions else {}),
        }

    @route("/generate-image", ("POST",))
    async def generate_image(request: Request):
        require_inference()
        try:
            body, references, reference_inputs = await generation_request(
                request, env, current_providers(app).renderer
            )
            controls = body.get("controls")
            resolved = resolve_controls(
                controls, allow_empty=bool(references), for_edit=bool(references)
            )
            width, height = dimensions_from_wire(
                body.get("dimensions", "768x1152"), image_pixel_limit(env)
            )
            draft = Generation(
                prompt=body.get("prompt", ""),
                mode="asset-image"
                if normalize_mode(body.get("generation_mode")) == "trellis"
                else "image",
                aspect="1:1" if width == height else "3:2" if width > height else "2:3",
                idempotency_key=body.get("idempotency_key") or str(uuid4()),
                selected_controls=controls,
                resolved_controls=resolved,
                dynamic_controls_metadata=body.get("dynamic_controls_metadata")
                if isinstance(body.get("dynamic_controls_metadata"), dict)
                else None,
                must_have_terms=body.get("must_have_terms", []),
                additional_controls_metadata=body.get(
                    "additional_controls_metadata", []
                ),
                requested_dimensions=(width, height),
                reference_images=references,
                variation_count=body.get("variation_count", 1),
                retry_variations=body.get("retry_variations"),
                region_edit=body.get("region_edit"),
            )
            draft._reference_inputs = reference_inputs
        except (ValueError, ValidationError, AttributeError) as exc:
            raise HTTPException(400, str(exc)) from exc
        from starlette.concurrency import run_in_threadpool

        job = await run_in_threadpool(submit_generation, draft)
        return JSONResponse(
            {
                "generation_job_id": job["id"],
                "enrichment": {"status": "pending", "transport": "server-sent-events"},
                **(
                    {"variation_group": job["variation_group"]}
                    if job.get("variation_group")
                    else {}
                ),
            },
            status_code=202,
        )

    @route("/generation-groups/{group_id}")
    def generation_group(group_id: str):
        try:
            group, jobs = app.state.generation_groups.lookup(group_id)
        except (OSError, ValueError, sqlite3.Error) as error:
            raise HTTPException(502, "Variation storage is unavailable") from error
        states = [job["stage"] for job in jobs]
        status = (
            "running"
            if any(state not in {"complete", "failed"} for state in states)
            else "complete"
            if all(state == "complete" for state in states)
            else "failed"
            if all(state == "failed" for state in states)
            else "partial"
        )
        return {
            "generation_group_id": group["id"],
            "variation_count": group["count"],
            "status": status,
            "jobs": [
                {
                    **job_status(job),
                    "index": index,
                    "attempt": group["slots"][index]["attempt"],
                }
                for index, job in enumerate(jobs)
            ],
        }

    @route("/generation-jobs/{job_id}")
    def generation_job(job_id: str):
        try:
            job = lookup_job(job_id)
        except HTTPException as exc:
            if exc.status_code == 404:
                return JSONResponse(
                    {"error": "Generation job not found"}, status_code=404
                )
            raise
        try:
            updates = [snapshot for _, snapshot in app.state.store.job_updates(job_id)]
            return job_status(job, updates)
        except (sqlite3.Error, OSError, ValueError) as exc:
            raise HTTPException(502, "Generation storage is unavailable") from exc
