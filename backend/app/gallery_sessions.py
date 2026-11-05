"""Bounded, durable gallery permutations over compact catalog identities."""

import hashlib
import json
import logging
import secrets
import sqlite3
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from dataclasses import dataclass
from uuid import uuid4

from fastapi import HTTPException, Request
from fastapi.responses import Response
from starlette.concurrency import run_in_threadpool

from .library_pages import (
    CACHE_CONTROL,
    ORIENTATIONS,
    PAGE_DEFAULT_RECORDS,
    PAGE_MAX_RECORDS,
    encoded_json,
    fingerprint,
    query_conditions,
    summary_record,
)
from .media import positive_integer
from .routing import canonical_routes
from .store import WORKER_LEASE_SECONDS

SESSION_FORMAT_VERSION = 1
SESSION_BUILD_BATCH_RECORDS = 1024
SESSION_INSTALL_BATCH_RECORDS = 4096
SESSION_INSTALL_YIELD_SECONDS = 0.005
# Retain the member-index working set while inserting a large shuffled session.
# One builder connection owns this cache; chunk transactions still yield writers.
SESSION_INSTALL_CACHE_KIB = 32 * 1024
SESSION_BUILD_MAX_ATTEMPTS = 2
DEFAULT_SESSION_MAX_COUNT = 4
DEFAULT_SESSION_MAX_RECORDS = 250_000
DEFAULT_SESSION_TTL_SECONDS = 1800
MAX_SIGNED_SORT_KEY = (1 << 63) - 1
MAX_SESSION_REQUEST_BYTES = 8192
MAX_IMAGE_ID_CHARACTERS = 200
SESSION_RESPONSE_VERSION = 5


class CatalogChanged(Exception):
    """A bounded construction attempt no longer describes one catalog revision."""


class SessionBuildStopped(Exception):
    """The session was released, expired or completed by another operation."""


class SessionRecordLimit(Exception):
    """The session cannot include its full matching set within its budget."""


@dataclass(frozen=True)
class GallerySessionPolicy:
    max_count: int
    max_records: int
    ttl_seconds: int

    @classmethod
    def from_env(cls, env):
        return cls(
            positive_integer(
                env, "GALLERY_SESSION_MAX_COUNT", DEFAULT_SESSION_MAX_COUNT
            ),
            positive_integer(
                env, "GALLERY_SESSION_MAX_RECORDS", DEFAULT_SESSION_MAX_RECORDS
            ),
            positive_integer(
                env, "GALLERY_SESSION_TTL_SECONDS", DEFAULT_SESSION_TTL_SECONDS
            ),
        )


def session_conditions(scope, orientations):
    conditions, parameters = query_conditions(scope, [], True)
    if orientations is not None:
        if not orientations:
            conditions += " AND 0"
        else:
            conditions += (
                " AND orientation IN (" + ",".join("?" for _ in orientations) + ")"
            )
            parameters.extend(orientations)
    return conditions, parameters


def has_session_neighbor(database, identity, rank, conditions, parameters, *, before):
    """Probe the nearest eligible rank without loading its summary or source."""
    comparator, order = ("<", "DESC") if before else (">", "ASC")
    return (
        database.execute(
            "SELECT 1 FROM gallery_session_members AS member "
            "JOIN library_catalog AS catalog ON catalog.id=member.image_id "
            f"WHERE member.session_id=? AND member.rank{comparator}? AND {conditions} "
            f"ORDER BY member.rank {order} LIMIT 1",
            [identity, rank, *parameters],
        ).fetchone()
        is not None
    )


class GallerySessions:
    def __init__(self, store, policy):
        self.store = store
        self.max_count = policy.max_count
        self.max_records = policy.max_records
        self.ttl_seconds = policy.ttl_seconds
        self.pool = ThreadPoolExecutor(max_workers=1)
        with store.write_transaction() as database:
            database.execute(
                "CREATE TABLE IF NOT EXISTS gallery_sessions ("
                "id TEXT PRIMARY KEY,scope TEXT NOT NULL,orientations TEXT NOT NULL,"
                "owner TEXT,state TEXT NOT NULL,expires_at REAL NOT NULL,"
                "revision INTEGER NOT NULL,total INTEGER NOT NULL DEFAULT 0,"
                "error TEXT,format INTEGER NOT NULL)"
            )
            database.execute(
                "CREATE INDEX IF NOT EXISTS gallery_sessions_expiry ON gallery_sessions(expires_at)"
            )
            columns = {
                row[1]
                for row in database.execute("PRAGMA table_info(gallery_sessions)")
            }
            for name, kind in (
                ("first_image_id", "TEXT"),
                ("first_image_member", "INTEGER"),
                ("preview_image_id", "TEXT"),
                ("preview_revision", "INTEGER"),
            ):
                if name not in columns:
                    database.execute(
                        f"ALTER TABLE gallery_sessions ADD COLUMN {name} {kind}"
                    )
            database.execute(
                "CREATE TABLE IF NOT EXISTS gallery_session_members ("
                "session_id TEXT NOT NULL,rank INTEGER NOT NULL,image_id TEXT NOT NULL,"
                "PRIMARY KEY(session_id,rank)) WITHOUT ROWID"
            )
            database.execute(
                "CREATE INDEX IF NOT EXISTS gallery_members_image ON gallery_session_members(image_id)"
            )
            database.execute(
                "CREATE TRIGGER IF NOT EXISTS gallery_members_deleted AFTER DELETE ON library_catalog "
                "BEGIN DELETE FROM gallery_session_members WHERE image_id=OLD.id; END"
            )
            self.expire(database, time.time())
            self.trim_to_policy(database)

    def close(self):
        self.pool.shutdown(wait=True, cancel_futures=True)

    def trim_to_policy(self, database):
        """Reapply reduced budgets without touching the source library."""
        removed = (
            "SELECT id FROM gallery_sessions WHERE id NOT IN ("
            "SELECT id FROM gallery_sessions WHERE total<=? "
            "ORDER BY expires_at DESC,id DESC LIMIT ?)"
        )
        parameters = (self.max_records, self.max_count)
        database.execute(
            "DELETE FROM gallery_session_members WHERE session_id IN (" + removed + ")",
            parameters,
        )
        database.execute(
            "DELETE FROM gallery_sessions WHERE id IN (" + removed + ")", parameters
        )

    @staticmethod
    def expire(database, now):
        database.execute(
            "DELETE FROM gallery_session_members WHERE session_id IN "
            "(SELECT id FROM gallery_sessions WHERE expires_at<=?)",
            (now,),
        )
        database.execute("DELETE FROM gallery_sessions WHERE expires_at<=?", (now,))

    def create(self, scope, orientations, first_image_id=None):
        identity, now = str(uuid4()), time.time()
        with self.store.write_transaction() as database:
            self.expire(database, now)
            if (
                database.execute("SELECT count(*) FROM gallery_sessions").fetchone()[0]
                >= self.max_count
            ):
                raise HTTPException(
                    429,
                    "Gallery session limit reached; release a session or wait for expiry",
                    headers={"Retry-After": "5"},
                )
            database.execute(
                "INSERT INTO gallery_sessions(id,scope,orientations,owner,state,expires_at,revision,format,first_image_id) "
                "VALUES (?,?,?,?,?,?,?,?,?)",
                (
                    identity,
                    json.dumps(sorted(scope)),
                    json.dumps(orientations),
                    self.store.worker_id,
                    "building",
                    now + self.ttl_seconds,
                    0,
                    SESSION_FORMAT_VERSION,
                    first_image_id,
                ),
            )
        try:
            self.pool.submit(self.build, identity, secrets.token_bytes(16))
        except RuntimeError:
            self.fail(identity, "Gallery session worker is unavailable")
        return {
            "session_id": identity,
            "state": "building",
            "expires_at": now + self.ttl_seconds,
            "first_image_member": None,
        }

    def fail(self, identity, message):
        with self.store.write_transaction() as database:
            database.execute(
                "DELETE FROM gallery_session_members WHERE session_id=?", (identity,)
            )
            database.execute(
                "UPDATE gallery_sessions SET state='failed',error=? WHERE id=?",
                (message, identity),
            )

    def build(self, identity, seed):
        try:
            for _ in range(SESSION_BUILD_MAX_ATTEMPTS):
                # An empty filename is SQLite's automatically removed temporary
                # database. Sort outside the library writer transaction and retain
                # only one bounded identity batch in Python memory.
                with closing(sqlite3.connect("")) as staging:
                    staging.execute("PRAGMA temp_store=FILE")
                    staging.execute(
                        "CREATE TABLE gallery_order (priority INTEGER,sort_key INTEGER,image_id TEXT,"
                        "PRIMARY KEY(priority,sort_key,image_id)) WITHOUT ROWID"
                    )
                    try:
                        revision, count = self.stage_members(staging, identity, seed)
                        self.publish_preview(staging, identity, revision)
                        self.install_members(staging, identity, revision, count)
                    except CatalogChanged:
                        continue
                    return
            self.fail(
                identity, "Library changed while gallery order was building; retry"
            )
        except SessionBuildStopped:
            return
        except SessionRecordLimit:
            self.fail(identity, "Gallery session exceeds its configured record limit")
        except Exception:
            logging.getLogger(__name__).exception("Unable to build gallery session")
            self.fail(identity, "Unable to build gallery session")

    @staticmethod
    def current_revision(database):
        return database.execute(
            "SELECT COALESCE(MAX(sequence),0) FROM library_changes"
        ).fetchone()[0]

    @staticmethod
    def build_parameters(database, identity):
        row = database.execute(
            "SELECT scope,orientations,expires_at,state FROM gallery_sessions WHERE id=?",
            (identity,),
        ).fetchone()
        if row is None or row[2] <= time.time() or row[3] != "building":
            raise SessionBuildStopped()
        return session_conditions(json.loads(row[0]), json.loads(row[1]))

    def read_batch(self, identity, conditions, parameters, last_id, revision):
        with self.store.connect() as database:
            database.execute("BEGIN")
            self.build_parameters(database, identity)
            if self.current_revision(database) != revision:
                raise CatalogChanged()
            anchor = " AND id>?" if last_id is not None else ""
            return database.execute(
                "SELECT id FROM library_catalog INDEXED BY library_catalog_identity "
                f"WHERE {conditions}{anchor} ORDER BY id LIMIT ?",
                [
                    *parameters,
                    *([last_id] if last_id is not None else []),
                    SESSION_BUILD_BATCH_RECORDS,
                ],
            ).fetchall()

    def stage_members(self, staging, identity, seed):
        with self.store.connect() as database:
            database.execute("BEGIN")
            conditions, parameters = self.build_parameters(database, identity)
            revision = self.current_revision(database)
            count = database.execute(
                "SELECT count(*) FROM library_catalog INDEXED BY library_catalog_identity "
                f"WHERE {conditions}",
                parameters,
            ).fetchone()[0]
            first_image_id = database.execute(
                "SELECT first_image_id FROM gallery_sessions WHERE id=?", (identity,)
            ).fetchone()[0]
        if count > self.max_records:
            raise SessionRecordLimit()
        last_id, staged = None, 0
        while batch := self.read_batch(
            identity, conditions, parameters, last_id, revision
        ):
            staging.executemany(
                "INSERT INTO gallery_order VALUES (?,?,?)",
                [
                    (
                        0 if image_id == first_image_id else 1,
                        int.from_bytes(
                            hashlib.blake2b(
                                image_id.encode(), key=seed, digest_size=8
                            ).digest(),
                            "big",
                        )
                        & MAX_SIGNED_SORT_KEY,
                        image_id,
                    )
                    for (image_id,) in batch
                ],
            )
            staged += len(batch)
            last_id = batch[-1][0]
        if staged != count:
            raise CatalogChanged()
        return revision, count

    def publish_preview(self, staging, identity, revision):
        """Expose one staged first image, separately from unpublished members."""
        first = staging.execute(
            "SELECT image_id FROM gallery_order ORDER BY priority,sort_key,image_id LIMIT 1"
        ).fetchone()
        with self.store.write_transaction() as database:
            self.validate_installation(database, identity, revision)
            database.execute(
                "UPDATE gallery_sessions SET preview_image_id=?,preview_revision=? WHERE id=?",
                (first[0] if first else None, revision, identity),
            )

    def clear_build_members(self, identity, connection=None):
        """Discard an unpublished attempt without monopolizing the writer."""
        while True:
            with self.store.write_transaction(connection) as database:
                self.build_parameters(database, identity)
                removed = database.execute(
                    "DELETE FROM gallery_session_members WHERE session_id=? AND rank IN ("
                    "SELECT rank FROM gallery_session_members WHERE session_id=? LIMIT ?)",
                    (identity, identity, SESSION_INSTALL_BATCH_RECORDS),
                ).rowcount
            if removed < SESSION_INSTALL_BATCH_RECORDS:
                return

    def validate_installation(self, database, identity, revision):
        self.build_parameters(database, identity)
        if self.current_revision(database) != revision:
            raise CatalogChanged()

    def install_members(self, staging, identity, revision, count):
        # Keep only a bounded SQLite page cache between short transactions;
        # reopening the connection for every chunk repeatedly discards it.
        with self.store.connect() as database:
            database.execute(f"PRAGMA cache_size=-{SESSION_INSTALL_CACHE_KIB}")
            self.install_member_chunks(staging, identity, revision, count, database)

    def install_member_chunks(self, staging, identity, revision, count, connection):
        # A changed catalog can leave an unpublished prefix from the previous
        # attempt. Readers see only "building" until every chunk is current.
        self.clear_build_members(identity, connection)
        cursor = staging.execute(
            "SELECT image_id FROM gallery_order ORDER BY priority,sort_key,image_id"
        )
        first_image_member = (
            staging.execute(
                "SELECT 1 FROM gallery_order WHERE priority=0 LIMIT 1"
            ).fetchone()
            is not None
        )
        rank = 0
        while batch := cursor.fetchmany(SESSION_INSTALL_BATCH_RECORDS):
            with self.store.write_transaction(connection) as database:
                self.validate_installation(database, identity, revision)
                database.executemany(
                    "INSERT INTO gallery_session_members VALUES (?,?,?)",
                    [
                        (identity, rank + offset, image_id)
                        for offset, (image_id,) in enumerate(batch)
                    ],
                )
            rank += len(batch)
            if rank < count:
                # Let waiting SQLite writers acquire the released lock instead
                # of immediately winning it again for the next identity chunk.
                time.sleep(SESSION_INSTALL_YIELD_SECONDS)
        with self.store.write_transaction(connection) as database:
            self.validate_installation(database, identity, revision)
            database.execute(
                "UPDATE gallery_sessions SET state='ready',revision=?,total=?,first_image_member=? WHERE id=?",
                (revision, count, first_image_member, identity),
            )

    def session(self, database, identity, scope):
        row = database.execute(
            "SELECT scope,orientations,owner,state,expires_at,revision,total,error,format,first_image_member,preview_image_id,preview_revision FROM gallery_sessions WHERE id=?",
            (identity,),
        ).fetchone()
        if row is None or json.loads(row[0]) != sorted(scope):
            raise HTTPException(404, "Gallery session not found")
        if row[4] <= time.time():
            raise HTTPException(410, "Gallery session expired; create another session")
        if row[8] != SESSION_FORMAT_VERSION:
            raise HTTPException(
                409, "Gallery session format changed; create another session"
            )
        if row[3] == "building":
            owner = database.execute(
                "SELECT heartbeat FROM workers WHERE id=?", (row[2],)
            ).fetchone()
            if owner is None or owner[0] < time.time() - WORKER_LEASE_SECONDS:
                return {
                    "session_id": identity,
                    "state": "failed",
                    "error": "Gallery session worker is no longer active",
                    "expires_at": row[4],
                }, row
        result = {
            "session_id": identity,
            "state": row[3],
            "expires_at": row[4],
            "snapshot_revision": row[5],
            "snapshot_total": row[6],
            "error": row[7],
            "first_image_member": None if row[9] is None else bool(row[9]),
        }
        if (
            row[3] == "building"
            and row[10] is not None
            and row[11] == self.current_revision(database)
        ):
            # This exact revision was fully staged. A catalog change hides the
            # candidate until a new attempt stages its own order. Scope and
            # shape are checked again without reading a complete source record.
            conditions, parameters = session_conditions(scope, json.loads(row[1]))
            preview = database.execute(
                f"SELECT summary FROM library_catalog WHERE id=? AND {conditions}",
                [row[10], *parameters],
            ).fetchone()
            if preview:
                result["preview"] = {
                    "snapshot_revision": row[11],
                    "image": summary_record(preview[0], storage_root=self.store.root),
                }
        return result, row

    def renew(self, identity, scope):
        """Extend an active lease by one configured interval; never revive expiry."""
        with self.store.write_transaction() as database:
            result, _ = self.session(database, identity, scope)
            if result["state"] not in {"building", "ready"}:
                raise HTTPException(
                    409, "Gallery session cannot be renewed; create another session"
                )
            expires_at = time.time() + self.ttl_seconds
            database.execute(
                "UPDATE gallery_sessions SET expires_at=? WHERE id=?",
                (expires_at, identity),
            )
            return {**result, "expires_at": expires_at}


def register_gallery_sessions(app, available_store):
    route = canonical_routes(app)

    @route("/images/library/shuffle-sessions", ("POST",))
    async def create_session(request: Request):
        try:
            raw = bytearray()
            async for chunk in request.stream():
                if len(raw) + len(chunk) > MAX_SESSION_REQUEST_BYTES:
                    raise HTTPException(413, "Gallery session request is too large")
                raw.extend(chunk)
            body = json.loads(raw)
            if not isinstance(body, dict) or set(body) - {
                "event_name",
                "orientations",
                "first_image_id",
            }:
                raise ValueError()
            event = body.get("event_name")
            if event is not None and not isinstance(event, str):
                raise ValueError()
            first_image_id = body.get("first_image_id")
            if first_image_id is not None and (
                not isinstance(first_image_id, str)
                or not 1 <= len(first_image_id) <= MAX_IMAGE_ID_CHARACTERS
                or "\x00" in first_image_id
            ):
                raise ValueError()
            orientations = body.get("orientations")
            if orientations is not None:
                if (
                    not isinstance(orientations, list)
                    or len(orientations) > len(ORIENTATIONS)
                    or any(
                        not isinstance(value, str) or value not in ORIENTATIONS
                        for value in orientations
                    )
                ):
                    raise ValueError()
                orientations = sorted(set(orientations))
        except (ValueError, TypeError):
            raise HTTPException(
                400, "Provide an event scope and valid orientation list"
            ) from None
        scope = app.state.deployment.scope(event)
        with available_store():
            result = await run_in_threadpool(
                app.state.gallery_sessions.create, scope, orientations, first_image_id
            )
        return Response(
            content=encoded_json(result),
            status_code=202,
            media_type="application/json",
            headers={"Cache-Control": "no-store"},
        )

    @route("/images/library/shuffle-sessions/{session_id}")
    def read_session(
        request: Request,
        session_id: str,
        event_name: str | None = None,
        rank: int = 0,
        direction: str = "forward",
        limit: int = PAGE_DEFAULT_RECORDS,
    ):
        if (
            not 0 <= rank <= MAX_SIGNED_SORT_KEY
            or direction not in {"forward", "backward"}
            or not 1 <= limit <= PAGE_MAX_RECORDS
        ):
            raise HTTPException(400, "Invalid gallery session page")
        scope = app.state.deployment.scope(event_name)
        with available_store() as store, store.connect() as database:
            database.execute("BEGIN")
            result, row = app.state.gallery_sessions.session(
                database, session_id, scope
            )
            if result["state"] != "ready":
                return Response(
                    content=encoded_json(result),
                    status_code=202 if result["state"] == "building" else 200,
                    media_type="application/json",
                    headers={"Cache-Control": "no-store"},
                )
            revision = database.execute(
                "SELECT COALESCE(MAX(sequence),0) FROM library_changes"
            ).fetchone()[0]
            etag = (
                '"'
                + fingerprint(
                    [
                        SESSION_RESPONSE_VERSION,
                        session_id,
                        rank,
                        direction,
                        limit,
                        revision,
                        result["expires_at"],
                    ]
                )
                + '"'
            )
            headers = {"ETag": etag, "Cache-Control": CACHE_CONTROL}
            if request.headers.get("if-none-match") == etag:
                return Response(status_code=304, headers=headers)
            conditions, parameters = session_conditions(scope, json.loads(row[1]))
            comparator, order = (
                (">=", "ASC") if direction == "forward" else ("<=", "DESC")
            )
            rows = database.execute(
                "SELECT member.rank,catalog.summary FROM gallery_session_members AS member "
                "JOIN library_catalog AS catalog ON catalog.id=member.image_id "
                f"WHERE member.session_id=? AND member.rank{comparator}? AND {conditions} "
                f"ORDER BY member.rank {order} LIMIT ?",
                [session_id, rank, *parameters, limit + 1],
            ).fetchall()
            selected = rows[:limit]
            if direction == "backward":
                selected.reverse()
            # The extra row proves a neighbor only in the requested direction.
            # Deleted members and changed metadata can remove every eligible
            # member at the opposite edge while snapshot ranks stay unchanged.
            has_previous = (
                bool(selected)
                and selected[0][0] > 0
                and (
                    len(rows) > limit
                    if direction == "backward"
                    else has_session_neighbor(
                        database,
                        session_id,
                        selected[0][0],
                        conditions,
                        parameters,
                        before=True,
                    )
                )
            )
            has_next = (
                bool(selected)
                and selected[-1][0] < result["snapshot_total"] - 1
                and (
                    len(rows) > limit
                    if direction == "forward"
                    else has_session_neighbor(
                        database,
                        session_id,
                        selected[-1][0],
                        conditions,
                        parameters,
                        before=False,
                    )
                )
            )
            result.update(
                images=[
                    {
                        **summary_record(raw, storage_root=store.root),
                        "session_rank": position,
                    }
                    for position, raw in selected
                ],
                count=len(selected),
                revision=revision,
                next_rank=selected[-1][0] + 1 if has_next else None,
                previous_rank=selected[0][0] - 1 if has_previous else None,
            )
            return Response(
                content=encoded_json(result),
                media_type="application/json",
                headers=headers,
            )

    @route("/images/library/shuffle-sessions/{session_id}/renew", ("POST",))
    def renew_session(session_id: str, event_name: str | None = None):
        scope = app.state.deployment.scope(event_name)
        with available_store():
            result = app.state.gallery_sessions.renew(session_id, scope)
        return Response(
            content=encoded_json(result),
            media_type="application/json",
            headers={"Cache-Control": "no-store"},
        )

    @route("/images/library/shuffle-sessions/{session_id}", ("DELETE",))
    def release_session(session_id: str, event_name: str | None = None):
        scope = app.state.deployment.scope(event_name)
        with available_store() as store, store.write_transaction() as database:
            app.state.gallery_sessions.session(database, session_id, scope)
            database.execute(
                "DELETE FROM gallery_session_members WHERE session_id=?", (session_id,)
            )
            database.execute("DELETE FROM gallery_sessions WHERE id=?", (session_id,))
        return Response(status_code=204)
