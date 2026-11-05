"""Canonical saved-image listing, identity validation and original/thumbnail reads."""

import hashlib
import json
import re
import sqlite3
from contextlib import contextmanager

from fastapi import HTTPException, Request
from fastapi.responses import Response
from PIL import UnidentifiedImageError

from .gallery_sessions import register_gallery_sessions
from .library_facets import register_library_facets
from .library_pages import register_library_pages
from .responses import local_file_response
from .routing import canonical_routes
from .thumbnails import (
    THUMBNAIL_DEFAULT_PIXELS,
    THUMBNAIL_MAX_PIXELS,
    THUMBNAIL_MIN_PIXELS,
    ThumbnailCache,
    thumbnail_key,
)
from .watermark_settings import watermark_settings
from .wire import enabled

FILE_CACHE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60
LIBRARY_CACHE_CONTROL = "private, max-age=0, must-revalidate"


def library_snapshots(store):
    return [
        snapshot
        for snapshot in store.images()
        if snapshot.get("visibility") != "private"
    ]


def identify_source(store, storage_id, filename, *, require_file=True):
    if storage_id != "local-0":
        raise HTTPException(404, "Storage target not found")
    if not isinstance(filename, str) or not re.fullmatch(
        r"[A-Za-z0-9_-]+\.png", filename
    ):
        raise HTTPException(400, "Invalid image filename")
    snapshot = store.image(filename[:-4])
    if snapshot is None or snapshot.get("visibility") == "private":
        raise HTTPException(404, "Image not found")
    path = store.root / filename
    if path.is_symlink() or not path.resolve().is_relative_to(store.root.resolve()):
        raise HTTPException(400, "Image file is outside its storage target")
    if require_file and not path.is_file():
        raise HTTPException(404, "Image file is missing")
    return snapshot, path


def register_library_routes(app, env):
    shared_enabled = enabled(env, "SHARED_LIBRARY_ENABLED")
    thumbnails = ThumbnailCache(env)
    app.state.thumbnail_cache = thumbnails

    @contextmanager
    def available_store():
        if not shared_enabled:
            raise HTTPException(403, "Shared library is disabled")
        try:
            yield app.state.store
        except (sqlite3.Error, OSError, ValueError) as exc:
            raise HTTPException(502, "Image storage is unavailable") from exc

    route = canonical_routes(app)
    register_library_pages(app, available_store)
    register_library_facets(app, available_store)
    register_gallery_sessions(app, available_store)

    @route("/images/library")
    def list_library(request: Request, event_name: str | None = None):
        scope = app.state.deployment.scope(event_name)
        with available_store() as store:
            snapshots = [
                snapshot
                for snapshot in library_snapshots(store)
                if not scope or snapshot.get("event_id") in scope
            ]
            records = [app.state.watermarks.record(snapshot) for snapshot in snapshots]
            records.sort(
                key=lambda r: (r.get("created_at") or 0, r["filename"]), reverse=True
            )
            body = {
                "images": records,
                "count": len(records),
                "watermark_settings": watermark_settings(store),
                "watermark_backfill": store.setting("watermark-backfill", None),
            }
            encoded = json.dumps(
                body, sort_keys=True, ensure_ascii=False, separators=(",", ":")
            ).encode()
            etag = '"' + hashlib.sha256(encoded).hexdigest() + '"'
            headers = {"ETag": etag, "Cache-Control": LIBRARY_CACHE_CONTROL}
            if request.headers.get("if-none-match") == etag:
                return Response(status_code=304, headers=headers)
            return Response(
                content=encoded, media_type="application/json", headers=headers
            )

    @route("/images/library/file/{storage_id}/{filename}")
    def library_file(
        request: Request,
        storage_id: str,
        filename: str,
        variant: str | None = None,
        max_size: str = str(THUMBNAIL_DEFAULT_PIXELS),
    ):
        with available_store() as store:
            snapshot, path = identify_source(store, storage_id, filename)
            headers = {"Cache-Control": f"public, max-age={FILE_CACHE_MAX_AGE_SECONDS}"}
            if variant != "thumbnail":
                return local_file_response(
                    path, media_type="image/png", headers=headers
                )
            try:
                maximum = int(max_size)
            except ValueError:
                maximum = THUMBNAIL_DEFAULT_PIXELS
            maximum = min(THUMBNAIL_MAX_PIXELS, max(THUMBNAIL_MIN_PIXELS, maximum))
            try:
                key = thumbnail_key(snapshot, path, maximum)
                headers["ETag"] = '"' + key + '"'
                if request.headers.get("if-none-match") == headers["ETag"]:
                    return Response(status_code=304, headers=headers)
                data = thumbnails.get(store, snapshot, path, maximum, key)
                return Response(content=data, media_type="image/jpeg", headers=headers)
            except (UnidentifiedImageError, ValueError, OSError):
                return local_file_response(
                    path, media_type="image/png", headers=headers
                )

    @route("/images/library", ("DELETE",))
    async def delete_library_image(request: Request):
        try:
            body = await request.json()
            storage_id, filename = body.get("storage_id"), body.get("filename")
            if (
                not isinstance(storage_id, str)
                or not storage_id
                or not isinstance(filename, str)
                or not filename
            ):
                raise ValueError("Provide a storage ID and filename")
        except (ValueError, AttributeError) as exc:
            raise HTTPException(400, "Provide a storage ID and filename") from exc
        with available_store() as store:
            # A missing original must not leave a listed record that returns
            # 404 to Delete and reappears at the next refresh. The journal can
            # remove the remaining catalog/derivative assets without that file.
            snapshot, _ = identify_source(
                store, storage_id, filename, require_file=False
            )
            store.delete(snapshot["id"])
        return {"deleted": True, "storage_id": storage_id, "filename": filename}
