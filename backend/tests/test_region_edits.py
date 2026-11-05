"""Region selection validation and preservation independent of model inference."""

import hashlib
import io
import json
from pathlib import Path

import pytest
from app.region_edits import composite_region, selection_mask
from app.region_types import RegionSelection, region_editing_capability
from PIL import Image
from pydantic import ValidationError


def test_shared_region_vector_matches_mask_and_capability():
    fixture = json.loads(
        (Path(__file__).parents[2] / "fixtures/api/region-editing.json").read_text()
    )
    selection = RegionSelection.model_validate(fixture["selection"])
    mask, _ = selection_mask(selection)
    assert (
        hashlib.sha256(mask.tobytes()).hexdigest() == fixture["expected_mask"]["sha256"]
    )
    assert mask.histogram()[255] == fixture["expected_mask"]["selected_pixels"]
    assert region_editing_capability(True) == fixture["capability"]


def png(image):
    output = io.BytesIO()
    image.save(output, "PNG")
    return output.getvalue()


def image_bytes(size=(16, 12)):
    image = Image.new("RGBA", size)
    image.putdata(
        [
            (x * 7, y * 9, (x + y) * 3, 0 if x % 3 == 0 else 170)
            for y in range(size[1])
            for x in range(size[0])
        ]
    )
    return png(image)


def selected(data, **patch):
    return {
        "version": 1,
        "source_sha256": hashlib.sha256(data).hexdigest(),
        "width": 16,
        "height": 12,
        "shapes": [{"kind": "rectangle", "x": 3, "y": 4, "width": 6, "height": 4}],
        "feather": 0,
        **patch,
    }


def rgba(data):
    with Image.open(io.BytesIO(data)) as image:
        return image.convert("RGBA")


def test_rectangle_uses_exclusive_bounds_and_changes_only_selected_rgba_pixels():
    source = image_bytes()
    generated = png(Image.new("RGBA", (16, 12), (240, 80, 30, 255)))
    selection = RegionSelection.model_validate(selected(source))
    result, metadata = composite_region(source, generated, selection)
    before, after = rgba(source), rgba(result)
    for y in range(12):
        for x in range(16):
            expected = (
                (240, 80, 30, 255)
                if 3 <= x < 9 and 4 <= y < 8
                else before.getpixel((x, y))
            )
            assert after.getpixel((x, y)) == expected
    assert metadata["selected_pixels"] == 24
    assert metadata["bounds"] == {"x": 3, "y": 4, "width": 6, "height": 4}
    assert metadata["native_mask"] is False
    assert metadata["outside_selection"] == "exact-rgba8"
    assert source == image_bytes()


def test_brush_rasterization_has_round_ends_and_clips_at_canvas_edges():
    selection = RegionSelection.model_validate(
        selected(
            image_bytes(),
            shapes=[{"kind": "brush", "radius": 1, "points": [[3, 6], [7, 6]]}],
        )
    )
    hard, _ = selection_mask(selection)
    expected = {(x, y) for x in range(3, 8) for y in range(5, 8)} | {(2, 6), (8, 6)}
    actual = {(x, y) for y in range(12) for x in range(16) if hard.getpixel((x, y))}
    assert actual == expected
    edge = selection.model_copy(
        update={"shapes": [selection.shapes[0].model_copy(update={"points": [(0, 0)]})]}
    )
    assert selection_mask(edge)[0].getbbox() == (0, 0, 2, 2)


@pytest.mark.parametrize("feather", [1, 4, 32])
def test_feather_never_changes_unselected_pixels_including_hidden_rgb(feather):
    source = image_bytes()
    generated = png(Image.new("RGBA", (16, 12), (250, 10, 30, 255)))
    selection = RegionSelection.model_validate(selected(source, feather=feather))
    output, _ = composite_region(source, generated, selection)
    before, after = rgba(source), rgba(output)
    assert before.tobytes() != after.tobytes()
    for y in range(12):
        for x in range(16):
            if not (3 <= x < 9 and 4 <= y < 8):
                assert after.getpixel((x, y)) == before.getpixel((x, y))


def test_provider_output_is_fitted_to_base_dimensions_before_compositing():
    source = image_bytes()
    generated = png(Image.new("RGB", (31, 31), (210, 30, 60)))
    output, metadata = composite_region(
        source, generated, RegionSelection.model_validate(selected(source))
    )
    assert rgba(output).size == (16, 12)
    assert rgba(output).getpixel((3, 4)) == (210, 30, 60, 255)
    assert metadata["provider_dimensions"] == {"width": 31, "height": 31}
    assert metadata["provider_fit"] == "cover-center"


def test_feathering_cannot_silently_erase_a_tiny_selection():
    selection = RegionSelection.model_validate(
        selected(
            image_bytes(),
            width=1000,
            height=1000,
            feather=32,
            shapes=[{"kind": "rectangle", "x": 500, "y": 500, "width": 1, "height": 1}],
        )
    )
    with pytest.raises(ValueError, match="reduce feathering"):
        selection_mask(selection)


def test_exif_coordinates_are_oriented_and_source_bytes_are_unchanged():
    original = Image.new("RGB", (5, 3))
    original.putdata([(x * 30, y * 50, 80) for y in range(3) for x in range(5)])
    exif = Image.Exif()
    exif[274] = 6
    buffer = io.BytesIO()
    original.save(buffer, "JPEG", exif=exif)
    source = buffer.getvalue()
    before_hash = hashlib.sha256(source).hexdigest()
    selection = RegionSelection.model_validate(
        selected(
            source,
            width=3,
            height=5,
            shapes=[{"kind": "rectangle", "x": 1, "y": 1, "width": 1, "height": 2}],
        )
    )
    generated = png(Image.new("RGB", (12, 8), (250, 10, 5)))
    output, _ = composite_region(source, generated, selection)
    with Image.open(io.BytesIO(source)) as raw:
        expected = raw.transpose(Image.Transpose.ROTATE_270).convert("RGBA")
    actual = rgba(output)
    assert actual.size == (3, 5)
    for y in range(5):
        for x in range(3):
            if x != 1 or y not in (1, 2):
                assert actual.getpixel((x, y)) == expected.getpixel((x, y))
    assert hashlib.sha256(source).hexdigest() == before_hash


@pytest.mark.parametrize(
    "patch",
    [
        {"width": True},
        {"feather": -1},
        {"feather": 33},
        {"shapes": []},
        {"shapes": [{"kind": "rectangle", "x": 15, "y": 0, "width": 2, "height": 2}]},
        {"shapes": [{"kind": "rectangle", "x": 1.5, "y": 0, "width": 2, "height": 2}]},
        {"shapes": [{"kind": "brush", "radius": 1, "points": [[16, 0]]}]},
        {"shapes": [{"kind": "brush", "radius": 0, "points": [[0, 0]]}]},
        {"shapes": [{"kind": "brush", "radius": 1, "points": [[0, 0]] * 4097}]},
        {"shapes": [{"kind": "brush", "radius": 1, "points": [[0, 0]] * 4096}] * 2},
        {"width": 32768, "height": 32768},
        {"source_sha256": "not-a-checksum"},
        {"unexpected": "ignored fields are forbidden"},
    ],
)
def test_invalid_selections_are_rejected(patch):
    with pytest.raises(ValidationError):
        RegionSelection.model_validate(selected(image_bytes(), **patch))


def test_checksum_geometry_and_decode_limits_fail_without_an_output():
    source, generated = image_bytes(), png(Image.new("RGB", (16, 12)))
    with pytest.raises(ValueError, match="different base"):
        composite_region(
            source,
            generated,
            RegionSelection.model_validate(selected(source, source_sha256="0" * 64)),
        )
    with pytest.raises(ValueError, match="oriented base size"):
        composite_region(
            source,
            generated,
            RegionSelection.model_validate(selected(source, width=17)),
        )
    with pytest.raises(ValueError, match="pixel limit"):
        composite_region(
            source,
            generated,
            RegionSelection.model_validate(selected(source)),
            max_pixels=100,
        )
