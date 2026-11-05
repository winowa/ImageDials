"""Shared settings, deterministic analysis and explicit print-ready transport."""

import json
import sqlite3

from fastapi import HTTPException, Request, Response
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile

from .imports import UploadBodyLimits, read_image_upload
from .library import FILE_CACHE_MAX_AGE_SECONDS, identify_source
from .media import (
    DEFAULT_IMPORT_MAX_BYTES,
    MAX_PNG_METADATA_BYTES,
    MULTIPART_OVERHEAD_BYTES,
    PREPARED_FILE_MAX_BYTES,
    PREPARED_REQUEST_MAX_BYTES,
    positive_integer,
)
from .responses import local_file_response
from .routing import canonical_paths, canonical_routes
from .watermark_batches import (
    BATCH_REQUEST_MAX_BYTES,
    BackfillActiveError,
    BackfillLimitError,
    BatchWorkerUnavailable,
)
from .watermark_metadata import watermarked_download_png
from .watermark_settings import MAX_SETTINGS_JSON_BYTES
from .watermarks import StaleWatermarkError
from .wire import enabled


def register_watermark_routes(app, env):
    route = canonical_routes(app)
    analysis_max_bytes = positive_integer(
        env, "WATERMARK_ANALYSIS_MAX_BYTES", DEFAULT_IMPORT_MAX_BYTES
    )
    upload_limits = {
        path: PREPARED_REQUEST_MAX_BYTES
        for path in canonical_paths(app, "/images/library/print-ready")
    }
    upload_limits.update(
        {
            path: analysis_max_bytes + MULTIPART_OVERHEAD_BYTES
            for path in canonical_paths(app, "/watermark/analyze-image")
        }
    )
    upload_limits.update(
        {
            path: BATCH_REQUEST_MAX_BYTES
            for path in canonical_paths(app, "/images/library/watermarks/backfill")
        }
    )
    upload_limits.update(
        {
            path: PREPARED_REQUEST_MAX_BYTES
            for path in canonical_paths(app, "/watermark/embed-metadata")
        }
    )
    app.add_middleware(
        UploadBodyLimits,
        limits=upload_limits,
    )

    @route("/watermark/embed-metadata", ("POST",))
    async def embed_metadata(request: Request):
        async with request.form(
            max_files=1, max_fields=1, max_part_size=PREPARED_REQUEST_MAX_BYTES
        ) as form:
            upload, raw = form.get("file"), form.get("metadata")
            if not isinstance(upload, UploadFile) or not isinstance(raw, str):
                raise HTTPException(
                    400, "Provide the rendered PNG and derivative metadata"
                )
            if len(raw.encode()) > MAX_PNG_METADATA_BYTES:
                raise HTTPException(413, "Derivative metadata exceeds the byte limit")
            data = await upload.read(PREPARED_FILE_MAX_BYTES + 1)
            if len(data) > PREPARED_FILE_MAX_BYTES:
                raise HTTPException(422, "Prepared PNG exceeds the file byte limit")
            try:
                metadata = json.loads(raw)
            except ValueError as exc:
                raise HTTPException(
                    400, "Provide valid derivative metadata JSON"
                ) from exc
            try:
                result = await run_in_threadpool(
                    watermarked_download_png,
                    data,
                    metadata,
                    app.state.store.max_image_pixels,
                )
            except StaleWatermarkError as exc:
                raise HTTPException(409, str(exc)) from exc
            except (ValueError, TypeError) as exc:
                raise HTTPException(422, str(exc)) from exc
            return Response(
                result,
                media_type="image/png",
                headers={
                    "Cache-Control": "no-store",
                    "Content-Disposition": 'attachment; filename="watermarked.png"',
                },
            )

    @route("/watermark/analyze-image", ("POST",))
    async def analyze_uploaded_image(request: Request, force: bool = False):
        data, fields = await read_image_upload(
            request,
            analysis_max_bytes,
            text_fields=("watermark_settings", "previous_analysis"),
        )
        try:
            raw_settings = fields["watermark_settings"]
            settings = None
            if raw_settings is not None:
                if (
                    not isinstance(raw_settings, str)
                    or len(raw_settings.encode()) > MAX_SETTINGS_JSON_BYTES
                ):
                    raise ValueError("Browser watermark settings exceed the size limit")
                settings = json.loads(raw_settings)
                if not isinstance(settings, dict):
                    raise ValueError(
                        "Provide browser watermark settings as a JSON object"
                    )
            raw_previous = fields.get("previous_analysis")
            if raw_previous is not None and (
                not isinstance(raw_previous, str)
                or len(raw_previous.encode()) > MAX_SETTINGS_JSON_BYTES
            ):
                raise ValueError("Previous analysis exceeds the size limit")
            previous = json.loads(raw_previous) if raw_previous else None
            return await run_in_threadpool(
                app.state.watermarks.analyze_upload,
                data,
                force=force,
                settings_override=settings,
                previous_analysis=previous,
            )
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        except (OSError, sqlite3.Error) as exc:
            raise HTTPException(
                502, "Watermark settings storage is unavailable"
            ) from exc

    def shared_source(storage_id, filename):
        if not enabled(env, "SHARED_LIBRARY_ENABLED"):
            raise HTTPException(403, "Shared library is disabled")
        try:
            return identify_source(app.state.store, storage_id, filename)
        except (sqlite3.Error, OSError) as exc:
            raise HTTPException(502, "Image storage is unavailable") from exc

    async def json_body(request):
        try:
            body = await request.json()
            if not isinstance(body, dict):
                raise ValueError()
            return body
        except ValueError as exc:
            raise HTTPException(400, "Provide a JSON object") from exc

    def identifiers(body):
        storage_id, filename = body.get("storage_id"), body.get("filename")
        if (
            not isinstance(storage_id, str)
            or not storage_id
            or not isinstance(filename, str)
            or not filename
        ):
            raise HTTPException(400, "Provide a storage ID and filename")
        return storage_id, filename

    def force_value(body):
        force = body.get("force", False)
        if type(force) is not bool:
            raise HTTPException(400, "Force must be a boolean")
        return force

    @route("/watermark/settings")
    def settings():
        try:
            return app.state.watermarks.settings()
        except (sqlite3.Error, OSError) as exc:
            raise HTTPException(
                502, "Watermark settings storage is unavailable"
            ) from exc

    @route("/watermark/settings", ("PUT",))
    async def save_settings(request: Request):
        body = await json_body(request)
        try:
            return await run_in_threadpool(app.state.watermarks.save_settings, body)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        except (OSError, sqlite3.Error) as exc:
            raise HTTPException(500, "Unable to save watermark settings") from exc

    @route("/images/library/watermark", ("POST",))
    async def analyze(request: Request):
        body = await json_body(request)
        snapshot, _ = shared_source(*identifiers(body))
        try:
            status, record = await run_in_threadpool(
                app.state.watermarks.analyze, snapshot, force_value(body)
            )
            return {
                "status": status,
                "print_watermark": record["print_watermark"],
                "image": record,
            }
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        except (OSError, sqlite3.Error) as exc:
            raise HTTPException(502, "Watermark storage is unavailable") from exc

    @route("/images/library/watermarks/backfill", ("POST",))
    async def backfill(request: Request):
        body = await json_body(request)
        force = force_value(body)
        async_preparation = body.get("async_preparation", False)
        if type(async_preparation) is not bool:
            raise HTTPException(400, "async_preparation must be a boolean")
        scope = app.state.deployment.scope(body.get("event_name"))
        if not enabled(env, "SHARED_LIBRARY_ENABLED"):
            raise HTTPException(403, "Shared library is disabled")
        try:
            result = await run_in_threadpool(
                app.state.watermarks.queue_backfill,
                force,
                app.state.analysis_pool,
                scope,
                async_preparation,
            )
            return Response(
                content=json.dumps(result),
                status_code=202 if async_preparation else 200,
                media_type="application/json",
                headers={"Cache-Control": "no-store"},
            )
        except BackfillActiveError as exc:
            raise HTTPException(409, str(exc)) from exc
        except BackfillLimitError as exc:
            raise HTTPException(422, str(exc)) from exc
        except BatchWorkerUnavailable as exc:
            raise HTTPException(503, "The analysis worker is unavailable") from exc
        except (OSError, sqlite3.Error) as exc:
            raise HTTPException(502, "Watermark storage is unavailable") from exc

    @route("/images/library/print-ready", ("POST",))
    async def upload_prepared(request: Request):
        async with request.form(
            max_files=1, max_fields=3, max_part_size=PREPARED_REQUEST_MAX_BYTES
        ) as form:
            storage_id, filename = identifiers(form)
            snapshot, _ = shared_source(storage_id, filename)
            key = form.get("watermark_key")
            upload = form.get("file")
            if (
                not isinstance(key, str)
                or not key
                or not isinstance(upload, UploadFile)
            ):
                raise HTTPException(400, "Provide a watermark key and PNG file")
            data = await upload.read(PREPARED_FILE_MAX_BYTES + 1)
            if len(data) > PREPARED_FILE_MAX_BYTES:
                raise HTTPException(422, "Prepared PNG exceeds the file byte limit")
            try:
                return {
                    "image": await run_in_threadpool(
                        app.state.watermarks.save_prepared, snapshot, key, data
                    )
                }
            except StaleWatermarkError as exc:
                raise HTTPException(409, str(exc)) from exc
            except ValueError as exc:
                raise HTTPException(422, str(exc)) from exc
            except (OSError, sqlite3.Error) as exc:
                raise HTTPException(
                    502, "Prepared-image storage is unavailable"
                ) from exc

    @route("/images/library/print-ready/{storage_id}/{filename}")
    def prepared_file(storage_id: str, filename: str, v: str | None = None):
        snapshot, _ = shared_source(storage_id, filename)
        try:
            record = app.state.watermarks.record(snapshot)
            path = app.state.watermarks.prepared_path(snapshot)
        except (sqlite3.Error, OSError) as exc:
            raise HTTPException(502, "Prepared-image storage is unavailable") from exc
        if path is None or (v is not None and v != record["print_watermark_key"]):
            raise HTTPException(404, "Current print-ready image not found")
        return local_file_response(
            path,
            media_type="image/png",
            headers={"Cache-Control": f"public, max-age={FILE_CACHE_MAX_AGE_SECONDS}"},
        )
