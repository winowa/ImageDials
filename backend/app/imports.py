"""Bounded multipart import analysis; analysis never inserts a library record."""

import base64
import hashlib
import json

from fastapi import HTTPException, Request
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile
from starlette.middleware.body_limit import RequestBodyLimitMiddleware

from .browser_settings import current_providers
from .media import (
    DEFAULT_IMPORT_MAX_BYTES,
    MULTIPART_OVERHEAD_BYTES,
    inspect_import_sources,
    positive_integer,
    source_pixel_limit,
)
from .providers import LanguageProvider, ProviderError, request
from .routing import canonical_paths, canonical_routes
from .vision_controls import choose_image_controls
from .wire import enabled, image_record, resolve_controls

DEFAULT_VISION_MAX_EDGE_PIXELS = 1280
MAX_DESCRIPTION_CHARACTERS = 4000


class UploadBodyLimits:
    """Apply the installed streaming body limiter only to documented upload routes."""

    def __init__(self, app, limits):
        self.app = app
        self.limited = {
            path: RequestBodyLimitMiddleware(app, max_body_size=limit)
            for path, limit in limits.items()
        }

    async def __call__(self, scope, receive, send):
        handler = (
            self.limited.get(scope.get("path"), self.app)
            if scope["type"] == "http"
            else self.app
        )
        await handler(scope, receive, send)


async def read_image_upload(request, max_bytes, *, text_fields=()):
    """Read exactly one bounded image upload and close its multipart resources."""
    async with request.form(
        max_files=1, max_fields=len(text_fields), max_part_size=max_bytes
    ) as form:
        if any(name not in {"image", "file", *text_fields} for name in form):
            raise HTTPException(400, "Unsupported upload field")
        upload = form.get("image") or form.get("file")
        if not isinstance(upload, UploadFile):
            raise HTTPException(400, "Choose an image to analyze")
        data = await upload.read(max_bytes + 1)
        if not data:
            raise HTTPException(400, "The uploaded image is empty")
        if len(data) > max_bytes:
            raise HTTPException(413, "The image exceeds the upload byte limit")
        return (
            (data, {name: form.get(name) for name in text_fields})
            if text_fields
            else data
        )


class ImageDescriptionProvider(LanguageProvider):
    def __init__(self, env):
        super().__init__(env)
        endpoint = env.get("DESCRIPTION_MODEL_ENDPOINT")
        if endpoint and endpoint != self.base:
            self.key = env.get("DESCRIPTION_MODEL_KEY", "")
        else:
            self.key = env.get("DESCRIPTION_MODEL_KEY") or self.key
        self.base = endpoint or self.base
        self.model = env.get("DESCRIPTION_MODEL_NAME") or self.model
        self.kind = env.get("IMAGE_DESCRIPTION_PROVIDER", "openai-compatible")
        if self.kind not in {"mock", "openai-compatible"}:
            raise ValueError(
                "IMAGE_DESCRIPTION_PROVIDER must be mock or openai-compatible"
            )

    def describe(self, jpeg):
        if self.kind == "mock":
            return "A mock image description of a small crafted object on a plain background"
        if not self.base:
            raise HTTPException(503, "Image description provider is not configured")
        try:
            model = self.model_id()
            response = request(
                self.base,
                "/chat/completions",
                {
                    "model": model,
                    "temperature": 0.3,
                    "max_tokens": 700,
                    "messages": [
                        {
                            "role": "system",
                            "content": "Describe the visible image as a concise image-generation idea. Include the subject, materials, colors, arrangement, lighting and setting that can actually be seen. Do not invent hidden facts, identities or text. Return only the description, without analysis or a preamble.",
                        },
                        {
                            "role": "user",
                            "content": [
                                {"type": "text", "text": "Describe this image."},
                                {
                                    "type": "image_url",
                                    "image_url": {
                                        "url": "data:image/jpeg;base64,"
                                        + base64.b64encode(jpeg).decode()
                                    },
                                },
                            ],
                        },
                    ],
                    "chat_template_kwargs": {"enable_thinking": False},
                },
                key=self.key,
            )
            choice = response["choices"][0]
            text = choice["message"]["content"]
            if (
                not isinstance(text, str)
                or not text.strip()
                or len(text) > MAX_DESCRIPTION_CHARACTERS
                or choice.get("finish_reason") == "length"
            ):
                raise ValueError("Invalid description")
            return text.strip()
        except (KeyError, IndexError, TypeError, ValueError) as exc:
            raise ProviderError(
                "Image description returned an invalid response"
            ) from exc


def register_import_routes(app, env):
    max_bytes = positive_integer(env, "IMPORT_MAX_BYTES", DEFAULT_IMPORT_MAX_BYTES)
    # Import reads metadata and a description-sized copy of the original only.
    max_pixels = source_pixel_limit(env)
    max_edge = positive_integer(
        env, "DESCRIPTION_MAX_EDGE_PIXELS", DEFAULT_VISION_MAX_EDGE_PIXELS
    )
    app.add_middleware(
        UploadBodyLimits,
        limits={
            path: max_bytes + MULTIPART_OVERHEAD_BYTES
            for path in canonical_paths(app, "/images/import-analysis")
        },
    )
    route = canonical_routes(app)

    def snapshot_record(embedded, dimensions, data):
        """A restorable record from valid embedded metadata; ValueError otherwise."""
        prompt = embedded.get("original_prompt") or embedded.get("prompt")
        controls = embedded.get("selected_controls")
        if controls is None:
            controls = image_record(embedded)["selected_controls"]
        if (
            not isinstance(prompt, str)
            or not prompt.strip()
            or not isinstance(controls, list)
        ):
            raise ValueError(
                "Embedded image snapshot needs a prompt and selected controls"
            )
        if controls:
            resolve_controls(controls)
        record = image_record(
            {
                **embedded,
                "prompt": prompt,
                "selected_controls": controls,
                "width": dimensions["width"],
                "height": dimensions["height"],
            }
        )
        record.update(
            storage_id="dropped-image",
            storage_type="browser-upload",
            image_url="",
            sha256=hashlib.sha256(data).hexdigest(),
        )
        return record, prompt

    async def describe(jpeg):
        """Description outcome; never claims success without provider text."""
        providers = current_providers(app)
        source = {
            "provider": providers.description.kind,
            "model": providers.description.model or "",
        }
        if not enabled(providers.env, "INFERENCE_ENABLED"):
            return {
                "status": "unavailable",
                "text": None,
                "message": "Inference is disabled",
                **source,
            }, HTTPException(503, "Inference is disabled")
        try:
            text = await run_in_threadpool(providers.description.describe, jpeg)
        except ProviderError as exc:
            return {
                "status": "error",
                "text": None,
                "message": str(exc),
                **source,
            }, HTTPException(502, str(exc))
        except HTTPException as exc:
            return {
                "status": "unavailable",
                "text": None,
                "message": str(exc.detail),
                **source,
            }, exc
        return {"status": "ready", "text": text, "message": None, **source}, None

    @route("/images/import-analysis", ("POST",))
    async def import_analysis(request: Request):
        """Restore metadata first, then a ComfyUI prompt, then the description.

        The description is requested for every valid image while inference is
        available, and is always reported with its actual status.
        """
        data, fields = await read_image_upload(
            request, max_bytes, text_fields=("context",)
        )
        context = None
        if fields["context"] is not None:
            try:
                raw_context = fields["context"]
                if not isinstance(raw_context, str) or len(raw_context) > 1000:
                    raise ValueError("Invalid import context")
                context = json.loads(raw_context)
                if (
                    not isinstance(context, dict)
                    or set(context)
                    != {"action", "revision", "request_id", "provider_id"}
                    or context["action"]
                    not in {"image-controls", "retry-controls", "description-only"}
                    or type(context["revision"]) is not int
                    or context["revision"] < 0
                    or any(
                        not isinstance(context[key], str)
                        or not 1 <= len(context[key]) <= 200
                        for key in ("request_id", "provider_id")
                    )
                ):
                    raise ValueError("Invalid import context")
            except (ValueError, TypeError) as exc:
                raise HTTPException(400, "Invalid import context") from exc
        try:
            sources = await run_in_threadpool(
                inspect_import_sources,
                data,
                max_pixels,
                min(max_edge, DEFAULT_VISION_MAX_EDGE_PIXELS) if context else max_edge,
            )
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

        record = prompt = None
        notice = sources["metadata_issue"]
        if sources["embedded"] is not None:
            try:
                record, prompt = snapshot_record(
                    sources["embedded"], sources["dimensions"], data
                )
            except (ValueError, KeyError, TypeError) as exc:
                notice = str(exc) or "Embedded image metadata is invalid"

        description, failure = (
            ({"status": "not-requested", "text": None}, None)
            if context and context["action"] == "retry-controls"
            else await describe(sources["jpeg"])
        )
        extra = {"metadata_notice": notice} if notice else {}
        if context:
            extra.update(
                source_sha256=hashlib.sha256(data).hexdigest(), binding=context
            )
        if context and context["action"] != "description-only":
            if record is not None:
                extra["image_controls"] = {"status": "restored"}
            elif not enabled(current_providers(app).env, "INFERENCE_ENABLED"):
                extra["image_controls"] = {
                    "status": "unavailable",
                    "message": "Inference is disabled",
                }
            else:
                extra["image_controls"] = await run_in_threadpool(
                    choose_image_controls,
                    current_providers(app).description,
                    sources["jpeg"],
                    extra["source_sha256"],
                    context,
                )
        if record is not None:
            return {
                "mode": "metadata",
                "image": record,
                "prompt": prompt,
                "prompt_source": "imagedials-metadata",
                "description": description,
                **extra,
            }
        if sources["comfyui_prompt"]:
            return {
                "mode": "comfyui",
                "prompt": sources["comfyui_prompt"],
                "prompt_source": "comfyui-workflow",
                "description": description,
                **extra,
            }
        if failure is not None:
            if context:
                return {
                    "mode": "description",
                    "prompt": "",
                    "description": description,
                    **extra,
                }
            raise failure
        return {
            "mode": "description",
            "prompt": description["text"],
            "provider": description.get("provider"),
            "prompt_source": "description",
            "description": description,
            **extra,
        }
