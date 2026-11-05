"""Bounded catalog summaries and search projections, separate from originals."""

import json
import math
import re
from datetime import datetime
from urllib.parse import quote
from uuid import uuid4

from .files import atomic_write, sync_directory
from .library_counts import initialize_orientation_counts
from .library_search import (
    SEARCH_TABLES,
    initialize_search,
    remove_search,
    replace_search,
)
from .variation_types import MAX_VARIATION_COUNT
from .watermark_preview import compact_watermark_analysis

INDEX_VERSION = 3
MIGRATION_BATCH_SIZE = 128
SUMMARY_TEXT_CHARACTERS = 160
SUMMARY_TITLE_CHARACTERS = 512
SEARCH_MAX_DEPTH = 16
SEARCH_MAX_STRING_CHARACTERS = 20_000
SQUARE_TOLERANCE_RATIO = 0.05


def numeric_time(value):
    try:
        result = (
            datetime.fromisoformat(value).timestamp()
            if isinstance(value, str)
            else float(value or 0)
        )
        return result if math.isfinite(result) else 0
    except (ValueError, TypeError, OverflowError):
        return 0


def dimensions_of(snapshot):
    width, height = snapshot.get("width"), snapshot.get("height")
    dimensions = snapshot.get("dimensions")
    if not width or not height:
        if isinstance(dimensions, dict):
            width, height = dimensions.get("width"), dimensions.get("height")
        elif isinstance(dimensions, str):
            parts = dimensions.lower().split("x")
            if len(parts) == 2:
                width, height = parts
    try:
        width, height = int(width), int(height)
        return {"width": width, "height": height} if min(width, height) > 0 else None
    except (ValueError, TypeError, OverflowError):
        return None


def orientation_of(dimensions):
    if dimensions is None:
        return "unknown"
    width, height = dimensions["width"], dimensions["height"]
    if abs(width - height) <= max(width, height) * SQUARE_TOLERANCE_RATIO:
        return "square"
    return "landscape" if width > height else "portrait"


def readable_values(value, depth=0):
    if value is None:
        return
    if isinstance(value, str):
        if len(value) <= SEARCH_MAX_STRING_CHARACTERS and not value.startswith("data:"):
            yield value
    elif isinstance(value, bool):
        yield "true" if value else "false"
    elif isinstance(value, (int, float)):
        yield str(value)
    elif depth <= SEARCH_MAX_DEPTH and isinstance(value, (dict, list, tuple)):
        items = value.values() if isinstance(value, dict) else value
        for item in items:
            yield from readable_values(item, depth + 1)


def clipped(value, limit):
    return value[:limit] if isinstance(value, str) else None


def projection(snapshot):
    identity = snapshot["id"]
    dimensions = dimensions_of(snapshot)
    filename = identity + ".png"
    summary = {
        "id": identity,
        "image_id": identity,
        "storage_id": "local-0",
        "filename": filename,
        "sha256": snapshot.get("sha256"),
        "created_at": numeric_time(snapshot.get("created_at")),
        "title": clipped(snapshot.get("title"), SUMMARY_TITLE_CHARACTERS),
        "display_prompt": clipped(
            snapshot.get("original_prompt", snapshot.get("prompt")),
            SUMMARY_TEXT_CHARACTERS,
        ),
        "dimensions": dimensions,
        "orientation": orientation_of(dimensions),
        "event_id": snapshot.get("event_id"),
        "generation_mode": "trellis"
        if snapshot.get("mode") == "asset-image"
        else "standard",
        "thumbnail_url": "/api/images/library/file/local-0/"
        + quote(filename, safe="")
        + "?variant=thumbnail",
        "detail_url": "/api/images/library/record/" + quote(identity, safe=""),
        "has_watermark_analysis": isinstance(snapshot.get("print_watermark"), dict),
        "has_prepared_record": isinstance(snapshot.get("print_ready"), dict),
    }
    variation = snapshot.get("variation")
    if (
        isinstance(variation, dict)
        and isinstance(variation.get("group_id"), str)
        and 0 < len(variation["group_id"]) <= 100
        and type(variation.get("count")) is int
        and 1 <= variation["count"] <= MAX_VARIATION_COUNT
        and type(variation.get("index")) is int
        and 0 <= variation["index"] < variation["count"]
        and type(variation.get("attempt")) is int
        and variation["attempt"] >= 0
    ):
        summary["variation"] = {
            name: variation[name] for name in ("group_id", "count", "index", "attempt")
        }
    preview = compact_watermark_analysis(snapshot.get("print_watermark"))
    if preview is not None:
        summary["print_watermark"] = preview
    if snapshot.get("derivative_type") == "watermarked":
        summary["derivative_type"] = "watermarked"
    search_parts = [
        *readable_values(snapshot),
        summary["generation_mode"],
        "local-0",
        filename,
        "Image library",
        "local",
        *readable_values(snapshot.get("visibility", "shared")),
        "/api/images/" + quote(identity, safe="") + "/content",
    ]
    if snapshot.get("created_at") is not None:
        search_parts.append(str(int(summary["created_at"] * 1_000_000_000)))
    if dimensions:
        search_parts.append(f"{dimensions['width']}x{dimensions['height']}")
    return summary, "\n".join(search_parts).lower()


def write_projection(database, snapshot, search_available):
    summary, search_text = projection(snapshot)
    database.execute(
        "INSERT INTO library_catalog(id,created_at,event_id,orientation,visibility,summary) "
        "VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET "
        "created_at=excluded.created_at,event_id=excluded.event_id,"
        "orientation=excluded.orientation,visibility=excluded.visibility,"
        "summary=excluded.summary",
        (
            snapshot["id"],
            summary["created_at"],
            summary["event_id"],
            summary["orientation"],
            "private" if snapshot.get("visibility") == "private" else "shared",
            json.dumps(summary, ensure_ascii=False, separators=(",", ":")),
        ),
    )
    if search_available:
        rowid = database.execute(
            "SELECT rowid FROM library_catalog WHERE id=?", (snapshot["id"],)
        ).fetchone()[0]
        replace_search(database, rowid, search_text)


def remove_projection(database, identity, search_available):
    if search_available:
        remove_search(database, identity)
    database.execute("DELETE FROM library_catalog WHERE id=?", (identity,))


def with_stored_annotations(root, snapshot):
    """Only read sidecars inside the configured store; never follow an escape."""
    if root is None:
        return snapshot
    identity = snapshot["id"]
    if not isinstance(identity, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", identity):
        raise OSError("Invalid image identity in library index")
    directory = root / "derivatives" / identity
    try:
        if not directory.exists():
            return {**snapshot, "print_watermark": None, "print_ready": None}
        if not directory.resolve().is_relative_to(root.resolve()):
            raise OSError("Image metadata is outside its storage target")
        annotations = {}
        for field, name in (
            ("print_watermark", "analysis.json"),
            ("print_ready", "print-ready.json"),
        ):
            path = directory / name
            if not path.resolve().is_relative_to(root.resolve()):
                raise OSError("Image metadata is outside its storage target")
            try:
                annotations[field] = json.loads(path.read_text(encoding="utf-8"))
            except FileNotFoundError:
                annotations[field] = None
        return {**snapshot, **annotations}
    except (ValueError, UnicodeError, RuntimeError) as error:
        raise OSError("Stored watermark metadata is invalid") from error


def annotation_journal(root):
    directory = root / ".catalog-pending"
    if directory.is_symlink():
        raise OSError("Catalog journal must be a local directory")
    return directory


def begin_annotation_update(root, identity):
    if not isinstance(identity, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", identity):
        raise OSError("Invalid image identity in catalog journal")
    directory = annotation_journal(root)
    if not directory.exists():
        directory.mkdir()
        sync_directory(root)
    marker = directory / (str(uuid4()) + ".json")
    atomic_write(marker, json.dumps({"image_id": identity}).encode())
    return marker


def finish_annotation_update(marker):
    marker.unlink(missing_ok=True)
    sync_directory(marker.parent)


def recover_annotation_updates(database, root, search_available):
    directory = annotation_journal(root)
    if not directory.exists():
        return []
    markers = []
    for marker in directory.iterdir():
        if marker.is_symlink():
            raise OSError("Invalid catalog journal entry")
        if not marker.is_file():
            if not marker.exists():
                continue
            raise OSError("Invalid catalog journal entry")
        if marker.suffix == ".tmp":
            # A marker's partial atomic write precedes any sidecar mutation.
            markers.append(marker)
            continue
        try:
            entry = json.loads(marker.read_text(encoding="utf-8"))
            identity = entry["image_id"]
            if not isinstance(identity, str) or not re.fullmatch(
                r"[A-Za-z0-9_-]+", identity
            ):
                raise ValueError()
        except FileNotFoundError:
            # A worker which committed before our write lock may finish
            # removing its own marker concurrently with this startup.
            continue
        except (ValueError, KeyError, TypeError, UnicodeError) as error:
            raise OSError("Invalid catalog journal entry") from error
        row = database.execute(
            "SELECT data FROM images WHERE id=?", (identity,)
        ).fetchone()
        if row:
            write_projection(
                database,
                with_stored_annotations(root, json.loads(row[0])),
                search_available,
            )
        else:
            remove_projection(database, identity, search_available)
        markers.append(marker)
    return markers


def initialize_index(database, root=None):
    """An atomic, bounded-memory migration; interrupted migrations roll back."""
    previous = database.execute(
        "SELECT data FROM settings WHERE name='library-index-version'"
    ).fetchone()
    try:
        previous = json.loads(previous[0]) if previous else None
    except (ValueError, TypeError):
        previous = None
    if not isinstance(previous, dict):
        previous = None
    if previous is None or previous.get("version") != INDEX_VERSION:
        database.execute("DROP TABLE IF EXISTS library_catalog")
    database.execute(
        "CREATE TABLE IF NOT EXISTS library_catalog ("
        "id TEXT PRIMARY KEY,created_at REAL NOT NULL,event_id TEXT,"
        "orientation TEXT NOT NULL,visibility TEXT NOT NULL,summary TEXT NOT NULL)"
    )
    for name, columns in (
        ("library_catalog_order", "visibility,created_at DESC,id DESC"),
        ("library_catalog_identity", "visibility,id,event_id,orientation"),
        ("library_catalog_event", "visibility,event_id,created_at DESC,id DESC"),
        (
            "library_catalog_event_shape",
            "visibility,event_id,orientation,created_at DESC,id DESC",
        ),
        ("library_catalog_shape", "visibility,orientation,created_at DESC,id DESC"),
    ):
        database.execute(
            f"CREATE INDEX IF NOT EXISTS {name} ON library_catalog({columns})"
        )
    search_available = initialize_search(
        database, previous is None or previous.get("version") != INDEX_VERSION
    )
    version = {"version": INDEX_VERSION, "search": search_available}
    if previous != version:
        database.execute("DELETE FROM library_catalog")
        if search_available:
            for table in SEARCH_TABLES:
                database.execute(f"DELETE FROM {table}")
        cursor = database.execute("SELECT data FROM images ORDER BY rowid")
        while batch := cursor.fetchmany(MIGRATION_BATCH_SIZE):
            for (raw,) in batch:
                write_projection(
                    database,
                    with_stored_annotations(root, json.loads(raw)),
                    search_available,
                )
        database.execute(
            "INSERT INTO settings(name,data) VALUES ('library-index-version',?) "
            "ON CONFLICT(name) DO UPDATE SET data=excluded.data",
            (json.dumps(version),),
        )
    initialize_orientation_counts(database, rebuild=previous != version)
    return search_available
