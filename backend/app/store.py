"""SQLite snapshots and atomic, validated original media storage."""

import hashlib
import json
import logging
import os
import sqlite3
import threading
import time
from contextlib import contextmanager, nullcontext
from itertools import chain, islice
from pathlib import Path
from uuid import uuid4

from .deletions import DeletionJournal
from .files import sync_directory
from .library_index import (
    begin_annotation_update,
    finish_annotation_update,
    initialize_index,
    recover_annotation_updates,
    remove_projection,
    write_projection,
)
from .media import DEFAULT_MAX_IMAGE_PIXELS, prepare_original_png
from .thumbnails import initialize_thumbnail_cache
from .watermark_batches import initialize_batch_queue

MAX_JOB_UPDATES = 64
MAX_LIBRARY_CHANGES = 256
LIBRARY_SCHEMA_VERSION = 6
WORKER_HEARTBEAT_SECONDS = 5
WORKER_LEASE_SECONDS = 30
RECOVERY_LOOKUP_BATCH_FILES = 128
ACTIVE_JOB_PREDICATE = "json_extract(data,'$.stage') NOT IN ('complete','failed')"


class StoreConnection(sqlite3.Connection):
    """Commit/roll back and release resources at the end of each store read/write."""

    def __exit__(self, *arguments):
        try:
            return super().__exit__(*arguments)
        finally:
            self.close()


class Store:
    def __init__(self, root, max_image_pixels=DEFAULT_MAX_IMAGE_PIXELS, worker=False):
        self.max_image_pixels = max_image_pixels
        self.worker_id = str(uuid4()) if worker else None
        self.stopping = threading.Event()
        self.heartbeat_thread = None
        self.active_jobs = set()
        self.active_jobs_lock = threading.Lock()
        self.active_batches = set()
        self.active_batches_lock = threading.Lock()
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.deletions = DeletionJournal(self.root)
        with self.connect() as db:
            if db.execute("PRAGMA user_version").fetchone()[0] > LIBRARY_SCHEMA_VERSION:
                raise ValueError("Library schema is newer than this application")
            if db.execute("PRAGMA journal_mode=WAL").fetchone()[0].lower() != "wal":
                raise ValueError(
                    "Storage requires SQLite WAL on a local writable filesystem"
                )
            db.executescript("""
                CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, data TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS jobs (
                    id TEXT PRIMARY KEY, key TEXT UNIQUE, fingerprint TEXT, data TEXT
                );
                CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, data TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS job_updates (
                    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                    job_id TEXT NOT NULL,
                    data TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS job_updates_by_job ON job_updates(job_id,sequence);
                CREATE TABLE IF NOT EXISTS library_changes (
                    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                    data TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS workers (id TEXT PRIMARY KEY, heartbeat REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS job_owners (job_id TEXT PRIMARY KEY, worker_id TEXT NOT NULL);
            """)
            db.execute("BEGIN IMMEDIATE")
            startup_writer_at_seconds = time.time()
            startup_writer_monotonic_seconds = time.monotonic()
            from .generation_groups import initialize_generation_groups

            initialize_generation_groups(db)
            initialize_thumbnail_cache(db)
            self.library_search_available = initialize_index(db, self.root)
            initialize_batch_queue(db)
            pending_annotations = recover_annotation_updates(
                db, self.root, self.library_search_available
            )
            if pending_annotations:
                self.record_library_change(db, "catalog-recovered")
            db.execute(
                "CREATE INDEX IF NOT EXISTS jobs_active ON jobs(id) WHERE "
                + ACTIVE_JOB_PREDICATE
            )
            db.execute(f"PRAGMA user_version={LIBRARY_SCHEMA_VERSION}")
            # Another worker cannot renew its lease while this startup writer
            # holds SQLite's lock for catalog/count migration and recovery.
            # Judge ownership as of lock acquisition, then preserve that lease
            # age across the blocked interval. Already expired owners stay expired.
            self.recover_jobs(db, now_seconds=startup_writer_at_seconds)
            blocked_seconds = max(
                0, time.monotonic() - startup_writer_monotonic_seconds
            )
            db.execute(
                "UPDATE workers SET heartbeat=heartbeat+? WHERE heartbeat>=?",
                (blocked_seconds, startup_writer_at_seconds - WORKER_LEASE_SECONDS),
            )
            if self.worker_id:
                db.execute(
                    "INSERT INTO workers VALUES (?,?)", (self.worker_id, time.time())
                )
        for marker in pending_annotations:
            self.finish_annotation(marker)
        # Preserve unmatched files for recovery; they may also be user-managed data.
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            self.deletions.recover(
                lambda image_id: (
                    db.execute(
                        "SELECT 1 FROM images WHERE id=?", (image_id,)
                    ).fetchone()
                    is not None
                )
            )
        self.recover_unmatched_files()
        if self.worker_id:
            self.heartbeat_thread = threading.Thread(
                target=self.heartbeat, name="imagedials-worker-lease", daemon=True
            )
            self.heartbeat_thread.start()

    def recover_unmatched_files(self):
        """Reconcile only files present on disk, without loading the whole catalog."""
        candidates = chain(self.root.glob("*.png"), self.root.glob("*.tmp"))
        while batch := list(islice(candidates, RECOVERY_LOOKUP_BATCH_FILES)):
            with self.write_transaction() as database:
                identities = [path.stem for path in batch if path.suffix == ".png"]
                present = (
                    {
                        row[0]
                        for row in database.execute(
                            "SELECT id FROM images WHERE id IN ("
                            + ",".join("?" for _ in identities)
                            + ")",
                            identities,
                        )
                    }
                    if identities
                    else set()
                )
                for path in batch:
                    if path.suffix == ".png" and path.stem in present:
                        continue
                    # A save or delete may have finished since directory iteration.
                    # Holding the writer transaction makes the final move safe.
                    try:
                        path.lstat()
                    except FileNotFoundError:
                        continue
                    recovery = self.root / "recovery"
                    if recovery.is_symlink():
                        raise OSError("Recovery directory must not be a symbolic link")
                    recovery.mkdir(exist_ok=True)
                    path.replace(recovery / f"{uuid4()}-{path.name}")

    def recover_jobs(self, db, *, now_seconds=None):
        """Fail only abandoned work; another API worker may still own a job."""
        cutoff = (
            time.time() if now_seconds is None else now_seconds
        ) - WORKER_LEASE_SECONDS
        active = {
            row[0]
            for row in db.execute(
                "SELECT id FROM workers WHERE heartbeat>=?", (cutoff,)
            )
        }
        with self.active_jobs_lock:
            running_here = self.active_jobs.copy()
        for job_id, raw, owner in db.execute(
            "SELECT jobs.id,jobs.data,job_owners.worker_id FROM jobs "
            "LEFT JOIN job_owners ON job_owners.job_id=jobs.id WHERE "
            + ACTIVE_JOB_PREDICATE
        ).fetchall():
            job = json.loads(raw)
            abandoned = owner not in active
            stopped_here = (
                self.worker_id is not None
                and owner == self.worker_id
                and job_id not in running_here
            )
            if job["stage"] not in {"complete", "failed"} and (
                abandoned or stopped_here
            ):
                job.update(
                    stage="failed",
                    error="Generation interrupted; its API worker is no longer active"
                    if abandoned
                    else "Generation stopped before its terminal state could be stored",
                )
                db.execute(
                    "UPDATE jobs SET data=? WHERE id=?", (json.dumps(job), job_id)
                )
                self.record_job_update(db, job)
        db.execute("DELETE FROM workers WHERE heartbeat<?", (cutoff,))
        batch_row = db.execute(
            "SELECT data FROM settings WHERE name='watermark-backfill'"
        ).fetchone()
        owner_row = db.execute(
            "SELECT data FROM settings WHERE name='watermark-backfill-owner'"
        ).fetchone()
        if batch_row:
            batch = json.loads(batch_row[0])
            owner = json.loads(owner_row[0]) if owner_row else None
            with self.active_batches_lock:
                stopped_batch_here = (
                    self.worker_id is not None
                    and owner == self.worker_id
                    and batch.get("id") not in self.active_batches
                )
            if batch["status"] in {"queued", "running"} and (
                owner not in active or stopped_batch_here
            ):
                batch.update(
                    status="failed",
                    error="Analysis batch interrupted; its API worker is no longer active"
                    if owner not in active
                    else "Analysis batch stopped before its terminal state could be stored",
                )
                self.write_setting(db, "watermark-backfill", batch)
                db.execute(
                    "DELETE FROM watermark_batch_items WHERE batch_id=?",
                    (batch.get("id"),),
                )

    def track_job(self, job_id):
        with self.active_jobs_lock:
            self.active_jobs.add(job_id)

    def finish_job(self, job_id):
        with self.active_jobs_lock:
            self.active_jobs.discard(job_id)

    def track_batch(self, batch_id):
        with self.active_batches_lock:
            self.active_batches.add(batch_id)

    def finish_batch(self, batch_id):
        with self.active_batches_lock:
            self.active_batches.discard(batch_id)

    def heartbeat(self):
        while not self.stopping.wait(WORKER_HEARTBEAT_SECONDS):
            try:
                with self.connect() as db:
                    db.execute("BEGIN IMMEDIATE")
                    self.renew_worker(db)
                    self.recover_jobs(db)
            except (sqlite3.Error, OSError):
                logging.getLogger(__name__).warning(
                    "Unable to renew the generation worker lease"
                )

    def close(self):
        self.stopping.set()
        if self.heartbeat_thread:
            self.heartbeat_thread.join()
        if self.worker_id:
            with self.connect() as db:
                db.execute("DELETE FROM workers WHERE id=?", (self.worker_id,))

    def connect(self):
        database = sqlite3.connect(
            self.root / "library.sqlite3", timeout=30, factory=StoreConnection
        )
        database.execute("PRAGMA synchronous=FULL")
        return database

    @contextmanager
    def write_transaction(self, connection=None):
        """Serialize writers; an optional caller-owned connection stays open."""
        connection_scope = (
            self.connect() if connection is None else nullcontext(connection)
        )
        with connection_scope as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                yield db
                self.renew_worker(db)
                db.commit()
            except BaseException:
                db.rollback()
                raise

    def renew_worker(self, database):
        # A writer doing useful work can renew its lease in the transaction
        # rather than starving its heartbeat thread behind repeated writes.
        if self.worker_id and not self.stopping.is_set():
            database.execute(
                "INSERT INTO workers VALUES (?,?) ON CONFLICT(id) DO UPDATE SET heartbeat=excluded.heartbeat",
                (self.worker_id, time.time()),
            )

    @contextmanager
    def annotation_transaction(self, image_id):
        """Journal the sidecar/SQLite boundary for repair after an interruption."""
        marker = None

        def mark_dirty():
            nonlocal marker
            if marker is None:
                marker = begin_annotation_update(self.root, image_id)

        with self.write_transaction() as db:
            yield db, mark_dirty
        if marker is not None:
            self.finish_annotation(marker)

    @staticmethod
    def finish_annotation(marker):
        try:
            finish_annotation_update(marker)
        except OSError:
            logging.getLogger(__name__).warning(
                "Deferred cleanup of a catalog journal entry"
            )

    def job(self, job_id):
        with self.connect() as db:
            row = db.execute("SELECT data FROM jobs WHERE id=?", (job_id,)).fetchone()
        return json.loads(row[0]) if row else None

    def update_job(self, job):
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            current = db.execute(
                "SELECT data FROM jobs WHERE id=?", (job["id"],)
            ).fetchone()
            if current is None or json.loads(current[0])["stage"] in {
                "complete",
                "failed",
            }:
                return False
            db.execute(
                "UPDATE jobs SET data=? WHERE id=?", (json.dumps(job), job["id"])
            )
            self.record_job_update(db, job)
        return True

    def record_job_update(self, db, job):
        """Keep bounded durable snapshots in the same transaction as job state."""
        db.execute(
            "INSERT INTO job_updates(job_id,data) VALUES (?,?)",
            (job["id"], json.dumps(job)),
        )
        if job["stage"] == "queued" and self.worker_id:
            db.execute(
                "INSERT OR IGNORE INTO job_owners VALUES (?,?)",
                (job["id"], self.worker_id),
            )
        db.execute(
            "DELETE FROM job_updates WHERE job_id=? AND sequence NOT IN "
            "(SELECT sequence FROM job_updates WHERE job_id=? ORDER BY sequence DESC LIMIT ?)",
            (job["id"], job["id"], MAX_JOB_UPDATES),
        )

    def job_updates(self, job_id, after_sequence=0):
        with self.connect() as db:
            return [
                (row[0], json.loads(row[1]))
                for row in db.execute(
                    "SELECT sequence,data FROM job_updates WHERE job_id=? AND sequence>? ORDER BY sequence",
                    (job_id, after_sequence),
                )
            ]

    def save_preview(self, snapshot, data, job):
        """Publish validated pixels before enrichment, outside the saved library."""
        data = prepare_original_png(data, snapshot, self.max_image_pixels)
        directory = self.root / "previews"
        directory.mkdir(exist_ok=True)
        path = directory / (job["id"] + ".png")
        temporary = path.with_suffix(".tmp")
        try:
            with temporary.open("wb") as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
            sync_directory(path.parent)
            job.update(stage="image-ready", preview=snapshot)
            if not self.update_job(job):
                raise JobNoLongerActive("Generation job is already terminal")
        finally:
            temporary.unlink(missing_ok=True)

    def save(self, snapshot, data, job):
        data = prepare_original_png(data, snapshot, self.max_image_pixels)
        snapshot["sha256"] = hashlib.sha256(data).hexdigest()
        path = self.root / (snapshot["id"] + ".png")
        temp = path.with_suffix(".tmp")
        installed = False
        try:
            with self.connect() as db:
                db.execute("BEGIN IMMEDIATE")
                current = db.execute(
                    "SELECT data FROM jobs WHERE id=?", (job["id"],)
                ).fetchone()
                if current is None or json.loads(current[0])["stage"] in {
                    "complete",
                    "failed",
                }:
                    raise JobNoLongerActive("Generation job is already terminal")
                if path.exists():
                    raise FileExistsError("Generation destination already exists")
                with temp.open("wb") as file:
                    file.write(data)
                    file.flush()
                    os.fsync(file.fileno())
                os.replace(temp, path)
                sync_directory(path.parent)
                installed = True
                job.update(stage="complete", result=snapshot)
                db.execute(
                    "INSERT INTO images VALUES (?,?)",
                    (snapshot["id"], json.dumps(snapshot)),
                )
                write_projection(db, snapshot, self.library_search_available)
                db.execute(
                    "UPDATE jobs SET data=? WHERE id=?", (json.dumps(job), job["id"])
                )
                self.record_job_update(db, job)
                if snapshot.get("visibility") != "private":
                    self.record_library_change(
                        db,
                        "saved",
                        storage_id="local-0",
                        filename=path.name,
                        event_name=snapshot.get("event_id"),
                    )
        except Exception:
            if installed:
                path.unlink(missing_ok=True)
            temp.unlink(missing_ok=True)
            raise

    def images(self):
        with self.connect() as db:
            return [
                json.loads(r[0])
                for r in db.execute("SELECT data FROM images ORDER BY rowid DESC")
            ]

    def image(self, image_id):
        with self.connect() as db:
            row = db.execute(
                "SELECT data FROM images WHERE id=?", (image_id,)
            ).fetchone()
        return json.loads(row[0]) if row else None

    def delete(self, image_id):
        pending = None
        try:
            with self.write_transaction() as db:
                row = db.execute(
                    "SELECT data FROM images WHERE id=?", (image_id,)
                ).fetchone()
                if row is None:
                    return
                snapshot = json.loads(row[0])
                pending = self.deletions.stage(image_id)
                db.execute("DELETE FROM images WHERE id=?", (image_id,))
                db.execute("DELETE FROM thumbnail_cache WHERE image_id=?", (image_id,))
                remove_projection(db, image_id, self.library_search_available)
                if snapshot.get("visibility") != "private":
                    self.record_library_change(
                        db,
                        "deleted",
                        storage_id="local-0",
                        filename=image_id + ".png",
                        event_name=snapshot.get("event_id"),
                    )
        except BaseException:
            if pending:
                with self.write_transaction():
                    pending.restore()
            raise
        try:
            with self.write_transaction():
                pending.purge()
        except OSError:
            # The deletion is committed; remaining staged bytes are inaccessible
            # through the API and are removed by startup recovery.
            logging.getLogger(__name__).warning("Deferred cleanup of a deleted image")

    def setting(self, name, default):
        with self.connect() as db:
            row = db.execute(
                "SELECT data FROM settings WHERE name=?", (name,)
            ).fetchone()
        return json.loads(row[0]) if row else default

    def set_setting(self, name, value):
        with self.connect() as db:
            self.write_setting(db, name, value)

    def write_setting(self, db, name, value):
        db.execute(
            "INSERT INTO settings(name,data) VALUES (?,?) ON CONFLICT(name) DO UPDATE SET data=excluded.data",
            (name, json.dumps(value, ensure_ascii=False)),
        )
        if name == "watermark":
            self.record_library_change(db, "watermark-settings")
        elif name == "watermark-backfill":
            self.record_library_change(
                db,
                "watermark-backfill-queued"
                if value["status"] == "queued"
                else "watermark",
                queued_count=value["queued_count"],
                analysis_batch_id=value["id"],
                status=value["status"],
            )

    def record_library_change(self, db, action, **fields):
        db.execute(
            "INSERT INTO library_changes(data) VALUES (?)",
            (json.dumps({"action": action, **fields}),),
        )
        db.execute(
            "DELETE FROM library_changes WHERE sequence NOT IN "
            "(SELECT sequence FROM library_changes ORDER BY sequence DESC LIMIT ?)",
            (MAX_LIBRARY_CHANGES,),
        )

    def notify_library(self, action, **fields):
        with self.connect() as db:
            self.record_library_change(db, action, **fields)

    def library_change_sequence(self):
        with self.connect() as db:
            return db.execute(
                "SELECT COALESCE(MAX(sequence),0) FROM library_changes"
            ).fetchone()[0]

    def library_changes(self, after_sequence):
        with self.connect() as db:
            return [
                (row[0], json.loads(row[1]))
                for row in db.execute(
                    "SELECT sequence,data FROM library_changes WHERE sequence>? ORDER BY sequence",
                    (after_sequence,),
                )
            ]


class JobNoLongerActive(RuntimeError):
    """A recovered/terminal generation cannot publish later worker results."""
