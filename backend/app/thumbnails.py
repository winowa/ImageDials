"""Bounded SQLite thumbnail derivatives; originals are decoded only on misses."""

import hashlib
import io
import json
import logging
import sqlite3
import threading
import time

from PIL import Image, ImageOps
from PIL import __version__ as PILLOW_VERSION

from .media import MEBIBYTE, positive_integer

THUMBNAIL_DEFAULT_PIXELS = 384
THUMBNAIL_MIN_PIXELS = 96
THUMBNAIL_MAX_PIXELS = 768
THUMBNAIL_JPEG_QUALITY = 85
THUMBNAIL_ENCODER_VERSION = "white-jpeg-v1-" + PILLOW_VERSION
DEFAULT_CACHE_MAX_BYTES = 256 * MEBIBYTE
DEFAULT_CACHE_MAX_ENTRIES = 4096
GENERATION_WORKERS_PER_PROCESS = 2
COALESCING_LOCK_COUNT = 64
ACCESS_UPDATE_INTERVAL_SECONDS = 30
EVICTION_BATCH_ENTRIES = 64


def initialize_thumbnail_cache(database):
    database.execute(
        "CREATE TABLE IF NOT EXISTS thumbnail_cache ("
        "cache_key TEXT PRIMARY KEY,image_id TEXT NOT NULL,"
        "content BLOB NOT NULL,bytes INTEGER NOT NULL CHECK(bytes>=0),"
        "last_used REAL NOT NULL)"
    )
    database.execute(
        "CREATE INDEX IF NOT EXISTS thumbnail_cache_lru ON thumbnail_cache(last_used,cache_key)"
    )
    database.execute(
        "CREATE INDEX IF NOT EXISTS thumbnail_cache_image ON thumbnail_cache(image_id)"
    )
    database.execute(
        "CREATE TABLE IF NOT EXISTS thumbnail_cache_usage ("
        "id INTEGER PRIMARY KEY CHECK(id=1),bytes INTEGER NOT NULL,entries INTEGER NOT NULL)"
    )
    database.execute("INSERT OR IGNORE INTO thumbnail_cache_usage VALUES (1,0,0)")
    database.execute(
        "CREATE TRIGGER IF NOT EXISTS thumbnail_cache_insert AFTER INSERT ON thumbnail_cache "
        "BEGIN UPDATE thumbnail_cache_usage SET bytes=bytes+new.bytes,entries=entries+1 WHERE id=1; END"
    )
    database.execute(
        "CREATE TRIGGER IF NOT EXISTS thumbnail_cache_delete AFTER DELETE ON thumbnail_cache "
        "BEGIN UPDATE thumbnail_cache_usage SET bytes=bytes-old.bytes,entries=entries-1 WHERE id=1; END"
    )


def thumbnail_key(snapshot, path, maximum):
    stat = path.stat()
    identity = {
        "image_id": snapshot["id"],
        "sha256": snapshot.get("sha256"),
        "source_bytes": stat.st_size,
        "source_mtime_ns": stat.st_mtime_ns,
        "maximum_pixels": maximum,
        "encoder": THUMBNAIL_ENCODER_VERSION,
    }
    return hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()


def render_thumbnail(path, maximum, max_image_pixels):
    with Image.open(path) as source:
        if source.width * source.height > max_image_pixels:
            raise ValueError("Image exceeds the decoded pixel limit")
        ImageOps.exif_transpose(source, in_place=True)
        source.thumbnail((maximum, maximum))
        rgba = source.convert("RGBA")
        thumbnail = Image.new("RGB", rgba.size, "white")
        thumbnail.paste(rgba, mask=rgba.getchannel("A"))
        output = io.BytesIO()
        thumbnail.save(output, format="JPEG", quality=THUMBNAIL_JPEG_QUALITY)
    return output.getvalue()


class ThumbnailCache:
    def __init__(self, env, render=render_thumbnail):
        self.max_bytes = positive_integer(
            env, "THUMBNAIL_CACHE_MAX_BYTES", DEFAULT_CACHE_MAX_BYTES
        )
        self.max_entries = positive_integer(
            env, "THUMBNAIL_CACHE_MAX_ENTRIES", DEFAULT_CACHE_MAX_ENTRIES
        )
        self.render = render
        self.workers = threading.BoundedSemaphore(GENERATION_WORKERS_PER_PROCESS)
        self.locks = [threading.Lock() for _ in range(COALESCING_LOCK_COUNT)]

    def evict(self, database, incoming_bytes=0, incoming_entries=0):
        total_bytes, total_entries = database.execute(
            "SELECT bytes,entries FROM thumbnail_cache_usage WHERE id=1"
        ).fetchone()
        while (
            total_bytes + incoming_bytes > self.max_bytes
            or total_entries + incoming_entries > self.max_entries
        ):
            victims = database.execute(
                "SELECT cache_key,bytes FROM thumbnail_cache ORDER BY last_used,cache_key LIMIT ?",
                (EVICTION_BATCH_ENTRIES,),
            ).fetchall()
            if not victims:
                return False
            for victim, size in victims:
                database.execute(
                    "DELETE FROM thumbnail_cache WHERE cache_key=?", (victim,)
                )
                total_bytes -= size
                total_entries -= 1
                if (
                    total_bytes + incoming_bytes <= self.max_bytes
                    and total_entries + incoming_entries <= self.max_entries
                ):
                    break
        return True

    def trim(self, store):
        with store.write_transaction() as database:
            self.evict(database)

    @staticmethod
    def read(store, key):
        with store.connect() as database:
            row = database.execute(
                "SELECT content,last_used FROM thumbnail_cache WHERE cache_key=?",
                (key,),
            ).fetchone()
            if row is None:
                return None
            now = time.time()
            if now - row[1] >= ACCESS_UPDATE_INTERVAL_SECONDS:
                try:
                    database.execute(
                        "UPDATE thumbnail_cache SET last_used=? WHERE cache_key=?",
                        (now, key),
                    )
                except (sqlite3.Error, OSError):
                    pass
            return row[0]

    def write(self, store, snapshot, path, maximum, key, data):
        if len(data) > self.max_bytes:
            return data
        with store.write_transaction() as database:
            # A concurrent delete or source replacement must not resurrect bytes.
            if (
                database.execute(
                    "SELECT 1 FROM images WHERE id=?", (snapshot["id"],)
                ).fetchone()
                is None
            ):
                return data
            if thumbnail_key(snapshot, path, maximum) != key:
                return data
            existing = database.execute(
                "SELECT content FROM thumbnail_cache WHERE cache_key=?", (key,)
            ).fetchone()
            if existing is not None:
                return existing[0]
            if not self.evict(database, len(data), 1):
                return data
            database.execute(
                "INSERT INTO thumbnail_cache VALUES (?,?,?,?,?)",
                (key, snapshot["id"], data, len(data), time.time()),
            )
        return data

    def get(self, store, snapshot, path, maximum, key):
        # Fixed stripes keep lock memory bounded independently of catalog size.
        with self.locks[int(key[:8], 16) % COALESCING_LOCK_COUNT]:
            try:
                cached = self.read(store, key)
            except (sqlite3.Error, OSError):
                cached = None
            if cached is not None:
                return cached
            with self.workers:
                data = self.render(path, maximum, store.max_image_pixels)
            try:
                return self.write(store, snapshot, path, maximum, key, data)
            except (sqlite3.Error, OSError):
                # Disposable cache failure must not hide a readable original.
                logging.getLogger(__name__).warning("Thumbnail cache write unavailable")
                return data
