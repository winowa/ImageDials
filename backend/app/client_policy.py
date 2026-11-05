"""Nonsecret browser behavior/cache budgets shared with the frontend defaults."""

import copy
import json
import math
from pathlib import Path

from .media import positive_integer

DEFAULT_CLIENT_POLICY = json.loads(
    (Path(__file__).resolve().parents[2] / "shared/client-policy.json").read_text(
        encoding="utf-8"
    )
)
MAX_JAVASCRIPT_SAFE_INTEGER = (1 << 53) - 1
POLICY_ENVIRONMENT_VARIABLES = {
    "cache": {
        "shared_record_limit": "CACHE_SHARED_RECORD_LIMIT",
        "shared_detail_record_limit": "CACHE_SHARED_DETAIL_RECORD_LIMIT",
        "shared_detail_max_bytes": "CACHE_SHARED_DETAIL_MAX_BYTES",
        "shared_page_manifest_limit": "CACHE_SHARED_PAGE_MANIFEST_LIMIT",
        "shared_page_max_bytes": "CACHE_SHARED_PAGE_MAX_BYTES",
        "shared_variant_limit": "CACHE_SHARED_VARIANT_LIMIT",
        "shared_variant_max_bytes": "CACHE_SHARED_VARIANT_MAX_BYTES",
        "reference_record_limit": "CACHE_REFERENCE_RECORD_LIMIT",
        "reference_max_bytes": "CACHE_REFERENCE_MAX_BYTES",
        "private_record_limit": "CACHE_PRIVATE_RECORD_LIMIT",
        "private_max_bytes": "CACHE_PRIVATE_MAX_BYTES",
        "private_volatile_record_limit": "CACHE_PRIVATE_VOLATILE_RECORD_LIMIT",
        "private_volatile_max_bytes": "CACHE_PRIVATE_VOLATILE_MAX_BYTES",
    },
    "controls": {
        "debounce_ms": "CONTROLS_DEBOUNCE_MS",
        "reset_debounce_ms": "CONTROLS_RESET_DEBOUNCE_MS",
        "reveal_hold_ms": "CONTROLS_REVEAL_HOLD_MS",
        "max_attempts": "CONTROLS_MAX_ATTEMPTS",
    },
    "transport": {
        "job_poll_interval_ms": "JOB_POLL_INTERVAL_MS",
        "job_poll_max_failures": "JOB_POLL_MAX_FAILURES",
        "library_reconnect_initial_ms": "LIBRARY_RECONNECT_INITIAL_MS",
        "library_reconnect_max_ms": "LIBRARY_RECONNECT_MAX_MS",
        "library_change_debounce_ms": "LIBRARY_CHANGE_DEBOUNCE_MS",
        "gallery_poll_interval_ms": "GALLERY_POLL_INTERVAL_MS",
        "library_poll_interval_ms": "LIBRARY_POLL_INTERVAL_MS",
        "library_pointer_idle_ms": "LIBRARY_POINTER_IDLE_MS",
    },
    "gallery": {
        "new_image_hold_ms": "GALLERY_NEW_IMAGE_HOLD_MS",
        "filmstrip_initial_count": "GALLERY_FILMSTRIP_INITIAL_COUNT",
        "filmstrip_batch_count": "GALLERY_FILMSTRIP_BATCH_COUNT",
    },
}


def client_policy(env):
    policy = copy.deepcopy(DEFAULT_CLIENT_POLICY)
    for group, variables in POLICY_ENVIRONMENT_VARIABLES.items():
        for key, variable in variables.items():
            value = positive_integer(env, variable, policy[group][key])
            if value > MAX_JAVASCRIPT_SAFE_INTEGER:
                raise ValueError(
                    f"{variable} exceeds the browser's exact integer range"
                )
            policy[group][key] = value
    try:
        ratio = float(
            env.get(
                "CONTROLS_SIMILARITY_MINIMUM_RATIO",
                policy["controls"]["similarity_minimum_ratio"],
            )
        )
    except (ValueError, TypeError) as exc:
        raise ValueError(
            "CONTROLS_SIMILARITY_MINIMUM_RATIO must be between zero and one"
        ) from exc
    if not math.isfinite(ratio) or not 0 <= ratio <= 1:
        raise ValueError(
            "CONTROLS_SIMILARITY_MINIMUM_RATIO must be between zero and one"
        )
    policy["controls"]["similarity_minimum_ratio"] = ratio
    transport = policy["transport"]
    if (
        transport["library_reconnect_initial_ms"]
        > transport["library_reconnect_max_ms"]
    ):
        raise ValueError(
            "LIBRARY_RECONNECT_INITIAL_MS must not exceed LIBRARY_RECONNECT_MAX_MS"
        )
    return policy
