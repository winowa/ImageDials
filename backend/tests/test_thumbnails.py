"""Bounded derivatives, reuse, source identity and deletion consistency."""

import io
import json
import sqlite3
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import pytest
from app.main import create_app
from app.store import Store
from app.thumbnails import (
    GENERATION_WORKERS_PER_PROCESS,
    THUMBNAIL_ENCODER_VERSION,
    ThumbnailCache,
    render_thumbnail,
    thumbnail_key,
)
from fastapi.testclient import TestClient
from PIL import Image
from test_library import save_image


def source_image(store, identity="sample"):
    snapshot = {"id": identity}
    path = store.root / (identity + ".png")
    Image.new("RGB", (600, 400), "blue").save(path)
    with store.connect() as database:
        database.execute(
            "INSERT INTO images VALUES (?,?)", (identity, json.dumps(snapshot))
        )
    return snapshot, path


def usage(store):
    with store.connect() as database:
        recorded = database.execute(
            "SELECT bytes,entries FROM thumbnail_cache_usage"
        ).fetchone()
        actual = database.execute(
            "SELECT COALESCE(SUM(bytes),0),COUNT(*) FROM thumbnail_cache"
        ).fetchone()
    assert recorded == actual
    return recorded


def test_native_route_reuses_bytes_after_restart_and_validates_etag(
    tmp_path, monkeypatch
):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        saved = save_image(client, "cached-thumb")
        original = (tmp_path / saved["filename"]).read_bytes()
        url = f"/api/images/library/file/local-0/{saved['filename']}?variant=thumbnail"
        first = client.get(url)
        assert (
            first.status_code == 200 and first.headers["content-type"] == "image/jpeg"
        )
        assert (
            client.get(
                url, headers={"If-None-Match": first.headers["etag"]}
            ).status_code
            == 304
        )

        def no_decode(*args, **kwargs):
            raise AssertionError("Cached thumbnail decoded an original")

        with monkeypatch.context() as patch:
            patch.setattr(Image, "open", no_decode)
            assert client.get(url).content == first.content
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        with monkeypatch.context() as patch:
            patch.setattr(Image, "open", no_decode)
            assert client.get(url).content == first.content
        assert (tmp_path / saved["filename"]).read_bytes() == original


def test_lru_count_and_byte_limits_refuse_oversize_without_eviction(tmp_path):
    store = Store(tmp_path)
    cache = ThumbnailCache(
        {"THUMBNAIL_CACHE_MAX_ENTRIES": "2", "THUMBNAIL_CACHE_MAX_BYTES": "8"},
        render=lambda *args: b"jpeg",
    )
    items = [source_image(store, str(index)) for index in range(4)]
    for snapshot, path in items[:2]:
        cache.get(store, snapshot, path, 384, thumbnail_key(snapshot, path, 384))
    assert usage(store) == (8, 2)
    with store.connect() as database:
        database.execute("UPDATE thumbnail_cache SET last_used=0 WHERE image_id='1'")
    snapshot, path = items[2]
    cache.get(store, snapshot, path, 384, thumbnail_key(snapshot, path, 384))
    with store.connect() as database:
        assert {
            row[0] for row in database.execute("SELECT image_id FROM thumbnail_cache")
        } == {"0", "2"}
    cache.render = lambda *args: b"too-large"
    snapshot, path = items[3]
    assert (
        cache.get(store, snapshot, path, 384, thumbnail_key(snapshot, path, 384))
        == b"too-large"
    )
    assert usage(store) == (8, 2)


def test_source_size_and_encoder_changes_invalidate_cache_identity(
    tmp_path, monkeypatch
):
    import app.thumbnails as module

    store = Store(tmp_path)
    snapshot, path = source_image(store)
    first = thumbnail_key(snapshot, path, 384)
    assert thumbnail_key(snapshot, path, 200) != first
    Image.new("RGB", (601, 400), "red").save(path)
    second = thumbnail_key(snapshot, path, 384)
    assert second != first
    monkeypatch.setattr(
        module, "THUMBNAIL_ENCODER_VERSION", THUMBNAIL_ENCODER_VERSION + "-new"
    )
    assert thumbnail_key(snapshot, path, 384) != second


def test_identical_misses_coalesce_and_decode_workers_are_bounded(tmp_path):
    store = Store(tmp_path)
    calls, active, peak = 0, 0, 0
    lock = threading.Lock()

    def render(*args):
        nonlocal calls, active, peak
        with lock:
            calls += 1
            active += 1
            peak = max(peak, active)
        time.sleep(0.03)
        with lock:
            active -= 1
        return b"jpeg"

    cache = ThumbnailCache({}, render=render)
    snapshot, path = source_image(store)
    key = thumbnail_key(snapshot, path, 384)
    with ThreadPoolExecutor(max_workers=12) as workers:
        assert all(
            value == b"jpeg"
            for value in workers.map(
                lambda _: cache.get(store, snapshot, path, 384, key), range(12)
            )
        )
    assert calls == 1
    items = [source_image(store, str(index)) for index in range(12)]
    with ThreadPoolExecutor(max_workers=12) as workers:
        list(
            workers.map(
                lambda item: cache.get(store, *item, 384, thumbnail_key(*item, 384)),
                items,
            )
        )
    assert peak == GENERATION_WORKERS_PER_PROCESS


def test_lowered_limits_trim_existing_cache_at_startup(tmp_path):
    app = create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})
    with TestClient(app) as client:
        record = save_image(client, "trim-thumbnails")
        url = f"/api/images/library/file/local-0/{record['filename']}?variant=thumbnail"
        for maximum in (96, 200, 384):
            assert client.get(url + f"&max_size={maximum}").status_code == 200
        assert usage(app.state.store)[1] == 3
    app = create_app(
        {"IMAGEDIALS_DATA_DIR": str(tmp_path), "THUMBNAIL_CACHE_MAX_ENTRIES": "1"}
    )
    with TestClient(app):
        assert usage(app.state.store)[1] == 1


def test_delete_and_late_render_cannot_resurrect_bytes(tmp_path):
    store = Store(tmp_path)
    snapshot, path = source_image(store)
    cache = ThumbnailCache({}, render=lambda *args: b"jpeg")
    key = thumbnail_key(snapshot, path, 384)
    cache.get(store, snapshot, path, 384, key)
    assert usage(store) == (4, 1)
    store.delete(snapshot["id"])
    assert usage(store) == (0, 0)
    assert cache.write(store, snapshot, path, 384, key, b"late") == b"late"
    assert usage(store) == (0, 0)


def test_cache_failure_returns_rendered_bytes(tmp_path, monkeypatch):
    store = Store(tmp_path)
    snapshot, path = source_image(store)
    cache = ThumbnailCache({}, render=lambda *args: b"jpeg")

    def failed(*args):
        raise sqlite3.OperationalError("Cache unavailable")

    monkeypatch.setattr(cache, "write", failed)
    assert (
        cache.get(store, snapshot, path, 384, thumbnail_key(snapshot, path, 384))
        == b"jpeg"
    )
    assert usage(store) == (0, 0)


@pytest.mark.parametrize(
    "name", ["THUMBNAIL_CACHE_MAX_BYTES", "THUMBNAIL_CACHE_MAX_ENTRIES"]
)
def test_invalid_limits_fail_clearly(name):
    with pytest.raises(ValueError, match=name):
        ThumbnailCache({name: "0"})


def test_oriented_dimensions_and_white_transparency(tmp_path):
    path = tmp_path / "alpha.png"
    Image.new("RGBA", (800, 800), (0, 0, 0, 0)).save(path)
    with Image.open(io.BytesIO(render_thumbnail(path, 96, 1_000_000))) as result:
        assert result.size == (96, 96)
        assert result.getpixel((0, 0)) == (255, 255, 255)
    image = Image.new("RGB", (600, 400), "blue")
    exif = image.getexif()
    exif[274] = 6
    image.save(path, exif=exif)
    with Image.open(io.BytesIO(render_thumbnail(path, 300, 1_000_000))) as result:
        assert result.size == (200, 300)
