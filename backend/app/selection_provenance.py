"""Optional per-control record of where a Standard control's value came from.

The field lives on the wire control itself, so it travels unchanged through
``selected_controls`` snapshots, saved records and restores. The server never
rewrites it and never sends it to prompt composition. Full raw model evidence stays
once in ``dynamic_controls_metadata``; ``anchor`` only links to that evidence.
"""

import re

SELECTION_PROVENANCE_FIELD = "selection_provenance"
SELECTION_PROVENANCE_VERSION = 1
SELECTION_SOURCES = ("suggested", "explicit", "fallback-random")
SELECTION_EFFECTS = ("value", "model-decides")
ANCHOR_PATTERN = re.compile(r"[A-Za-z0-9._:-]{1,64}")


def validate_selection_provenance(value):
    """Reject a malformed version-1 record; leave other versions untouched.

    Unknown extra keys are allowed so later versions can add information without
    breaking older readers or writers.
    """
    if not isinstance(value, dict):
        raise ValueError("Selection provenance must be an object")
    version = value.get("version")
    if type(version) is not int or version < 1:
        raise ValueError("Selection provenance needs a positive integer version")
    if version != SELECTION_PROVENANCE_VERSION:
        return
    if value.get("source") not in SELECTION_SOURCES:
        raise ValueError("Unsupported selection provenance source")
    anchor = value.get("anchor")
    if anchor is not None and (
        not isinstance(anchor, str) or not ANCHOR_PATTERN.fullmatch(anchor)
    ):
        raise ValueError("Selection provenance anchor is invalid")
    effect = value.get("effect")
    if effect is not None and (
        effect not in SELECTION_EFFECTS or value["source"] != "suggested"
    ):
        raise ValueError("Selection provenance effect is invalid")
