"""Variation requests reserve durable children atomically without duplicating jobs."""

import copy
import io
import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import pytest
from app.main import create_app
from app.media import PNG_METADATA_KEY
from app.providers import ProviderError
from fastapi.testclient import TestClient
from PIL import Image


def request(key="group-one", count=3):
    return {
        "prompt": "A small teal ceramic sphere",
        "controls": [
            {"kind": "binary", "label": "Gloss", "value": False},
            {"kind": "slider", "label": "Detail", "value": 0, "min": 0, "max": 5},
        ],
        "dimensions": "96x64",
        "idempotency_key": key,
        "variation_count": count,
        "dynamic_controls_metadata": {"opaque": {"false": False, "zero": 0}},
    }


def finish(client, identity):
    end = time.monotonic() + 8
    while time.monotonic() < end:
        response = client.get(f"/api/generation-groups/{identity}")
        assert response.status_code == 200, response.text
        group = response.json()
        if group["status"] != "running":
            return group
        time.sleep(0.01)
    pytest.fail("Variation group did not finish")


def accepted(client, body):
    response = client.post("/api/generate-image", json=body)
    assert response.status_code == 202, response.text
    return response.json()["variation_group"]


@pytest.mark.parametrize("count", [2, 3, 4])
def test_group_is_serial_uses_one_prompt_and_saves_distinct_provenance(tmp_path, count):
    settings = {"IMAGEDIALS_DATA_DIR": str(tmp_path)}
    with TestClient(create_app(settings)) as client:
        original = client.app.state.renderer.render
        compose = client.app.state.composer.compose
        calls, prompts, live = [], [], []

        def track_compose(*args):
            prompts.append(True)
            return compose(*args)

        def track_render(prompt, width, height, **kwargs):
            live.append(True)
            assert len(live) == 1
            try:
                time.sleep(0.01)
                data, diagnostics = original(prompt, width, height, **kwargs)
                calls.append((prompt, diagnostics["seed"]))
                return data, diagnostics
            finally:
                live.pop()

        client.app.state.composer.compose = track_compose
        client.app.state.renderer.render = track_render
        body = request(count=count)
        before = copy.deepcopy(body)
        group = accepted(client, body)
        assert len(group["jobs"]) == count
        assert len({job["generation_job_id"] for job in group["jobs"]}) == count
        result = finish(client, group["id"])
        assert result["status"] == "complete"
        assert len(calls) == count and len(prompts) == 1
        assert len({prompt for prompt, _ in calls}) == 1
        assert body == before
        for index, job in enumerate(result["jobs"]):
            record = job["result"]
            assert record["variation"] == {
                "group_id": group["id"],
                "index": index,
                "count": count,
                "attempt": 0,
            }
            assert record["original_selected_controls"] == body["controls"]
            assert (
                record["dynamic_controls_metadata"] == body["dynamic_controls_metadata"]
            )
            data = client.get(record["image_url"]).content
            with Image.open(io.BytesIO(data)) as image:
                embedded = json.loads(image.info[PNG_METADATA_KEY])["image"]
            assert embedded["variation"] == record["variation"]
            assert embedded["final_prompt"] == calls[index][0]
        again = accepted(client, body)
        assert again == group
        assert len(calls) == count
    with TestClient(create_app(settings)) as client:
        assert finish(client, group["id"]) == result
        assert accepted(client, body) == group


def test_changed_draft_or_count_conflicts_and_single_default_stays_compatible(tmp_path):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        body = request(count=2)
        group = accepted(client, body)
        finish(client, group["id"])
        for changes in ({"variation_count": 3}, {"prompt": "Different subject"}):
            response = client.post("/api/generate-image", json={**body, **changes})
            assert response.status_code == 409
        single = request("single-default", 1)
        first = client.post("/api/generate-image", json=single)
        assert first.status_code == 202
        assert "variation_group" not in first.json()
        single.pop("variation_count")
        assert client.post("/api/generate-image", json=single).json() == first.json()
        assert (
            client.post(
                "/api/generate-image", json={**single, "variation_count": 2}
            ).status_code
            == 409
        )


@pytest.mark.parametrize("count", [0, 5, True, 2.5, "3"])
def test_invalid_count_never_accepts_a_job(tmp_path, count):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        assert (
            client.post("/api/generate-image", json=request(count=count)).status_code
            == 400
        )
        with client.app.state.store.connect() as database:
            assert database.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 0


def test_missing_retry_key_selection_and_changed_source_are_rejected(tmp_path):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        group = accepted(client, request(count=2))
        finish(client, group["id"])
        retry = request("retry-invalid", 1)
        retry["retry_variations"] = {"group_id": group["id"], "indices": [0]}
        assert client.post("/api/generate-image", json=retry).status_code == 409
        retry["retry_variations"]["indices"] = [0, 0]
        retry["variation_count"] = 2
        assert client.post("/api/generate-image", json=retry).status_code == 400
        assert client.get("/api/generation-groups/missing").status_code == 404


def test_partial_failure_retries_only_failed_slot_with_same_final_prompt(tmp_path):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        render = client.app.state.renderer.render
        compose = client.app.state.composer.compose
        rendered, composed = [], []

        def track_compose(*args):
            composed.append(True)
            return compose(*args)

        def fail_second(prompt, width, height, **kwargs):
            rendered.append(prompt)
            if len(rendered) == 2:
                raise ProviderError("synthetic render failure")
            return render(prompt, width, height, **kwargs)

        client.app.state.composer.compose = track_compose
        client.app.state.renderer.render = fail_second
        body = request(count=3)
        group = accepted(client, body)
        partial = finish(client, group["id"])
        assert partial["status"] == "partial"
        assert [job["status"] for job in partial["jobs"]] == [
            "complete",
            "failed",
            "complete",
        ]
        first_id = partial["jobs"][0]["generation_job_id"]
        last_id = partial["jobs"][2]["generation_job_id"]
        retry = {
            **body,
            "idempotency_key": "retry-failed",
            "variation_count": 1,
            "retry_variations": {"group_id": group["id"], "indices": [1]},
        }
        retry_accepted = accepted(client, retry)
        assert len(retry_accepted["jobs"]) == 1
        assert retry_accepted["jobs"][0]["index"] == 1
        done = finish(client, group["id"])
        assert done["status"] == "complete"
        assert done["jobs"][0]["generation_job_id"] == first_id
        assert done["jobs"][2]["generation_job_id"] == last_id
        assert done["jobs"][1]["attempt"] == 1
        assert len(rendered) == 4 and len(composed) == 1
        assert len(set(rendered)) == 1
        assert accepted(client, retry) == retry_accepted
        assert len(rendered) == 4
        changed = {**retry, "idempotency_key": "retry-changed", "prompt": "Different"}
        assert client.post("/api/generate-image", json=changed).status_code == 409


def test_duplicate_group_submissions_return_identical_children(tmp_path):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        body = request(count=4)
        with ThreadPoolExecutor(max_workers=2) as pool:
            responses = list(pool.map(lambda _: accepted(client, body), range(2)))
        assert responses[0] == responses[1]
        finish(client, responses[0]["id"])
        with client.app.state.store.connect() as database:
            assert database.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 4


def test_group_admission_is_atomic_when_queue_has_insufficient_room(tmp_path):
    gate = threading.Event()
    entered = threading.Event()
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        original = client.app.state.renderer.render

        def hold(*args, **kwargs):
            entered.set()
            assert gate.wait(5)
            return original(*args, **kwargs)

        client.app.state.renderer.render = hold
        try:
            first = client.post("/api/generate-image", json=request("busy", 1))
            assert first.status_code == 202
            assert entered.wait(2)
            refused = client.post("/api/generate-image", json=request("too-many", 4))
            assert refused.status_code == 429
            with client.app.state.store.connect() as database:
                assert database.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 1
                assert (
                    database.execute(
                        "SELECT COUNT(*) FROM generation_groups"
                    ).fetchone()[0]
                    == 0
                )
        finally:
            gate.set()


def test_shutdown_pool_returns_terminal_failed_children_not_orphaned_queue(tmp_path):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        client.app.state.pool.shutdown(wait=True)
        group = accepted(client, request(count=2))
        done = finish(client, group["id"])
        assert done["status"] == "failed"
        assert all(job["status"] == "failed" for job in done["jobs"])
        assert accepted(client, request(count=2)) == group


def test_group_metadata_is_compact_in_pages_and_does_not_touch_originals(tmp_path):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        group = accepted(client, request(count=2))
        done = finish(client, group["id"])
        page = client.get("/api/images/library/page").json()
        assert len(page["images"]) == 2
        assert {row["variation"]["index"] for row in page["images"]} == {0, 1}
        assert all(
            row["variation"]["group_id"] == group["id"] for row in page["images"]
        )
        assert all(
            set(row["variation"]) == {"group_id", "count", "index", "attempt"}
            for row in page["images"]
        )
        assert {row["id"] for row in page["images"]} == {
            job["result"]["id"] for job in done["jobs"]
        }


def test_group_capabilities_and_disabled_inference_are_honest(tmp_path):
    with TestClient(
        create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path), "INFERENCE_ENABLED": "false"})
    ) as client:
        capability = client.get("/api/app-capabilities").json()["variations"]
        assert capability == {
            "enabled": False,
            "default_count": 1,
            "max_count": 4,
            "execution": "serial",
            "status_url": "/api/generation-groups/{group_id}",
            "retry": "failed-only",
        }
        assert client.post("/api/generate-image", json=request()).status_code == 503
        with client.app.state.store.connect() as database:
            assert database.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 0


def test_legacy_group_keeps_generated_categories_when_a_failed_slot_is_retried(
    tmp_path,
):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        controls = client.app.state.controls.controls
        render = client.app.state.renderer.render
        generated, rendered = [], []

        def track_controls(draft):
            generated.append(True)
            return controls(draft)

        def fail_first(*args, **kwargs):
            rendered.append(True)
            if len(rendered) == 1:
                raise ProviderError("synthetic first render failed")
            return render(*args, **kwargs)

        client.app.state.controls.controls = track_controls
        client.app.state.renderer.render = fail_first
        body = {
            "prompt": "A blue ceramic leaf",
            "idempotency_key": "legacy-group",
            "categories": [],
            "variation_count": 2,
        }
        response = client.post("/api/generations", json=body)
        assert response.status_code == 202, response.text
        group = response.json()["variation_group"]
        partial = finish(client, group["id"])
        assert partial["status"] == "partial" and len(generated) == 1
        retry = {
            **body,
            "idempotency_key": "legacy-retry",
            "variation_count": 1,
            "retry_variations": {"group_id": group["id"], "indices": [0]},
        }
        assert client.post("/api/generations", json=retry).status_code == 202
        done = finish(client, group["id"])
        assert done["status"] == "complete" and len(generated) == 1
        assert (
            done["jobs"][0]["result"]["original_selected_controls"]
            == done["jobs"][1]["result"]["original_selected_controls"]
        )
        assert (
            done["jobs"][0]["result"]["final_prompt"]
            == done["jobs"][1]["result"]["final_prompt"]
        )
