"""Full-image model editing followed by source-preserving region compositing.

The model receives the existing ordered references, not a native inference mask.
Only the final composite becomes a saved result or preview. Original bytes are
never changed; preservation means decoded, EXIF-oriented eight-bit RGBA pixels.
"""

import hashlib
import io

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageOps

from .media import DEFAULT_MAX_IMAGE_PIXELS
from .region_types import RectangleSelection, RegionSelection

REGION_COMPOSITOR_VERSION = "source-region-composite-v1"


def selection_mask(selection: RegionSelection):
    """Rectangles have exclusive right/bottom bounds; brush circles are clipped."""
    hard = Image.new("L", (selection.width, selection.height), 0)
    draw = ImageDraw.Draw(hard)
    for shape in selection.shapes:
        if isinstance(shape, RectangleSelection):
            draw.rectangle(
                (
                    shape.x,
                    shape.y,
                    shape.x + shape.width - 1,
                    shape.y + shape.height - 1,
                ),
                fill=255,
            )
        else:
            if len(shape.points) > 1:
                draw.line(
                    shape.points, fill=255, width=shape.radius * 2 + 1, joint="curve"
                )
            for x, y in shape.points:
                draw.ellipse(
                    (
                        x - shape.radius,
                        y - shape.radius,
                        x + shape.radius,
                        y + shape.radius,
                    ),
                    fill=255,
                )
    if hard.getbbox() is None:
        raise ValueError("Choose a nonempty region")
    if not selection.feather:
        return hard, hard
    # Blur inward only: feathering may never introduce edits outside the hard mask.
    blended = ImageChops.multiply(
        hard, hard.filter(ImageFilter.GaussianBlur(selection.feather))
    )
    if blended.getbbox() is None:
        raise ValueError("Enlarge the selection or reduce feathering")
    return hard, blended


def _oriented_rgba(data, max_pixels, *, provider=False):
    with Image.open(io.BytesIO(data)) as source:
        allowed = {"PNG"} if provider else {"PNG", "JPEG", "WEBP"}
        if source.format not in allowed:
            raise ValueError("Unsupported region-edit image format")
        if source.width * source.height > max_pixels:
            raise ValueError("Region editing exceeds the decoded pixel limit")
        source.load()
        return ImageOps.exif_transpose(source).convert("RGBA")


def composite_region(
    source_bytes,
    generated_bytes,
    selection: RegionSelection,
    max_pixels=DEFAULT_MAX_IMAGE_PIXELS,
):
    """Return a new base-sized PNG and reproducible selection diagnostics."""
    if hashlib.sha256(source_bytes).hexdigest() != selection.source_sha256:
        raise ValueError("The selected region belongs to a different base image")
    base = _oriented_rgba(source_bytes, max_pixels)
    if base.size != (selection.width, selection.height):
        raise ValueError("The selected region does not match the oriented base size")
    generated = _oriented_rgba(generated_bytes, max_pixels, provider=True)
    provider_size = generated.size
    if generated.size != base.size:
        generated = ImageOps.fit(
            generated, base.size, method=Image.Resampling.LANCZOS, centering=(0.5, 0.5)
        )
    hard, mask = selection_mask(selection)
    result = Image.composite(generated, base, mask)
    result.info.clear()
    result.getexif().clear()
    output = io.BytesIO()
    result.save(output, format="PNG")
    bounds = hard.getbbox()
    return output.getvalue(), {
        "method": "generated-image-composite",
        "native_mask": False,
        "compositor_version": REGION_COMPOSITOR_VERSION,
        "source_sha256": selection.source_sha256,
        "source_rgba_sha256": hashlib.sha256(base.tobytes()).hexdigest(),
        "mask_sha256": hashlib.sha256(mask.tobytes()).hexdigest(),
        "mask_encoding": "row-major-l8",
        "selected_pixels": hard.histogram()[255],
        "bounds": {
            "x": bounds[0],
            "y": bounds[1],
            "width": bounds[2] - bounds[0],
            "height": bounds[3] - bounds[1],
        },
        "provider_dimensions": {"width": provider_size[0], "height": provider_size[1]},
        "output_dimensions": {"width": base.width, "height": base.height},
        "provider_fit": "cover-center",
        "outside_selection": "exact-rgba8",
    }
