"""Measured pixel and PNG byte bounds for the browser's exact model copy."""

import hashlib
import io

from PIL import Image, UnidentifiedImageError

from .image_editing import _fit_to_budget, _png
from .media import display_dimensions, fitted_dimensions
from .reference_pixels import oriented_reference_pixels


def prepare_model_copy(data, target_pixels, source_pixels, byte_budget):
    """Return no copy when normalized pixels fit, otherwise an exact RGBA PNG.

    Source bytes and source identity remain untouched. A measured lossless
    encode decides the byte fit, including sources compressed efficiently by
    JPEG. Scaling uses Lanczos and premultiplied alpha, with bounded attempts.
    """
    try:
        with Image.open(io.BytesIO(data)) as source:
            if source.format not in {"PNG", "JPEG", "WEBP"}:
                raise ValueError("Use a PNG, JPEG or WebP image")
            if source.width * source.height > source_pixels:
                raise ValueError("Image exceeds the decoded pixel limit")
            if getattr(source, "n_frames", 1) > 1:
                raise ValueError("Use a still image")
            width, height = display_dimensions(source)
        descriptor = {
            "sha256": hashlib.sha256(data).hexdigest(),
            "width": width,
            "height": height,
        }
        image = oriented_reference_pixels(data)
        target = fitted_dimensions(width, height, target_pixels)
        if target != image.size:
            image = (
                image.convert("RGBa")
                .resize(target, Image.Resampling.LANCZOS)
                .convert("RGBA")
            )
        encoded = _png(image)
        if target == (width, height) and len(encoded) <= byte_budget:
            return {"source": descriptor, "adapted": None}
        if len(encoded) > byte_budget:
            encoded, target = _fit_to_budget(encoded, byte_budget, len(encoded))
        return {
            "source": descriptor,
            "adapted": {
                "data": encoded,
                "sha256": hashlib.sha256(encoded).hexdigest(),
                "width": target[0],
                "height": target[1],
                "content_type": "image/png",
            },
        }
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
        raise ValueError("The upload is not a decodable image") from exc
    except MemoryError as exc:
        raise ValueError("The image is too large to prepare on this server") from exc
