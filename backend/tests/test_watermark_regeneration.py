"""Explicit alternatives use the original, measured corners and related tones."""

import copy
import hashlib
import io

import pytest
from app.store import Store
from app.watermark_analysis import (
    ANALYSIS_VERSION,
    REGENERATION_SCORE_MARGIN,
    analyze_watermark,
    regenerate_watermark,
)
from app.watermarks import WatermarkService
from PIL import Image


def source():
    image = Image.new("RGB", (480, 320), "#908b82")
    # Detailed central subject with quiet corner margins.
    for x in range(150, 330):
        for y in range(75, 245):
            image.putpixel((x, y), ((x * 13 + y * 7) % 256, y % 256, x % 256))
    output = io.BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


def test_repeated_regeneration_is_reproducible_bounded_and_not_identical():
    data = source()
    baseline = analyze_watermark(data)
    previous = baseline
    for _ in range(8):
        result = regenerate_watermark(data, previous)
        assert result == regenerate_watermark(data, previous)
        assert (result["position"], result["presentation"]) != (
            previous["position"],
            previous["presentation"],
        )
        scores = result["provenance"]["corner_scores"]
        selected = next(
            s for s in scores if s["corner"] == result["position"]["corner"]
        )
        assert (
            selected["placement_score"]
            <= min(s["placement_score"] for s in scores) + REGENERATION_SCORE_MARGIN
        )
        assert result["provenance"]["source_sha256"] == hashlib.sha256(data).hexdigest()
        assert result["provenance"]["generator_version"] == ANALYSIS_VERSION
        assert result["provenance"]["regeneration"]["placement"]
        assert result["provenance"]["regeneration"]["colors"]
        previous = result
    assert analyze_watermark(data) == baseline


def test_confident_retention_and_no_alternative_are_explicit():
    data = source()
    baseline = analyze_watermark(data)
    selected = baseline["position"]["corner"]
    for score in baseline["provenance"]["corner_scores"]:
        score["placement_score"] = 0 if score["corner"] == selected else 1
        score["target_met"] = True
        score["start_contrast"]["footprint_pixels_at_minimum"] = 1
        score["end_contrast"]["footprint_pixels_at_minimum"] = 1
    baseline["provenance"]["palette"] = ["#235a9a", "#3068a9"]
    retained = regenerate_watermark(data, baseline, copy.deepcopy(baseline))
    assert retained["position"] == baseline["position"]
    assert retained["presentation"] == baseline["presentation"]
    reason = retained["provenance"]["regeneration"]
    assert reason["placement"].startswith("Kept the only corner")
    assert reason["colors"].startswith("Kept image colors")


def test_transient_context_uses_matching_current_analysis_and_rejects_other_source(
    tmp_path,
):
    service = WatermarkService(Store(tmp_path))
    data = source()
    first = service.analyze_upload(data)
    next_response = service.analyze_upload(
        data, force=True, previous_analysis=first["print_watermark"]
    )
    assert next_response["print_watermark_key"] != first["print_watermark_key"]
    # Automatic preparation keeps the chosen mark and binds browser content.
    context = next_response["print_watermark"]
    prepared = service.analyze_upload(
        data,
        previous_analysis=context,
        settings_override={"type": "text", "text": "Other"},
    )
    assert prepared["print_watermark"] == context
    assert prepared["print_watermark_key"] != next_response["print_watermark_key"]
    assert service.analyze_upload(data)["print_watermark"] == first["print_watermark"]
    wrong = copy.deepcopy(context)
    wrong["provenance"]["source_sha256"] = "0" * 64
    with pytest.raises(ValueError, match="another source"):
        service.analyze_upload(data, force=True, previous_analysis=wrong)
    stale = copy.deepcopy(context)
    stale["provenance"]["generator_version"] = "pixel-analysis-v3"
    assert (
        service.analyze_upload(data, previous_analysis=stale)["print_watermark"]
        == first["print_watermark"]
    )


def test_baked_shared_source_cannot_be_analyzed_again(tmp_path):
    service = WatermarkService(Store(tmp_path))
    with pytest.raises(ValueError, match="built in"):
        service.analyze({"derivative_type": "watermarked"}, force=True)


def test_no_valid_tonal_alternative_is_reported_without_inventing_confidence():
    from app.watermark_analysis import (
        ACCENT_MAXIMUM_LIGHTNESS,
        ACCENT_MINIMUM_LIGHTNESS,
        oklch_rgb,
        rgb_hex,
    )

    data = source()
    baseline = analyze_watermark(data)
    selected = baseline["position"]["corner"]
    colors = {
        "gradient_start": rgb_hex(oklch_rgb(ACCENT_MINIMUM_LIGHTNESS, 0, 0)),
        "gradient_end": rgb_hex(oklch_rgb(ACCENT_MAXIMUM_LIGHTNESS, 0, 0)),
    }
    for score in baseline["provenance"]["corner_scores"]:
        score["placement_score"] = 0 if score["corner"] == selected else 1
        if score["corner"] == selected:
            score.update(colors)
    baseline["presentation"].update(colors)
    baseline["provenance"]["palette"] = ["#808080"]
    result = regenerate_watermark(data, baseline, copy.deepcopy(baseline))
    assert result["position"] == baseline["position"]
    assert result["presentation"] == baseline["presentation"]
    assert result["provenance"]["regeneration"]["colors"].startswith(
        "Kept colors: no distinct tonal alternative"
    )
    assert result["provenance"]["regeneration"]["colors_changed"] is False


def test_baked_transient_source_refuses_second_mark(tmp_path):
    from app.media import prepare_original_png

    service = WatermarkService(Store(tmp_path))
    baked = prepare_original_png(
        source(), {"id": "baked", "derivative_type": "watermarked"}
    )
    with pytest.raises(ValueError, match="built in"):
        service.analyze_upload(baked, force=True)
