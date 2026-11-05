"""Shared helpers for tests that consume the sanitized control fixtures."""

import copy
import io
import json
from pathlib import Path

FIXTURES = Path(__file__).resolve().parents[2] / "fixtures" / "api"


def load_fixture(name):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def ordered_categories(kinds, *, suffix=""):
    """Fictional initial categories, one per requested kind, in that order."""
    templates = load_fixture("initial-controls.json")["templates"]
    result = []
    for index, kind in enumerate(kinds):
        category = copy.deepcopy(templates[kind])
        category["id"] += f"{suffix}-{index}" if suffix else ""
        result.append(category)
    return result


def chat_response(body, finish_reason=None):
    """OpenAI-compatible chat completion envelope around a JSON body or raw text."""
    content = body if isinstance(body, str) else json.dumps(body)
    choice = {"message": {"content": content}}
    if finish_reason:
        choice["finish_reason"] = finish_reason
    return {"choices": [choice]}


def unsupported_format_error():
    """The explicit unsupported-format response that permits one downgrade."""
    import urllib.error

    from app.providers import ProviderError

    cause = urllib.error.HTTPError(
        "http://localhost",
        400,
        "Unsupported",
        {},
        io.BytesIO(b'{"error":"response_format json_schema is not supported"}'),
    )
    error = ProviderError("Provider rejected format")
    error.__cause__ = cause
    return error


class FakeHttpResponse:
    """Minimal urllib response for tests that exercise providers.request itself."""

    def __init__(self, document):
        self.data = json.dumps(document).encode()

    def read(self, limit=-1):
        return self.data if limit < 0 else self.data[:limit]

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False
