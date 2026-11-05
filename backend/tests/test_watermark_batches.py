"""Bounded admission, asynchronous counts and recoverable analysis membership."""

import base64
import hashlib
import json
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from uuid import UUID

import pytest
from app.library_index import write_projection
from app.main import create_app
from app.store import Store
from app.watermark_batches import BATCH_ERROR_SAMPLE_RECORDS, BATCH_REQUEST_MAX_BYTES
from fastapi.testclient import TestClient
from test_library_pages import seed
from test_watermarks import prepared_bytes, saved, upload

PATH = "/api/images/library/watermarks/backfill"
STATUS = "/api/images/library/watermarks/status"


def defer(client, monkeypatch):
    pending = []
    monkeypatch.setattr(
        client.app.state.analysis_pool, "submit", lambda work: pending.append(work)
    )
    return pending


def batch_of(client):
    return client.app.state.store.setting("watermark-backfill", None)


def members(store):
    with store.connect() as database:
        return database.execute(
            "SELECT image_id FROM watermark_batch_items ORDER BY rank"
        ).fetchall()


def test_startup_bounds_legacy_diagnostics_without_loading_the_old_error_list(
    tmp_path, monkeypatch
):
    store = Store(tmp_path)
    seed(store, 1)
    original = store.image("sample-000000")
    batch = {
        "id": "legacy-failed-batch",
        "status": "failed",
        "queued_count": 10_000,
        "completed_count": 3,
        "failed_count": 9997,
        "extensions": {"false": False, "zero": 0},
        "errors": [
            {"image_id": str(index) + "x" * 300, "error": "failure" * 200}
            for index in range(9997)
        ],
    }
    store.set_setting("watermark-backfill", batch)
    store.close()
    decoded_sizes = []
    import app.watermark_batches as batch_module

    decode = batch_module.json.loads

    def bounded_decode(raw, *args, **kwargs):
        decoded_sizes.append(len(raw))
        return decode(raw, *args, **kwargs)

    # json is shared with the store. This records recovery reads too, rather
    # than merely asserting that the final response happened to be short.
    monkeypatch.setattr(batch_module.json, "loads", bounded_decode)
    restarted = Store(tmp_path)
    current = restarted.setting("watermark-backfill", None)
    assert len(current["errors"]) == BATCH_ERROR_SAMPLE_RECORDS
    assert current["omitted_error_count"] == 9977
    assert all(len(item["image_id"]) == 200 for item in current["errors"])
    assert all(len(item["error"]) == 512 for item in current["errors"])
    assert current["queued_count"] == 10_000 and current["failed_count"] == 9997
    assert current["extensions"] == {"false": False, "zero": 0}
    assert restarted.image(original["id"]) == original
    assert max(decoded_sizes) < 32_000
    restarted.close()
    # A second startup leaves the already bounded record semantically intact.
    repeated = Store(tmp_path)
    assert repeated.setting("watermark-backfill", None) == current
    repeated.close()


def test_small_legacy_batch_diagnostics_are_not_rewritten(tmp_path):
    store = Store(tmp_path)
    original = {"id": "small", "status": "complete", "queued_count": 0, "errors": []}
    store.set_setting("watermark-backfill", original)
    store.close()
    restarted = Store(tmp_path)
    assert restarted.setting("watermark-backfill", None) == original
    restarted.close()


def test_unprepared_admission_reads_only_compact_identities_not_records_or_sidecars(
    tmp_path, monkeypatch
):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        store = client.app.state.store
        seed(store, 1000)
        pending = defer(client, monkeypatch)

        def forbidden(*args):
            raise AssertionError(
                "Admission hydrated full library or unprepared records"
            )

        monkeypatch.setattr(store, "images", forbidden)
        monkeypatch.setattr(store, "image", forbidden)
        monkeypatch.setattr(client.app.state.watermarks, "record", forbidden)
        response = client.post(PATH, json={})
        assert response.status_code == 200
        assert response.json()["queued_count"] == 1000
        assert len(members(store)) == 1000 and len(pending) == 1
        assert batch_of(client)["count_pending"] is False


def test_async_acceptance_precedes_preparation_and_real_analysis_preserves_originals(
    tmp_path, monkeypatch
):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        first = saved(client, "batch-one")
        second = saved(client, "batch-two")
        before = {
            item["image_id"]: hashlib.sha256(
                client.get(item["image_url"]).content
            ).hexdigest()
            for item in (first, second)
        }
        pending = defer(client, monkeypatch)
        response = client.post(PATH, json={"async_preparation": True})
        assert response.status_code == 202
        assert response.headers["cache-control"] == "no-store"
        assert response.json()["queued_count"] is None
        assert response.json()["candidate_count"] == 2
        assert response.json()["phase"] == "preparing"
        assert members(client.app.state.store) == []
        progress = client.get(STATUS).json()["watermark_backfill"]
        assert progress["count_pending"] is True and progress["queued_count"] is None
        assert client.post(PATH, json={}).status_code == 409
        pending[0]()
        terminal = batch_of(client)
        assert terminal["status"] == "complete"
        assert terminal["queued_count"] == terminal["completed_count"] == 2
        assert members(client.app.state.store) == []
        for item in (first, second):
            assert (
                hashlib.sha256(client.get(item["image_url"]).content).hexdigest()
                == before[item["image_id"]]
            )
            record = client.get(f"/api/images/library/record/{item['image_id']}").json()
            assert (
                record["print_watermark"] is not None
                and record["print_ready_url"] is None
            )


def test_current_prepared_file_is_excluded_but_force_and_missing_file_are_included(
    tmp_path, monkeypatch
):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        record = saved(client, "batch-prepared")
        analyzed = client.post(
            "/api/images/library/watermark",
            json={"storage_id": "local-0", "filename": record["filename"]},
        ).json()["image"]
        key = analyzed["print_watermark_key"]
        assert upload(client, record, key, prepared_bytes()).status_code == 200
        pending = defer(client, monkeypatch)
        response = client.post(PATH, json={})
        assert response.status_code == 200 and response.json()["queued_count"] == 0
        pending.pop(0)()
        response = client.post(PATH, json={"force": True})
        assert response.json()["queued_count"] == 1
        pending.pop(0)()
        current = client.get(f"/api/images/library/record/{record['image_id']}").json()
        # Force can change the analysis key. Remove the old derivative only in
        # this owned fixture and ensure a stored flag never promises a file.
        for derivative in (tmp_path / "derivatives" / record["image_id"]).glob("*.png"):
            derivative.unlink()
        response = client.post(PATH, json={})
        assert response.json()["queued_count"] == 1
        assert current["print_watermark"] is not None
        pending.pop(0)()


def test_scope_and_candidate_budget_never_broaden_or_truncate(tmp_path, monkeypatch):
    settings = {
        "IMAGEDIALS_DATA_DIR": str(tmp_path),
        "WATERMARK_BATCH_MAX_RECORDS": "2",
    }
    with TestClient(create_app(settings)) as client:
        seed(client.app.state.store, 5)
        pending = defer(client, monkeypatch)
        assert client.post(PATH, json={}).status_code == 422
        assert batch_of(client) is None
        response = client.post(PATH, json={"event_name": "exhibit"})
        assert response.status_code == 200 and response.json()["queued_count"] == 2
        assert {row[0] for row in members(client.app.state.store)} == {
            "sample-000001",
            "sample-000003",
        }
        pending.pop(0)()
    with TestClient(
        create_app({**settings, "GALLERY_EVENT_NAMES": '["exhibit"]'})
    ) as client:
        defer(client, monkeypatch)
        assert client.post(PATH, json={"event_name": "workshop"}).status_code == 400
        assert client.post(PATH, json={}).json()["queued_count"] == 2


def test_failures_keep_exact_counts_with_bounded_sanitized_diagnostics(
    tmp_path, monkeypatch
):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        store = client.app.state.store
        seed(store, 200)
        pending = defer(client, monkeypatch)

        def unavailable(*args):
            raise OSError("Private diagnostic that must stay out of client errors")

        monkeypatch.setattr(client.app.state.watermarks, "analyze", unavailable)
        response = client.post(PATH, json={})
        assert response.json()["queued_count"] == 200
        pending.pop(0)()
        terminal = batch_of(client)
        assert terminal["status"] == "failed" and terminal["failed_count"] == 200
        assert len(terminal["errors"]) == BATCH_ERROR_SAMPLE_RECORDS
        assert terminal["omitted_error_count"] == 200 - BATCH_ERROR_SAMPLE_RECORDS
        assert "Private diagnostic" not in json.dumps(terminal)
        assert len(json.dumps(terminal)) < 10000
        assert members(store) == []
        status = client.get(STATUS).json()["watermark_backfill"]
        assert status["omitted_error_count"] == terminal["omitted_error_count"]
        assert "errors" not in status


def test_deleted_or_private_member_is_not_analyzed_and_arrival_does_not_join_queue(
    tmp_path, monkeypatch
):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        store = client.app.state.store
        seed(store, 3)
        pending = defer(client, monkeypatch)
        response = client.post(PATH, json={})
        assert response.json()["queued_count"] == 3
        store.delete("sample-000000")
        with store.write_transaction() as database:
            private = {**store.image("sample-000001"), "visibility": "private"}
            database.execute(
                "UPDATE images SET data=? WHERE id=?",
                (json.dumps(private), private["id"]),
            )
            write_projection(database, private, store.library_search_available)
            late = {"id": "late", "title": "Late image"}
            database.execute(
                "INSERT INTO images VALUES (?,?)", (late["id"], json.dumps(late))
            )
            write_projection(database, late, store.library_search_available)
            store.record_library_change(database, "saved")
        calls = []
        monkeypatch.setattr(
            client.app.state.watermarks,
            "analyze",
            lambda snapshot, force: calls.append(snapshot["id"]),
        )
        pending.pop(0)()
        terminal = batch_of(client)
        assert calls == ["sample-000002"]
        assert terminal["completed_count"] == 1 and terminal["failed_count"] == 2
        assert terminal["queued_count"] == 3


def test_prepared_eligibility_checks_do_not_hold_the_library_writer(
    tmp_path, monkeypatch
):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        store = client.app.state.store
        seed(store, 1)
        with store.write_transaction() as database:
            write_projection(
                database,
                {**store.image("sample-000000"), "print_ready": {}},
                store.library_search_available,
            )
        defer(client, monkeypatch)
        entered, release = threading.Event(), threading.Event()

        def prepared(*args):
            entered.set()
            assert release.wait(5)
            return {"print_ready_url": "/prepared-example"}

        monkeypatch.setattr(client.app.state.watermarks, "record", prepared)
        other = Store(tmp_path, worker=True)
        try:
            with ThreadPoolExecutor(max_workers=2) as executor:
                queued = executor.submit(client.post, PATH, json={})
                try:
                    assert entered.wait(5)
                    executor.submit(other.set_setting, "concurrent-probe", True).result(
                        timeout=2
                    )
                finally:
                    release.set()
                assert queued.result(timeout=5).json()["queued_count"] == 0
        finally:
            other.close()


def test_stopped_own_task_recovers_even_while_its_api_worker_is_alive(
    tmp_path, monkeypatch
):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        store = client.app.state.store
        seed(store)
        pending = defer(client, monkeypatch)
        response = client.post(PATH, json={})
        identity = response.json()["analysis_batch_id"]
        store.finish_batch(identity)  # Simulate loss of the owning future.
        with store.write_transaction() as database:
            store.recover_jobs(database)
        assert batch_of(client)["status"] == "failed" and members(store) == []
        pending.pop(0)()
        assert batch_of(client)["status"] == "failed"


def test_worker_rejection_and_unexpected_failure_leave_no_eternal_busy_batch(
    tmp_path, monkeypatch
):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        store = client.app.state.store
        seed(store)

        def reject(*args):
            raise RuntimeError("Executor stopped")

        monkeypatch.setattr(client.app.state.analysis_pool, "submit", reject)
        assert client.post(PATH, json={}).status_code == 503
        assert batch_of(client)["status"] == "failed" and members(store) == []
        pending = defer(client, monkeypatch)

        def unexpected(*args):
            raise RuntimeError("Owned unexpected error")

        monkeypatch.setattr(client.app.state.watermarks, "analyze", unexpected)
        assert client.post(PATH, json={}).status_code == 200
        pending.pop(0)()
        assert batch_of(client)["status"] == "failed" and members(store) == []
        assert not store.active_batches


@pytest.mark.parametrize(
    "body", [{"async_preparation": "yes"}, {"async_preparation": None}, {"force": 1}]
)
def test_invalid_async_requests_cannot_allocate_a_batch(tmp_path, body):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        assert client.post(PATH, json=body).status_code == 400
        assert batch_of(client) is None


def test_request_and_configuration_limits_are_validated(tmp_path):
    with pytest.raises(ValueError, match="WATERMARK_BATCH_MAX_RECORDS"):
        create_app(
            {"IMAGEDIALS_DATA_DIR": str(tmp_path), "WATERMARK_BATCH_MAX_RECORDS": "0"}
        )
    assert not (tmp_path / "library.sqlite3").exists()
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        assert (
            client.post(PATH, content=b" " * (BATCH_REQUEST_MAX_BYTES + 1)).status_code
            == 413
        )
        assert batch_of(client) is None


def test_shared_batch_fixture_matches_actual_transport_and_preserves_source(
    tmp_path, monkeypatch
):
    fixture = json.loads(
        (
            Path(__file__).resolve().parents[2] / "fixtures/api/watermark-batches.json"
        ).read_text()
    )
    identities = iter(
        UUID(value)
        for value in (
            fixture["legacy"]["response"]["analysis_batch_id"],
            fixture["async"]["response"]["analysis_batch_id"],
            "55555555-5555-4555-8555-555555555555",  # Busy attempt allocates no row.
            fixture["failure_accepted"]["response"]["analysis_batch_id"],
        )
    )
    monkeypatch.setattr("app.watermark_batches.uuid4", lambda: next(identities))
    with TestClient(
        create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path), "INFERENCE_ENABLED": "false"})
    ) as client:
        store = client.app.state.store
        original = base64.b64decode(fixture["source_png_base64"])
        for record in fixture["source_records"]:
            (tmp_path / (record["id"] + ".png")).write_bytes(original)
            with store.write_transaction() as database:
                database.execute(
                    "INSERT INTO images VALUES (?,?)",
                    (record["id"], json.dumps(record)),
                )
                write_projection(database, record, store.library_search_available)
                store.record_library_change(database, "saved")
        pending = defer(client, monkeypatch)
        for key in ("legacy", "async"):
            response = client.post(PATH, json=fixture[key]["request"])
            assert response.status_code == fixture[key]["status"]
            assert response.json() == fixture[key]["response"]
            if key == "async":
                assert client.get(STATUS).json() == fixture["preparing"]["response"]
                busy = client.post(PATH, json={})
                assert busy.status_code == fixture["busy"]["status"]
                assert busy.json() == fixture["busy"]["response"]
            pending.pop(0)()
            assert client.get(STATUS).json() == fixture[key + "_complete"]["response"]
        missing = fixture["missing_record"]
        with store.write_transaction() as database:
            database.execute(
                "INSERT INTO images VALUES (?,?)", (missing["id"], json.dumps(missing))
            )
            write_projection(database, missing, store.library_search_available)
            store.record_library_change(database, "saved")
        response = client.post(PATH, json=fixture["failure_accepted"]["request"])
        assert response.json() == fixture["failure_accepted"]["response"]
        pending.pop(0)()
        assert client.get(STATUS).json() == fixture["failed"]["response"]
        for record in fixture["source_records"]:
            assert (tmp_path / (record["id"] + ".png")).read_bytes() == original
            assert store.image(record["id"]) == record
