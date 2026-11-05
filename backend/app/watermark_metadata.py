"""Embed provenance in a separate watermarked PNG without changing its source."""

import copy
import hashlib
import io
import json
import re

from PIL import Image, UnidentifiedImageError

from .media import display_dimensions, prepare_original_png
from .watermark_analysis import ANALYSIS_VERSION
from .watermark_policy import WATERMARK_GEOMETRY_FINGERPRINT
from .watermark_settings import normalize_settings, settings_response
from .watermarks import StaleWatermarkError, watermark_key

VIEW_ONLY_FIELDS = {
    "sha256",
    "image_url",
    "print_ready",
    "print_ready_url",
    "local_origin",
    "local_storage",
    "local_thumbnail_url",
    "client_key",
    "client_pending",
}


def watermarked_download_png(data, metadata, max_pixels):
    if not isinstance(metadata, dict):
        raise ValueError("Provide a derivative metadata object")
    source = metadata.get("source_image")
    analysis = metadata.get("print_watermark")
    dimensions = metadata.get("dimensions")
    source_hash = metadata.get("source_sha256")
    if (
        not isinstance(source, dict)
        or not isinstance(analysis, dict)
        or not isinstance(dimensions, dict)
    ):
        raise ValueError("Provide source, analysis and dimensions for the derivative")
    if not isinstance(source_hash, str) or not re.fullmatch(
        r"[a-f0-9]{64}", source_hash
    ):
        raise ValueError("Provide the original source hash")
    provenance = analysis.get("provenance")
    if (
        not isinstance(provenance, dict)
        or provenance.get("source_sha256") != source_hash
    ):
        raise ValueError("Analysis does not match the original source")
    if provenance.get("source_dimensions") != dimensions:
        raise ValueError("Derivative dimensions do not match the analyzed original")
    if (
        provenance.get("generator_version") != ANALYSIS_VERSION
        or provenance.get("geometry_policy_fingerprint")
        != WATERMARK_GEOMETRY_FINGERPRINT
    ):
        # Positions and colors from another analysis version are never reused.
        raise StaleWatermarkError("Watermark analysis is outdated; analyze again")
    settings = settings_response(normalize_settings(metadata.get("watermark_settings")))
    key = watermark_key({"sha256": source_hash}, analysis, settings)
    if metadata.get("watermark_key") != key:
        raise StaleWatermarkError(
            "Watermark version changed; refresh analysis and render again"
        )
    try:
        with Image.open(io.BytesIO(data)) as image:
            if image.format != "PNG":
                raise ValueError("Prepared derivative must be a PNG")
            width, height = display_dimensions(image)
            if width * height > max_pixels:
                raise ValueError("Prepared derivative exceeds the pixel limit")
            if dimensions != {"width": width, "height": height}:
                raise ValueError("Prepared derivative dimensions do not match analysis")
            image.load()
    except (OSError, UnidentifiedImageError, Image.DecompressionBombError) as exc:
        raise ValueError("Prepared derivative is not a valid PNG") from exc
    identity = "watermark-" + hashlib.sha256(data + key.encode()).hexdigest()
    record = {
        name: copy.deepcopy(value)
        for name, value in source.items()
        if name not in VIEW_ONLY_FIELDS
    }
    record.update(
        id=identity,
        image_id=identity,
        filename=identity + ".png",
        storage_id="browser-derivative",
        storage_type="browser-upload",
        derivative_type="watermarked",
        derivative_of={
            "image_id": source.get("image_id") or source.get("id"),
            "storage_id": source.get("storage_id"),
            "filename": source.get("filename"),
            "sha256": source_hash,
        },
        print_watermark=copy.deepcopy(analysis),
        watermark_settings=settings,
        print_watermark_key=key,
        width=width,
        height=height,
        dimensions={"width": width, "height": height},
        actual_dimensions={"width": width, "height": height},
    )
    if isinstance(source.get("original_selected_controls"), list):
        record["selected_controls"] = copy.deepcopy(
            source["original_selected_controls"]
        )
    # Reject non-JSON values before embedding; the original wire data is retained.
    json.dumps(record, allow_nan=False)
    return prepare_original_png(data, record, max_pixels)
