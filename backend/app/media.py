"""Shared image bounds, initial PNG metadata and validated import decoding."""

import hashlib
import io
import json
import math

from PIL import Image, ImageOps, PngImagePlugin, UnidentifiedImageError

MEBIBYTE = 1024 * 1024
DEFAULT_IMPORT_MAX_BYTES = 32 * MEBIBYTE
MULTIPART_OVERHEAD_BYTES = MEBIBYTE
PREPARED_FILE_MAX_BYTES = 64 * MEBIBYTE
PREPARED_REQUEST_MAX_BYTES = 65 * MEBIBYTE
DEFAULT_MAX_IMAGE_PIXELS = 32_000_000
# Absolute decode envelope for an upload that is only read to prepare a smaller
# copy or a description. It is not a model size and never applies to provider
# output. It must stay below Pillow's own decompression-bomb error threshold.
DEFAULT_MAX_SOURCE_PIXELS = 120_000_000
ADAPTED_JPEG_QUALITY = 92
PNG_METADATA_KEY = "ImageDials"
PNG_METADATA_VERSION = 1
MAX_PNG_METADATA_BYTES = MEBIBYTE
EXIF_ORIENTATION_TAG = 274
SWAPPED_EXIF_ORIENTATIONS = frozenset({5, 6, 7, 8})


def display_dimensions(image):
    """Browser-oriented size from headers, without decoding a second full image."""
    return (
        (image.height, image.width)
        if image.getexif().get(EXIF_ORIENTATION_TAG) in SWAPPED_EXIF_ORIENTATIONS
        else image.size
    )


def positive_integer(env, name, default):
    raw = str(env.get(name, default))
    if not raw.isascii() or not raw.isdecimal() or int(raw) <= 0:
        raise ValueError(f"{name} must be a positive integer")
    return int(raw)


def image_pixel_limit(env):
    return positive_integer(env, "IMAGE_MAX_DECODED_PIXELS", DEFAULT_MAX_IMAGE_PIXELS)


def source_pixel_limit(env):
    """Upload decode envelope: at least the target limit, below Pillow's bomb error."""
    target = image_pixel_limit(env)
    ceiling = 2 * Image.MAX_IMAGE_PIXELS if Image.MAX_IMAGE_PIXELS else None
    if ceiling and target >= ceiling:
        raise ValueError(
            "IMAGE_MAX_DECODED_PIXELS must be below the Pillow bomb threshold"
        )
    if str(env.get("IMAGE_MAX_SOURCE_PIXELS", "")).strip() == "":
        limit = max(DEFAULT_MAX_SOURCE_PIXELS, target)
        return min(limit, ceiling - 1) if ceiling else limit
    limit = positive_integer(env, "IMAGE_MAX_SOURCE_PIXELS", DEFAULT_MAX_SOURCE_PIXELS)
    if limit < target:
        raise ValueError(
            "IMAGE_MAX_SOURCE_PIXELS must be at least IMAGE_MAX_DECODED_PIXELS"
        )
    if ceiling and limit >= ceiling:
        raise ValueError(f"IMAGE_MAX_SOURCE_PIXELS must be below {ceiling}")
    return limit


def fitted_dimensions(width, height, max_pixels):
    """Largest proportional size with width*height <= max_pixels (never upscaled)."""
    if width * height <= max_pixels:
        return width, height
    scale = math.sqrt(max_pixels / (width * height))
    w = max(1, math.floor(width * scale))
    h = max(1, math.floor(height * scale))
    # Keep the aspect within one pixel while staying inside the area bound.
    while w * h > max_pixels:
        if w / width >= h / height and w > 1:
            w -= 1
        else:
            h -= 1
    return w, h


def prepare_original_png(data, snapshot, max_pixels=DEFAULT_MAX_IMAGE_PIXELS):
    with Image.open(io.BytesIO(data)) as image:
        if image.format != "PNG" or image.width * image.height > max_pixels:
            raise ValueError("Provider must return a PNG within the image size limit")
        image = ImageOps.exif_transpose(image)
        snapshot.update(width=image.width, height=image.height)
        if snapshot.get("generation_type") == "image-edit":
            actual_aspect = (
                "1:1"
                if image.width == image.height
                else "3:2"
                if image.width > image.height
                else "2:3"
            )
            if snapshot.get("aspect") != actual_aspect:
                snapshot.setdefault("requested_aspect", snapshot.get("aspect"))
                snapshot["aspect"] = actual_aspect
        metadata = json.dumps(
            {"version": PNG_METADATA_VERSION, "image": snapshot}, ensure_ascii=False
        )
        if len(metadata.encode()) > MAX_PNG_METADATA_BYTES:
            raise ValueError("Generation metadata exceeds the PNG metadata limit")
        chunks = PngImagePlugin.PngInfo()
        chunks.add_itxt(PNG_METADATA_KEY, metadata)
        output = io.BytesIO()
        image.save(output, format="PNG", pnginfo=chunks)
    return output.getvalue()


def _vision_jpeg(image, vision_max_edge_pixels):
    # Metadata and full-resolution pixels never go to the description provider.
    image.thumbnail((vision_max_edge_pixels, vision_max_edge_pixels))
    rgba = image.convert("RGBA")
    rgb = Image.new("RGB", rgba.size, "white")
    rgb.paste(rgba, mask=rgba.getchannel("A"))
    output = io.BytesIO()
    rgb.save(output, format="JPEG")
    return output.getvalue()


def _open_bounded(data, max_pixels):
    image = Image.open(io.BytesIO(data))
    if image.format not in {"PNG", "JPEG", "WEBP"}:
        image.close()
        raise ValueError("Use a PNG, JPEG or WebP image")
    if image.width * image.height > max_pixels:
        image.close()
        raise ValueError("Image exceeds the decoded pixel limit")
    return image


def _draft_for(image, size):
    """Let JPEG decode at a DCT scale no smaller than `size` (stored orientation)."""
    if image.format == "JPEG":
        width, height = size
        if image.getexif().get(EXIF_ORIENTATION_TAG) in SWAPPED_EXIF_ORIENTATIONS:
            width, height = height, width
        image.draft(image.mode if image.mode in {"RGB", "L"} else None, (width, height))


def _has_alpha(image):
    return image.mode in {"RGBA", "LA", "PA"} or (
        image.mode == "P" and "transparency" in image.info
    )


def _encode_adapted(image, source_format, icc, max_bytes):
    """Encode resized pixels within `max_bytes`; ValueError if nothing fits."""
    alpha = image.mode == "RGBA"
    if alpha:
        attempts = [
            ("PNG", {}),
            ("WEBP", {"lossless": True}),
            ("WEBP", {"quality": ADAPTED_JPEG_QUALITY}),
        ]
    elif source_format == "JPEG":
        attempts = [("JPEG", {"quality": ADAPTED_JPEG_QUALITY, "subsampling": 0})]
    else:
        attempts = [
            ("PNG", {}),
            ("JPEG", {"quality": ADAPTED_JPEG_QUALITY, "subsampling": 0}),
        ]
    encoded_any = False
    for fmt, options in attempts:
        if fmt == "WEBP" and max(image.size) > 16383:
            continue
        pixels = (
            image
            if fmt != "JPEG" or image.mode in {"RGB", "L"}
            else image.convert("RGB")
        )
        output = io.BytesIO()
        extra = {"icc_profile": icc} if icc else {}
        try:
            pixels.save(output, format=fmt, **options, **extra)
        except (OSError, ValueError):
            continue
        encoded_any = True
        if output.tell() <= max_bytes:
            return output.getvalue(), fmt
    if not encoded_any:
        raise ValueError("The smaller copy could not be encoded on this server")
    raise ValueError("The smaller copy still exceeds the upload byte limit")


ADAPTED_CONTENT_TYPES = {"PNG": "image/png", "JPEG": "image/jpeg", "WEBP": "image/webp"}


def adapt_to_pixel_limit(data, target_pixels, source_pixels, max_bytes):
    """Proportionally shrink an upload to the target decoded-pixel area.

    The original bytes are never changed. Within the target nothing is decoded
    beyond headers and `adapted` is None. Otherwise EXIF orientation is
    applied first, then a Lanczos resize to the largest size whose area fits;
    no crop, no stretch. ValueError for undecodable, over-envelope, animated or
    unencodable input.
    """
    source_sha = hashlib.sha256(data).hexdigest()
    try:
        with _open_bounded(data, source_pixels) as opened:
            width, height = display_dimensions(opened)
            source = {"sha256": source_sha, "width": width, "height": height}
            if width * height <= target_pixels:
                return {"source": source, "adapted": None}
            if getattr(opened, "n_frames", 1) > 1:
                # A smaller copy would silently keep only the first frame.
                raise ValueError("Use a still image")
            target = fitted_dimensions(width, height, target_pixels)
            icc = opened.info.get("icc_profile")
            source_format = opened.format
            _draft_for(opened, target)
            image = ImageOps.exif_transpose(opened)
            source_mode = image.mode
            if _has_alpha(image):
                image = image.convert("RGBA")
            elif image.mode not in {"RGB", "L"}:
                image = image.convert("RGB")
            # Alpha and palette expansion retain RGB primaries, but mode
            # conversion (notably CMYK -> RGB) cannot retain the old profile.
            color_space = {
                "RGB": "RGB",
                "RGBA": "RGB",
                "P": "RGB",
                "PA": "RGB",
                "L": "GRAY",
                "LA": "GRAY",
            }
            if color_space.get(source_mode, source_mode) != color_space.get(
                image.mode, image.mode
            ):
                icc = None
            resized = image.resize(target, Image.Resampling.LANCZOS)
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
        raise ValueError("The upload is not a decodable image") from exc
    except MemoryError as exc:
        raise ValueError("The image is too large to prepare on this server") from exc
    try:
        encoded, fmt = _encode_adapted(resized, source_format, icc, max_bytes)
    except (OSError, MemoryError) as exc:
        raise ValueError(
            "The smaller copy could not be encoded on this server"
        ) from exc
    return {
        "source": source,
        "adapted": {
            "data": encoded,
            "sha256": hashlib.sha256(encoded).hexdigest(),
            "width": resized.width,
            "height": resized.height,
            "content_type": ADAPTED_CONTENT_TYPES[fmt],
        },
    }


def _embedded_snapshot(raw):
    """Decode an ImageDials chunk; ValueError names why it is not usable."""
    try:
        decoded = json.loads(raw)
    except (TypeError, ValueError, RecursionError) as exc:
        raise ValueError("Embedded image metadata is invalid") from exc
    if (
        not isinstance(decoded, dict)
        or decoded.get("version") != PNG_METADATA_VERSION
        or not isinstance(decoded.get("image"), dict)
    ):
        raise ValueError("Embedded image metadata version is unsupported")
    return decoded["image"]


def _metadata_text(raw):
    if not isinstance(raw, str) or len(raw.encode()) > MAX_PNG_METADATA_BYTES:
        raise ValueError("Embedded image metadata exceeds the size limit")
    return raw


def inspect_import(data, max_pixels, vision_max_edge_pixels, *, read_metadata=True):
    try:
        with _open_bounded(data, max_pixels) as image:
            width, height = display_dimensions(image)
            dimensions = {"width": width, "height": height}
            _draft_for(image, (vision_max_edge_pixels, vision_max_edge_pixels))
            image = ImageOps.exif_transpose(image)
            raw = image.info.get(PNG_METADATA_KEY) if read_metadata else None
            embedded = (
                _embedded_snapshot(_metadata_text(raw)) if raw is not None else None
            )
            return embedded, dimensions, _vision_jpeg(image, vision_max_edge_pixels)
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
        raise ValueError("The upload is not a decodable image") from exc
    except MemoryError as exc:
        raise ValueError("The image is too large to read on this server") from exc


def inspect_import_sources(data, max_pixels, vision_max_edge_pixels):
    """Decode an import and read its prompt sources without trusting them.

    `max_pixels` is the upload decode envelope: dimensions come from the
    original's oriented header, and only a description-sized copy is decoded
    (a JPEG at a reduced DCT scale), so a large photo is not refused.

    Decoding, file and size failures raise ValueError. An ImageDials chunk that
    is malformed, unsupported or does not match the decoded image is reported
    in `metadata_issue` instead, so the import can fall back to a ComfyUI
    prompt or a description rather than restoring a false snapshot.
    """
    try:
        with _open_bounded(data, max_pixels) as opened:
            info = dict(opened.info) if opened.format == "PNG" else {}
            width, height = display_dimensions(opened)
            dimensions = {"width": width, "height": height}
            _draft_for(opened, (vision_max_edge_pixels, vision_max_edge_pixels))
            image = ImageOps.exif_transpose(opened)
            embedded = None
            issue = None
            raw = info.get(PNG_METADATA_KEY)
            if raw is not None:
                text = _metadata_text(raw)
                try:
                    embedded = _embedded_snapshot(text)
                    recorded = (embedded.get("width"), embedded.get("height"))
                    if recorded != (None, None) and recorded != (
                        dimensions["width"],
                        dimensions["height"],
                    ):
                        raise ValueError(
                            "Embedded image metadata does not match this image's size"
                        )
                except ValueError as exc:
                    embedded, issue = None, str(exc)
            from .comfy_prompt import comfyui_positive_prompt

            comfy = comfyui_positive_prompt(info) if info else None
            return {
                "embedded": embedded,
                "metadata_issue": issue,
                "comfyui_prompt": comfy,
                "dimensions": dimensions,
                "jpeg": _vision_jpeg(image, vision_max_edge_pixels),
            }
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
        raise ValueError("The upload is not a decodable image") from exc
    except MemoryError as exc:
        raise ValueError("The image is too large to read on this server") from exc
