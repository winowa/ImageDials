"""A failed controls call keeps its request and received response inspectable."""

import copy
import io
import json
import urllib.error

import pytest
from app import providers
from app.domain import Draft
from app.main import create_app
from app.providers import ProviderError
from control_fixtures import chat_response, load_fixture, ordered_categories
from fastapi.testclient import TestClient

FIXTURE = load_fixture("initial-controls.json")
KEY = "sk-test-credential-value"
BASE = "http://provider.invalid:9"
ENV = {
    "LLM_MODEL_ENDPOINT_1": BASE,
    "LLM_MODEL_NAME": "fixture-model",
    "LLM_MODEL_KEY_1": KEY,
}


def stub(monkeypatch, *items):
    calls, queue = [], list(items)

    def respond(base, path, payload=None, **kwargs):
        calls.append(copy.deepcopy(payload))
        item = queue.pop(0) if len(queue) > 1 else queue[0]
        if isinstance(item, Exception):
            raise item
        return item

    monkeypatch.setattr(providers, "request", respond)
    return calls


def http_error(status, body):
    cause = urllib.error.HTTPError(BASE, status, "x", {}, io.BytesIO(body))
    error = ProviderError("Provider request failed; check service availability")
    error.__cause__ = cause
    return error


def failed(monkeypatch, response):
    stub(monkeypatch, response)
    with pytest.raises(ProviderError) as caught:
        providers.ControlsProvider(ENV).controls_with_suggestions(
            Draft(prompt="A barn owl")
        )
    return caught.value.evidence


def test_invalid_controls_keep_the_exact_request_and_raw_response(monkeypatch):
    raw = json.dumps({"categories": ordered_categories(FIXTURE["kinds"][:-1])})
    calls = stub(monkeypatch, chat_response(raw))
    with pytest.raises(ProviderError, match="invalid controls") as caught:
        providers.ControlsProvider(ENV).controls_with_suggestions(
            Draft(prompt="A barn owl")
        )
    evidence = caught.value.evidence
    assert len(calls) == 1
    assert evidence["status"] == "failed"
    assert evidence["raw_response"] == raw
    assert evidence["raw_response_truncated"] is False
    assert json.loads(evidence["prompt"]) == calls[0]["messages"]
    assert evidence["response_format"] == calls[0]["response_format"]
    assert evidence["schema_fallback"] is False
    assert evidence["model"] == "fixture-model"
    assert evidence["failure"]["reason"]


def test_non_json_text_is_kept_verbatim(monkeypatch):
    text = "Here are your controls:\n```json\n{oops\n"
    evidence = failed(monkeypatch, chat_response(text))
    assert evidence["raw_response"] == text
    assert "provider_body" not in evidence


def test_a_reply_without_message_content_keeps_the_provider_body(monkeypatch):
    evidence = failed(monkeypatch, {"error": {"message": "no choices"}})
    assert "raw_response" not in evidence
    assert json.loads(evidence["provider_body"]) == {"error": {"message": "no choices"}}


@pytest.mark.parametrize("content", [None, 12, [], {"text": "not chat text"}])
def test_non_text_content_keeps_the_received_body(monkeypatch, content):
    response = {"choices": [{"message": {"content": content}}]}
    evidence = failed(monkeypatch, response)
    assert "raw_response" not in evidence
    assert json.loads(evidence["provider_body"]) == response
    assert "Message content is not text" in evidence["failure"]["reason"]


def test_oversized_raw_responses_are_bounded_and_flagged(monkeypatch):
    evidence = failed(
        monkeypatch, chat_response("x" * (providers.EVIDENCE_TEXT_LIMIT + 5))
    )
    assert len(evidence["raw_response"]) == providers.EVIDENCE_TEXT_LIMIT
    assert evidence["raw_response_truncated"] is True


def test_redaction_precedes_clipping_so_no_partial_credential_is_exposed(monkeypatch):
    raw = "x" * (providers.EVIDENCE_TEXT_LIMIT - 5) + KEY + BASE
    evidence = failed(monkeypatch, chat_response(raw))
    assert KEY[:5] not in evidence["raw_response"]
    assert BASE not in evidence["raw_response"]
    assert evidence["raw_response_truncated"] is True


def test_http_error_responses_are_kept_without_credentials(monkeypatch):
    body = f"bad request for {BASE} using {KEY}".encode()
    evidence = failed(monkeypatch, http_error(503, body))
    assert evidence["failure"]["http_status"] == 503
    assert "[redacted]" in evidence["failure"]["body"]
    assert KEY not in json.dumps(evidence) and BASE not in json.dumps(evidence)
    assert json.loads(evidence["prompt"])[0]["role"] == "system"


@pytest.mark.parametrize(
    "address",
    ["provider.invalid", "PROVIDER.INVALID", "https://Provider.Invalid:9/api/"],
)
@pytest.mark.parametrize("http", [False, True])
def test_provider_host_aliases_are_redacted_in_received_evidence(
    monkeypatch, address, http
):
    text = f"Upstream {address} rejected this request"
    response = http_error(503, text.encode()) if http else chat_response(text)
    evidence = failed(monkeypatch, response)
    received = evidence["failure"]["body"] if http else evidence["raw_response"]
    assert "provider.invalid" not in received.lower()
    assert "[redacted]" in received
    assert "rejected this request" in received


def test_hostname_redaction_precedes_raw_response_clipping(monkeypatch):
    raw = "x" * (providers.EVIDENCE_TEXT_LIMIT - 5) + "PROVIDER.INVALID"
    evidence = failed(monkeypatch, chat_response(raw))
    assert "PROVI" not in evidence["raw_response"]
    assert evidence["raw_response_truncated"] is True


@pytest.mark.parametrize("status", [400, 503])
def test_large_http_error_is_flagged_and_redacted_before_clipping(monkeypatch, status):
    body = "x" * (providers.SCHEMA_ERROR_MAX_BYTES - 5) + KEY + "y" * 100
    evidence = failed(monkeypatch, http_error(status, body.encode()))
    failure = evidence["failure"]
    assert failure["body_truncated"] is True
    assert len(failure["body"]) == providers.SCHEMA_ERROR_MAX_BYTES
    assert KEY[:5] not in failure["body"]


def test_unreachable_provider_has_a_request_but_invents_no_response(monkeypatch):
    error = ProviderError("Provider request failed; check service availability")
    error.__cause__ = urllib.error.URLError("refused")
    evidence = failed(monkeypatch, error)
    assert "raw_response" not in evidence and "body" not in evidence["failure"]
    assert "http_status" not in evidence["failure"]
    assert evidence["prompt"]


def test_rejected_schema_body_survives_the_single_downgrade(monkeypatch):
    unsupported = http_error(400, b'{"error":"json_schema is not supported"}')
    stub(monkeypatch, unsupported, chat_response("not json"))
    with pytest.raises(ProviderError) as caught:
        providers.ControlsProvider(ENV).controls_with_suggestions(
            Draft(prompt="A barn owl")
        )
    evidence = caught.value.evidence
    assert evidence["schema_fallback"] is True
    assert evidence["response_format"] is None
    assert evidence["raw_response"] == "not json"


def test_endpoint_returns_the_diagnostics_beside_the_unchanged_message(
    tmp_path, monkeypatch
):
    raw = json.dumps({"categories": ordered_categories(FIXTURE["kinds"][:-1])})
    calls = stub(monkeypatch, chat_response(raw))
    with TestClient(
        create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path), **ENV})
    ) as client:
        response = client.post("/api/controls/dynamic", json={"prompt": "A barn owl"})
    assert response.status_code == 502
    body = response.json()
    assert "invalid controls" in body["detail"]
    assert body["evidence"]["raw_response"] == raw
    assert len(calls) == 1
    assert KEY not in response.text and "Authorization" not in response.text


def test_plain_provider_failures_without_evidence_keep_the_old_shape(
    tmp_path, monkeypatch
):
    def fail(self, *args, **kwargs):
        raise ProviderError("plain")

    monkeypatch.setattr(providers.ControlsProvider, "controls_with_suggestions", fail)
    with TestClient(
        create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path), **ENV})
    ) as client:
        response = client.post("/api/controls/dynamic", json={"prompt": "A barn owl"})
    assert response.status_code == 502
    assert response.json() == {"detail": "plain"}
