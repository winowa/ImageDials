"""Bounded identity queues for shared-image analysis, separate from source records."""

import json
import logging
import sqlite3
import time
from contextlib import closing
from functools import partial
from uuid import uuid4

from .library_counts import orientation_count_rows
from .library_pages import query_conditions

DEFAULT_BATCH_MAX_RECORDS = 250_000
BATCH_MEMBER_CHUNK_RECORDS = 256
BATCH_PROGRESS_INTERVAL_SECONDS = 0.5
BATCH_PROGRESS_MAX_ITEMS = 128
BATCH_ERROR_SAMPLE_RECORDS = 20
BATCH_ERROR_MAX_CHARACTERS = 512
BATCH_ERROR_IMAGE_ID_MAX_CHARACTERS = 200
BATCH_REQUEST_MAX_BYTES = 8192
ACTIVE_BATCH_STATUSES = {"queued", "running"}


class BackfillActiveError(ValueError):
    pass


class BackfillLimitError(ValueError):
    pass


class BatchStopped(Exception):
    """A superseded or abandoned batch must not install or process more members."""


class BatchWorkerUnavailable(Exception):
    pass


def initialize_batch_queue(database):
    database.execute(
        "CREATE TABLE IF NOT EXISTS watermark_batch_items ("
        "batch_id TEXT NOT NULL,rank INTEGER NOT NULL,image_id TEXT NOT NULL,"
        "PRIMARY KEY(batch_id,rank)) WITHOUT ROWID"
    )
    database.execute(
        "DELETE FROM watermark_batch_items WHERE batch_id NOT IN ("
        "SELECT json_extract(data,'$.id') FROM settings WHERE name='watermark-backfill' "
        "AND json_extract(data,'$.status') IN ('queued','running'))"
    )
    compact_legacy_batch_diagnostics(database)


def compact_legacy_batch_diagnostics(database):
    """Bound old diagnostics before recovery reads a batch into Python memory."""
    row = database.execute(
        "SELECT json_remove(data,'$.errors'),json_array_length(data,'$.errors') "
        "FROM settings WHERE name='watermark-backfill' AND ("
        "json_array_length(data,'$.errors')>? OR EXISTS ("
        "SELECT 1 FROM json_each(data,'$.errors') WHERE "
        "length(json_extract(value,'$.error'))>? OR "
        "length(json_extract(value,'$.image_id'))>?))",
        (
            BATCH_ERROR_SAMPLE_RECORDS,
            BATCH_ERROR_MAX_CHARACTERS,
            BATCH_ERROR_IMAGE_ID_MAX_CHARACTERS,
        ),
    ).fetchone()
    if row is None:
        return
    samples = database.execute(
        "SELECT substr(json_extract(value,'$.image_id'),1,?),"
        "substr(json_extract(value,'$.error'),1,?) "
        "FROM settings,json_each(settings.data,'$.errors') "
        "WHERE settings.name='watermark-backfill' LIMIT ?",
        (
            BATCH_ERROR_IMAGE_ID_MAX_CHARACTERS,
            BATCH_ERROR_MAX_CHARACTERS,
            BATCH_ERROR_SAMPLE_RECORDS,
        ),
    ).fetchall()
    batch = json.loads(row[0])
    batch["errors"] = [
        {"image_id": identity, "error": error} for identity, error in samples
    ]
    batch["omitted_error_count"] = max(
        batch.get("omitted_error_count", 0), row[1] - len(samples)
    )
    database.execute(
        "UPDATE settings SET data=? WHERE name='watermark-backfill'",
        (json.dumps(batch),),
    )


def read_batch(database):
    row = database.execute(
        "SELECT data FROM settings WHERE name='watermark-backfill'"
    ).fetchone()
    return json.loads(row[0]) if row else None


def active_batch(database, identity):
    return (
        database.execute(
            "SELECT 1 FROM settings WHERE name='watermark-backfill' "
            "AND json_extract(data,'$.id')=? "
            "AND json_extract(data,'$.status') IN ('queued','running')",
            (identity,),
        ).fetchone()
        is not None
    )


class WatermarkBatches:
    def __init__(self, store, watermarks, max_records=DEFAULT_BATCH_MAX_RECORDS):
        self.store = store
        self.watermarks = watermarks
        self.max_records = max_records

    def reserve(self, scope, force):
        identity = str(uuid4())
        self.store.track_batch(identity)
        try:
            return self.reserve_tracked(identity, scope, force)
        except Exception:
            self.store.finish_batch(identity)
            raise

    def reserve_tracked(self, identity, scope, force):
        with self.store.write_transaction() as database:
            current = read_batch(database)
            if current and current["status"] in ACTIVE_BATCH_STATUSES:
                raise BackfillActiveError("An analysis batch is already running")
            candidates = sum(row[1] for row in orientation_count_rows(database, scope))
            if candidates > self.max_records:
                raise BackfillLimitError(
                    "Matching images exceed the analysis batch limit; narrow the event scope"
                )
            batch = {
                "id": identity,
                "status": "queued",
                "phase": "preparing",
                "completion_scope": "analysis",
                "queued_count": None,
                "candidate_count": candidates,
                "count_pending": True,
                "completed_count": 0,
                "failed_count": 0,
                "errors": [],
                "omitted_error_count": 0,
                "force": force,
            }
            self.store.write_setting(database, "watermark-backfill", batch)
            self.store.write_setting(
                database, "watermark-backfill-owner", self.store.worker_id
            )
            return batch

    def persist(self, batch, through_rank=None):
        with self.store.write_transaction() as database:
            if not active_batch(database, batch["id"]):
                return False
            self.store.write_setting(database, "watermark-backfill", batch)
            if batch["status"] not in ACTIVE_BATCH_STATUSES:
                database.execute(
                    "DELETE FROM watermark_batch_items WHERE batch_id=?", (batch["id"],)
                )
            elif through_rank is not None:
                database.execute(
                    "DELETE FROM watermark_batch_items WHERE batch_id=? AND rank<=?",
                    (batch["id"], through_rank),
                )
            return True

    def fail(self, batch, message):
        batch.update(status="failed", error=message)
        self.persist(batch)

    def stage_members(self, staging, batch, scope):
        """Capture identities from one read snapshot, with at most one full record live."""
        conditions, parameters = query_conditions(scope, [], True)
        rank = 0
        with self.store.connect() as database:
            database.execute("BEGIN")
            if not active_batch(database, batch["id"]):
                raise BatchStopped()
            count = database.execute(
                f"SELECT count(*) FROM library_catalog WHERE {conditions}", parameters
            ).fetchone()[0]
            if count > self.max_records:
                raise BackfillLimitError(
                    "Matching images exceed the analysis batch limit; narrow the event scope"
                )
            cursor = database.execute(
                "SELECT id,json_extract(summary,'$.has_prepared_record') FROM library_catalog "
                f"WHERE {conditions} ORDER BY id",
                parameters,
            )
            while rows := cursor.fetchmany(BATCH_MEMBER_CHUNK_RECORDS):
                selected = []
                for identity, has_prepared in rows:
                    if not batch["force"] and has_prepared:
                        row = database.execute(
                            "SELECT data FROM images WHERE id=?", (identity,)
                        ).fetchone()
                        if (
                            row
                            and self.watermarks.record(json.loads(row[0]))[
                                "print_ready_url"
                            ]
                        ):
                            continue
                    selected.append((rank, identity))
                    rank += 1
                staging.executemany("INSERT INTO queued_members VALUES (?,?)", selected)
        return count, rank

    def prepare(self, batch, scope):
        # SQLite owns and removes this temporary disk-backed database. It stores
        # only identity/rank, never image bytes or complete generation snapshots.
        with closing(sqlite3.connect("")) as staging:
            staging.execute("PRAGMA temp_store=FILE")
            staging.execute(
                "CREATE TABLE queued_members (rank INTEGER PRIMARY KEY,image_id TEXT NOT NULL)"
            )
            candidates, count = self.stage_members(staging, batch, scope)
            cursor = staging.execute(
                "SELECT rank,image_id FROM queued_members ORDER BY rank"
            )
            while rows := cursor.fetchmany(BATCH_MEMBER_CHUNK_RECORDS):
                with self.store.write_transaction() as database:
                    if not active_batch(database, batch["id"]):
                        raise BatchStopped()
                    database.executemany(
                        "INSERT INTO watermark_batch_items VALUES (?,?,?)",
                        [(batch["id"], rank, identity) for rank, identity in rows],
                    )
        batch.update(
            phase="analysis",
            count_pending=False,
            candidate_count=candidates,
            queued_count=count,
        )
        if not self.persist(batch):
            raise BatchStopped()

    def item(self, batch_id, identity, scope):
        with self.store.connect() as database:
            if not active_batch(database, batch_id):
                raise BatchStopped()
            row = database.execute(
                "SELECT data FROM images WHERE id=?", (identity,)
            ).fetchone()
        if row is None:
            raise ValueError("Image no longer exists")
        snapshot = json.loads(row[0])
        if snapshot.get("visibility") == "private" or (
            scope and snapshot.get("event_id") not in scope
        ):
            raise ValueError("Image is no longer in this analysis scope")
        return snapshot

    @staticmethod
    def note_error(batch, identity, error):
        batch["failed_count"] += 1
        if len(batch["errors"]) < BATCH_ERROR_SAMPLE_RECORDS:
            message = (
                str(error)
                if isinstance(error, ValueError)
                else "Image storage is unavailable"
            )
            batch["errors"].append(
                {
                    "image_id": identity[:BATCH_ERROR_IMAGE_ID_MAX_CHARACTERS],
                    "error": message[:BATCH_ERROR_MAX_CHARACTERS],
                }
            )
        batch["omitted_error_count"] = batch["failed_count"] - len(batch["errors"])

    def run_items(self, batch, scope):
        batch["status"] = "running"
        if not self.persist(batch):
            return
        last_rank, unflushed = -1, 0
        flushed_at = time.monotonic()
        while True:
            with self.store.connect() as database:
                if not active_batch(database, batch["id"]):
                    return
                rows = database.execute(
                    "SELECT rank,image_id FROM watermark_batch_items WHERE batch_id=? AND rank>? ORDER BY rank LIMIT ?",
                    (batch["id"], last_rank, BATCH_MEMBER_CHUNK_RECORDS),
                ).fetchall()
            if not rows:
                break
            for rank, identity in rows:
                try:
                    snapshot = self.item(batch["id"], identity, scope)
                    self.watermarks.analyze(snapshot, batch["force"])
                    batch["completed_count"] += 1
                except (OSError, ValueError, sqlite3.Error) as error:
                    self.note_error(batch, identity, error)
                last_rank, unflushed = rank, unflushed + 1
                now = time.monotonic()
                if (
                    unflushed >= BATCH_PROGRESS_MAX_ITEMS
                    or now - flushed_at >= BATCH_PROGRESS_INTERVAL_SECONDS
                ):
                    if not self.persist(batch, through_rank=rank):
                        return
                    flushed_at, unflushed = now, 0
        batch["status"] = "complete" if batch["failed_count"] == 0 else "failed"
        self.persist(batch)

    def work(self, batch, scope, *, prepare=False):
        try:
            if prepare:
                self.prepare(batch, scope)
            self.run_items(batch, scope)
        except BatchStopped:
            return
        except Exception:
            logging.getLogger(__name__).exception("Unable to complete analysis batch")
            self.fail(batch, "Unable to prepare or persist the analysis batch")
        finally:
            self.store.finish_batch(batch["id"])

    def queue(self, force, pool, scope=(), async_preparation=False):
        batch = self.reserve(scope, force)
        scheduled = False
        try:
            if not async_preparation:
                try:
                    self.prepare(batch, scope)
                except BatchStopped:
                    raise BackfillActiveError(
                        "Analysis batch stopped during preparation"
                    ) from None
                except Exception:
                    self.fail(batch, "Unable to prepare the analysis batch")
                    raise
            result = {
                "status": "queued",
                "queued_count": batch["queued_count"],
                "force": force,
                "analysis_batch_id": batch["id"],
            }
            if async_preparation:
                result.update(
                    phase="preparing",
                    candidate_count=batch["candidate_count"],
                    count_pending=True,
                )
            try:
                pool.submit(partial(self.work, batch, scope, prepare=async_preparation))
            except RuntimeError:
                self.fail(batch, "The analysis worker is unavailable")
                raise BatchWorkerUnavailable() from None
            scheduled = True
            return result
        finally:
            if not scheduled:
                self.store.finish_batch(batch["id"])
