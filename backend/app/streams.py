"""Bounded SQLite-backed event streams with polling-equivalent job history."""

import asyncio
import json
import sqlite3
import time

from fastapi import HTTPException, Request
from fastapi.responses import StreamingResponse
from starlette.concurrency import run_in_threadpool

from .responses import local_file_response
from .routing import canonical_routes
from .wire import enabled, job_event

STREAM_POLL_SECONDS = 0.25
STREAM_HEARTBEAT_SECONDS = 25
STREAM_HEADERS = {
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
}
TERMINAL_EVENTS = {"complete", "failed"}


def encode_event(name, data):
    encoded = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    return f"event: {name}\ndata: {encoded}\n\n"


async def job_stream(request, store, job_id):
    yield ": connected\n\n"
    cursor = 0
    heartbeat_at = time.monotonic() + STREAM_HEARTBEAT_SECONDS
    while not await request.is_disconnected():
        try:
            job = await run_in_threadpool(store.job, job_id)
            if job is None:
                yield encode_event(
                    "failed",
                    {
                        "error": "Generation job not found",
                        "enrichment": {"status": "failed"},
                    },
                )
                return
            updates = await run_in_threadpool(store.job_updates, job_id, cursor)
            # Historical schema-v2 terminal jobs have no retained updates.
            if not updates and cursor == 0:
                updates = [(0, job)]
            for sequence, snapshot in updates:
                event = job_event(snapshot)
                yield encode_event(event["event"], event["data"])
                cursor = max(cursor, sequence)
                if event["event"] in TERMINAL_EVENTS:
                    return
        except (sqlite3.Error, OSError, ValueError):
            # Observation failure says nothing about the job's terminal state.
            # Closing the stream lets the client recover through polling.
            return
        if time.monotonic() >= heartbeat_at:
            yield ": keep-alive\n\n"
            heartbeat_at = time.monotonic() + STREAM_HEARTBEAT_SECONDS
        await asyncio.sleep(STREAM_POLL_SECONDS)


async def library_stream(request, store, scope=()):
    # Capture the tail before announcing connection: no historical replay, and
    # changes after this point cannot fall into a connect/subscribe race.
    try:
        cursor = await run_in_threadpool(store.library_change_sequence)
    except (sqlite3.Error, OSError, ValueError):
        return
    yield ": connected\n\n"
    heartbeat_at = time.monotonic() + STREAM_HEARTBEAT_SECONDS
    while not await request.is_disconnected():
        try:
            changes = await run_in_threadpool(store.library_changes, cursor)
        except (sqlite3.Error, OSError, ValueError):
            return
        for sequence, change in changes:
            cursor = sequence
            if (
                not scope
                or not change.get("event_name")
                or change["event_name"] in scope
            ):
                yield encode_event("changed", change)
        if time.monotonic() >= heartbeat_at:
            yield ": keep-alive\n\n"
            heartbeat_at = time.monotonic() + STREAM_HEARTBEAT_SECONDS
        await asyncio.sleep(STREAM_POLL_SECONDS)


def register_stream_routes(app, env):
    route = canonical_routes(app)

    @route("/generation-jobs/{job_id}/events")
    def generation_events(request: Request, job_id: str):
        return StreamingResponse(
            job_stream(request, app.state.store, job_id),
            media_type="text/event-stream",
            headers=STREAM_HEADERS,
        )

    @route("/generation-jobs/{job_id}/preview")
    def generation_preview(job_id: str):
        job = app.state.store.job(job_id)
        if job is None or not job.get("preview"):
            raise HTTPException(404, "Generation preview not found")
        path = app.state.store.root / "previews" / (job_id + ".png")
        if not path.is_file():
            raise HTTPException(404, "Generation preview file is missing")
        return local_file_response(
            path, media_type="image/png", headers={"Cache-Control": "private, no-store"}
        )

    @route("/images/library/events")
    def library_events(request: Request, event_name: str | None = None):
        if not enabled(env, "SHARED_LIBRARY_ENABLED"):
            raise HTTPException(403, "Shared library is disabled")
        return StreamingResponse(
            library_stream(
                request, app.state.store, app.state.deployment.scope(event_name)
            ),
            media_type="text/event-stream",
            headers=STREAM_HEADERS,
        )
