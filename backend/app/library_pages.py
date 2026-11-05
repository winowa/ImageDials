"""Indexed keyset browsing and direct detail reads without catalog hydration."""

import base64
import binascii
import hashlib
import json
import math

from fastapi import HTTPException, Request
from fastapi.responses import Response

from .library_counts import OrientationCountsCache, orientation_count_rows
from .library_index import INDEX_VERSION
from .library_search import search_conditions
from .routing import canonical_routes, image_content_url
from .watermark_preview import summary_watermark_preview

PAGE_DEFAULT_RECORDS = 48
PAGE_MAX_RECORDS = 96
QUERY_MAX_CHARACTERS = 200
QUERY_MAX_TERMS = 20
CURSOR_MAX_CHARACTERS = 2048
CURSOR_VERSION = 1
PAGE_RESPONSE_VERSION = 4
BACKFILL_STATUS_ERROR_MAX_CHARACTERS = 512
CACHE_CONTROL = "private, max-age=0, must-revalidate"
ORIENTATIONS = {"landscape", "portrait", "square", "unknown"}
PAGE_ORDERS = {"newest": ("DESC", "<"), "oldest": ("ASC", ">")}
BACKFILL_STATUS_FIELDS = (
    "id",
    "status",
    "completion_scope",
    "queued_count",
    "completed_count",
    "failed_count",
    "force",
    "phase",
    "candidate_count",
    "count_pending",
    "omitted_error_count",
    "error",
)


def encoded_json(value):
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode()


def fingerprint(value):
    return hashlib.sha256(encoded_json(value)).hexdigest()


def summary_record(raw, *, storage_root=None):
    """Add serving URLs without rebuilding a durable search projection."""
    record = json.loads(raw)
    return {
        **record,
        "image_url": image_content_url(record["id"]),
        **summary_watermark_preview(record, storage_root),
    }


def backfill_status(database):
    """Read bounded global progress; never return an unbounded per-image error list."""
    fields = ",".join(
        f"json_extract(data,'$.{field}')" for field in BACKFILL_STATUS_FIELDS
    )
    row = database.execute(
        f"SELECT {fields},json_extract(data,'$.errors[0].image_id'),"
        "json_extract(data,'$.errors[0].error') FROM settings WHERE name='watermark-backfill'"
    ).fetchone()
    if row is None:
        return None
    result = dict(
        zip(BACKFILL_STATUS_FIELDS, row[: len(BACKFILL_STATUS_FIELDS)], strict=True)
    )
    result["force"] = bool(result["force"])
    if result["count_pending"] is not None:
        result["count_pending"] = bool(result["count_pending"])
    if isinstance(result["error"], str):
        result["error"] = result["error"][:BACKFILL_STATUS_ERROR_MAX_CHARACTERS]
    sample_id, sample_error = row[-2:]
    if isinstance(sample_id, str) and isinstance(sample_error, str):
        result["error_sample"] = {
            "image_id": sample_id[:QUERY_MAX_CHARACTERS],
            "error": sample_error[:BACKFILL_STATUS_ERROR_MAX_CHARACTERS],
        }
    return result


def encode_cursor(value):
    return base64.urlsafe_b64encode(encoded_json(value)).decode().rstrip("=")


def decode_cursor(value, signature):
    try:
        if len(value) > CURSOR_MAX_CHARACTERS:
            raise ValueError()
        raw = base64.b64decode(
            value + "=" * (-len(value) % 4), altchars=b"-_", validate=True
        )
        data = json.loads(raw)
        if (
            not isinstance(data, dict)
            or type(data.get("v")) is not int
            or data.get("v") != CURSOR_VERSION
            or not isinstance(data.get("query"), str)
            or type(data.get("revision")) is not int
            or type(data.get("time")) not in (int, float)
            or not math.isfinite(data["time"])
            or not isinstance(data.get("id"), str)
            or not 1 <= len(data["id"]) <= QUERY_MAX_CHARACTERS
            or type(data.get("index_version", INDEX_VERSION)) is not int
            or data.get("direction", "forward") not in {"forward", "backward"}
            or type(data.get("inclusive", False)) is not bool
            or (
                data.get("position") is not None
                and (type(data["position"]) is not int or data["position"] < 0)
            )
        ):
            raise ValueError()
    except (
        ValueError,
        TypeError,
        UnicodeError,
        binascii.Error,
        OverflowError,
        RecursionError,
    ) as error:
        raise HTTPException(400, "Invalid library cursor for this query") from error
    if data.get("index_version", INDEX_VERSION) != INDEX_VERSION:
        raise HTTPException(
            409, "Library projection changed; refresh this query from its first page"
        )
    if data["query"] != signature:
        raise HTTPException(400, "Invalid library cursor for this query")
    return data


def page_cursor(row, *, signature, revision, direction, position, inclusive=False):
    """Opaque keyset boundary; no client-side catalog or cursor history required."""
    return encode_cursor(
        {
            "v": CURSOR_VERSION,
            "index_version": INDEX_VERSION,
            "query": signature,
            "revision": revision,
            "time": row[1],
            "id": row[2],
            "direction": direction,
            "position": position,
            "inclusive": inclusive,
        }
    )


def has_neighbor(database, conditions, parameters, row, comparator):
    return (
        database.execute(
            f"SELECT 1 FROM library_catalog WHERE {conditions} "
            f"AND (created_at,id){comparator}(?,?) LIMIT 1",
            [*parameters, row[1], row[2]],
        ).fetchone()
        is not None
    )


def window_rows(
    database, conditions, parameters, order, limit, boundary=None, comparator=None
):
    if boundary is not None:
        conditions += f" AND (created_at,id){comparator}(?,?)"
        parameters = [*parameters, boundary[1], boundary[2]]
    return database.execute(
        f"SELECT summary,created_at,id FROM library_catalog WHERE {conditions} "
        f"ORDER BY created_at {order},id {order} LIMIT ?",
        [*parameters, limit],
    ).fetchall()


def around_window(database, conditions, parameters, identity, order, comparator, limit):
    target = database.execute(
        f"SELECT summary,created_at,id FROM library_catalog WHERE {conditions} AND id=?",
        [*parameters, identity],
    ).fetchone()
    if target is None:
        raise HTTPException(404, "Image is not in this library query")
    reverse_order = "ASC" if order == "DESC" else "DESC"
    reverse_comparator = ">" if comparator == "<" else "<"
    before = window_rows(
        database,
        conditions,
        parameters,
        reverse_order,
        limit // 2,
        target,
        reverse_comparator,
    )
    after = window_rows(
        database,
        conditions,
        parameters,
        order,
        limit - len(before) - 1,
        target,
        comparator,
    )
    missing = limit - len(before) - len(after) - 1
    if missing:
        before += window_rows(
            database,
            conditions,
            parameters,
            reverse_order,
            missing,
            before[-1] if before else target,
            reverse_comparator,
        )
    return [*reversed(before), target, *after], len(before)


def query_conditions(scope, terms, search_available):
    clauses, parameters = ["visibility='shared'"], []
    if scope:
        clauses.append("event_id IN (" + ",".join("?" for _ in scope) + ")")
        parameters.extend(scope)
    if terms and not search_available:
        raise HTTPException(503, "Indexed search requires SQLite FTS5 trigram support")
    search_clauses, search_parameters = search_conditions(terms)
    clauses.extend(search_clauses)
    parameters.extend(search_parameters)
    return " AND ".join(clauses), parameters


def register_library_pages(app, available_store):
    route = canonical_routes(app)
    count_cache = OrientationCountsCache()

    @route("/images/library/page")
    def library_page(
        request: Request,
        limit: int = PAGE_DEFAULT_RECORDS,
        cursor: str | None = None,
        q: str = "",
        orientation: str | None = None,
        event_name: str | None = None,
        order: str = "newest",
        around: str | None = None,
        edge: str | None = None,
    ):
        if not 1 <= limit <= PAGE_MAX_RECORDS:
            raise HTTPException(400, "Library page limit must be between 1 and 96")
        if (
            "\x00" in q
            or len(q) > QUERY_MAX_CHARACTERS
            or len(q.split()) > QUERY_MAX_TERMS
        ):
            raise HTTPException(400, "Library search is too long")
        if orientation is not None and orientation not in ORIENTATIONS:
            raise HTTPException(400, "Unknown library orientation")
        if order not in PAGE_ORDERS:
            raise HTTPException(400, "Unknown library order")
        if edge not in {None, "first", "last"}:
            raise HTTPException(400, "Unknown library edge")
        if (
            sum(value is not None for value in (cursor, around, edge)) > 1
            or (cursor is not None and not cursor)
            or (
                around is not None
                and (not 1 <= len(around) <= QUERY_MAX_CHARACTERS or "\x00" in around)
            )
        ):
            raise HTTPException(400, "Use one valid cursor, image anchor or edge")
        sql_order, comparator = PAGE_ORDERS[order]
        scope = app.state.deployment.scope(event_name)
        terms = sorted(set(q.lower().split()))
        signature = fingerprint(
            {
                "scope": sorted(scope),
                "terms": terms,
                "orientation": orientation,
                "limit": limit,
                "index_version": INDEX_VERSION,
                "order": order,
            }
        )
        with available_store() as store, store.connect() as database:
            database.execute("BEGIN")
            revision = database.execute(
                "SELECT COALESCE(MAX(sequence),0) FROM library_changes"
            ).fetchone()[0]
            anchor = decode_cursor(cursor, signature) if cursor else None
            backward = anchor is not None and anchor.get("direction") == "backward"
            position = (
                0
                if anchor is None
                else anchor.get("position")
                if anchor["revision"] == revision
                else None
            )
            etag = (
                '"'
                + fingerprint(
                    {
                        "format": PAGE_RESPONSE_VERSION,
                        "query": signature,
                        "cursor": cursor,
                        "around": around,
                        "edge": edge,
                        "revision": revision,
                    }
                )
                + '"'
            )
            headers = {"ETag": etag, "Cache-Control": CACHE_CONTROL}
            if request.headers.get("if-none-match") == etag:
                return Response(status_code=304, headers=headers)
            conditions, parameters = query_conditions(
                scope, terms, store.library_search_available
            )
            counts_key = (tuple(sorted(scope)), tuple(terms), revision)
            orientation_counts = count_cache.get(counts_key)
            if orientation_counts is None:
                orientation_counts = {key: 0 for key in sorted(ORIENTATIONS)}
                rows = (
                    database.execute(
                        f"SELECT orientation,COUNT(*) FROM library_catalog WHERE {conditions} GROUP BY orientation",
                        parameters,
                    )
                    if terms
                    else orientation_count_rows(database, scope)
                )
                for shape, count in rows:
                    orientation_counts[shape] = count
                count_cache.put(counts_key, orientation_counts)
            total = (
                orientation_counts[orientation]
                if orientation
                else sum(orientation_counts.values())
            )
            if orientation:
                conditions += " AND orientation=?"
                parameters.append(orientation)
            base_conditions, base_parameters = conditions, list(parameters)
            reverse_comparator = ">" if comparator == "<" else "<"
            scan_order = (
                ("ASC" if sql_order == "DESC" else "DESC") if backward else sql_order
            )
            if anchor:
                boundary_comparator = reverse_comparator if backward else comparator
                if anchor.get("inclusive", False):
                    boundary_comparator += "="
                conditions += f" AND (created_at,id){boundary_comparator}(?,?)"
                parameters.extend((anchor["time"], anchor["id"]))
            # Counts come from this same revision/snapshot. An empty result
            # needs no ordered catalog scan, even if SQLite chooses an ordering
            # index before checking an empty search-posting set.
            anchor_index = None
            if around is not None:
                selected, anchor_index = around_window(
                    database,
                    base_conditions,
                    base_parameters,
                    around,
                    sql_order,
                    comparator,
                    limit,
                )
                position = (
                    None
                    if has_neighbor(
                        database,
                        base_conditions,
                        base_parameters,
                        selected[0],
                        reverse_comparator,
                    )
                    else 0
                )
            elif edge == "last":
                selected = (
                    window_rows(
                        database,
                        base_conditions,
                        base_parameters,
                        "ASC" if sql_order == "DESC" else "DESC",
                        limit,
                    )
                    if total
                    else []
                )
                selected.reverse()
                position = max(0, total - len(selected))
            else:
                selected = (
                    window_rows(database, conditions, parameters, scan_order, limit)
                    if total
                    else []
                )
                if backward:
                    selected.reverse()
            next_cursor = previous_cursor = None
            if selected:
                before = (
                    position > 0
                    if position is not None
                    else has_neighbor(
                        database,
                        base_conditions,
                        base_parameters,
                        selected[0],
                        reverse_comparator,
                    )
                )
                after = (
                    position + len(selected) < total
                    if position is not None
                    else has_neighbor(
                        database,
                        base_conditions,
                        base_parameters,
                        selected[-1],
                        comparator,
                    )
                )
                if before:
                    previous_cursor = page_cursor(
                        selected[0],
                        signature=signature,
                        revision=revision,
                        direction="backward",
                        position=max(0, position - limit)
                        if position is not None
                        else None,
                    )
                if after:
                    next_cursor = page_cursor(
                        selected[-1],
                        signature=signature,
                        revision=revision,
                        direction="forward",
                        position=position + len(selected)
                        if position is not None
                        else None,
                    )
            elif anchor and total:
                # A concurrent deletion can empty the range after an old
                # boundary. Let the caller return toward the remaining rows,
                # including that boundary if it is still present.
                opposite = page_cursor(
                    (None, anchor["time"], anchor["id"]),
                    signature=signature,
                    revision=revision,
                    direction="forward" if backward else "backward",
                    position=None,
                    inclusive=True,
                )
                if backward:
                    next_cursor = opposite
                else:
                    previous_cursor = opposite
            return Response(
                content=encoded_json(
                    {
                        "images": [
                            summary_record(row[0], storage_root=store.root)
                            for row in selected
                        ],
                        "count": len(selected),
                        "total": total,
                        "orientation_counts": orientation_counts,
                        "next_cursor": next_cursor,
                        "previous_cursor": previous_cursor,
                        "position": position,
                        "anchor_index": anchor_index,
                        "revision": revision,
                        "listing_kind": "summary-page",
                        "order": order,
                        **(
                            {"watermark_backfill": backfill_status(database)}
                            if cursor is None
                            else {}
                        ),
                    }
                ),
                media_type="application/json",
                headers=headers,
            )

    @route("/images/library/watermarks/status")
    def library_watermark_status(request: Request):
        with available_store() as store, store.connect() as database:
            body = {"watermark_backfill": backfill_status(database)}
            etag = '"' + fingerprint(body) + '"'
            headers = {"ETag": etag, "Cache-Control": CACHE_CONTROL}
            if request.headers.get("if-none-match") == etag:
                return Response(status_code=304, headers=headers)
            return Response(
                content=encoded_json(body),
                media_type="application/json",
                headers=headers,
            )

    @route("/images/library/record/{image_id}")
    def library_detail(request: Request, image_id: str, event_name: str | None = None):
        scope = app.state.deployment.scope(event_name)
        with available_store() as store:
            snapshot = store.image(image_id)
            if (
                snapshot is None
                or snapshot.get("visibility") == "private"
                or (scope and snapshot.get("event_id") not in scope)
            ):
                raise HTTPException(404, "Image not found")
            # Only this selected record needs full provenance/sidecar decoration.
            body = app.state.watermarks.record(snapshot)
            etag = '"' + fingerprint(body) + '"'
            headers = {"ETag": etag, "Cache-Control": CACHE_CONTROL}
            if request.headers.get("if-none-match") == etag:
                return Response(status_code=304, headers=headers)
            return Response(
                content=encoded_json(body),
                media_type="application/json",
                headers=headers,
            )
