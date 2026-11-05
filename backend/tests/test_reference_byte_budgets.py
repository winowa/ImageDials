"""Normalized reference copies fit per-item and combined byte budgets."""

import hashlib
import io

import pytest
from app import image_editing as editing
from app.image_editing import _byte_budgets, normalize_references
from app.providers import ImageProvider, ProviderError
from PIL import Image, ImageChops, ImageOps


def noisy(size, *, alpha=None, fmt="PNG", exif_orientation=None):
    """Photo-like high-entropy pixels; solid colours would compress away."""
    width, height = size
    channels = [Image.effect_noise(size, sigma) for sigma in (40, 48, 56)]
    gradient = Image.linear_gradient("L").resize(size)
    channels = [ImageChops.add(c, gradient, scale=1.6) for c in channels]
    image = Image.merge("RGB", channels)
    if alpha is not None:
        image = image.convert("RGBA")
        image.putalpha(alpha(size))
    output = io.BytesIO()
    options = {}
    if exif_orientation:
        exif = Image.Exif()
        exif[274] = exif_orientation
        options["exif"] = exif.tobytes()
    if fmt == "JPEG":
        options.update(quality=95)
    image.save(output, fmt, **options)
    return output.getvalue()


def half_transparent(size):
    mask = Image.new("L", size, 255)
    mask.paste(0, (0, 0, size[0] // 2, size[1]))
    return mask


def ref(data, name="r.png"):
    return {"data": data, "filename": name, "role": "reference", "description": ""}


def full_png_size(data):
    with Image.open(io.BytesIO(data)) as image:
        oriented = ImageOps.exif_transpose(image).convert("RGBA")
    output = io.BytesIO()
    oriented.save(output, format="PNG", optimize=False)
    return len(output.getvalue())


def test_budgets_keep_small_copies_and_cap_large_ones_together():
    assert _byte_budgets([10, 20], 32, 64) == [10, 20]
    assert _byte_budgets([10, 40], 32, 64) == [10, 32]
    assert _byte_budgets([95, 10, 36], 32, 64) == [27, 10, 27]
    assert _byte_budgets([100, 100, 100], 32, 64) == [21, 21, 21]


def test_sets_that_fit_are_byte_identical_to_plain_normalization():
    data = noisy((64, 48))
    prepared = normalize_references([ref(data)])[0]
    assert "fitted_from" not in prepared
    assert (prepared["width"], prepared["height"]) == (64, 48)
    assert len(prepared["data"]) == full_png_size(data)


def test_one_oversized_copy_is_fitted_proportionally_and_losslessly(monkeypatch):
    data = noisy((320, 240), fmt="JPEG")
    full = full_png_size(data)
    monkeypatch.setattr(editing, "MAX_NORMALIZED_REFERENCE_BYTES", full // 2)
    prepared = normalize_references([ref(data, "photo.jpg")])[0]
    assert len(prepared["data"]) <= full // 2
    assert prepared["fitted_from"] == {"width": 320, "height": 240}
    width, height = prepared["width"], prepared["height"]
    assert width < 320 and abs(width * 240 - height * 320) <= 320 + 240
    # Exact RGBA encoding survives normalization without a second resize.
    with Image.open(io.BytesIO(prepared["data"])) as copy:
        assert copy.format == "PNG" and copy.mode == "RGBA"
        assert copy.size == (width, height) and not copy.info
    assert prepared["sha256"] == hashlib.sha256(data).hexdigest()
    assert prepared["normalized_sha256"] == hashlib.sha256(prepared["data"]).hexdigest()
    # Deterministic: a frozen retry of the same bytes prepares the same copy.
    again = normalize_references([ref(data, "photo.jpg")])[0]
    assert again["normalized_sha256"] == prepared["normalized_sha256"]


def test_combined_budget_fits_the_set_and_leaves_small_members_exact(monkeypatch):
    large = noisy((360, 480), fmt="JPEG")
    middle = noisy((200, 150))
    small = noisy((40, 30))
    sizes = [full_png_size(item) for item in (large, middle, small)]
    total = sizes[1] + sizes[2] + sizes[0] // 3
    monkeypatch.setattr(editing, "MAX_NORMALIZED_TOTAL_BYTES", total)
    prepared = normalize_references([ref(large), ref(middle), ref(small)])
    assert sum(len(item["data"]) for item in prepared) <= total
    assert [item["index"] for item in prepared] == [1, 2, 3]
    assert prepared[0]["fitted_from"] == {"width": 360, "height": 480}
    assert "fitted_from" not in prepared[1] and "fitted_from" not in prepared[2]
    assert len(prepared[1]["data"]) == sizes[1]
    assert len(prepared[2]["data"]) == sizes[2]


def test_fitted_copies_keep_orientation_and_transparency(monkeypatch):
    data = noisy((300, 200), alpha=half_transparent, exif_orientation=6)
    full = full_png_size(data)
    monkeypatch.setattr(editing, "MAX_NORMALIZED_REFERENCE_BYTES", full // 3)
    prepared = normalize_references([ref(data)])[0]
    assert prepared["fitted_from"] == {"width": 200, "height": 300}
    with Image.open(io.BytesIO(prepared["data"])) as copy:
        assert copy.mode == "RGBA" and copy.height > copy.width
        assert not copy.getexif()
        alpha = copy.getchannel("A")
        # Rotated 90 degrees clockwise: the transparent left half is now on top.
        assert alpha.getpixel((copy.width // 2, 2)) == 0
        assert alpha.getpixel((copy.width // 2, copy.height - 3)) == 255
        # Premultiplied resize: no stray colour hidden under transparent pixels.
        top = copy.crop((0, 0, copy.width, copy.height // 4))
        assert all(pixel == (0, 0, 0, 0) or pixel[3] == 0 for pixel in top.getdata())


def test_unfittable_budget_fails_with_a_specific_error(monkeypatch):
    monkeypatch.setattr(editing, "MAX_NORMALIZED_REFERENCE_BYTES", 40)
    with pytest.raises(ProviderError, match="within the model byte limit"):
        normalize_references([ref(noisy((64, 64)))])


def test_mock_diagnostics_report_the_fitted_model_copy(monkeypatch):
    data = noisy((240, 180))
    monkeypatch.setattr(
        editing, "MAX_NORMALIZED_REFERENCE_BYTES", full_png_size(data) // 2
    )
    _, diagnostics = ImageProvider({"IMAGE_PROVIDER": "mock"}).render(
        "Edit", 240, 180, references=[ref(data)]
    )
    entry = diagnostics["references"][0]
    assert entry["fitted_from"] == {"width": 240, "height": 180}
    assert entry["width"] < 240
