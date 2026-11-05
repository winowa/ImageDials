"""Measured high-entropy model copies, exact retry bytes and color handling."""

import hashlib
import io

from app.image_editing import normalize_references
from app.reference_model_copy import prepare_model_copy
from app.reference_pixels import oriented_reference_pixels
from PIL import Image, ImageCms
from test_reference_byte_budgets import half_transparent, noisy, ref


def test_real_camera_sized_jpeg_fits_bytes_pixels_and_ten_slot_set():
    # Original report: a compressed 6144×8160 JPEG fits upload bytes while
    # its 32 MP lossless model copy exceeds the normalized 32 MiB cap.
    original = noisy((6144, 8160), fmt="JPEG")
    original_sha = hashlib.sha256(original).hexdigest()
    budget = (64 * 1024 * 1024) // 10
    result = prepare_model_copy(original, 32_000_000, 100_000_000, budget)
    copy = result["adapted"]
    assert result["source"] == {"sha256": original_sha, "width": 6144, "height": 8160}
    assert copy and len(copy["data"]) <= budget
    assert copy["width"] * copy["height"] <= 32_000_000
    assert abs(copy["width"] * 8160 - copy["height"] * 6144) <= 8160 + 6144
    normalized = normalize_references([ref(copy["data"])])[0]
    assert normalized["data"] == copy["data"]
    assert normalized["normalized_sha256"] == copy["sha256"]
    assert hashlib.sha256(original).hexdigest() == original_sha


def test_three_high_entropy_model_copies_fit_aggregate_and_exact_retry():
    budget = 200_000
    originals = [noisy((960, 1280), fmt="JPEG") for _ in range(3)]
    copies = [
        prepare_model_copy(data, 1_000_000, 2_000_000, budget)["adapted"]
        for data in originals
    ]
    assert all(copy and len(copy["data"]) <= budget for copy in copies)
    normalized = normalize_references([ref(copy["data"]) for copy in copies])
    assert sum(len(item["data"]) for item in normalized) <= 3 * budget
    assert all(
        item["normalized_sha256"] == copy["sha256"]
        for item, copy in zip(normalized, copies, strict=True)
    )
    assert (
        prepare_model_copy(originals[0], 1_000_000, 2_000_000, budget)["adapted"]
        == copies[0]
    )


def test_byte_fit_preserves_oriented_transparency():
    data = noisy((360, 240), alpha=half_transparent, exif_orientation=6)
    copy = prepare_model_copy(data, 100_000, 100_000, 40_000)["adapted"]
    with Image.open(io.BytesIO(copy["data"])) as image:
        assert image.height > image.width
        assert image.getpixel((image.width // 2, 2))[3] == 0
        assert image.getpixel((image.width // 2, image.height - 3))[3] == 255
        assert not image.getexif()


def test_16bit_greyscale_scales_instead_of_clipping():
    image = Image.new("I;16", (3, 1))
    image.putdata([0, 32768, 65535])
    output = io.BytesIO()
    image.save(output, "PNG")
    pixels = oriented_reference_pixels(output.getvalue())
    assert [pixel[0] for pixel in pixels.getdata()] == [0, 128, 255]


def test_rgb_profile_converts_to_srgb_before_metadata_is_removed():
    image = Image.new("RGB", (10, 10), (150, 40, 90))
    output = io.BytesIO()
    profile = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
    image.save(output, "PNG", icc_profile=profile)
    pixels = oriented_reference_pixels(output.getvalue())
    assert pixels.getpixel((5, 5)) == (150, 40, 90, 255)
    assert not pixels.info


def test_cmyk_profile_transform_receives_cmyk_pixels(monkeypatch):
    image = Image.new("CMYK", (8, 8), (10, 20, 30, 40))
    output = io.BytesIO()
    image.save(output, "JPEG", icc_profile=b"test-profile")
    seen = []
    monkeypatch.setattr(ImageCms, "ImageCmsProfile", lambda _value: "input-profile")

    def transform(pixels, _source, _target, **_options):
        seen.append(pixels.mode)
        return Image.new("RGB", pixels.size, (80, 100, 120))

    monkeypatch.setattr(ImageCms, "profileToProfile", transform)
    pixels = oriented_reference_pixels(output.getvalue())
    assert seen == ["CMYK"]
    assert pixels.getpixel((0, 0)) == (80, 100, 120, 255)
