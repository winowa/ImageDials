"""Uploads over the decoded pixel limit become a proportional model-sized copy."""

import hashlib
import io
import json
import time

import pytest
from app import reference_analysis
from app.imports import ImageDescriptionProvider
from app.main import create_app
from app.media import (
    DEFAULT_MAX_SOURCE_PIXELS,
    PNG_METADATA_KEY,
    adapt_to_pixel_limit,
    fitted_dimensions,
    prepare_original_png,
    source_pixel_limit,
)
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw

TARGET = 1_000_000
ADAPT = "/api/images/reference-adapt"


def photo(size, mode="RGB", fmt="JPEG", **save):
    """A detailed, non-uniform picture so encoders and resampling do real work."""
    width, height = size
    image = Image.linear_gradient("L").resize(size).convert("RGB")
    draw = ImageDraw.Draw(image)
    for step in range(0, max(size), max(size) // 24):
        draw.line((step, 0, 0, step), fill=(step % 255, 90, 200), width=7)
    draw.rectangle((0, 0, width // 6, height // 6), fill=(250, 20, 20))
    if mode == "RGBA":
        image = image.convert("RGBA")
        ImageDraw.Draw(image).rectangle(
            (width // 2, height // 2, width - 1, height - 1), fill=(0, 0, 0, 0)
        )
    output = io.BytesIO()
    image.save(output, format=fmt, **save)
    return output.getvalue()


def client_for(tmp_path, **settings):
    env = {
        "IMAGEDIALS_DATA_DIR": str(tmp_path),
        "IMAGE_DESCRIPTION_PROVIDER": "mock",
        "IMAGE_SQUARE_DIMENSIONS": "96x96",
        "IMAGE_MAX_DECODED_PIXELS": str(TARGET),
        **settings,
    }
    return TestClient(create_app(env))


def adapt(client, data, name="photo.jpg", kind="image/jpeg"):
    return client.post(ADAPT, files={"file": (name, data, kind)})


def no_inference(monkeypatch):
    def must_not_run(*_args, **_kwargs):
        raise AssertionError("Adaptation must not call a model")

    monkeypatch.setattr(ImageDescriptionProvider, "describe", must_not_run)
    monkeypatch.setattr(reference_analysis, "_prompt_proposal", must_not_run)


def test_fitted_dimensions_keep_shape_and_area_bound():
    for size in [(6000, 4000), (4000, 6000), (16000, 900), (5001, 5003), (7, 3)]:
        width, height = fitted_dimensions(*size, TARGET if size[0] > 10 else 10)
        bound = TARGET if size[0] > 10 else 10
        assert width * height <= bound
        assert abs(width * size[1] - height * size[0]) <= size[0] + size[1]
        # As large as possible: one more pixel each way would exceed the area.
        assert (width + 1) * (height + 1) > bound
    assert fitted_dimensions(800, 600, TARGET) == (800, 600)


def test_over_limit_jpeg_becomes_proportional_copy_with_bound_hashes(
    tmp_path, monkeypatch
):
    no_inference(monkeypatch)
    original = photo((3000, 2000), quality=90)
    with client_for(tmp_path) as client:
        response = adapt(client, original)
        assert response.status_code == 200, response.text
        copy = response.content
        headers = response.headers
        assert headers["content-type"] == "image/jpeg"
        assert headers["cache-control"] == "no-store"
        assert headers["x-source-sha256"] == hashlib.sha256(original).hexdigest()
        assert headers["x-adapted-sha256"] == hashlib.sha256(copy).hexdigest()
        assert (headers["x-source-width"], headers["x-source-height"]) == (
            "3000",
            "2000",
        )
        with Image.open(io.BytesIO(copy)) as image:
            assert image.format == "JPEG"
            assert image.size == (
                int(headers["x-adapted-width"]),
                int(headers["x-adapted-height"]),
            )
            assert image.width * image.height <= TARGET
            assert image.size == fitted_dimensions(3000, 2000, TARGET)
            # Resized, not cropped: the red corner block keeps its share.
            red = image.getpixel((image.width // 12, image.height // 12))
            assert red[0] > 200 and red[1] < 80
        # Nothing stored, and the same input gives the same bytes again.
        assert client.get("/api/images").json()["total"] == 0
        assert adapt(client, original).content == copy


def test_rotated_portrait_alpha_png_and_progressive_jpeg(tmp_path):
    exif = Image.Exif()
    exif[274] = 6
    rotated = photo((3000, 2000), exif=exif.tobytes())
    alpha = photo((1500, 1500), mode="RGBA", fmt="PNG")
    progressive = photo((2400, 1600), progressive=True, quality=85)
    with client_for(tmp_path) as client:
        turned = adapt(client, rotated)
        assert turned.status_code == 200, turned.text
        assert (
            turned.headers["x-source-width"],
            turned.headers["x-source-height"],
        ) == (
            "2000",
            "3000",
        )
        with Image.open(io.BytesIO(turned.content)) as image:
            # Orientation is applied to the pixels; no tag is left to apply twice.
            assert image.height > image.width
            assert image.getexif().get(274) in (None, 1)
            assert image.size == fitted_dimensions(2000, 3000, TARGET)

        clear = adapt(client, alpha, "alpha.png", "image/png")
        assert clear.status_code == 200, clear.text
        assert clear.headers["content-type"] == "image/png"
        with Image.open(io.BytesIO(clear.content)) as image:
            assert image.mode == "RGBA"
            assert image.getpixel((image.width - 2, image.height - 2))[3] == 0
            assert image.getpixel((2, 2))[3] == 255

        steps = adapt(client, progressive)
        assert steps.status_code == 200, steps.text
        with Image.open(io.BytesIO(steps.content)) as image:
            assert image.size == fitted_dimensions(2400, 1600, TARGET)


def test_within_limit_is_never_reencoded(tmp_path):
    exact = photo((1000, 1000), fmt="PNG")
    under = photo((1200, 800), quality=80)
    with client_for(tmp_path) as client:
        for data in (exact, under):
            response = adapt(client, data)
            assert response.status_code == 204
            assert response.content == b""
            assert (
                response.headers["x-source-sha256"] == hashlib.sha256(data).hexdigest()
            )
            assert "x-adapted-sha256" not in response.headers


@pytest.mark.parametrize("mode", ["CMYK", "RGB"])
def test_resized_jpeg_keeps_profile_only_for_unchanged_color_space(mode):
    image = Image.new("RGB", (120, 80), (200, 60, 30)).convert(mode)
    original = io.BytesIO()
    profile = b"source color profile"
    image.save(original, "JPEG", icc_profile=profile, quality=95)
    data = original.getvalue()
    result = adapt_to_pixel_limit(data, 2400, 10000, 100000)
    assert result["source"]["sha256"] == hashlib.sha256(data).hexdigest()
    with Image.open(io.BytesIO(result["adapted"]["data"])) as copy:
        assert copy.mode == "RGB"
        assert copy.size == (60, 40)
        assert copy.info.get("icc_profile") == (profile if mode == "RGB" else None)
        assert all(
            abs(actual - expected) <= 5
            for actual, expected in zip(copy.getpixel((30, 20)), (200, 60, 30))
        )


def test_bad_and_dangerously_large_inputs_still_fail_honestly(tmp_path):
    frames = io.BytesIO()
    big = Image.new("RGB", (1200, 1000), "red")
    big.save(
        frames, "PNG", save_all=True, append_images=[Image.new("RGB", (1200, 1000))]
    )
    with client_for(tmp_path, IMAGE_MAX_SOURCE_PIXELS="4000000") as client:
        assert adapt(client, b"not an image", "bad.png", "image/png").status_code == 400
        truncated = photo((1800, 1800))[:5000]
        assert adapt(client, truncated).status_code == 400
        huge = adapt(client, photo((2600, 2000), fmt="PNG"), "huge.png", "image/png")
        assert huge.status_code == 413
        assert "larger than this server can prepare" in huge.json()["detail"]
        animated = adapt(client, frames.getvalue(), "anim.png", "image/png")
        assert animated.status_code == 400
        assert client.get("/api/images").json()["total"] == 0


def test_copy_that_cannot_fit_the_byte_limit_is_an_error():
    data = photo((2000, 1500), fmt="PNG")
    with pytest.raises(ValueError, match="byte limit"):
        adapt_to_pixel_limit(data, TARGET, 10_000_000, 1000)


def test_source_envelope_configuration():
    assert source_pixel_limit({}) == DEFAULT_MAX_SOURCE_PIXELS
    assert source_pixel_limit({"IMAGE_MAX_DECODED_PIXELS": "150000000"}) == 150_000_000
    with pytest.raises(ValueError, match="at least"):
        source_pixel_limit(
            {"IMAGE_MAX_DECODED_PIXELS": "2000", "IMAGE_MAX_SOURCE_PIXELS": "1000"}
        )
    with pytest.raises(ValueError, match="below"):
        source_pixel_limit({"IMAGE_MAX_SOURCE_PIXELS": "999999999999"})
    with pytest.raises(ValueError):
        source_pixel_limit({"IMAGE_MAX_SOURCE_PIXELS": "-1"})


def test_capabilities_publish_target_and_source_limits(tmp_path):
    with client_for(tmp_path, IMAGE_MAX_SOURCE_PIXELS="50000000") as client:
        uploads = client.get("/api/app-capabilities").json()["uploads"]
        assert uploads["max_decoded_pixels"] == TARGET
        assert uploads["max_source_pixels"] == 50_000_000


def test_reference_analysis_describes_only_what_is_sent(tmp_path, monkeypatch):
    original = photo((3000, 2000))
    with client_for(tmp_path, IMAGE_PROVIDER="mock") as client:
        refused = client.post(
            "/api/images/reference-analysis",
            files={"image": ("big.jpg", original, "image/jpeg")},
        )
        # The browser prepares a copy on this answer instead of failing.
        assert refused.status_code == 413
        assert "decoded pixel limit" in refused.json()["detail"]
        # Checksum-only inspection of the original still works (no-crypto path).
        no_inference(monkeypatch)
        inspected = client.post(
            "/api/images/reference-analysis?inspect_only=true",
            files={"image": ("big.jpg", original, "image/jpeg")},
        )
        assert inspected.status_code == 200, inspected.text
        assert inspected.json()["source_sha256"] == hashlib.sha256(original).hexdigest()
        assert inspected.json()["dimensions"] == {"width": 3000, "height": 2000}


def finish(client, identity):
    for _ in range(300):
        result = client.get(f"/api/generation-jobs/{identity}").json()
        if result["status"] != "running":
            return result
        time.sleep(0.01)
    pytest.fail("Reference generation did not complete")


def edit_request(copy, source, key):
    descriptor = {
        "id": "upload:large",
        "sha256": hashlib.sha256(copy).hexdigest(),
        "description": "A large photo",
        "role": "base",
    }
    if source is not None:
        descriptor["source"] = source
    return {
        "prompt": "Warm the colors",
        "controls": [],
        "dimensions": "96x64",
        "idempotency_key": key,
        "reference_images": [descriptor],
    }


def send(client, body, data, kind="image/jpeg"):
    return client.post(
        "/api/generate-image",
        data={"request": json.dumps(body)},
        files=[("reference_1", ("photo.jpg", data, kind))],
    )


def test_prepared_copy_generates_with_recorded_lineage(tmp_path):
    original = photo((3000, 2000))
    with client_for(tmp_path, IMAGE_PROVIDER="mock") as client:
        response = adapt(client, original)
        copy = response.content
        width = int(response.headers["x-adapted-width"])
        height = int(response.headers["x-adapted-height"])
        lineage = {
            "sha256": hashlib.sha256(original).hexdigest(),
            "width": 3000,
            "height": 2000,
        }
        renderer = client.app.state.renderer
        render = renderer.render
        sent = []

        def record(prompt, w, h, **kwargs):
            sent.append(kwargs["references"])
            return render(prompt, w, h, **kwargs)

        renderer.render = record
        accepted = send(client, edit_request(copy, lineage, "adapted"), copy)
        assert accepted.status_code == 202, accepted.text
        status = finish(client, accepted.json()["generation_job_id"])
        assert status["status"] == "complete", status
        assert sent[0][0]["data"] == copy
        saved = status["result"]["reference_images"][0]
        assert saved["sha256"] == hashlib.sha256(copy).hexdigest()
        assert saved["dimensions"] == {"width": width, "height": height}
        assert saved["source"] == lineage
        image = client.get(status["result"]["image_url"]).content
        with Image.open(io.BytesIO(image)) as result:
            embedded = json.loads(result.info[PNG_METADATA_KEY])["image"]
        assert embedded["reference_images"][0]["source"] == lineage

        # The original itself is still refused for generation (hard guard kept).
        assert (
            send(client, edit_request(original, None, "raw"), original).status_code
            == 400
        )
        # Lineage that does not describe a larger original of the same shape is refused.
        for bad in (
            {**lineage, "width": 30, "height": 20},
            {**lineage, "width": 2000, "height": 3000},
            {**lineage, "sha256": hashlib.sha256(copy).hexdigest()},
        ):
            assert send(
                client, edit_request(copy, bad, f"bad-{bad['width']}"), copy
            ).status_code in (400, 422)


def test_plain_reference_snapshot_has_no_source_key(tmp_path):
    small = photo((320, 200), fmt="PNG")
    with client_for(tmp_path, IMAGE_PROVIDER="mock") as client:
        accepted = send(client, edit_request(small, None, "plain"), small, "image/png")
        assert accepted.status_code == 202, accepted.text
        status = finish(client, accepted.json()["generation_job_id"])
        assert "source" not in status["result"]["reference_images"][0]


def test_import_of_large_metadata_png_keeps_original_snapshot(tmp_path):
    base = photo((1600, 1000), fmt="PNG")
    snapshot = {
        "id": "imported-lighthouse",
        "prompt": "A lighthouse at dusk",
        "selected_controls": [],
        "width": 1600,
        "height": 1000,
    }
    tagged = prepare_original_png(base, dict(snapshot), max_pixels=10_000_000)
    with client_for(tmp_path) as client:
        response = client.post(
            "/api/images/import-analysis",
            files={"image": ("large.png", tagged, "image/png")},
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["mode"] == "metadata", body
        assert "metadata_notice" not in body
        record = body["image"]
        assert record["sha256"] == hashlib.sha256(tagged).hexdigest()
        assert (record["width"], record["height"]) == (1600, 1000)
        assert body["description"]["status"] == "ready"


def test_import_of_large_plain_jpeg_is_described(tmp_path):
    exif = Image.Exif()
    exif[274] = 8
    data = photo((3200, 2000), exif=exif.tobytes())
    with client_for(tmp_path) as client:
        response = client.post(
            "/api/images/import-analysis",
            files={"image": ("photo.jpg", data, "image/jpeg")},
        )
        assert response.status_code == 200, response.text
        assert response.json()["mode"] == "description"
        assert client.get("/api/images/library").json()["count"] == 0


def test_measured_png_copy_query_keeps_exact_normalized_bytes(tmp_path, monkeypatch):
    from app.image_editing import normalize_references
    from test_reference_byte_budgets import noisy, ref

    no_inference(monkeypatch)
    original = noisy((900, 1200), fmt="JPEG")
    budget = 200_000
    with client_for(tmp_path) as client:
        response = client.post(
            f"{ADAPT}?max_normalized_bytes={budget}",
            files={"file": ("photo.jpg", original, "image/jpeg")},
        )
        assert response.status_code == 200, response.text
        assert response.headers["content-type"] == "image/png"
        assert len(response.content) <= budget
        normalized = normalize_references([ref(response.content)])[0]
        assert normalized["data"] == response.content
        assert normalized["normalized_sha256"] == response.headers["x-adapted-sha256"]
        assert (
            response.headers["x-source-sha256"] == hashlib.sha256(original).hexdigest()
        )
