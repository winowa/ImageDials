"""Transient model-sized copies of reference uploads over the decoded pixel limit.

Nothing is stored and no provider is called: the original arrives, a
proportionally smaller copy (or nothing, when it already fits) goes back, and
both hashes are reported so the browser can bind the copy to its original.
"""

import asyncio

from fastapi import HTTPException, Query, Request, Response
from starlette.concurrency import run_in_threadpool

from .imports import MULTIPART_OVERHEAD_BYTES, UploadBodyLimits, read_image_upload
from .media import (
    DEFAULT_IMPORT_MAX_BYTES,
    adapt_to_pixel_limit,
    image_pixel_limit,
    positive_integer,
    source_pixel_limit,
)
from .providers import ProviderError
from .reference_model_copy import prepare_model_copy
from .reference_types import MAX_REFERENCE_BYTES
from .routing import canonical_paths, canonical_routes

# Large decodes are memory-bound; one at a time per server process.
ADAPTATION_CONCURRENCY = 1


def _headers(result):
    source = result["source"]
    headers = {
        "Cache-Control": "no-store",
        "X-Source-SHA256": source["sha256"],
        "X-Source-Width": str(source["width"]),
        "X-Source-Height": str(source["height"]),
    }
    adapted = result["adapted"]
    if adapted:
        headers.update(
            {
                "X-Adapted-SHA256": adapted["sha256"],
                "X-Adapted-Width": str(adapted["width"]),
                "X-Adapted-Height": str(adapted["height"]),
            }
        )
    return headers


def register_reference_adaptation_routes(app, env):
    max_bytes = positive_integer(env, "IMPORT_MAX_BYTES", DEFAULT_IMPORT_MAX_BYTES)
    target_pixels = image_pixel_limit(env)
    source_pixels = source_pixel_limit(env)
    output_bytes = min(max_bytes, MAX_REFERENCE_BYTES)
    gate = asyncio.Semaphore(ADAPTATION_CONCURRENCY)
    app.add_middleware(
        UploadBodyLimits,
        limits={
            path: max_bytes + MULTIPART_OVERHEAD_BYTES
            for path in canonical_paths(app, "/images/reference-adapt")
        },
    )
    route = canonical_routes(app)

    @route("/images/reference-adapt", ("POST",))
    async def reference_adapt(
        request: Request,
        max_normalized_bytes: int | None = Query(default=None, ge=1024),
    ):
        """200 with the smaller copy's bytes, or 204 when the upload already fits."""
        data = await read_image_upload(request, max_bytes)
        async with gate:
            try:
                result = await run_in_threadpool(
                    prepare_model_copy
                    if max_normalized_bytes
                    else adapt_to_pixel_limit,
                    data,
                    target_pixels,
                    source_pixels,
                    min(output_bytes, max_normalized_bytes or output_bytes),
                )
            except (ValueError, ProviderError) as exc:
                text = str(exc)
                status = 413 if "limit" in text or "too large" in text else 400
                if "decoded pixel limit" in text:
                    text = "Image is larger than this server can prepare"
                raise HTTPException(status, text) from exc
        adapted = result["adapted"]
        if adapted is None:
            return Response(status_code=204, headers=_headers(result))
        return Response(
            content=adapted["data"],
            media_type=adapted["content_type"],
            headers=_headers(result),
        )
