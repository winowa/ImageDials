"""Bounded event choices and counts without hydrating image records."""

import base64
import binascii
import json
import unicodedata

from fastapi import HTTPException, Request
from fastapi.responses import Response

from .library_counts import EVENT_NAME_ORDER_INDEX, orientation_count_rows
from .library_pages import (
    CACHE_CONTROL,
    CURSOR_MAX_CHARACTERS,
    encoded_json,
    fingerprint,
)
from .library_pages import (
    ORIENTATIONS as LIBRARY_ORIENTATIONS,
)
from .profile import MAX_EVENT_NAME_CHARACTERS, event_name
from .routing import canonical_routes

DEFAULT_EVENT_PAGE_SIZE = 100
MAX_EVENT_PAGE_SIZE = 200
EVENT_FACET_VERSION = 1
ORIENTATIONS = tuple(sorted(LIBRARY_ORIENTATIONS))


def folded_name(value):
    return unicodedata.normalize("NFC", value).casefold()


def selectable_name(value):
    """Do not advertise legacy names that the scope validator cannot select."""
    return (
        isinstance(value, str)
        and 1 <= len(value) <= MAX_EVENT_NAME_CHARACTERS
        and value.strip() == value
    )


def facet_cursor(name, signature):
    payload = encoded_json(
        {"version": EVENT_FACET_VERSION, "query": signature, "after": name}
    )
    return base64.urlsafe_b64encode(payload).decode().rstrip("=")


def read_facet_cursor(value, signature):
    try:
        if not value or len(value) > CURSOR_MAX_CHARACTERS:
            raise ValueError()
        payload = json.loads(
            base64.b64decode(
                value + "=" * (-len(value) % 4), altchars=b"-_", validate=True
            )
        )
        if (
            not isinstance(payload, dict)
            or set(payload) != {"version", "query", "after"}
            or type(payload["version"]) is not int
            or payload["version"] != EVENT_FACET_VERSION
            or payload["query"] != signature
            or not selectable_name(payload["after"])
            or event_name(payload["after"]) != payload["after"]
        ):
            raise ValueError()
        return payload["after"]
    except (ValueError, TypeError, UnicodeError, binascii.Error):
        raise HTTPException(400, "Invalid event-page cursor for this query") from None


def event_choices(database, scope, search, after, limit):
    """Return at most one page plus a lookahead, using metadata buckets only."""
    if scope:
        names = sorted(
            name
            for name in scope
            if (after is None or name > after) and search in folded_name(name)
        )[: limit + 1]
        if not names:
            return []
        choices = {
            name: {
                "name": name,
                "count": 0,
                "orientation_counts": dict.fromkeys(ORIENTATIONS, 0),
            }
            for name in names
        }
        rows = database.execute(
            "SELECT json_extract(event_key,'$'),orientation,image_count "
            "FROM library_orientation_counts WHERE visibility='shared' "
            "AND scope_kind='event' AND event_key IN ("
            + ",".join("json_quote(?)" for _ in names)
            + ")",
            names,
        )
        for name, orientation, count in rows:
            choices[name]["count"] += count
            choices[name]["orientation_counts"][orientation] = count
        return list(choices.values())

    # Built-in JSON extraction is indexed. The bounded validation/search
    # functions inspect event names only, never image JSON or source pixels.
    database.create_function("selectable_event", 1, selectable_name, deterministic=True)
    database.create_function(
        "fold_event",
        1,
        lambda name: folded_name(name) if isinstance(name, str) else "",
        deterministic=True,
    )
    conditions = [
        "visibility='shared'",
        "scope_kind='event'",
        "selectable_event(json_extract(event_key,'$'))",
    ]
    parameters = []
    if after is not None:
        conditions.append("json_extract(event_key,'$')>?")
        parameters.append(after)
    if search:
        conditions.append("instr(fold_event(json_extract(event_key,'$')),?)>0")
        parameters.append(search)
    parameters.append(limit + 1)
    shape_sums = ",".join(
        f"SUM(CASE WHEN orientation='{shape}' THEN image_count ELSE 0 END)"
        for shape in ORIENTATIONS
    )
    rows = database.execute(
        "SELECT json_extract(event_key,'$'),SUM(image_count),"
        + shape_sums
        + " FROM library_orientation_counts INDEXED BY "
        + EVENT_NAME_ORDER_INDEX
        + " WHERE "
        + " AND ".join(conditions)
        + " GROUP BY json_extract(event_key,'$') ORDER BY json_extract(event_key,'$') LIMIT ?",
        parameters,
    )
    return [
        {
            "name": row[0],
            "count": row[1],
            "orientation_counts": dict(zip(ORIENTATIONS, row[2:], strict=True)),
        }
        for row in rows
    ]


def register_library_facets(app, available_store):
    route = canonical_routes(app)

    @route("/images/library/event-facets")
    def library_event_facets(
        request: Request,
        limit: int = DEFAULT_EVENT_PAGE_SIZE,
        cursor: str | None = None,
        q: str = "",
        event_name: str | None = None,
    ):
        if not 1 <= limit <= MAX_EVENT_PAGE_SIZE:
            raise HTTPException(400, "Event page limit must be between 1 and 200")
        if len(q) > MAX_EVENT_NAME_CHARACTERS or "\x00" in q:
            raise HTTPException(400, "Event search is too long or invalid")
        search = folded_name(q.strip())
        scope = app.state.deployment.scope(event_name)
        signature = fingerprint({"scope": sorted(scope), "q": search, "limit": limit})
        after = read_facet_cursor(cursor, signature) if cursor is not None else None
        with available_store() as store, store.connect() as database:
            database.execute("BEGIN")
            revision = database.execute(
                "SELECT COALESCE(MAX(sequence),0) FROM library_changes"
            ).fetchone()[0]
            etag = (
                '"'
                + fingerprint(
                    {
                        "format": EVENT_FACET_VERSION,
                        "query": signature,
                        "cursor": cursor,
                        "revision": revision,
                    }
                )
                + '"'
            )
            headers = {"ETag": etag, "Cache-Control": CACHE_CONTROL}
            if request.headers.get("if-none-match") == etag:
                return Response(status_code=304, headers=headers)
            choices = event_choices(database, scope, search, after, limit)
            selected = choices[:limit]
            counts = dict.fromkeys(ORIENTATIONS, 0)
            counts.update(orientation_count_rows(database, scope))
            return Response(
                content=encoded_json(
                    {
                        "events": selected,
                        "count": len(selected),
                        "next_cursor": facet_cursor(selected[-1]["name"], signature)
                        if len(choices) > limit
                        else None,
                        "revision": revision,
                        "configured": bool(scope),
                        "orientation_counts": counts,
                        "total_images": sum(counts.values()),
                    }
                ),
                media_type="application/json",
                headers=headers,
            )
