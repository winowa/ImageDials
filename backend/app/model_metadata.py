"""Optional public model information; never a source of provider configuration."""

import json
from urllib.parse import urlsplit

MAX_MODEL_METADATA_BYTES = 64 * 1024
MAX_MODEL_METADATA_ENTRIES = 128
MAX_MODEL_NAME_CHARS = 512
MODEL_FIELD_LIMITS = {"publisher": 200, "detail": 2000, "url": 2048}


def public_text(value, limit):
    if value is None:
        return None
    if not isinstance(value, str) or len(value) > limit:
        raise ValueError("Model metadata fields must be bounded text or null")
    try:
        value.encode("utf-8")
    except UnicodeEncodeError as error:
        raise ValueError("Model metadata must contain valid Unicode text") from error
    return value.strip() or None


def model_metadata(env):
    """Read the bounded, name-keyed public descriptors once at app startup."""
    raw = env.get("MODEL_METADATA_JSON")
    if raw is None or raw == "":
        raw = "{}"
    if not isinstance(raw, str):
        raise ValueError("MODEL_METADATA_JSON must be a JSON object")
    try:
        size = len(raw.encode("utf-8"))
    except UnicodeEncodeError as error:
        raise ValueError("Model metadata must contain valid Unicode text") from error
    if size > MAX_MODEL_METADATA_BYTES:
        raise ValueError("MODEL_METADATA_JSON exceeds its public metadata limit")
    try:
        values = json.loads(raw)
    except (ValueError, RecursionError) as error:
        raise ValueError("MODEL_METADATA_JSON must be a JSON object") from error
    if not isinstance(values, dict) or len(values) > MAX_MODEL_METADATA_ENTRIES:
        raise ValueError("MODEL_METADATA_JSON must be a bounded JSON object")
    result = {}
    for name, fields in values.items():
        if public_text(name, MAX_MODEL_NAME_CHARS) is None:
            raise ValueError("MODEL_METADATA_JSON contains an invalid model name")
        if not isinstance(fields, dict) or set(fields) - MODEL_FIELD_LIMITS.keys():
            raise ValueError("Model metadata permits only publisher, detail and url")
        normalized = {}
        for field, limit in MODEL_FIELD_LIMITS.items():
            normalized[field] = public_text(fields.get(field), limit)
        if normalized["url"] is not None:
            url = normalized["url"]
            try:
                parsed = urlsplit(url)
                valid = (
                    parsed.scheme in {"http", "https"}
                    and parsed.hostname
                    and parsed.username is None
                    and parsed.password is None
                    and not any(
                        character.isspace()
                        or ord(character) < 32
                        or ord(character) == 127
                        for character in url
                    )
                )
                parsed.port  # Validate an explicitly supplied port as well.
            except ValueError:
                valid = False
            if not valid:
                raise ValueError(
                    "Model resource URLs must be HTTP(S) without credentials"
                )
        result[name] = normalized
    return result
