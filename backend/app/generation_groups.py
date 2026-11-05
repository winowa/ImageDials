"""Atomic bounded variation admission over the existing durable generation jobs."""

import copy
import hashlib
import json
from dataclasses import replace
from datetime import UTC, datetime
from uuid import uuid4

from fastapi import HTTPException

from .domain import Category
from .image_routing import ROUTE_GENERATION, editing_route
from .store import ACTIVE_JOB_PREDICATE

MAX_QUEUED_GENERATION_JOBS = 4
TERMINAL = {"complete", "failed"}


def generation_fingerprint(draft, providers, *, source_only=False):
    """Retain single-request retry identity; never persist provider credentials."""
    excluded = {
        field
        for field in ("additional_controls_metadata", "reference_images")
        if not getattr(draft, field)
    }
    if source_only:
        excluded.update({"idempotency_key", "variation_count", "retry_variations"})
    data = draft.model_dump_json(exclude=excluded)
    if providers.overridden:
        data += json.dumps(
            {
                name: providers.env.get(name, "")
                for name in (
                    "LLM_MODEL_ENDPOINT_1",
                    "LLM_MODEL_NAME",
                    "IMAGE_MODEL_ENDPOINT_1",
                    "IMAGE_PROVIDER",
                    "DESCRIPTION_MODEL_ENDPOINT",
                    "DESCRIPTION_MODEL_NAME",
                )
            },
            sort_keys=True,
        )
        route = editing_route(providers.renderer)
        if providers.env.get("IMAGE_EDIT_ROUTE") or route != ROUTE_GENERATION:
            # Appended only for an editing choice so earlier identities hold.
            data += json.dumps(
                {
                    "route": route,
                    "endpoint": providers.env.get("IMAGE_EDIT_MODEL_ENDPOINT", ""),
                },
                sort_keys=True,
            )
    return hashlib.sha256(data.encode()).hexdigest()


def initialize_generation_groups(database):
    database.execute(
        "CREATE TABLE IF NOT EXISTS generation_groups ("
        "id TEXT PRIMARY KEY,source_fingerprint TEXT NOT NULL,data TEXT NOT NULL)"
    )
    database.execute(
        "CREATE TABLE IF NOT EXISTS generation_group_requests ("
        "key TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,group_id TEXT NOT NULL,"
        "job_ids TEXT NOT NULL)"
    )


class GroupComposer:
    """One final prompt per group; enrichment still runs separately per result."""

    def __init__(self, original, prepared, save):
        self.original = original
        self.prepared = prepared
        self.save = save
        self.failure = None

    def __getattr__(self, name):
        return getattr(self.original, name)

    def compose(self, draft, categories):
        if self.failure:
            raise self.failure
        if self.prepared is None:
            try:
                prompt, metadata = self.original.compose(draft, categories)
                self.prepared = {
                    "prompt": prompt,
                    "metadata": metadata,
                    "categories": [category.model_dump() for category in categories],
                }
                self.save(self.prepared)
            except Exception as error:
                self.failure = error
                raise
        return self.prepared["prompt"], copy.deepcopy(self.prepared["metadata"])


class GroupControls:
    def __init__(self, original, prepared):
        self.original = original
        stored = prepared.get("categories") if prepared else None
        self.categories = (
            [Category.model_validate(row) for row in stored]
            if stored is not None
            else None
        )
        self.failure = None

    def __getattr__(self, name):
        return getattr(self.original, name)

    def controls(self, draft):
        if self.failure:
            raise self.failure
        if self.categories is None:
            try:
                self.categories = self.original.controls(draft)
            except Exception as error:
                self.failure = error
                raise
        return copy.deepcopy(self.categories)


class GenerationGroups:
    def __init__(self, store, pool, lock, run):
        self.store, self.pool, self.lock, self.run = store, pool, lock, run

    def raw(self, group_id):
        with self.store.connect() as database:
            row = database.execute(
                "SELECT data FROM generation_groups WHERE id=?", (group_id,)
            ).fetchone()
        if row is None:
            raise HTTPException(404, "Variation group not found")
        return json.loads(row[0])

    def lookup(self, group_id):
        group = self.raw(group_id)
        jobs = [self.store.job(slot["job_id"]) for slot in group["slots"]]
        if any(job is None for job in jobs):
            raise HTTPException(502, "Variation job records are unavailable")
        return group, jobs

    def save_prepared(self, group_id, prepared):
        with self.store.connect() as database:
            database.execute("BEGIN IMMEDIATE")
            row = database.execute(
                "SELECT data FROM generation_groups WHERE id=?", (group_id,)
            ).fetchone()
            group = json.loads(row[0])
            if group.get("prepared") is None:
                group["prepared"] = prepared
                database.execute(
                    "UPDATE generation_groups SET data=? WHERE id=?",
                    (json.dumps(group), group_id),
                )

    def execute(self, group, jobs, draft, providers):
        composer = GroupComposer(
            providers.composer,
            group.get("prepared"),
            lambda prepared: self.save_prepared(group["id"], prepared),
        )
        frozen = replace(
            providers,
            composer=composer,
            controls=GroupControls(providers.controls, group.get("prepared")),
        )
        for job in jobs:
            try:
                child = draft.model_copy(deep=True)
                child._variation = job["variation"]
                self.run(job.copy(), child, frozen)
            finally:
                self.store.finish_job(job["id"])

    @staticmethod
    def accepted(group, jobs):
        return {
            **jobs[0],
            "variation_group": {
                "id": group["id"],
                "count": group["count"],
                "jobs": [
                    {
                        "generation_job_id": job["id"],
                        "index": job["variation"]["index"],
                        "attempt": job["variation"]["attempt"],
                    }
                    for job in jobs
                ],
            },
        }

    def submit(self, draft, providers):
        fingerprint = generation_fingerprint(draft, providers)
        source = generation_fingerprint(draft, providers, source_only=True)
        tracked = []
        with self.lock, self.store.connect() as database:
            database.execute("BEGIN IMMEDIATE")
            previous = database.execute(
                "SELECT fingerprint,group_id,job_ids FROM generation_group_requests WHERE key=?",
                (draft.idempotency_key,),
            ).fetchone()
            if previous:
                if previous[0] != fingerprint:
                    raise HTTPException(409, "Idempotency key belongs to another draft")
                row = database.execute(
                    "SELECT data FROM generation_groups WHERE id=?", (previous[1],)
                ).fetchone()
                group = json.loads(row[0])
                jobs = [
                    json.loads(
                        database.execute(
                            "SELECT data FROM jobs WHERE id=?", (identity,)
                        ).fetchone()[0]
                    )
                    for identity in json.loads(previous[2])
                ]
                return self.accepted(group, jobs)
            if database.execute(
                "SELECT 1 FROM jobs WHERE key=?", (draft.idempotency_key,)
            ).fetchone():
                raise HTTPException(409, "Idempotency key belongs to another draft")
            retry = draft.retry_variations
            if retry:
                row = database.execute(
                    "SELECT source_fingerprint,data FROM generation_groups WHERE id=?",
                    (retry.group_id,),
                ).fetchone()
                if row is None:
                    raise HTTPException(404, "Variation group not found")
                if row[0] != source:
                    raise HTTPException(
                        409, "Retry must use the original variation draft"
                    )
                group = json.loads(row[1])
                indices = retry.indices
                for index in indices:
                    if index >= group["count"]:
                        raise HTTPException(400, "Variation index is outside the group")
                    slot = group["slots"][index]
                    job = json.loads(
                        database.execute(
                            "SELECT data FROM jobs WHERE id=?", (slot["job_id"],)
                        ).fetchone()[0]
                    )
                    if job["stage"] != "failed":
                        raise HTTPException(409, "Retry only failed variations")
            else:
                indices = list(range(draft.variation_count))
                group = {
                    "id": str(uuid4()),
                    "count": draft.variation_count,
                    "created_at": datetime.now(UTC).isoformat(),
                    "slots": [None] * draft.variation_count,
                    "prepared": None,
                }
            active = database.execute(
                "SELECT COUNT(*) FROM jobs WHERE " + ACTIVE_JOB_PREDICATE
            ).fetchone()[0]
            if active + len(indices) > MAX_QUEUED_GENERATION_JOBS:
                raise HTTPException(
                    429, "Generation queue lacks room for these variations"
                )
            jobs = []
            try:
                for ordinal, index in enumerate(indices):
                    old = group["slots"][index]
                    attempt = old["attempt"] + 1 if old else 0
                    variation = {
                        "group_id": group["id"],
                        "index": index,
                        "count": group["count"],
                        "attempt": attempt,
                    }
                    job = {
                        "id": str(uuid4()),
                        "revision": draft.revision,
                        "stage": "queued",
                        "result": None,
                        "error": None,
                        "categories": [],
                        "variation": variation,
                    }
                    key = (
                        draft.idempotency_key
                        if ordinal == 0
                        else "variation-"
                        + hashlib.sha256(
                            f"{draft.idempotency_key}:{index}:{attempt}".encode()
                        ).hexdigest()
                    )
                    database.execute(
                        "INSERT INTO jobs VALUES (?,?,?,?)",
                        (job["id"], key, fingerprint, json.dumps(job)),
                    )
                    self.store.record_job_update(database, job)
                    self.store.track_job(job["id"])
                    tracked.append(job["id"])
                    group["slots"][index] = {
                        "job_id": job["id"],
                        "attempt": attempt,
                    }
                    jobs.append(job)
                database.execute(
                    "INSERT INTO generation_groups VALUES (?,?,?) "
                    "ON CONFLICT(id) DO UPDATE SET data=excluded.data",
                    (group["id"], source, json.dumps(group)),
                )
                database.execute(
                    "INSERT INTO generation_group_requests VALUES (?,?,?,?)",
                    (
                        draft.idempotency_key,
                        fingerprint,
                        group["id"],
                        json.dumps(tracked),
                    ),
                )
                database.commit()
            except BaseException:
                for identity in tracked:
                    self.store.finish_job(identity)
                raise
            try:
                self.pool.submit(
                    self.execute, group, jobs, draft.model_copy(deep=True), providers
                )
            except Exception:
                for job in jobs:
                    job.update(stage="failed", error="Generation worker is unavailable")
                    self.store.update_job(job)
                    self.store.finish_job(job["id"])
            return self.accepted(group, jobs)
