"""The browser receives validated nonsecret budget and timing configuration."""

import copy
import json
from pathlib import Path

import pytest
from app.client_policy import DEFAULT_CLIENT_POLICY, client_policy
from app.main import create_app
from fastapi.testclient import TestClient


def test_configured_capabilities_and_shared_defaults_are_independent(tmp_path):
    original = copy.deepcopy(DEFAULT_CLIENT_POLICY)
    settings = {
        "IMAGEDIALS_DATA_DIR": str(tmp_path),
        "CACHE_SHARED_RECORD_LIMIT": "12",
        "CACHE_SHARED_DETAIL_RECORD_LIMIT": "6",
        "CACHE_SHARED_DETAIL_MAX_BYTES": "8192",
        "CACHE_SHARED_PAGE_MANIFEST_LIMIT": "8",
        "CACHE_SHARED_PAGE_MAX_BYTES": "16384",
        "CACHE_PRIVATE_MAX_BYTES": "4096",
        "CACHE_REFERENCE_RECORD_LIMIT": "8",
        "CACHE_REFERENCE_MAX_BYTES": "32768",
        "CACHE_PRIVATE_VOLATILE_RECORD_LIMIT": "2",
        "CACHE_PRIVATE_VOLATILE_MAX_BYTES": "2048",
        "CONTROLS_SIMILARITY_MINIMUM_RATIO": "0.85",
        "CONTROLS_REVEAL_HOLD_MS": "3500",
        "LIBRARY_RECONNECT_MAX_MS": "5000",
    }
    with TestClient(create_app(settings)) as client:
        policy = client.get("/api/app-capabilities").json()["client_policy"]
    assert policy["cache"]["shared_record_limit"] == 12
    assert policy["cache"]["shared_detail_record_limit"] == 6
    assert policy["cache"]["shared_detail_max_bytes"] == 8192
    assert policy["cache"]["shared_page_manifest_limit"] == 8
    assert policy["cache"]["shared_page_max_bytes"] == 16384
    assert policy["cache"]["reference_record_limit"] == 8
    assert policy["cache"]["reference_max_bytes"] == 32768
    assert policy["cache"]["private_max_bytes"] == 4096
    assert policy["cache"]["private_volatile_record_limit"] == 2
    assert policy["cache"]["private_volatile_max_bytes"] == 2048
    assert policy["controls"]["similarity_minimum_ratio"] == 0.85
    assert policy["controls"]["reveal_hold_ms"] == 3500
    assert policy["transport"]["library_reconnect_max_ms"] == 5000
    assert DEFAULT_CLIENT_POLICY == original
    assert client_policy({}) == original
    assert original["controls"]["similarity_minimum_ratio"] == 0.5


@pytest.mark.parametrize(
    "settings",
    [
        {"CACHE_PRIVATE_RECORD_LIMIT": "0"},
        {"CACHE_REFERENCE_RECORD_LIMIT": "0"},
        {"CACHE_REFERENCE_MAX_BYTES": str(1 << 53)},
        {"CACHE_PRIVATE_VOLATILE_RECORD_LIMIT": "0"},
        {"CACHE_PRIVATE_VOLATILE_MAX_BYTES": "-1"},
        {"CACHE_SHARED_VARIANT_MAX_BYTES": "-1"},
        {"CACHE_SHARED_DETAIL_RECORD_LIMIT": "0"},
        {"CACHE_SHARED_DETAIL_MAX_BYTES": "-1"},
        {"CACHE_SHARED_PAGE_MANIFEST_LIMIT": "0"},
        {"CACHE_SHARED_PAGE_MAX_BYTES": str(1 << 53)},
        {"CONTROLS_DEBOUNCE_MS": "1.5"},
        {"CONTROLS_REVEAL_HOLD_MS": "0"},
        {"CONTROLS_SIMILARITY_MINIMUM_RATIO": "NaN"},
        {"CONTROLS_SIMILARITY_MINIMUM_RATIO": "1.1"},
        {"JOB_POLL_INTERVAL_MS": str(1 << 53)},
        {"LIBRARY_RECONNECT_INITIAL_MS": "40000", "LIBRARY_RECONNECT_MAX_MS": "10000"},
    ],
)
def test_invalid_client_configuration_fails_before_serving(settings):
    with pytest.raises(ValueError):
        create_app(settings)


@pytest.mark.parametrize(
    "profile,shared", [("shared", True), ("browser_private", False)]
)
def test_shared_capability_fixtures_match_actual_endpoint(tmp_path, profile, shared):
    fixture = json.loads(
        (
            Path(__file__).resolve().parents[2] / "fixtures/api/m5-configuration.json"
        ).read_text()
    )[profile]
    with TestClient(
        create_app(
            {
                "IMAGEDIALS_DATA_DIR": str(tmp_path),
                "SHARED_LIBRARY_ENABLED": str(shared).lower(),
            }
        )
    ) as client:
        assert client.get("/api/app-capabilities").json() == fixture
