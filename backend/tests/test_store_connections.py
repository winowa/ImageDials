"""Store-owned SQLite scopes release resources without changing transactions."""

import json
import sqlite3
import time
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import pytest
from app.library_index import write_projection
from app.store import WORKER_HEARTBEAT_SECONDS, WORKER_LEASE_SECONDS, Store


def test_successful_scope_commits_then_closes_connection(tmp_path):
    store = Store(tmp_path)
    with store.connect() as database:
        database.execute("INSERT INTO settings VALUES ('test-scope','true')")
    assert store.setting("test-scope", False) is True
    with pytest.raises(sqlite3.ProgrammingError, match="closed"):
        database.execute("SELECT 1")


def test_caller_owned_writer_connection_commits_rolls_back_and_can_be_reused(tmp_path):
    store = Store(tmp_path)
    with store.connect() as database:
        with store.write_transaction(database):
            database.execute("INSERT INTO settings VALUES ('before-error','true')")
        assert not database.in_transaction
        assert store.setting("before-error", False) is True
        with pytest.raises(ValueError, match="abort this chunk"):
            with store.write_transaction(database):
                database.execute("INSERT INTO settings VALUES ('rolled-back','true')")
                raise ValueError("abort this chunk")
        assert not database.in_transaction
        assert store.setting("rolled-back", False) is False
        with store.write_transaction(database):
            database.execute("INSERT INTO settings VALUES ('after-error','true')")
        assert store.setting("after-error", False) is True
        assert database.execute("SELECT 1").fetchone() == (1,)
    with pytest.raises(sqlite3.ProgrammingError, match="closed"):
        database.execute("SELECT 1")


def test_nested_writer_does_not_commit_or_rollback_a_callers_existing_transaction(
    tmp_path,
):
    store = Store(tmp_path)
    with store.connect() as database:
        database.execute("BEGIN")
        database.execute("INSERT INTO settings VALUES ('still-pending','true')")
        with pytest.raises(sqlite3.OperationalError, match="transaction"):
            with store.write_transaction(database):
                raise AssertionError("Nested writer must not start")
        assert database.in_transaction
        database.rollback()
    assert store.setting("still-pending", False) is False


def test_writer_renews_lease_before_another_worker_recovers_jobs(tmp_path, monkeypatch):
    monkeypatch.setattr("app.store.WORKER_HEARTBEAT_SECONDS", 3600)
    owner = Store(tmp_path, worker=True)
    try:
        owner.track_job("owned-job")
        with owner.connect() as database:
            database.execute(
                "INSERT INTO jobs VALUES (?,?,?,?)",
                ("owned-job", "key", "fingerprint", json.dumps({"stage": "rendering"})),
            )
            database.execute(
                "INSERT INTO job_owners VALUES (?,?)", ("owned-job", owner.worker_id)
            )
            database.execute(
                "UPDATE workers SET heartbeat=0 WHERE id=?", (owner.worker_id,)
            )
        before = time.time()
        with owner.write_transaction() as database:
            database.execute("INSERT INTO settings VALUES ('writer-progress','true')")
        observer = Store(tmp_path)
        with observer.connect() as database:
            assert (
                database.execute(
                    "SELECT heartbeat FROM workers WHERE id=?", (owner.worker_id,)
                ).fetchone()[0]
                >= before
            )
            assert (
                json.loads(
                    database.execute(
                        "SELECT data FROM jobs WHERE id='owned-job'"
                    ).fetchone()[0]
                )["stage"]
                == "rendering"
            )
        observer.close()
    finally:
        owner.close()


def test_startup_migration_does_not_expire_a_recent_worker_or_its_batch(
    tmp_path, monkeypatch
):
    import app.store as store_module

    store = Store(tmp_path)
    clock = {"wall_seconds": 10_000.0, "monotonic_seconds": 1_000.0}
    recent_heartbeat = clock["wall_seconds"] - WORKER_HEARTBEAT_SECONDS
    with store.connect() as database:
        database.executemany(
            "INSERT INTO workers VALUES (?,?)",
            [
                ("recent-worker", recent_heartbeat),
                ("expired-worker", clock["wall_seconds"] - WORKER_LEASE_SECONDS - 1),
            ],
        )
        for identity, owner in (
            ("recent-job", "recent-worker"),
            ("expired-job", "expired-worker"),
            ("ownerless-job", None),
        ):
            database.execute(
                "INSERT INTO jobs VALUES (?,?,?,?)",
                (
                    identity,
                    identity,
                    identity,
                    json.dumps({"id": identity, "stage": "rendering"}),
                ),
            )
            if owner:
                database.execute(
                    "INSERT INTO job_owners VALUES (?,?)", (identity, owner)
                )
        database.execute(
            "INSERT INTO settings VALUES ('watermark-backfill',?)",
            (
                json.dumps(
                    {"id": "recent-batch", "status": "running", "queued_count": 1}
                ),
            ),
        )
        database.execute(
            "INSERT INTO settings VALUES ('watermark-backfill-owner',?)",
            (json.dumps("recent-worker"),),
        )
    store.close()
    initialize = store_module.initialize_index
    migration_seconds = WORKER_LEASE_SECONDS * 2

    def slow_migration(*arguments):
        result = initialize(*arguments)
        # The startup writer owns SQLite's lock throughout this interval, so
        # another worker cannot commit its heartbeat even if it is alive.
        clock["wall_seconds"] += migration_seconds
        clock["monotonic_seconds"] += migration_seconds
        return result

    monkeypatch.setattr(
        store_module,
        "time",
        SimpleNamespace(
            time=lambda: clock["wall_seconds"],
            monotonic=lambda: clock["monotonic_seconds"],
        ),
    )
    monkeypatch.setattr(store_module, "initialize_index", slow_migration)
    observer = Store(tmp_path)
    try:
        with observer.connect() as database:
            jobs = {
                identity: json.loads(raw)
                for identity, raw in database.execute("SELECT id,data FROM jobs")
            }
            assert jobs["recent-job"]["stage"] == "rendering"
            assert (
                jobs["expired-job"]["stage"]
                == jobs["ownerless-job"]["stage"]
                == "failed"
            )
            assert (
                json.loads(
                    database.execute(
                        "SELECT data FROM settings WHERE name='watermark-backfill'"
                    ).fetchone()[0]
                )["status"]
                == "running"
            )
            assert (
                database.execute(
                    "SELECT heartbeat FROM workers WHERE id='recent-worker'"
                ).fetchone()[0]
                == recent_heartbeat + migration_seconds
            )
        # Pausing lease aging for the migration does not make a dead owner immortal.
        clock["wall_seconds"] += WORKER_LEASE_SECONDS - WORKER_HEARTBEAT_SECONDS + 1
        with observer.connect() as database:
            observer.recover_jobs(database)
            assert (
                json.loads(
                    database.execute(
                        "SELECT data FROM jobs WHERE id='recent-job'"
                    ).fetchone()[0]
                )["stage"]
                == "failed"
            )
            assert (
                json.loads(
                    database.execute(
                        "SELECT data FROM settings WHERE name='watermark-backfill'"
                    ).fetchone()[0]
                )["status"]
                == "failed"
            )
    finally:
        observer.close()


def test_failed_scope_rolls_back_then_closes_connection(tmp_path):
    store = Store(tmp_path)
    with pytest.raises(ValueError, match="Interrupted"):
        with store.write_transaction() as database:
            database.execute("INSERT INTO settings VALUES ('test-scope','true')")
            raise ValueError("Interrupted")
    assert store.setting("test-scope", False) is False
    with pytest.raises(sqlite3.ProgrammingError, match="closed"):
        database.execute("SELECT 1")


def test_snapshot_reader_does_not_block_a_writer_or_lease_renewal(tmp_path):
    store = Store(tmp_path, worker=True)
    reader = store.connect()
    try:
        reader.execute("BEGIN")
        assert (
            reader.execute("SELECT data FROM settings WHERE name='progress'").fetchone()
            is None
        )
        assert reader.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
        assert reader.execute("PRAGMA synchronous").fetchone()[0] == 2

        def write():
            with store.write_transaction() as database:
                store.write_setting(database, "progress", True)

        with ThreadPoolExecutor(max_workers=1) as pool:
            pool.submit(write).result(timeout=2)
        # The old snapshot stays consistent while a fresh reader sees the commit.
        assert (
            reader.execute("SELECT data FROM settings WHERE name='progress'").fetchone()
            is None
        )
        assert store.setting("progress", False) is True
    finally:
        reader.close()
        store.close()


def test_recovery_looks_up_only_present_files_in_bounded_batches(tmp_path, monkeypatch):
    store = Store(tmp_path)
    originals = {}
    with store.write_transaction() as database:
        for number in range(140):
            record = {
                "id": f"retained-{number}",
                "unknown": {"false": False, "zero": 0},
            }
            raw = json.dumps(record)
            originals[record["id"]] = raw
            database.execute("INSERT INTO images VALUES (?,?)", (record["id"], raw))
            write_projection(database, record, store.library_search_available)
            (tmp_path / (record["id"] + ".png")).write_bytes(b"retained original")
    (tmp_path / "orphan.png").write_bytes(b"recover orphan")
    (tmp_path / "incomplete.tmp").write_bytes(b"recover incomplete")
    store.close()
    queries, connect = [], Store.connect

    def traced(self):
        database = connect(self)
        database.set_trace_callback(queries.append)
        return database

    monkeypatch.setattr(Store, "connect", traced)
    restarted = Store(tmp_path)
    with restarted.connect() as database:
        assert dict(database.execute("SELECT id,data FROM images")) == originals
    lookups = [query for query in queries if query.startswith("SELECT id FROM images")]
    assert len(lookups) == 2 and all("WHERE id IN (" in query for query in lookups)
    assert sorted(path.read_bytes() for path in (tmp_path / "recovery").iterdir()) == [
        b"recover incomplete",
        b"recover orphan",
    ]
    assert all(
        (tmp_path / (identity + ".png")).read_bytes() == b"retained original"
        for identity in originals
    )
    restarted.close()


def test_empty_disk_recovery_does_not_scan_saved_image_identities(
    tmp_path, monkeypatch
):
    Store(tmp_path).close()
    queries, connect = [], Store.connect

    def traced(self):
        database = connect(self)
        database.set_trace_callback(queries.append)
        return database

    monkeypatch.setattr(Store, "connect", traced)
    Store(tmp_path).close()
    assert not any(query.startswith("SELECT id FROM images") for query in queries)


def test_future_schema_is_rejected_before_changing_journal_mode(tmp_path):
    with sqlite3.connect(tmp_path / "library.sqlite3") as database:
        database.execute("PRAGMA user_version=999")
        assert database.execute("PRAGMA journal_mode").fetchone()[0] == "delete"
    with pytest.raises(ValueError, match="newer"):
        Store(tmp_path)
    with sqlite3.connect(tmp_path / "library.sqlite3") as database:
        assert database.execute("PRAGMA journal_mode").fetchone()[0] == "delete"
        assert database.execute("PRAGMA user_version").fetchone()[0] == 999


def test_recovery_rejects_a_symbolic_destination_without_moving_files(tmp_path):
    root, outside = tmp_path / "data", tmp_path / "outside"
    Store(root).close()
    outside.mkdir()
    try:
        (root / "recovery").symlink_to(outside, target_is_directory=True)
    except OSError:
        pytest.skip("Symbolic links are unavailable for this user")
    (root / "orphan.png").write_bytes(b"preserve original")
    with pytest.raises(OSError, match="symbolic link"):
        Store(root)
    assert (root / "orphan.png").read_bytes() == b"preserve original"
    assert list(outside.iterdir()) == []
