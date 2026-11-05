"""Connected replay, provisional-image, late-failure and invalidation checks."""

import asyncio
import io
import json
import threading

from app.main import create_app
from app.providers import ProviderError
from app.store import MAX_JOB_UPDATES, MAX_LIBRARY_CHANGES, Store
from app.streams import library_stream
from fastapi.testclient import TestClient
from PIL import Image
from test_canonical import FIXTURE, wait_for_job


def decode_events(text):
    events = []
    for frame in text.split("\n\n"):
        fields = dict(
            line.split(": ", 1)
            for line in frame.splitlines()
            if ": " in line and not line.startswith(":")
        )
        if "event" in fields:
            events.append(
                {"event": fields["event"], "data": json.loads(fields["data"])}
            )
    return events


def test_preview_before_enrichment_and_late_failure_survives_restart(tmp_path):
    settings = {"IMAGEDIALS_DATA_DIR": str(tmp_path)}
    app = create_app(settings)
    enriching = threading.Event()
    finish = threading.Event()

    def fail_enrichment(*args):
        enriching.set()
        assert finish.wait(5)
        raise ProviderError("Enrichment provider unavailable")

    with TestClient(app) as client:
        app.state.composer.enrich = fail_enrichment
        accepted = client.post(
            "/api/generate-image", json=json.loads(FIXTURE.read_text())
        ).json()
        job_id = accepted["generation_job_id"]
        try:
            assert enriching.wait(5)
            pending = client.get(f"/api/generation-jobs/{job_id}").json()
            assert pending["status"] == "running" and pending["result"] is None
            preview = next(
                event["data"]
                for event in pending["events"]
                if event["event"] == "image-ready"
            )
            assert preview["enrichment"]["status"] == "running"
            assert preview["alt_text"] == "" and preview["accessibility"] == {}
            assert (
                preview["original_selected_controls"]
                == json.loads(FIXTURE.read_text())["controls"]
            )
            response = client.get(preview["image_url"])
            assert response.status_code == 200
            with Image.open(io.BytesIO(response.content)) as image:
                assert image.size == (768, 1152)
            assert client.get("/api/images/library").json()["count"] == 0
        finally:
            finish.set()
        terminal = wait_for_job(client, job_id)
        assert terminal["status"] == "failed"
        assert terminal["result"]["error"] == "Enrichment provider unavailable"
        assert any(event["event"] == "image-ready" for event in terminal["events"])
        assert not any(event["event"] == "complete" for event in terminal["events"])
        preview_bytes = client.get(preview["image_url"]).content
        assert client.get("/api/images/library").json()["count"] == 0
    with TestClient(create_app(settings)) as client:
        assert client.get(f"/api/generation-jobs/{job_id}").json() == terminal
        assert client.get(preview["image_url"]).content == preview_bytes
        stream = client.get(f"/api/generation-jobs/{job_id}/events")
        assert stream.status_code == 200
        assert stream.text.startswith(": connected\n\n")
        assert decode_events(stream.text) == terminal["events"]


def test_complete_stream_replays_poll_history_and_unknown_stream_is_200(tmp_path):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        job_id = client.post(
            "/api/generate-image", json=json.loads(FIXTURE.read_text())
        ).json()["generation_job_id"]
        terminal = wait_for_job(client, job_id)
        assert terminal["status"] == "complete"
        assert [event["event"] for event in terminal["events"]].count("complete") == 1
        assert any(event["event"] == "image-ready" for event in terminal["events"])
        for prefix in ["/api", ""]:
            response = client.get(f"{prefix}/generation-jobs/{job_id}/events")
            assert response.headers["content-type"].startswith("text/event-stream")
            assert response.headers["x-accel-buffering"] == "no"
            assert decode_events(response.text) == terminal["events"]
        missing = client.get("/api/generation-jobs/missing/events")
        assert missing.status_code == 200
        assert decode_events(missing.text)[0]["event"] == "failed"
        assert client.get("/api/generation-jobs/missing").status_code == 404
        assert client.get("/api/generation-jobs/missing/preview").status_code == 404


def test_library_stream_no_replay_heartbeat_and_disconnect(tmp_path, monkeypatch):
    import app.streams as streams

    store = Store(tmp_path)
    store.notify_library("saved", filename="historical.png")
    monkeypatch.setattr(streams, "STREAM_HEARTBEAT_SECONDS", 0)
    monkeypatch.setattr(streams, "STREAM_POLL_SECONDS", 0)

    class Connection:
        disconnected = False

        async def is_disconnected(self):
            return self.disconnected

    async def check():
        request = Connection()
        stream = library_stream(request, store)
        assert await anext(stream) == ": connected\n\n"
        store.notify_library("deleted", filename="new.png")
        change = decode_events(await anext(stream))
        assert change == [
            {"event": "changed", "data": {"action": "deleted", "filename": "new.png"}}
        ]
        assert await anext(stream) == ": keep-alive\n\n"
        request.disconnected = True
        try:
            await anext(stream)
        except StopAsyncIteration:
            pass
        else:
            raise AssertionError("Disconnected stream did not stop")

    asyncio.run(check())


def test_durable_buffers_are_bounded_and_job_recovery_is_terminal(tmp_path):
    store = Store(tmp_path)
    job = {"id": "interrupted", "stage": "queued", "result": None}
    with store.connect() as db:
        db.execute(
            "INSERT INTO jobs VALUES (?,?,?,?)",
            (job["id"], "key", "fingerprint", json.dumps(job)),
        )
    for sequence in range(MAX_JOB_UPDATES + 10):
        store.update_job({**job, "message": str(sequence)})
    assert len(store.job_updates(job["id"])) == MAX_JOB_UPDATES
    for sequence in range(MAX_LIBRARY_CHANGES + 10):
        store.notify_library("saved", filename=str(sequence))
    assert len(store.library_changes(0)) == MAX_LIBRARY_CHANGES
    reopened = Store(tmp_path)
    assert reopened.job(job["id"])["stage"] == "failed"
    assert reopened.job_updates(job["id"])[-1][1]["stage"] == "failed"


def test_disabled_library_stream(tmp_path):
    with TestClient(
        create_app(
            {"IMAGEDIALS_DATA_DIR": str(tmp_path), "SHARED_LIBRARY_ENABLED": "false"}
        )
    ) as client:
        assert client.get("/api/images/library/events").status_code == 403


def test_second_worker_keeps_live_job_and_reuses_idempotent_submission(tmp_path):
    settings = {"IMAGEDIALS_DATA_DIR": str(tmp_path)}
    app = create_app(settings)
    blocked = threading.Event()
    release = threading.Event()
    original_enrich = None

    def delayed(*args):
        blocked.set()
        assert release.wait(5)
        return original_enrich(*args)

    with TestClient(app) as first:
        original_enrich = app.state.composer.enrich
        app.state.composer.enrich = delayed
        payload = {
            **json.loads(FIXTURE.read_text()),
            "idempotency_key": "shared-worker-key",
        }
        job_id = first.post("/api/generate-image", json=payload).json()[
            "generation_job_id"
        ]
        try:
            assert blocked.wait(5)
            with TestClient(create_app(settings)) as second:
                assert (
                    second.get(f"/api/generation-jobs/{job_id}").json()["status"]
                    == "running"
                )
                assert (
                    second.post("/api/generate-image", json=payload).json()[
                        "generation_job_id"
                    ]
                    == job_id
                )
                release.set()
                terminal = wait_for_job(second, job_id)
                assert terminal["status"] == "complete"
                assert second.get("/api/images/library").json()["count"] == 1
                assert first.get(f"/api/generation-jobs/{job_id}").json() == terminal
        finally:
            release.set()


def test_expired_worker_recovery_cannot_be_overwritten(tmp_path):
    import pytest
    from app.store import JobNoLongerActive

    first = Store(tmp_path, worker=True)
    second = None
    try:
        job = {"id": "abandoned", "stage": "queued", "result": None}
        with first.connect() as db:
            db.execute(
                "INSERT INTO jobs VALUES (?,?,?,?)",
                (job["id"], "key", "fingerprint", json.dumps(job)),
            )
            first.record_job_update(db, job)
        second = Store(tmp_path, worker=True)
        assert second.job(job["id"])["stage"] == "queued"
        with second.connect() as db:
            db.execute("UPDATE workers SET heartbeat=0 WHERE id=?", (first.worker_id,))
            second.recover_jobs(db)
        terminal = second.job(job["id"])
        assert terminal["stage"] == "failed"
        assert not first.update_job({**job, "stage": "enriching"})
        image = io.BytesIO()
        Image.new("RGB", (8, 8)).save(image, format="PNG")
        with pytest.raises(JobNoLongerActive):
            first.save({"id": job["id"]}, image.getvalue(), job)
        assert not (tmp_path / (job["id"] + ".png")).exists()
        assert second.job(job["id"]) == terminal
    finally:
        first.close()
        if second:
            second.close()


def test_storage_observation_failure_does_not_emit_terminal_job_failure(
    tmp_path, monkeypatch
):
    import sqlite3

    from app.streams import job_stream

    store = Store(tmp_path)
    job = {"id": "still-running", "stage": "queued", "result": None}
    with store.connect() as database:
        database.execute(
            "INSERT INTO jobs VALUES (?,?,?,?)",
            (job["id"], "key", "fingerprint", json.dumps(job)),
        )

    class Connection:
        async def is_disconnected(self):
            return False

    def unavailable(*args):
        raise sqlite3.OperationalError("Temporary read failure")

    async def observe():
        return [frame async for frame in job_stream(Connection(), store, job["id"])]

    with monkeypatch.context() as patch:
        patch.setattr(store, "job", unavailable)
        frames = asyncio.run(observe())
    assert frames == [": connected\n\n"]
    assert store.job(job["id"]) == job
    assert decode_events("".join(frames)) == []


def test_job_poll_storage_failure_is_recoverable_502(tmp_path, monkeypatch):
    import sqlite3

    app = create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})
    with TestClient(app) as client:

        def unavailable(*args):
            raise sqlite3.OperationalError("Temporary read failure")

        with monkeypatch.context() as patch:
            patch.setattr(app.state.store, "job", unavailable)
            response = client.get("/api/generation-jobs/opaque-id")
            assert response.status_code == 502
            assert response.json()["detail"] == "Generation storage is unavailable"
        assert client.get("/api/generation-jobs/opaque-id").status_code == 404


def test_finished_worker_with_unpublished_failure_is_recovered(tmp_path, monkeypatch):
    import sqlite3

    app = create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})
    with TestClient(app) as client:
        update = app.state.store.update_job

        def failing_terminal_write(job):
            if job["stage"] in {"enriching", "failed"}:
                raise sqlite3.OperationalError("Temporary write outage")
            return update(job)

        with monkeypatch.context() as patch:
            patch.setattr(app.state.store, "update_job", failing_terminal_write)
            accepted = client.post(
                "/api/generate-image", json=json.loads(FIXTURE.read_text())
            )
            job_id = accepted.json()["generation_job_id"]
            # A barrier on the real one-worker pool waits for its task and its
            # completion callback, without waiting for the heartbeat interval.
            app.state.pool.submit(lambda: None).result(timeout=5)
        pending = client.get(f"/api/generation-jobs/{job_id}").json()
        assert pending["status"] == "running"
        assert any(event["event"] == "image-ready" for event in pending["events"])
        with app.state.store.write_transaction() as database:
            app.state.store.recover_jobs(database)
        terminal = client.get(f"/api/generation-jobs/{job_id}").json()
        assert terminal["status"] == "failed"
        assert "terminal state" in terminal["result"]["error"]
        assert any(event["event"] == "image-ready" for event in terminal["events"])
        assert client.get("/api/images/library").json()["count"] == 0


def test_job_stream_heartbeat_slow_subscriber_and_terminal_close(tmp_path, monkeypatch):
    import app.streams as streams

    store = Store(tmp_path)
    job = {"id": "slow-subscriber", "stage": "queued", "result": None}
    with store.connect() as database:
        database.execute(
            "INSERT INTO jobs VALUES (?,?,?,?)",
            (job["id"], "slow-key", "slow-fingerprint", json.dumps(job)),
        )
    store.update_job(job)
    monkeypatch.setattr(streams, "STREAM_HEARTBEAT_SECONDS", 0)
    monkeypatch.setattr(streams, "STREAM_POLL_SECONDS", 0)

    class Connection:
        async def is_disconnected(self):
            return False

    async def observe():
        stream = streams.job_stream(Connection(), store, job["id"])
        assert await anext(stream) == ": connected\n\n"
        assert decode_events(await anext(stream))[0]["data"]["message"] == "queued"
        assert await anext(stream) == ": keep-alive\n\n"
        # The subscriber pauses while more updates arrive than can be retained.
        for index in range(MAX_JOB_UPDATES + 10):
            store.update_job({**job, "stage": f"working-{index}"})
        store.update_job(
            {**job, "stage": "failed", "error": "Independent test failure"}
        )
        received = []
        async for frame in stream:
            received.extend(decode_events(frame))
        assert len(received) == MAX_JOB_UPDATES
        assert received[-1] == {
            "event": "failed",
            "data": {
                "error": "Independent test failure",
                "enrichment": {"status": "failed"},
                "generation_job_id": job["id"],
            },
        }
        assert all(event["event"] == "progress" for event in received[:-1])
        assert store.job(job["id"])["stage"] == "failed"

    asyncio.run(observe())
    store.close()
