"""Bounded watermark rendering data for thumbnail and slideshow summaries."""

import json
import re
from pathlib import Path

from .media import MEBIBYTE
from .watermark_analysis import ANALYSIS_VERSION, CORNERS
from .watermark_policy import WATERMARK_GEOMETRY_FINGERPRINT

MAX_PREVIEW_SIDECAR_BYTES = 2 * MEBIBYTE
DEFAULT_PREVIEW_CORNER = "bottom-left"
COLOR_FIELDS = (
    ("gradient_start", "gradientStart"),
    ("gradient_end", "gradientEnd"),
    ("separation_color", "separationColor"),
    ("glow_color", "glowColor"),
)
HEX_COLOR = re.compile(r"#[0-9a-fA-F]{6}\Z")
IMAGE_ID = re.compile(r"[A-Za-z0-9_-]+\Z")


def compact_watermark_analysis(analysis):
    """Keep only renderer-consumed fields; never copy palettes or provenance.

    An analysis whose provenance names another analysis version or geometry
    policy is stale: its corner and colors belong to a different algorithm, so
    it yields nothing. A current analysis carries its version forward as
    `analysis_version`, which lets bounded summaries reject older compact copies
    without reading provenance.
    """
    if not isinstance(analysis, dict):
        return None
    provenance = analysis.get("provenance")
    provenance = provenance if isinstance(provenance, dict) else {}
    version = provenance.get("generator_version") or analysis.get("analysis_version")
    geometry = provenance.get("geometry_policy_fingerprint")
    if (version is not None and version != ANALYSIS_VERSION) or (
        geometry is not None and geometry != WATERMARK_GEOMETRY_FINGERPRINT
    ):
        return None
    position = analysis.get("position")
    corner = position.get("corner") if isinstance(position, dict) else None
    if not isinstance(corner, str) or not corner:
        return None
    corner = corner.strip().lower()
    if corner not in CORNERS:
        corner = DEFAULT_PREVIEW_CORNER
    presentation = analysis.get("presentation")
    presentation = presentation if isinstance(presentation, dict) else {}
    colors = {}
    for snake_case, camel_case in COLOR_FIELDS:
        value = presentation.get(snake_case)
        if value is None:
            value = presentation.get(camel_case)
        if isinstance(value, str) and HEX_COLOR.fullmatch(value.strip()):
            colors[snake_case] = value.strip()
    compact = {"position": {"corner": corner}, "presentation": colors}
    if version is not None:
        compact["analysis_version"] = version
    return compact


def current_compact_preview(preview):
    return (
        preview
        if isinstance(preview, dict)
        and preview.get("analysis_version") == ANALYSIS_VERSION
        else None
    )


def legacy_watermark_preview(storage_root, identity):
    """Read one old sidecar without loading source pixels or generation records."""
    if not isinstance(identity, str) or not IMAGE_ID.fullmatch(identity):
        return None
    try:
        root = Path(storage_root).resolve()
        path = root / "derivatives" / identity / "analysis.json"
        if path.is_symlink() or not path.resolve().is_relative_to(root):
            return None
        with path.open("rb") as handle:
            data = handle.read(MAX_PREVIEW_SIDECAR_BYTES + 1)
        if len(data) > MAX_PREVIEW_SIDECAR_BYTES:
            return None
        return compact_watermark_analysis(json.loads(data))
    except (OSError, ValueError, UnicodeError, RuntimeError):
        # Broken metadata must not make an otherwise valid image page disappear.
        return None


def summary_watermark_preview(record, storage_root=None):
    if not record.get("has_watermark_analysis"):
        return {}
    # Projections written by an older analysis version hold compact copies
    # without the current version; fall back to the bounded sidecar, which is
    # itself rejected when stale.
    preview = current_compact_preview(
        compact_watermark_analysis(record.get("print_watermark"))
    )
    if preview is None and storage_root is not None:
        preview = current_compact_preview(
            legacy_watermark_preview(storage_root, record["id"])
        )
    return {
        "has_watermark_analysis": preview is not None,
        "print_watermark": preview,
        "watermark_preview_status": "available"
        if preview is not None
        else "unavailable",
    }
