"""Versioned watermark sidecars and prepared PNGs, separate from source bytes."""

import copy
import hashlib
import io
import json
import threading
import time
from collections import OrderedDict
from urllib.parse import quote

from PIL import Image, UnidentifiedImageError

from .files import atomic_write
from .library_index import write_projection
from .media import MAX_PNG_METADATA_BYTES, PNG_METADATA_KEY, display_dimensions
from .watermark_analysis import (
    ANALYSIS_VERSION,
    RENDERER_VERSION,
    analyze_watermark,
    regenerate_watermark,
)
from .watermark_batches import DEFAULT_BATCH_MAX_RECORDS, WatermarkBatches
from .watermark_policy import (
    WATERMARK_GEOMETRY_FINGERPRINT,
    WATERMARK_POLICY_FINGERPRINT,
)
from .watermark_settings import (
    normalize_settings,
    settings_response,
    watermark_settings,
)
from .wire import image_record

# Cached values contain analysis metadata only, never uploaded image bytes.
TRANSIENT_ANALYSIS_CACHE_LIMIT = 64


def read_json(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except (ValueError, UnicodeError) as exc:
        raise OSError("Stored watermark metadata is invalid") from exc


def watermark_key(snapshot, analysis, settings):
    payload = {
        "renderer_version": RENDERER_VERSION,
        "renderer_policy_fingerprint": WATERMARK_POLICY_FINGERPRINT,
        "analysis_generator_version": ANALYSIS_VERSION,
        "source_sha256": snapshot.get("sha256")
        or analysis["provenance"]["source_sha256"],
        "position": analysis["position"],
        "presentation": analysis["presentation"],
        "settings_fingerprint": settings["fingerprint"],
    }
    return hashlib.sha256(
        json.dumps(
            payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False
        ).encode()
    ).hexdigest()


class WatermarkService:
    def __init__(self, store, *, batch_max_records=DEFAULT_BATCH_MAX_RECORDS):
        self.store = store
        self.lock = threading.RLock()
        self.transient_analysis_lock = threading.RLock()
        self.transient_analyses = OrderedDict()
        self.batches = WatermarkBatches(store, self, batch_max_records)

    def directory(self, snapshot):
        path = self.store.root / "derivatives" / snapshot["id"]
        try:
            inside_storage = path.resolve().is_relative_to(self.store.root.resolve())
        except (OSError, RuntimeError) as exc:
            raise OSError("Unable to resolve image metadata storage") from exc
        if not inside_storage:
            raise OSError("Image metadata is outside its storage target")
        return path

    def settings(self):
        return watermark_settings(self.store)

    def save_settings(self, body):
        settings = normalize_settings(body)
        with self.lock, self.store.write_transaction() as database:
            self.store.write_setting(database, "watermark", settings)
        return self.settings()

    def analysis(self, snapshot):
        return read_json(self.directory(snapshot) / "analysis.json")

    def analyze_upload(
        self, data, force=False, settings_override=None, previous_analysis=None
    ):
        """Analyze browser-only bytes without creating records, jobs or sidecars."""
        local_settings = (
            settings_response(normalize_settings(settings_override))
            if settings_override is not None
            else None
        )
        try:
            with Image.open(io.BytesIO(data)) as image:
                if image.format not in {"PNG", "JPEG", "WEBP"}:
                    raise ValueError("Use a PNG, JPEG or WebP image")
                if image.width * image.height > self.store.max_image_pixels:
                    raise ValueError("Image exceeds the decoded pixel limit")
                embedded = image.info.get(PNG_METADATA_KEY)
                if (
                    isinstance(embedded, str)
                    and len(embedded.encode()) <= MAX_PNG_METADATA_BYTES
                ):
                    try:
                        baked = (
                            json.loads(embedded).get("image", {}).get("derivative_type")
                            == "watermarked"
                        )
                    except (ValueError, AttributeError):
                        baked = False
                    if baked:
                        raise ValueError(
                            "This image already has the watermark built in"
                        )
                width, height = display_dimensions(image)
                dimensions = {"width": width, "height": height}
            source_hash = hashlib.sha256(data).hexdigest()
            cache_key = (ANALYSIS_VERSION, WATERMARK_GEOMETRY_FINGERPRINT, source_hash)
            with self.transient_analysis_lock:
                if not force and cache_key in self.transient_analyses:
                    self.transient_analyses.move_to_end(cache_key)
                    analysis = copy.deepcopy(self.transient_analyses[cache_key])
                else:
                    analysis = analyze_watermark(data)
                    self.transient_analyses[cache_key] = copy.deepcopy(analysis)
                    self.transient_analyses.move_to_end(cache_key)
                    while len(self.transient_analyses) > TRANSIENT_ANALYSIS_CACHE_LIMIT:
                        self.transient_analyses.popitem(last=False)
        except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
            raise ValueError("The upload is not a decodable image") from exc
        if previous_analysis is not None:
            if not isinstance(previous_analysis, dict):
                raise ValueError("Previous analysis must be an object")
            if force:
                analysis = regenerate_watermark(data, previous_analysis, analysis)
            elif self.is_current({"sha256": source_hash}, previous_analysis):
                analysis = copy.deepcopy(previous_analysis)
        settings = local_settings if local_settings is not None else self.settings()
        return {
            "print_watermark": analysis,
            "print_watermark_key": watermark_key(
                {"sha256": source_hash}, analysis, settings
            ),
            "source_sha256": source_hash,
            "dimensions": dimensions,
            "watermark_settings": settings,
            "storage": "transient",
        }

    def is_current(self, snapshot, analysis):
        provenance = (analysis or {}).get("provenance") or {}
        source_hash = provenance.get("source_sha256")
        return (
            provenance.get("generator_version") == ANALYSIS_VERSION
            and provenance.get("geometry_policy_fingerprint")
            == WATERMARK_GEOMETRY_FINGERPRINT
            and bool(source_hash)
            and source_hash == (snapshot.get("sha256") or source_hash)
        )

    def source_bytes(self, snapshot):
        data = (self.store.root / (snapshot["id"] + ".png")).read_bytes()
        actual_hash = hashlib.sha256(data).hexdigest()
        if snapshot.get("sha256") and actual_hash != snapshot["sha256"]:
            raise ValueError("Original image bytes no longer match the saved record")
        return data, actual_hash

    def source_dimensions(self, data):
        try:
            with Image.open(io.BytesIO(data)) as original:
                if (
                    original.format != "PNG"
                    or original.width * original.height > self.store.max_image_pixels
                ):
                    raise ValueError(
                        "Original must be a PNG within the image pixel limit"
                    )
                return display_dimensions(original)
        except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
            raise ValueError("Original image cannot be decoded") from exc

    def record(self, snapshot):
        record = image_record(snapshot)
        analysis = self.analysis(snapshot)
        prepared = read_json(self.directory(snapshot) / "print-ready.json")
        analysis_current = self.is_current(snapshot, analysis)
        current_key = (
            watermark_key(snapshot, analysis, self.settings())
            if analysis_current
            else None
        )
        current = (
            prepared
            and current_key
            and prepared.get("watermark_key") == current_key
            and (self.directory(snapshot) / (current_key + ".png")).is_file()
        )
        record.update(
            # A stale analysis was made by another algorithm or geometry; its
            # corner and colors must not be drawn. The sidecar stays on disk
            # until analysis runs again.
            print_watermark=analysis if analysis_current else None,
            print_ready=prepared,
            print_watermark_key=current_key,
            print_ready_url=f"/api/images/library/print-ready/local-0/{quote(record['filename'], safe='')}?v={current_key}"
            if current
            else None,
        )
        return record

    def analyze(self, snapshot, force=False):
        if snapshot.get("derivative_type") == "watermarked":
            raise ValueError("This image already has the watermark built in")
        with (
            self.lock,
            self.store.annotation_transaction(snapshot["id"]) as (database, mark_dirty),
        ):
            if self.store.image(snapshot["id"]) is None:
                raise ValueError("Image no longer exists")
            data, source_hash = self.source_bytes(snapshot)
            self.source_dimensions(data)
            existing = self.analysis(snapshot)
            if not force and self.is_current(
                {**snapshot, "sha256": source_hash}, existing
            ):
                return "existing", self.record(snapshot)
            analysis = (
                regenerate_watermark(data, existing)
                if force and existing
                else analyze_watermark(data)
            )
            if existing:
                analysis = {
                    **existing,
                    **analysis,
                    "position": {
                        **existing.get("position", {}),
                        **analysis["position"],
                    },
                    "presentation": {
                        **existing.get("presentation", {}),
                        **analysis["presentation"],
                    },
                }
            mark_dirty()
            atomic_write(
                self.directory(snapshot) / "analysis.json",
                json.dumps(analysis, ensure_ascii=False, sort_keys=True).encode(),
            )
            write_projection(
                database, self.record(snapshot), self.store.library_search_available
            )
            self.store.record_library_change(
                database,
                "watermark",
                storage_id="local-0",
                filename=snapshot["id"] + ".png",
                event_name=snapshot.get("event_id"),
            )
            return ("regenerated" if existing else "generated"), self.record(snapshot)

    def save_prepared(self, snapshot, key, data):
        source, source_hash = self.source_bytes(snapshot)
        dimensions = self.source_dimensions(source)
        try:
            with Image.open(io.BytesIO(data)) as image:
                if image.format != "PNG" or image.size != dimensions:
                    raise ValueError("Prepared PNG dimensions must match the original")
                image.load()
        except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
            raise ValueError("Prepared file must be a valid PNG") from exc
        with (
            self.lock,
            self.store.annotation_transaction(snapshot["id"]) as (database, mark_dirty),
        ):
            if self.store.image(snapshot["id"]) is None:
                raise ValueError("Image no longer exists")
            analysis = self.analysis(snapshot)
            if (
                not analysis
                or (analysis.get("provenance") or {}).get("source_sha256")
                != source_hash
            ):
                raise StaleWatermarkError(
                    "Original image changed; refresh analysis and render again"
                )
            current = self.record(snapshot)
            if (
                not current["print_watermark_key"]
                or key != current["print_watermark_key"]
            ):
                raise StaleWatermarkError(
                    "Watermark settings or analysis changed; refresh and render again"
                )
            if current["print_ready_url"]:
                return current
            directory = self.directory(snapshot)
            mark_dirty()
            atomic_write(directory / (key + ".png"), data)
            prepared = {
                "watermark_key": key,
                "sha256": hashlib.sha256(data).hexdigest(),
                "dimensions": {"width": dimensions[0], "height": dimensions[1]},
                "bytes": len(data),
                "created_at": time.time(),
            }
            atomic_write(
                directory / "print-ready.json",
                json.dumps(prepared, sort_keys=True).encode(),
            )
            write_projection(
                database, self.record(snapshot), self.store.library_search_available
            )
            self.store.record_library_change(
                database,
                "print-ready",
                storage_id="local-0",
                filename=snapshot["id"] + ".png",
                event_name=snapshot.get("event_id"),
            )
            return self.record(snapshot)

    def prepared_path(self, snapshot):
        record = self.record(snapshot)
        if not record["print_ready_url"]:
            return None
        return self.directory(snapshot) / (record["print_watermark_key"] + ".png")

    def queue_backfill(self, force, pool, scope=(), async_preparation=False):
        return self.batches.queue(force, pool, scope, async_preparation)


class StaleWatermarkError(ValueError):
    pass
