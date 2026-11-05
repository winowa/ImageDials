"""Image-derived colors and quiet placement must be deterministic and evidenced."""

import hashlib
import io
import random

import pytest
from app.watermark_analysis import (
    ACCENT_MAXIMUM_CHROMA,
    CONTRAST_MINIMUM_RATIO,
    CONTRAST_TARGET_RATIO,
    analyze_watermark,
    contrast_ratio,
    hex_rgb,
    hue_distance,
    oklab_distance,
    rgb_oklch,
    watermark_geometry,
)
from app.watermark_policy import WATERMARK_POLICY, geometry_fingerprint
from PIL import Image, ImageDraw

# Portrait, landscape, square and wide sources; the mark footprint differs.
SHAPES = [(1200, 1800), (1800, 1200), (1200, 1200), (2400, 900)]
# Old v3 output for a solid (20, 90, 160) blue image: an unrelated lime.
OLD_LIME = (0xC7, 0xDF, 0x20)


def encode(image):
    stream = io.BytesIO()
    image.save(stream, format="PNG")
    return stream.getvalue()


def endpoints(result):
    return [
        hex_rgb(result["presentation"][key])
        for key in ("gradient_start", "gradient_end")
    ]


def grain(patch, amplitude, seed):
    """Add ±amplitude luma grain to every pixel of a patch."""
    rng = random.Random(seed)
    pixels = []
    for pixel in patch.getdata():
        step = rng.randint(-amplitude, amplitude)
        pixels.append(tuple(max(0, min(255, value + step)) for value in pixel))
    patch.putdata(pixels)
    return patch


def vertical_gradient(size, top, bottom):
    width, height = size
    image = Image.new("RGB", size)
    draw = ImageDraw.Draw(image)
    for row in range(height):
        t = row / max(1, height - 1)
        color = tuple(round(a + (b - a) * t) for a, b in zip(top, bottom, strict=True))
        draw.line((0, row, width, row), fill=color)
    return image


def footprint_box(width, height, corner, margin=0.15):
    box = watermark_geometry(width, height, corner)
    extra = round(box["size"] * margin)
    return (
        max(0, box["x"] - extra),
        max(0, box["y"] - extra),
        min(width, box["x"] + box["size"] + extra),
        min(height, box["y"] + box["size"] + extra),
    )


@pytest.mark.parametrize(
    "color",
    [(20, 90, 160), (150, 60, 40), (40, 120, 60), (200, 170, 60), (110, 60, 140)],
)
def test_single_hue_images_keep_their_own_hue_with_bounded_chroma(color):
    source = encode(Image.new("RGB", (300, 200), color))
    result = analyze_watermark(source)
    assert result == analyze_watermark(source)
    assert result["provenance"]["candidate_source"] == "image-palette"
    source_hue = rgb_oklch(color)[2]
    for rgb in endpoints(result):
        _, chroma, hue = rgb_oklch(rgb)
        assert hue_distance(hue, source_hue) <= 12
        assert chroma <= ACCENT_MAXIMUM_CHROMA + 0.005
    # A blue image no longer receives the synthesized lime.
    if color == (20, 90, 160):
        assert all(
            hue_distance(rgb_oklch(rgb)[2], rgb_oklch(OLD_LIME)[2]) > 60
            for rgb in endpoints(result)
        )


@pytest.mark.parametrize(
    "color",
    [(0, 0, 0), (32, 32, 32), (128, 128, 128), (220, 220, 220), (255, 255, 255)],
)
def test_neutral_images_get_restrained_neutral_gradients(color):
    result = analyze_watermark(encode(Image.new("RGB", (300, 200), color)))
    assert result["provenance"]["candidate_source"] == "neutral-image-tint"
    for rgb in endpoints(result):
        assert rgb_oklch(rgb)[1] <= 0.025
    separation = hex_rgb(result["presentation"]["separation_color"])
    assert rgb_oklch(separation)[1] <= 0.03


def test_saturated_sources_are_toned_down_not_amplified():
    result = analyze_watermark(encode(Image.new("RGB", (300, 200), (120, 255, 0))))
    source_chroma = rgb_oklch((120, 255, 0))[1]
    for rgb in endpoints(result):
        assert rgb_oklch(rgb)[1] <= ACCENT_MAXIMUM_CHROMA + 0.005 < source_chroma


@pytest.mark.parametrize(
    "color", [(20, 90, 160), (128, 128, 128), (245, 240, 230), (12, 14, 20)]
)
def test_gradient_endpoints_are_distinct_and_contrast_is_reported_honestly(color):
    result = analyze_watermark(encode(Image.new("RGB", (400, 300), color)))
    start, end = endpoints(result)
    assert oklab_distance(start, end) >= 0.03
    evidence = result["provenance"]["contrast"]
    assert evidence["target_ratio"] == CONTRAST_TARGET_RATIO
    for name, rgb in (("gradient_start", start), ("gradient_end", end)):
        measured = contrast_ratio(rgb, color)
        assert evidence[name]["minimum_material_ratio"] == pytest.approx(measured)
        assert evidence[name]["footprint_pixels_at_minimum"] == (
            1.0 if measured >= CONTRAST_MINIMUM_RATIO else 0.0
        )
        # A uniform footprint: every pixel clears the target exactly when the color does.
        assert evidence[name]["footprint_pixels_at_target"] == (
            1.0 if measured >= CONTRAST_TARGET_RATIO else 0.0
        )
    assert evidence["target_met"] == all(
        contrast_ratio(rgb, color) >= CONTRAST_TARGET_RATIO for rgb in (start, end)
    )
    # The halo sits on the background side, opposite the mark's lightness.
    separation = hex_rgb(result["presentation"]["separation_color"])
    mark_side = evidence["mark_side"]
    assert (rgb_oklch(separation)[0] < rgb_oklch(start)[0]) == (mark_side == "light")


def test_split_contrast_footprints_do_not_claim_the_target():
    image = Image.new("RGB", (600, 400), (128, 128, 128))
    draw = ImageDraw.Draw(image)
    for corner in ("top-left", "top-right", "bottom-left", "bottom-right"):
        left, top, right, bottom = footprint_box(600, 400, corner)
        middle = (left + right) // 2
        # No single color clears 3:1 against both of these halves.
        draw.rectangle((left, top, middle, bottom), fill=(5, 5, 5))
        draw.rectangle((middle, top, right, bottom), fill=(160, 160, 160))
    result = analyze_watermark(encode(image))
    evidence = result["provenance"]["contrast"]
    assert evidence["target_met"] is False
    assert oklab_distance(*endpoints(result)) >= 0.03
    for endpoint in ("gradient_start", "gradient_end"):
        assert evidence[endpoint]["minimum_material_ratio"] >= CONTRAST_MINIMUM_RATIO
    assert evidence["gradient_start"]["footprint_pixels_at_target"] < 0.7


def test_multicolor_image_draws_endpoints_from_nearby_image_hues():
    image = Image.new("RGB", (900, 600), (24, 40, 70))
    draw = ImageDraw.Draw(image)
    draw.rectangle((250, 120, 450, 480), fill=(200, 70, 40))
    draw.rectangle((460, 120, 650, 480), fill=(40, 110, 200))
    result = analyze_watermark(encode(image))
    assert result["provenance"]["candidate_source"] == "image-palette"
    palette_hues = [
        rgb_oklch(hex_rgb(color))[2]
        for color in result["provenance"]["palette"]
        if rgb_oklch(hex_rgb(color))[1] >= 0.035
    ]
    for rgb in endpoints(result):
        hue = rgb_oklch(rgb)[2]
        assert min(hue_distance(hue, other) for other in palette_hues) <= 30
    for corner in result["provenance"]["corner_scores"]:
        assert 0 <= corner["legibility_shortfall"] <= 1
        assert len(corner["gradient_start"]) == len(corner["gradient_end"]) == 7


@pytest.mark.parametrize("width,height", SHAPES)
@pytest.mark.parametrize("quiet", ["top-left", "bottom-right"])
def test_fine_grain_is_busier_than_a_smooth_tonal_gradient(width, height, quiet):
    # A 64-pixel resample used to average this grain away and pick it over the
    # smooth gradient. The grain covers exactly where the mark would draw.
    image = vertical_gradient((width, height), (70, 95, 120), (150, 170, 190))
    for corner in ("top-left", "top-right", "bottom-left", "bottom-right"):
        if corner == quiet:
            continue
        box = footprint_box(width, height, corner)
        image.paste(grain(image.crop(box), 14, len(corner)), box[:2])
    result = analyze_watermark(encode(image))
    assert result["position"]["corner"] == quiet


@pytest.mark.parametrize("width,height", SHAPES)
def test_dark_texture_counts_as_busy(width, height):
    image = Image.new("RGB", (width, height), (18, 18, 22))
    for corner in ("top-left", "top-right", "bottom-left"):
        box = footprint_box(width, height, corner)
        image.paste(grain(image.crop(box), 16, 3), box[:2])
    assert analyze_watermark(encode(image))["position"]["corner"] == "bottom-right"


@pytest.mark.parametrize("width,height", SHAPES)
def test_contrasting_patches_lose_to_a_plain_corner(width, height):
    image = Image.new("RGB", (width, height), (90, 110, 130))
    draw = ImageDraw.Draw(image)
    for corner in ("top-left", "top-right", "bottom-right"):
        left, top, right, bottom = footprint_box(width, height, corner)
        step = (right - left) // 2
        for row in range(2):
            for column in range(2):
                fill = (8, 8, 8) if (row + column) % 2 else (245, 245, 245)
                draw.rectangle(
                    (
                        left + column * step,
                        top + row * step,
                        left + (column + 1) * step,
                        top + (row + 1) * step,
                    ),
                    fill=fill,
                )
    assert analyze_watermark(encode(image))["position"]["corner"] == "bottom-left"


def test_busy_footprint_loses_to_a_clean_footprint_beside_a_subject():
    width, height = 1800, 1200
    image = Image.new("RGB", (width, height), (150, 165, 175))
    for corner in ("top-left", "bottom-left", "bottom-right"):
        box = footprint_box(width, height, corner)
        image.paste(grain(image.crop(box), 50, 5), box[:2])
    # A smooth subject begins just inward of the clean top-right footprint.
    mark = watermark_geometry(width, height, "top-right")
    draw = ImageDraw.Draw(image)
    draw.ellipse(
        (
            mark["x"] - mark["size"] * 1.4,
            mark["y"] + mark["size"] * 1.05,
            mark["x"] + mark["size"] * 0.2,
            mark["y"] + mark["size"] * 2.5,
        ),
        fill=(120, 60, 50),
    )
    result = analyze_watermark(encode(image))
    assert result["position"]["corner"] == "top-right"
    scores = {row["corner"]: row for row in result["provenance"]["corner_scores"]}
    assert scores["top-right"]["context_busyness"] > 0


def test_nearby_detail_is_counted_beyond_the_mark_footprint():
    image = Image.new("RGB", (900, 600), (180, 180, 180))
    draw = ImageDraw.Draw(image)
    for corner in ("top-left", "top-right", "bottom-left"):
        box = watermark_geometry(900, 600, corner)
        side = box["size"]
        x = box["x"] + side if corner.endswith("left") else box["x"] - side
        y = box["y"] + side if corner.startswith("top") else box["y"] - side
        draw.rectangle((x, y, x + side, y + side), fill="black")
        for row in range(y, y + side, 2):
            draw.line((x, row, x + side, row), fill="white")
    result = analyze_watermark(encode(image))
    assert result["position"]["corner"] == "bottom-right"
    scores = {row["corner"]: row for row in result["provenance"]["corner_scores"]}
    for corner in ("top-left", "top-right", "bottom-left"):
        assert (
            scores[corner]["context_busyness"]
            > scores["bottom-right"]["context_busyness"]
        )


@pytest.mark.parametrize("width,height", SHAPES)
def test_scored_regions_are_the_actual_mark_footprint(width, height):
    result = analyze_watermark(encode(Image.new("RGB", (width, height), "white")))
    for row in result["provenance"]["corner_scores"]:
        mark = watermark_geometry(width, height, row["corner"])
        assert row["geometry"] == mark
        left, top, right, bottom = row["footprint_rectangle"]
        assert left <= mark["x"] and right >= mark["x"] + mark["size"]
        assert top <= mark["y"] and bottom >= mark["y"] + mark["size"]
        band = row["band_rectangle"]
        assert band[0] == mark["x"] and band[2] == mark["x"] + mark["size"]
        # The text band hugs the corner-side edge of the square.
        if row["corner"].startswith("top"):
            assert band[1] == mark["y"]
        else:
            assert band[3] == mark["y"] + mark["size"]


def test_analysis_is_bound_to_the_source_and_geometry():
    source = encode(Image.new("RGB", (300, 200), (20, 90, 160)))
    provenance = analyze_watermark(source)["provenance"]
    assert provenance["source_sha256"] == hashlib.sha256(source).hexdigest()
    assert provenance["generator_version"] == WATERMARK_POLICY["analysisVersion"]
    assert provenance["geometry_policy_fingerprint"] == geometry_fingerprint(
        WATERMARK_POLICY
    )


def test_renderer_changes_keep_geometry_analysis_reusable():
    original = geometry_fingerprint(WATERMARK_POLICY)
    for renderer_only in (
        "rendererVersion",
        "ruleHeightFraction",
        "contentGapFraction",
        "haloPaddingFraction",
        "separationBlurFraction",
    ):
        changed = {**WATERMARK_POLICY, renderer_only: "changed"}
        assert geometry_fingerprint(changed) == original
    for geometry in ("insetFraction", "sizeFraction", "placementFrame"):
        assert geometry_fingerprint({**WATERMARK_POLICY, geometry: 0.1}) != original
