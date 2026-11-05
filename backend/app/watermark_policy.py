"""One cross-language source for watermark rendering geometry and policy."""

import hashlib
import json
from pathlib import Path

_POLICY_PATH = Path(__file__).resolve().parents[2] / "shared/watermark-policy.json"
WATERMARK_POLICY = json.loads(_POLICY_PATH.read_text(encoding="utf-8"))
WATERMARK_POLICY_FINGERPRINT = hashlib.sha256(
    json.dumps(WATERMARK_POLICY, sort_keys=True, separators=(",", ":")).encode()
).hexdigest()

# Fields that decide where the mark lies, and therefore which pixels analysis
# reads. Absent fields (older policies) are simply left out.
GEOMETRY_FIELDS = (
    "placementFrame",
    "contentAnchor",
    "sizeFraction",
    "insetFraction",
    "sizeReferenceAspectRatios",
    "safeAspectRatios",
)


def geometry_fingerprint(policy):
    """Rendering-only changes invalidate PNGs without invalidating pixel analysis."""
    geometry = {name: policy[name] for name in GEOMETRY_FIELDS if name in policy}
    return hashlib.sha256(
        json.dumps(geometry, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


WATERMARK_GEOMETRY_FINGERPRINT = geometry_fingerprint(WATERMARK_POLICY)
