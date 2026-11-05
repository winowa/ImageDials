"""Deterministic watermark geometry, corner scoring and image-derived colors.

Placement measures how visually busy each candidate corner is where the mark
will actually draw. Colors come from the image itself: the accent keeps an
actual palette hue, its chroma is bounded, and only its lightness moves until
it separates from the local background. Diagnostics report what was measured,
including the share of footprint pixels each endpoint clears; nothing here
claims contrast it did not measure.
"""

import hashlib
import io
import math

from PIL import Image, ImageChops, ImageOps, ImageStat

from .watermark_policy import WATERMARK_GEOMETRY_FINGERPRINT, WATERMARK_POLICY

ANALYSIS_VERSION = WATERMARK_POLICY["analysisVersion"]
RENDERER_VERSION = WATERMARK_POLICY["rendererVersion"]
CORNERS = ("top-left", "top-right", "bottom-left", "bottom-right")
# Equal-busyness corners resolve to the conventional signature corners first.
CORNER_PREFERENCE = ("bottom-left", "bottom-right", "top-left", "top-right")
IMAGE_EDGES_FRAME = "image-edges"

# Pixel sources. Analysis runs on one bounded working copy: large enough that a
# texture at glyph-stroke scale survives, small enough to stay fast.
ANALYSIS_EDGE_PIXELS = 1024
PALETTE_SAMPLE_EDGE_PIXELS = 256
PALETTE_COLOR_COUNT = 16
LOCAL_PALETTE_COLOR_COUNT = 8
LOCAL_SAMPLE_PADDING_FRACTION = 0.04

# Busyness. Every term is normalized to 0..1 before weighting. Structure is
# measured on gamma-encoded luma so dark textures count as much as light ones.
EDGE_SATURATION_LEVEL = 24  # luma steps (of 255) that count as a full edge
TONAL_SPREAD_SCALE = 128  # luma standard deviation of a black/white split
COLOR_QUANTIZATION_SHIFT_BITS = 4
# Edge activity leads: a smooth tonal gradient is not busy, whereas grain and
# foliage are, even when their overall spread is small.
BUSYNESS_EDGE_WEIGHT = 0.60
BUSYNESS_TONAL_WEIGHT = 0.20
BUSYNESS_ENTROPY_WEIGHT = 0.20
# Text is drawn against the corner-side edge of the square, so that band is
# where the mark nearly always lies. The full square covers taller content and
# artwork; the inward neighborhood penalizes a smooth patch beside a subject.
ANCHOR_BAND_FRACTION = 0.45
BAND_WEIGHT = 0.45
FOOTPRINT_WEIGHT = 0.30
CONTEXT_WEIGHT = 0.25
CONTEXT_SCALE = 1.6
# Legibility: the share of footprint pixels below the practical 2.1 floor.
# The aspirational 4.5 target must not push a mark into a busier corner.
# Large contrasting patches have little edge activity but split any single
# mark color between readable and unreadable halves; this measures that.
LEGIBILITY_WEIGHT = 0.25
# Corners this close in placement score are equally good; the conventional
# corner order decides.
PLACEMENT_TIE_MARGIN = 0.01

# Color. Perceptual OKLab/OKLCH coordinates keep hue stable while lightness
# changes, unlike HLS, whose saturation inflates mid-tones into neon.
CHROMATIC_MINIMUM_CHROMA = 0.035
CHROMATIC_MINIMUM_WEIGHT = 0.04
NEUTRAL_MAXIMUM_CHROMA = 0.02
ACCENT_MAXIMUM_CHROMA = 0.12
CHROMA_PREFERENCE_SCALE = 0.05
SECONDARY_MINIMUM_HUE_DEGREES = 12
SECONDARY_MAXIMUM_HUE_DEGREES = 90
GRADIENT_MAXIMUM_HUE_DRIFT_DEGREES = 28
TONAL_END_CHROMA_FACTOR = 0.8
GRADIENT_END_LIGHTNESS_STEP = 0.08
MINIMUM_ENDPOINT_LIGHTNESS_STEP = 0.04
ACCENT_MINIMUM_LIGHTNESS = 0.14
ACCENT_MAXIMUM_LIGHTNESS = 0.97
LIGHTNESS_SEARCH_STEP = 0.005
CONTRAST_TARGET_RATIO = 4.5
CONTRAST_MINIMUM_RATIO = 2.1
MATERIAL_LOCAL_WEIGHT = 0.10
SEPARATION_DARK_LIGHTNESS = 0.17
SEPARATION_LIGHT_LIGHTNESS = 0.97
SEPARATION_MAXIMUM_CHROMA = 0.03
GLOBAL_HUE_WEIGHT = 0.5
NEIGHBORHOOD_HUE_WEIGHT = 0.5


def round_pixel(value):
    """Match JavaScript Math.round for nonnegative image coordinates."""
    return math.floor(value + 0.5)


def _reference_ratio(policy, width, height):
    ratios = policy.get("sizeReferenceAspectRatios") or policy["safeAspectRatios"]
    if width > height:
        key = "landscape"
    elif width < height or policy.get("placementFrame") != IMAGE_EDGES_FRAME:
        # Older policies sized and placed square images in the portrait frame.
        key = "portrait"
    else:
        key = "square"
    numerator, denominator = ratios[key]
    return numerator / denominator


def watermark_geometry(width, height, corner="bottom-left", policy=None):
    """The mark's square in source pixels, identical to watermarkGeometry.js.

    Size scales with the short side of the largest reference-aspect rectangle
    in the image, so square and very wide images keep a modest mark. Under the
    `image-edges` frame the inset is measured from the image's own edges and is
    the same on both axes; older policies placed the mark inside a centred
    print-safe rectangle instead.
    """
    policy = WATERMARK_POLICY if policy is None else policy
    if type(width) is not int or type(height) is not int or min(width, height) <= 0:
        raise ValueError("Image dimensions must be positive integer pixels")
    corner = corner.strip().lower() if isinstance(corner, str) else ""
    if corner not in CORNERS:
        corner = "bottom-left"
    ratio = _reference_ratio(policy, width, height)
    reference_width = min(width, height * ratio)
    reference_height = reference_width / ratio
    shorter = min(reference_width, reference_height)
    size = min(width, height, max(1, round_pixel(shorter * policy["sizeFraction"])))
    if policy.get("placementFrame") == IMAGE_EDGES_FRAME:
        inset = round_pixel(min(width, height) * policy["insetFraction"])
        frame = {"x": 0, "y": 0, "width": width, "height": height}
    else:
        inset = round_pixel(shorter * policy["insetFraction"])
        frame = {
            "x": (width - reference_width) / 2,
            "y": (height - reference_height) / 2,
            "width": reference_width,
            "height": reference_height,
        }
    x = (
        frame["x"] + inset
        if corner.endswith("left")
        else frame["x"] + frame["width"] - inset - size
    )
    y = (
        frame["y"] + inset
        if corner.startswith("top")
        else frame["y"] + frame["height"] - inset - size
    )
    return {
        "corner": corner,
        "x": min(width - size, max(0, round_pixel(x))),
        "y": min(height - size, max(0, round_pixel(y))),
        "size": size,
        "inset": inset,
        "frame": policy.get("placementFrame", "safe-rectangle"),
        "placement_rectangle": frame,
    }


# --- color science ---------------------------------------------------------


def rgb_hex(rgb):
    return "#" + "".join(
        f"{min(255, max(0, round_pixel(channel))):02x}" for channel in rgb
    )


def hex_rgb(color):
    return tuple(int(color[index : index + 2], 16) for index in (1, 3, 5))


def _linear(channel):
    value = channel / 255
    return value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4


def _encoded(value):
    value = min(1.0, max(0.0, value))
    encoded = (
        12.92 * value if value <= 0.0031308 else 1.055 * value ** (1 / 2.4) - 0.055
    )
    return encoded * 255


def relative_luminance(rgb):
    """WCAG relative luminance from linear sRGB."""
    red, green, blue = (_linear(channel) for channel in rgb)
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue


def contrast_ratio(first, second):
    light, dark = sorted(
        (relative_luminance(first), relative_luminance(second)), reverse=True
    )
    return (light + 0.05) / (dark + 0.05)


def _luminance_contrast(first, second):
    light, dark = max(first, second), min(first, second)
    return (light + 0.05) / (dark + 0.05)


def rgb_oklch(rgb):
    red, green, blue = (_linear(channel) for channel in rgb)
    long = 0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue
    medium = 0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue
    short = 0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue
    long, medium, short = (
        math.copysign(abs(v) ** (1 / 3), v) for v in (long, medium, short)
    )
    lightness = 0.2104542553 * long + 0.7936177850 * medium - 0.0040720468 * short
    a = 1.9779984951 * long - 2.4285922050 * medium + 0.4505937099 * short
    b = 0.0259040371 * long + 0.7827717662 * medium - 0.8086757660 * short
    return lightness, math.hypot(a, b), math.degrees(math.atan2(b, a)) % 360


def _oklch_linear(lightness, chroma, hue):
    a = chroma * math.cos(math.radians(hue))
    b = chroma * math.sin(math.radians(hue))
    long = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3
    medium = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3
    short = (lightness - 0.0894841775 * a - 1.2914855480 * b) ** 3
    return (
        4.0767416621 * long - 3.3077115913 * medium + 0.2309699292 * short,
        -1.2684380046 * long + 2.6097574011 * medium - 0.3413193965 * short,
        -0.0041960863 * long - 0.7034186147 * medium + 1.7076147010 * short,
    )


def oklch_rgb(lightness, chroma, hue):
    """sRGB for an OKLCH color, reducing chroma (never hue) to stay in gamut."""
    low, high = 0.0, max(0.0, chroma)
    linear = _oklch_linear(lightness, high, hue)
    if any(value < -1e-6 or value > 1 + 1e-6 for value in linear):
        for _ in range(24):
            middle = (low + high) / 2
            candidate = _oklch_linear(lightness, middle, hue)
            if all(-1e-6 <= value <= 1 + 1e-6 for value in candidate):
                low = middle
            else:
                high = middle
        linear = _oklch_linear(lightness, low, hue)
    return tuple(round_pixel(_encoded(value)) for value in linear)


def hue_distance(first, second):
    difference = abs(first - second) % 360
    return min(difference, 360 - difference)


def signed_hue_step(origin, target):
    return (target - origin + 180) % 360 - 180


def oklab_distance(first, second):
    def lab(rgb):
        lightness, chroma, hue = rgb_oklch(rgb)
        return (
            lightness,
            chroma * math.cos(math.radians(hue)),
            chroma * math.sin(math.radians(hue)),
        )

    return math.dist(lab(first), lab(second))


# --- pixel sampling --------------------------------------------------------


def color_palette(image, colors=PALETTE_COLOR_COUNT):
    """(share, rgb) pairs, most frequent first."""
    entries = (
        image.quantize(colors=colors, method=Image.Quantize.MEDIANCUT)
        .convert("RGB")
        .getcolors(image.width * image.height)
    )
    total = sum(count for count, _ in entries)
    return [
        (count / total, color)
        for count, color in sorted(entries, key=lambda item: (-item[0], item[1]))
    ]


def _edge_activity(luma):
    if luma.width < 2 or luma.height < 2:
        return 0.0
    saturate = [
        min(255, round_pixel(value * 255 / EDGE_SATURATION_LEVEL))
        for value in range(256)
    ]
    horizontal = ImageChops.difference(
        luma.crop((1, 0, luma.width, luma.height)),
        luma.crop((0, 0, luma.width - 1, luma.height)),
    ).point(saturate)
    vertical = ImageChops.difference(
        luma.crop((0, 1, luma.width, luma.height)),
        luma.crop((0, 0, luma.width, luma.height - 1)),
    ).point(saturate)
    return (ImageStat.Stat(horizontal).mean[0] + ImageStat.Stat(vertical).mean[0]) / 510


def busyness_metrics(region):
    """Busyness of a region at working resolution; no resampling smooths it."""
    luma = region.convert("L")
    edge = _edge_activity(luma)
    tonal = min(1.0, ImageStat.Stat(luma).stddev[0] / TONAL_SPREAD_SCALE)
    shift = COLOR_QUANTIZATION_SHIFT_BITS
    quantized = region.point(lambda value: value >> shift << shift)
    pixels = region.width * region.height
    counts = quantized.getcolors(pixels) or []
    bins = min(pixels, 2 ** (3 * (8 - shift)))
    entropy = (
        -sum(count / pixels * math.log2(count / pixels) for count, _ in counts)
        / math.log2(bins)
        if bins > 1
        else 0.0
    )
    combined = (
        BUSYNESS_EDGE_WEIGHT * edge
        + BUSYNESS_TONAL_WEIGHT * tonal
        + BUSYNESS_ENTROPY_WEIGHT * entropy
    )
    return {
        "busyness": combined,
        "edge_activity": edge,
        "tonal_spread": tonal,
        "color_entropy": entropy,
    }


def anchor_band(geometry):
    """Corner-side band of the square where anchored text always lies."""
    x, y, size = geometry["x"], geometry["y"], geometry["size"]
    band = max(1, round_pixel(size * ANCHOR_BAND_FRACTION))
    top = y if geometry["corner"].startswith("top") else y + size - band
    return (x, top, x + size, top + band)


def context_rectangle(geometry, width, height):
    """Look inward beyond the footprint so nearby subject detail is penalized."""
    x, y, size = geometry["x"], geometry["y"], geometry["size"]
    extra = round_pixel(size * (CONTEXT_SCALE - 1))
    corner = geometry["corner"]
    left = x - extra if corner.endswith("right") else x
    top = y - extra if corner.startswith("bottom") else y
    right = x + size if corner.endswith("right") else x + size + extra
    bottom = y + size if corner.startswith("bottom") else y + size + extra
    return (max(0, left), max(0, top), min(width, right), min(height, bottom))


def padded_rectangle(geometry, width, height):
    x, y, size = geometry["x"], geometry["y"], geometry["size"]
    padding = round_pixel(size * LOCAL_SAMPLE_PADDING_FRACTION)
    return (
        max(0, x - padding),
        max(0, y - padding),
        min(width, x + size + padding),
        min(height, y + size + padding),
    )


def _scaled_box(box, scale, working):
    sx, sy = scale
    left, top, right, bottom = (
        value * factor for value, factor in zip(box, (sx, sy, sx, sy), strict=True)
    )
    left, top = math.floor(left), math.floor(top)
    right = max(left + 1, min(working.width, math.ceil(right)))
    bottom = max(top + 1, min(working.height, math.ceil(bottom)))
    return (max(0, left), max(0, top), right, bottom)


# --- color selection -------------------------------------------------------


def _hue_candidates(global_palette, neighborhood_palette):
    """Chromatic image colors weighted by global and nearby prevalence."""
    weights = {}
    for weight_scale, palette in (
        (GLOBAL_HUE_WEIGHT, global_palette),
        (NEIGHBORHOOD_HUE_WEIGHT, neighborhood_palette),
    ):
        for share, color in palette:
            weights[color] = weights.get(color, 0.0) + weight_scale * share
    candidates = []
    for color, weight in weights.items():
        lightness, chroma, hue = rgb_oklch(color)
        if chroma >= CHROMATIC_MINIMUM_CHROMA:
            candidates.append((weight, color, lightness, chroma, hue))
    return sorted(candidates, key=lambda item: (-item[0], item[1]))


def _neutral_tint(palette):
    """Weighted mean OKLab hue of the image, kept close to neutral."""
    a = b = lightness = 0.0
    for share, color in palette:
        value_lightness, chroma, hue = rgb_oklch(color)
        a += share * chroma * math.cos(math.radians(hue))
        b += share * chroma * math.sin(math.radians(hue))
        lightness += share * value_lightness
    return (
        lightness,
        min(NEUTRAL_MAXIMUM_CHROMA, math.hypot(a, b)),
        (math.degrees(math.atan2(b, a)) % 360),
    )


def _material(local_palette):
    material = [entry for entry in local_palette if entry[0] >= MATERIAL_LOCAL_WEIGHT]
    return material or local_palette[:1]


def _side(material):
    """Light marks on dark material, dark marks on light material."""
    light = min(contrast_ratio((255, 255, 255), color) for _, color in material)
    dark = min(contrast_ratio((0, 0, 0), color) for _, color in material)
    return ("light", light) if light >= dark else ("dark", dark)


def _fit_lightness(start_lightness, chroma, hue, material, side, target):
    """Smallest lightness move from the source tone that clears `target`."""
    direction = 1 if side == "light" else -1
    limit = ACCENT_MAXIMUM_LIGHTNESS if side == "light" else ACCENT_MINIMUM_LIGHTNESS
    lightness = min(
        ACCENT_MAXIMUM_LIGHTNESS, max(ACCENT_MINIMUM_LIGHTNESS, start_lightness)
    )
    best = None
    while True:
        color = oklch_rgb(lightness, chroma, hue)
        worst = min(contrast_ratio(color, local) for _, local in material)
        if best is None or worst > best[1]:
            best = (lightness, worst, color)
        if worst >= target:
            return lightness, color, True
        if (lightness - limit) * direction >= 0:
            return best[0], best[2], False
        lightness = lightness + direction * LIGHTNESS_SEARCH_STEP
        lightness = min(lightness, limit) if direction > 0 else max(lightness, limit)


def region_gradient(global_palette, neighborhood_palette, local_palette):
    """Two related image-derived endpoints that separate from the local colors."""
    material = _material(local_palette)
    side, achievable = _side(material)
    candidates = _hue_candidates(global_palette, neighborhood_palette)
    chromatic_weight = sum(item[0] for item in candidates)
    if candidates and chromatic_weight >= CHROMATIC_MINIMUM_WEIGHT:
        primary = max(
            candidates,
            key=lambda item: (
                item[0] * item[3] / (item[3] + CHROMA_PREFERENCE_SCALE),
                item[1],
            ),
        )
        _, primary_color, lightness, chroma, hue = primary
        chroma = min(chroma, ACCENT_MAXIMUM_CHROMA)
        related = [
            item
            for item in candidates
            if SECONDARY_MINIMUM_HUE_DEGREES
            <= hue_distance(item[4], hue)
            <= SECONDARY_MAXIMUM_HUE_DEGREES
        ]
        if related:
            secondary = related[0]
            step = signed_hue_step(hue, secondary[4])
            step = max(
                -GRADIENT_MAXIMUM_HUE_DRIFT_DEGREES,
                min(GRADIENT_MAXIMUM_HUE_DRIFT_DEGREES, step),
            )
            end_hue = (hue + step) % 360
            end_chroma = min(ACCENT_MAXIMUM_CHROMA, (chroma + secondary[3]) / 2)
            end_source = rgb_hex(secondary[1])
        else:
            end_hue, end_chroma, end_source = (
                hue,
                chroma * TONAL_END_CHROMA_FACTOR,
                None,
            )
        source = "image-palette"
        source_colors = [rgb_hex(primary_color)] + ([end_source] if end_source else [])
    else:
        lightness, chroma, hue = _neutral_tint(global_palette)
        end_hue, end_chroma = hue, chroma
        source = "neutral-image-tint"
        source_colors = []
    start_lightness, start, start_met = _fit_lightness(
        lightness, chroma, hue, material, side, CONTRAST_TARGET_RATIO
    )
    direction = 1 if side == "light" else -1
    end_lightness = start_lightness + direction * GRADIENT_END_LIGHTNESS_STEP
    end_lightness = min(
        ACCENT_MAXIMUM_LIGHTNESS, max(ACCENT_MINIMUM_LIGHTNESS, end_lightness)
    )
    if abs(end_lightness - start_lightness) < MINIMUM_ENDPOINT_LIGHTNESS_STEP:
        # No room further from the background: keep a real tonal gradient
        # by stepping inward. If the target is impossible on split material,
        # report that shortfall rather than silently returning identical stops.
        end_lightness = min(
            ACCENT_MAXIMUM_LIGHTNESS,
            max(
                ACCENT_MINIMUM_LIGHTNESS,
                start_lightness - direction * GRADIENT_END_LIGHTNESS_STEP,
            ),
        )
    end = oklch_rgb(end_lightness, end_chroma, end_hue)
    if (
        min(contrast_ratio(end, local) for _, local in material)
        < CONTRAST_MINIMUM_RATIO
    ):
        # Preserve the practical contrast floor when it is reachable, even
        # when neither endpoint can reach the aspirational target. Keep the
        # tonal step if fitting is impossible; diagnostics expose the shortfall.
        fitted_lightness, fitted_end, minimum_met = _fit_lightness(
            end_lightness, end_chroma, end_hue, material, side, CONTRAST_MINIMUM_RATIO
        )
        if minimum_met:
            end_lightness, end = fitted_lightness, fitted_end
    end_met = (
        min(contrast_ratio(end, local) for _, local in material)
        >= CONTRAST_TARGET_RATIO
    )
    separation_lightness = (
        SEPARATION_DARK_LIGHTNESS if side == "light" else SEPARATION_LIGHT_LIGHTNESS
    )
    background_lightness, background_chroma, background_hue = rgb_oklch(material[0][1])
    separation = oklch_rgb(
        separation_lightness,
        min(SEPARATION_MAXIMUM_CHROMA, background_chroma),
        background_hue,
    )
    return {
        "start": start,
        "end": end,
        "separation": separation,
        "side": side,
        "achievable_ratio": achievable,
        "target_met": start_met and end_met,
        "candidate_source": source,
        "source_colors": source_colors,
        "material": material,
    }


def contrast_evidence(color, material, local_palette, luminances):
    luminance = relative_luminance(color)
    cleared = sum(
        count
        for value, count in luminances.items()
        if _luminance_contrast(luminance, value) >= CONTRAST_TARGET_RATIO
    )
    minimum_cleared = sum(
        count
        for value, count in luminances.items()
        if _luminance_contrast(luminance, value) >= CONTRAST_MINIMUM_RATIO
    )
    total = sum(luminances.values())
    return {
        "minimum_material_ratio": min(
            contrast_ratio(color, local) for _, local in material
        ),
        "weighted_ratio": sum(
            share * contrast_ratio(color, local) for share, local in local_palette
        ),
        "footprint_pixels_at_target": cleared / total if total else 0.0,
        "footprint_pixels_at_minimum": minimum_cleared / total if total else 0.0,
    }


def _luminance_histogram(region):
    counts = region.getcolors(region.width * region.height) or []
    histogram = {}
    for count, color in counts:
        value = round(relative_luminance(color), 4)
        histogram[value] = histogram.get(value, 0) + count
    return histogram


def analyze_watermark(data):
    with Image.open(io.BytesIO(data)) as source:
        displayed = ImageOps.exif_transpose(source)
        width, height = displayed.size
        rgba = displayed.convert("RGBA")
        image = Image.new("RGB", rgba.size, "white")
        image.paste(rgba, mask=rgba.getchannel("A"))
    working = image.copy()
    working.thumbnail(
        (ANALYSIS_EDGE_PIXELS, ANALYSIS_EDGE_PIXELS), Image.Resampling.LANCZOS
    )
    scale = (working.width / width, working.height / height)
    palette_image = image.copy()
    palette_image.thumbnail((PALETTE_SAMPLE_EDGE_PIXELS, PALETTE_SAMPLE_EDGE_PIXELS))
    global_palette = color_palette(palette_image)
    scores = []
    for corner in CORNERS:
        geometry = watermark_geometry(width, height, corner)
        footprint_box = padded_rectangle(geometry, width, height)
        band_box = anchor_band(geometry)
        context_box = context_rectangle(geometry, width, height)
        footprint = working.crop(_scaled_box(footprint_box, scale, working))
        band = busyness_metrics(working.crop(_scaled_box(band_box, scale, working)))
        whole = busyness_metrics(footprint)
        context_region = working.crop(_scaled_box(context_box, scale, working))
        context = busyness_metrics(context_region)
        busyness = (
            BAND_WEIGHT * band["busyness"]
            + FOOTPRINT_WEIGHT * whole["busyness"]
            + CONTEXT_WEIGHT * context["busyness"]
        )
        local_palette = color_palette(footprint, LOCAL_PALETTE_COLOR_COUNT)
        neighborhood_palette = color_palette(context_region, LOCAL_PALETTE_COLOR_COUNT)
        gradient = region_gradient(global_palette, neighborhood_palette, local_palette)
        luminances = _luminance_histogram(footprint)
        start_evidence = contrast_evidence(
            gradient["start"], gradient["material"], local_palette, luminances
        )
        end_evidence = contrast_evidence(
            gradient["end"], gradient["material"], local_palette, luminances
        )
        shortfall = 1 - min(
            start_evidence["footprint_pixels_at_minimum"],
            end_evidence["footprint_pixels_at_minimum"],
        )
        scores.append(
            {
                "corner": corner,
                "placement_score": busyness + LEGIBILITY_WEIGHT * shortfall,
                "legibility_shortfall": shortfall,
                "busyness": busyness,
                "band_busyness": band["busyness"],
                "footprint_busyness": whole["busyness"],
                "context_busyness": context["busyness"],
                "edge_activity": whole["edge_activity"],
                "tonal_spread": whole["tonal_spread"],
                "color_entropy": whole["color_entropy"],
                "band_rectangle": list(band_box),
                "footprint_rectangle": list(footprint_box),
                "context_rectangle": list(context_box),
                "context_scale": CONTEXT_SCALE,
                "background": rgb_hex(gradient["material"][0][1]),
                "local_palette": [
                    {"share": round(share, 4), "color": rgb_hex(color)}
                    for share, color in local_palette
                ],
                "mark_side": gradient["side"],
                "achievable_ratio": gradient["achievable_ratio"],
                "target_met": gradient["target_met"],
                "candidate_source": gradient["candidate_source"],
                "source_colors": gradient["source_colors"],
                "gradient_start": rgb_hex(gradient["start"]),
                "gradient_end": rgb_hex(gradient["end"]),
                "separation_color": rgb_hex(gradient["separation"]),
                "endpoint_difference": oklab_distance(
                    gradient["start"], gradient["end"]
                ),
                "start_contrast": start_evidence,
                "end_contrast": end_evidence,
                "geometry": geometry,
            }
        )
    best = min(score["placement_score"] for score in scores)
    selected = min(
        (
            score
            for score in scores
            if score["placement_score"] - best <= PLACEMENT_TIE_MARGIN
        ),
        key=lambda score: CORNER_PREFERENCE.index(score["corner"]),
    )
    return {
        "position": {"corner": selected["corner"]},
        "presentation": {
            "gradient_start": selected["gradient_start"],
            "gradient_end": selected["gradient_end"],
            "separation_color": selected["separation_color"],
            "glow_color": selected["separation_color"],
            "use_gradient": True,
        },
        "provenance": {
            "method": "deterministic-python-pixels",
            "generator_version": ANALYSIS_VERSION,
            "geometry_policy_fingerprint": WATERMARK_GEOMETRY_FINGERPRINT,
            "source_sha256": hashlib.sha256(data).hexdigest(),
            "source_dimensions": {"width": width, "height": height},
            "analysis_dimensions": {"width": working.width, "height": working.height},
            "selected_corner": selected["corner"],
            "local_background": selected["background"],
            "palette": [rgb_hex(color) for _, color in global_palette],
            "candidate_source": selected["candidate_source"],
            "source_colors": selected["source_colors"],
            "corner_scores": scores,
            "contrast": {
                "target_ratio": CONTRAST_TARGET_RATIO,
                "minimum_ratio": CONTRAST_MINIMUM_RATIO,
                "mark_side": selected["mark_side"],
                "target_met": selected["target_met"],
                "achievable_ratio": selected["achievable_ratio"],
                "gradient_start": selected["start_contrast"],
                "gradient_end": selected["end_contrast"],
                "scope": (
                    "Ratios against local palette colors covering at least 10% of the "
                    "padded footprint; pixel shares count footprint pixels at the "
                    "analysis resolution. The halo is not included."
                ),
            },
        },
    }


# Explicit regeneration is separate from automatic policy refresh. Alternatives
# stay within the measured quiet-corner margin and the same image-derived hue.
REGENERATION_SCORE_MARGIN = 0.045
REGENERATION_TONAL_STEP = 0.04


def regenerate_watermark(data, previous, analysis=None):
    result = analysis or analyze_watermark(data)
    provenance = result["provenance"]
    if not isinstance(previous, dict):
        provenance["regeneration"] = {
            "policy": "bounded-alternatives-v1",
            "reason": "No previous analysis",
        }
        return result
    prior = previous.get("provenance") or {}
    if prior.get("source_sha256") != provenance["source_sha256"]:
        raise ValueError("Previous watermark analysis belongs to another source")
    scores = provenance["corner_scores"]
    best = min(score["placement_score"] for score in scores)
    eligible = [
        score
        for score in scores
        if score["placement_score"] <= best + REGENERATION_SCORE_MARGIN
    ]
    old_corner = (previous.get("position") or {}).get("corner")
    alternatives = [score for score in eligible if score["corner"] != old_corner]
    if alternatives:
        # Walk a stable ring so repeated requests explore eligible corners.
        start = (
            CORNER_PREFERENCE.index(old_corner)
            if old_corner in CORNER_PREFERENCE
            else -1
        )
        selected = min(
            alternatives,
            key=lambda score: (
                (CORNER_PREFERENCE.index(score["corner"]) - start - 1)
                % len(CORNER_PREFERENCE)
            ),
        )
        placement_reason = (
            "Changed to another corner within the measured quiet-corner margin"
        )
    else:
        selected = min(eligible, key=lambda score: score["placement_score"])
        placement_reason = (
            "Kept the only corner within the measured quiet-corner margin"
        )
    presentation = {
        "gradient_start": selected["gradient_start"],
        "gradient_end": selected["gradient_end"],
        "separation_color": selected["separation_color"],
        "glow_color": selected["separation_color"],
        "use_gradient": True,
    }
    old_colors = previous.get("presentation") or {}
    material = [
        (entry["share"], tuple(bytes.fromhex(entry["color"][1:])))
        for entry in selected["local_palette"]
        if entry["share"] >= MATERIAL_LOCAL_WEIGHT
    ]
    material = material or [(1, tuple(bytes.fromhex(selected["background"][1:])))]
    palette = [tuple(bytes.fromhex(value[1:])) for value in provenance["palette"]]
    hues = [rgb_oklch(color) for color in palette]
    chromatic = [value for value in hues if value[1] >= CHROMATIC_MINIMUM_CHROMA]
    hue_agreement = (
        bool(chromatic)
        and max(hue_distance(chromatic[0][2], value[2]) for value in chromatic) <= 12
    )
    strong = (
        hue_agreement
        and selected["target_met"]
        and min(
            selected["start_contrast"]["footprint_pixels_at_minimum"],
            selected["end_contrast"]["footprint_pixels_at_minimum"],
        )
        >= 0.98
    )
    color_reason = "Kept image colors: consistent source hue and local contrast"
    if not strong:
        variants = [presentation]
        for step in (REGENERATION_TONAL_STEP, -REGENERATION_TONAL_STEP):
            variant = dict(presentation)
            valid = True
            for field in ("gradient_start", "gradient_end"):
                rgb = tuple(bytes.fromhex(presentation[field][1:]))
                lightness, chroma, hue = rgb_oklch(rgb)
                value = lightness + step
                if not ACCENT_MINIMUM_LIGHTNESS <= value <= ACCENT_MAXIMUM_LIGHTNESS:
                    valid = False
                    break
                color = oklch_rgb(value, chroma, hue)
                original_floor = min(
                    contrast_ratio(rgb, local) for _, local in material
                )
                if min(contrast_ratio(color, local) for _, local in material) < min(
                    CONTRAST_MINIMUM_RATIO, original_floor
                ):
                    valid = False
                    break
                variant[field] = rgb_hex(color)
            if valid and variant != presentation:
                variants.append(variant)
        changed = next(
            (
                variant
                for variant in variants
                if any(
                    variant[field] != old_colors.get(field)
                    for field in ("gradient_start", "gradient_end")
                )
            ),
            None,
        )
        if changed:
            presentation = changed
            color_reason = "Changed image-derived tones within local contrast limits"
        else:
            color_reason = "Kept colors: no distinct tonal alternative clears local contrast limits"
    placement_changed = selected["corner"] != old_corner
    colors_changed = any(
        presentation[field] != old_colors.get(field)
        for field in ("gradient_start", "gradient_end")
    )
    if placement_changed and not alternatives:
        placement_reason = (
            "Changed to the only corner within the measured quiet-corner margin"
        )
    if strong and colors_changed:
        color_reason = (
            "Selected image colors with consistent source hue and local contrast"
        )
    result["position"] = {"corner": selected["corner"]}
    result["presentation"] = presentation
    provenance.update(
        selected_corner=selected["corner"],
        local_background=selected["background"],
        candidate_source=selected["candidate_source"],
        source_colors=selected["source_colors"],
    )
    # Baseline diagnostics belong to their candidate colors. Never attach them
    # to a tonal alternative as if those exact pixel shares had been measured.
    provenance["contrast"] = {
        "scope": "Regenerated colors checked against material local palette colors; see corner_scores for baseline pixel measurements",
        "minimum_ratio": CONTRAST_MINIMUM_RATIO,
        "gradient_start_material_ratio": min(
            contrast_ratio(
                tuple(bytes.fromhex(presentation["gradient_start"][1:])), color
            )
            for _, color in material
        ),
        "gradient_end_material_ratio": min(
            contrast_ratio(
                tuple(bytes.fromhex(presentation["gradient_end"][1:])), color
            )
            for _, color in material
        ),
    }
    provenance["regeneration"] = {
        "policy": "bounded-alternatives-v1",
        "previous_corner": old_corner,
        "placement_changed": placement_changed,
        "colors_changed": colors_changed,
        "previous_presentation": old_colors,
        "placement": placement_reason,
        "colors": color_reason,
        "eligible_corners": [score["corner"] for score in eligible],
        "score_margin": REGENERATION_SCORE_MARGIN,
    }
    return result
