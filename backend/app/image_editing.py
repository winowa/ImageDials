"""Bounded, source-bound preparation of user supplied image references."""

import hashlib
import io
import math
import re
from pathlib import PurePath

from PIL import Image, UnidentifiedImageError

from .media import DEFAULT_MAX_IMAGE_PIXELS
from .providers import ProviderError
from .reference_pixels import oriented_reference_pixels
from .reference_types import (
    MAX_REFERENCE_BYTES,
    MAX_REFERENCE_DESCRIPTION_CHARACTERS,
    MAX_REFERENCE_SLOTS,
    MAX_REFERENCE_TOTAL_BYTES,
)

REFERENCE_MARKER = "$reference_images"
QWEN_ENCODER_CLASS = "TextEncodeQwenImage21"
# Adapter bound: numbered `images.image_N` inputs this adapter will create on
# the native autogrow encoder. It must not be lower than a supported model's
# documented maximum (Qwen-Image-2.1: 10); the model limit applies first.
MAX_QWEN_REFERENCE_SLOTS = 16
# Bounds for the oriented PNG copies sent to the provider. They match the
# upload limits, but are separate: a compressed upload that fits can still
# expand past them as lossless pixels, and is then fitted rather than refused.
MAX_NORMALIZED_REFERENCE_BYTES = MAX_REFERENCE_BYTES
MAX_NORMALIZED_TOTAL_BYTES = MAX_REFERENCE_TOTAL_BYTES


# Fitted copies aim slightly under their byte budget so one measured re-encode
# normally suffices; the attempt count is fixed, so no loop can run unbounded.
BUDGET_HEADROOM = 0.97
MAX_FIT_ATTEMPTS = 4


def _oriented_pixels(data):
    """Decode, apply EXIF orientation and drop every metadata field."""
    return oriented_reference_pixels(data)


def _png(image):
    output = io.BytesIO()
    image.save(output, format="PNG", optimize=False)
    return output.getvalue()


def _byte_budgets(sizes, per_item, total):
    """Common byte cap (water level) over full-resolution normalized sizes.

    Copies at or below the cap keep their exact bytes; larger copies are each
    fitted to the cap, which never exceeds `per_item` and makes the set fit
    `total`.
    """
    cap = per_item
    if sum(min(size, cap) for size in sizes) > total:
        remaining, count = total, len(sizes)
        cap = 0
        for size in sorted(sizes):
            share = remaining // count
            if size <= share:
                remaining -= size
                count -= 1
                continue
            cap = share
            break
    return [min(size, cap) for size in sizes]


def _fit_to_budget(data, budget, full_size):
    """Lossless PNG model copy within `budget` bytes, proportionally scaled.

    Transparent sources are resized premultiplied so hidden colors cannot
    bleed into edges. RGBA encoding matches subsequent normalization exactly.
    """
    image = _oriented_pixels(data)
    width, height = image.size
    opaque = image.getchannel("A").getextrema() == (255, 255)
    working = image if opaque else image.convert("RGBa")
    estimate = full_size
    scale = min(1.0, math.sqrt(budget * BUDGET_HEADROOM / estimate))
    for _ in range(MAX_FIT_ATTEMPTS):
        size = (max(1, math.floor(width * scale)), max(1, math.floor(height * scale)))
        if size == (width, height):
            fitted = working
        else:
            fitted = working.resize(size, Image.Resampling.LANCZOS)
        if not opaque:
            fitted = fitted.convert("RGBA")
        encoded = _png(fitted)
        if len(encoded) <= budget:
            return encoded, fitted.size
        scale *= min(0.95, math.sqrt(budget * BUDGET_HEADROOM / len(encoded)))
    raise ProviderError("A reference could not be prepared within the model byte limit")


def normalize_references(
    references, max_pixels=DEFAULT_MAX_IMAGE_PIXELS, *, max_count=MAX_REFERENCE_SLOTS
):
    """Validate and normalize immutable reference payloads without mutating them.

    `max_count` is the selected model's effective limit; the absolute slot
    envelope still applies to any caller.

    Each normalized copy is an oriented, metadata-free PNG. When copies would
    exceed the per-reference or combined normalized byte limit, oversized
    copies are proportionally scaled by one common byte ratio instead of
    failing; those entries report `fitted_from` with their oriented size.
    Sets that already fit produce exactly the same bytes as before.
    """
    if not isinstance(references, (tuple, list)):
        raise ProviderError("Image references must be a list")
    limit = min(max_count, MAX_REFERENCE_SLOTS)
    if len(references) > limit:
        raise ProviderError(
            f"At most {limit} reference image{'' if limit == 1 else 's'} allowed"
        )
    total = 0
    validated = []
    for index, reference in enumerate(references, start=1):
        if not isinstance(reference, dict):
            raise ProviderError("Image reference is invalid")
        data = reference.get("data")
        filename = reference.get("filename")
        role = reference.get("role")
        description = reference.get("description")
        if not isinstance(data, bytes) or not data:
            raise ProviderError("Image reference bytes are required")
        if len(data) > MAX_REFERENCE_BYTES:
            raise ProviderError("A reference image exceeds the 32 MiB limit")
        total += len(data)
        if total > MAX_REFERENCE_TOTAL_BYTES:
            raise ProviderError("Reference images exceed the 64 MiB total limit")
        if not isinstance(filename, str) or not filename.strip():
            raise ProviderError("Image reference filename is invalid")
        if not isinstance(role, str) or not role.strip() or len(role) > 80:
            raise ProviderError("Image reference role is invalid")
        if (
            not isinstance(description, str)
            or len(description) > MAX_REFERENCE_DESCRIPTION_CHARACTERS
        ):
            raise ProviderError("Image reference description is invalid")
        name = PurePath(filename.replace("\\", "/")).name
        if name in {"", ".", ".."} or any(ord(char) < 32 for char in name):
            raise ProviderError("Image reference filename is invalid")
        original_sha = hashlib.sha256(data).hexdigest()
        supplied_sha = reference.get("sha256")
        if supplied_sha is not None and supplied_sha != original_sha:
            raise ProviderError("Image reference checksum does not match its bytes")
        validated.append((index, data, name, role, description, original_sha))

    per_item = MAX_NORMALIZED_REFERENCE_BYTES
    combined = MAX_NORMALIZED_TOTAL_BYTES
    prepared = []
    kept = 0
    for index, data, name, role, description, original_sha in validated:
        try:
            with Image.open(io.BytesIO(data)) as source:
                if source.format not in {"PNG", "JPEG", "WEBP"}:
                    raise ProviderError("Use a PNG, JPEG, or WebP reference image")
                if source.width <= 0 or source.height <= 0:
                    raise ValueError("empty image")
                if source.width * source.height > max_pixels:
                    raise ProviderError(
                        "Image reference exceeds the decoded pixel limit"
                    )
            image = _oriented_pixels(data)
            size = image.size
            encoded = _png(image)
            del image
        except ProviderError:
            raise
        except (
            OSError,
            ValueError,
            UnidentifiedImageError,
            Image.DecompressionBombError,
        ) as exc:
            raise ProviderError("Image reference could not be decoded") from exc
        # Only bytes that can be sent unchanged are retained between passes.
        fits = len(encoded) <= per_item and kept + len(encoded) <= combined
        kept += len(encoded) if fits else 0
        prepared.append(
            {
                "full_size": len(encoded),
                "data": encoded if fits else None,
                "size": size,
                "fields": (index, data, name, role, description, original_sha),
            }
        )

    budgets = _byte_budgets(
        [item["full_size"] for item in prepared], per_item, combined
    )
    normalized = []
    for item, budget in zip(prepared, budgets, strict=True):
        index, data, name, role, description, original_sha = item["fields"]
        width, height = item["size"]
        entry = {}
        if item["full_size"] <= budget and item["data"] is not None:
            normalized_bytes, fitted = item["data"], (width, height)
        elif item["full_size"] <= budget:
            normalized_bytes, fitted = _png(_oriented_pixels(data)), (width, height)
        else:
            try:
                normalized_bytes, fitted = _fit_to_budget(
                    data, budget, item["full_size"]
                )
            except (OSError, ValueError, MemoryError) as exc:
                raise ProviderError("Image reference could not be decoded") from exc
            entry["fitted_from"] = {"width": width, "height": height}
        normalized.append(
            {
                "data": normalized_bytes,
                "filename": name,
                "role": role.strip(),
                "description": description.strip(),
                "sha256": original_sha,
                "normalized_sha256": hashlib.sha256(normalized_bytes).hexdigest(),
                "width": fitted[0],
                "height": fitted[1],
                "index": index,
                **entry,
            }
        )
    return normalized


def load_edit_workflow(path):
    """Load and validate the explicit reference-edit graph before any upload."""
    import json
    from pathlib import Path

    try:
        graph = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError) as exc:
        raise ProviderError("Image editing workflow configuration is invalid") from exc
    if not isinstance(graph, dict) or not graph:
        raise ProviderError("Image editing workflow configuration is invalid")
    matches = []
    for node_id, node in graph.items():
        if not isinstance(node, dict):
            continue
        inputs = node.get("inputs")
        if isinstance(inputs, dict) and REFERENCE_MARKER in inputs:
            matches.append((node_id, node, inputs))
    if len(matches) != 1:
        raise ProviderError("Image editing workflow must have one reference marker")
    encoder_id, encoder, inputs = matches[0]
    if (
        encoder.get("class_type") != QWEN_ENCODER_CLASS
        or inputs[REFERENCE_MARKER] is not True
    ):
        raise ProviderError(
            "Image editing reference marker must be on a Qwen image encoder"
        )
    if inputs.get("prompt") != "$prompt":
        raise ProviderError("Image editing encoder must accept the final prompt")
    if any(re.fullmatch(r"images\.image_\d+", key) for key in inputs):
        raise ProviderError("Image editing encoder already has reference links")
    samplers = []
    for node_id, node in graph.items():
        node_inputs = node.get("inputs") if isinstance(node, dict) else None
        if not isinstance(node_inputs, dict):
            continue
        positive = node_inputs.get("positive")
        negative = node_inputs.get("negative")
        if (
            node.get("class_type") in {"KSampler", "KSamplerAdvanced"}
            and isinstance(positive, list)
            and len(positive) == 2
            and positive == [encoder_id, 0]
            and isinstance(negative, list)
            and len(negative) == 2
            and negative == [encoder_id, 1]
        ):
            samplers.append((node_id, node_inputs))
    if len(samplers) != 1 or samplers[0][1].get("latent_image") != [encoder_id, 2]:
        raise ProviderError(
            "Image editing sampler must use the Qwen encoder latent output"
        )
    for node in graph.values():
        if (
            isinstance(node, dict)
            and isinstance(node.get("class_type"), str)
            and "empty" in node["class_type"].lower()
            and "latent" in node["class_type"].lower()
        ):
            raise ProviderError(
                "Image editing workflow contains a separate latent path"
            )
        node_inputs = node.get("inputs") if isinstance(node, dict) else None
        latent = (
            node_inputs.get("latent_image") if isinstance(node_inputs, dict) else None
        )
        if isinstance(latent, list) and len(latent) == 2 and latent[0] != encoder_id:
            raise ProviderError(
                "Image editing workflow contains a separate latent path"
            )
    return graph, encoder_id


def add_reference_nodes(graph, encoder_id, uploaded):
    """Add numeric Qwen image inputs while preserving their supplied order."""
    if len(uploaded) > MAX_QWEN_REFERENCE_SLOTS:
        raise ProviderError("Too many reference images for the configured encoder")
    result = {key: value for key, value in graph.items()}
    node_ids = [int(key) for key in result if str(key).isdigit()]
    next_id = max(node_ids, default=0) + 1
    encoder = result[encoder_id]
    inputs = dict(encoder["inputs"])
    inputs.pop(REFERENCE_MARKER)
    for index, image_ref in enumerate(uploaded, start=1):
        node_id = str(next_id)
        next_id += 1
        result[node_id] = {
            "class_type": "LoadImage",
            "inputs": {"image": image_ref},
        }
        inputs[f"images.image_{index}"] = [node_id, 0]
    result[encoder_id] = {**encoder, "inputs": inputs}
    return result
