"""Cross-worker ordering for settings, prepared files and analysis batches."""

import threading
from concurrent.futures import ThreadPoolExecutor

from app.main import create_app
from fastapi.testclient import TestClient
from test_watermarks import prepared_bytes, saved, upload


def test_settings_cannot_change_during_prepared_key_validation(tmp_path, monkeypatch):
    import app.watermarks as watermarks

    settings = {"IMAGEDIALS_DATA_DIR": str(tmp_path)}
    with (
        TestClient(create_app(settings)) as first,
        TestClient(create_app(settings)) as second,
    ):
        record = saved(first, "ordered-upload")
        original = first.get(record["image_url"]).content
        identity = {"storage_id": "local-0", "filename": record["filename"]}
        key = first.post("/api/images/library/watermark", json=identity).json()[
            "image"
        ]["print_watermark_key"]
        writing = threading.Event()
        release = threading.Event()
        updating = threading.Event()
        real_write = watermarks.atomic_write

        def pause_png(path, data):
            if path.suffix == ".png":
                writing.set()
                assert release.wait(5)
            return real_write(path, data)

        def update_settings():
            updating.set()
            return second.put(
                "/api/watermark/settings", json={"type": "text", "text": "Changed"}
            )

        monkeypatch.setattr(watermarks, "atomic_write", pause_png)
        with ThreadPoolExecutor(max_workers=2) as pool:
            uploaded = pool.submit(upload, first, record, key, prepared_bytes())
            try:
                assert writing.wait(5)
                changed = pool.submit(update_settings)
                assert updating.wait(5)
            finally:
                release.set()
            response = uploaded.result(timeout=5)
            assert response.status_code == 200
            old_url = response.json()["image"]["print_ready_url"]
            assert old_url, (
                "Upload must return a coherent current record before the later settings write"
            )
            assert changed.result(timeout=5).status_code == 200
        current = second.get("/api/images/library").json()["images"][0]
        assert current["print_watermark_key"] != key
        assert current["print_ready_url"] is None
        assert second.get(old_url).status_code == 404
        assert upload(second, record, key, prepared_bytes()).status_code == 409
        assert first.get(record["image_url"]).content == original


def test_other_worker_preserves_queued_batch_and_expired_work_cannot_revive(tmp_path):
    settings = {"IMAGEDIALS_DATA_DIR": str(tmp_path)}
    first_app = create_app(settings)

    class DeferredPool:
        work = None

        def submit(self, work):
            self.work = work

    deferred = DeferredPool()
    with TestClient(first_app) as first:
        saved(first, "queued-owner")
        result = first_app.state.watermarks.queue_backfill(False, deferred)
        assert result["queued_count"] == 1
        second_app = create_app(settings)
        with TestClient(second_app) as second:
            batch = second.get("/api/images/library").json()["watermark_backfill"]
            assert batch["status"] == "queued"
            assert (
                second.post(
                    "/api/images/library/watermarks/backfill", json={}
                ).status_code
                == 409
            )
            with second_app.state.store.write_transaction() as db:
                db.execute(
                    "UPDATE workers SET heartbeat=0 WHERE id=?",
                    (first_app.state.store.worker_id,),
                )
                second_app.state.store.recover_jobs(db)
            deferred.work()
            terminal = second.get("/api/images/library").json()["watermark_backfill"]
            assert terminal["status"] == "failed"
            assert terminal["completed_count"] == 0
            assert (
                second.get("/api/images/library").json()["images"][0]["print_watermark"]
                is None
            )
