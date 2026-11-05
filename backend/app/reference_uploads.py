"""Multipart generation requests bound to ordered, immutable reference pixels."""

import hashlib
import io
import json
from pathlib import PurePosixPath

from fastapi import HTTPException
from PIL import Image, UnidentifiedImageError
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile

from .media import display_dimensions, image_pixel_limit
from .reference_types import (
    MAX_REFERENCE_BYTES,
    MAX_REFERENCE_REQUEST_BYTES,
    MAX_REFERENCE_SLOTS,
    MAX_REFERENCE_TOTAL_BYTES,
    ReferenceDescriptor,
    ReferenceImage,
)

FORM_REQUEST_FIELD = "request"
REFERENCE_FILE_PREFIX = "reference_"
REFERENCE_CONTENT_TYPES = {
    "PNG": "image/png",
    "JPEG": "image/jpeg",
    "WEBP": "image/webp",
}


def describe_upload(data, filename, descriptor, index, max_pixels):
    """Validate a bounded source and preserve its original bytes for the worker."""
    if hashlib.sha256(data).hexdigest() != descriptor.sha256:
        raise ValueError("Reference pixels do not match their description hash")
    name = PurePosixPath((filename or "reference.png").replace("\\", "/")).name
    if not name or len(name) > 255 or any(ord(c) < 32 or ord(c) == 127 for c in name):
        raise ValueError("Reference filename is invalid")
    try:
        with Image.open(io.BytesIO(data)) as image:
            content_type = REFERENCE_CONTENT_TYPES.get(image.format)
            if content_type is None:
                raise ValueError("Use a PNG, JPEG or WebP reference image")
            if image.width * image.height > max_pixels:
                raise ValueError("Reference exceeds the decoded pixel limit")
            width, height = display_dimensions(image)
            image.load()
    except (OSError, UnidentifiedImageError, Image.DecompressionBombError) as error:
        raise ValueError("Reference image cannot be decoded") from error
    source = descriptor.source
    if source is not None and (
        source.sha256 == descriptor.sha256
        or source.width * source.height <= width * height
        # A prepared copy keeps the original's shape within rounding.
        or abs(width * source.height - height * source.width)
        > source.width + source.height
    ):
        raise ValueError("Reference source does not describe a smaller copy")
    metadata = ReferenceImage(
        **descriptor.model_dump(),
        filename=name,
        index=index,
        dimensions={"width": width, "height": height},
        content_type=content_type,
    )
    return metadata, {
        "data": data,
        "sha256": descriptor.sha256,
        "filename": name,
        "role": descriptor.role,
        "description": descriptor.description,
    }


async def generation_request(request, env, renderer=None):
    """JSON stays text-only; multipart sends one request plus matching files.

    The ordered descriptors are checked against the selected `renderer`'s
    effective model limit before any file is read or decoded; the absolute
    slot envelope bounds multipart parsing for every provider.
    """
    if (
        request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
        != "multipart/form-data"
    ):
        body = await request.json()
        if not isinstance(body, dict):
            raise ValueError("Provide a generation object")
        if body.get("reference_images") or body.get("reference_context"):
            raise ValueError("Attach reference image files with a multipart request")
        return body, [], ()

    async with request.form(
        max_files=MAX_REFERENCE_SLOTS, max_fields=1, max_part_size=MAX_REFERENCE_BYTES
    ) as form:
        raw = form.get(FORM_REQUEST_FIELD)
        if not isinstance(raw, str) or len(raw.encode()) > MAX_REFERENCE_REQUEST_BYTES:
            raise ValueError("Provide a bounded JSON request field")
        body = json.loads(raw)
        if not isinstance(body, dict):
            raise ValueError("Provide a generation object")
        descriptions = body.get("reference_images")
        if (
            not isinstance(descriptions, list)
            or not 1 <= len(descriptions) <= MAX_REFERENCE_SLOTS
        ):
            raise ValueError(
                f"Provide 1 to {MAX_REFERENCE_SLOTS} ordered reference descriptors"
            )
        if renderer is not None:
            from .reference_capability import too_many_references

            problem = too_many_references(renderer, len(descriptions))
            if problem:
                raise ValueError(problem)
        descriptors = [
            ReferenceDescriptor.model_validate(value) for value in descriptions
        ]
        if len({item.id for item in descriptors}) != len(descriptors):
            raise ValueError("Reference identities must be distinct")
        expected = {
            FORM_REQUEST_FIELD,
            *(f"{REFERENCE_FILE_PREFIX}{n}" for n in range(1, len(descriptors) + 1)),
        }
        fields = list(form.multi_items())
        if len(fields) != len(expected) or {key for key, _ in fields} != expected:
            raise ValueError("Reference files must match their ordered descriptors")
        total = 0
        metadata, inputs = [], []
        for index, descriptor in enumerate(descriptors, start=1):
            upload = form.get(f"{REFERENCE_FILE_PREFIX}{index}")
            if not isinstance(upload, UploadFile):
                raise ValueError("Attach each reference image file")
            data = await upload.read(MAX_REFERENCE_BYTES + 1)
            total += len(data)
            if len(data) > MAX_REFERENCE_BYTES or total > MAX_REFERENCE_TOTAL_BYTES:
                raise HTTPException(
                    413, "Reference images exceed the upload byte limit"
                )
            if not data:
                raise ValueError("Reference images must not be empty")
            item, pixels = await run_in_threadpool(
                describe_upload,
                data,
                upload.filename,
                descriptor,
                index,
                image_pixel_limit(env),
            )
            metadata.append(item)
            inputs.append(pixels)
        return body, metadata, tuple(inputs)
