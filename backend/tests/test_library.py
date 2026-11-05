import io
import json
import sqlite3

import pytest
from app.main import create_app
from fastapi.testclient import TestClient
from PIL import Image
from test_canonical import FIXTURE, wait_for_job


def save_image(client, key):
    payload = {**json.loads(FIXTURE.read_text()), "idempotency_key": key}
    accepted = client.post("/api/generate-image", json=payload)
    assert accepted.status_code == 202
    terminal = wait_for_job(client, accepted.json()["generation_job_id"])
    assert terminal["status"] == "complete"
    return terminal["result"]


def test_library_identity_conditional_read_and_delete(tmp_path):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        first = save_image(client, "one")
        second = save_image(client, "two")
        response = client.get("/api/images/library")
        assert response.status_code == 200
        records = response.json()["images"]
        assert [r["id"] for r in records] == [second["id"], first["id"]]
        assert records[0]["selected_controls"] == second["original_selected_controls"]
        assert records[0]["dimensions"] == second["actual_dimensions"]
        assert response.json()["count"] == 2
        etag = response.headers["etag"]
        cached = client.get("/api/images/library", headers={"If-None-Match": etag})
        assert cached.status_code == 304 and cached.content == b""
        assert cached.headers["etag"] == etag
        assert cached.headers["cache-control"] == "private, max-age=0, must-revalidate"
        assert client.get("/images/library").json() == response.json()
        assert (
            client.get("/api/images/library?event_name=unrelated").json()["count"] == 0
        )
        file_url = f"/api/images/library/file/local-0/{first['filename']}"
        original = client.get(file_url)
        assert original.content == client.get(first["image_url"]).content
        assert "max-age=2592000" in original.headers["cache-control"]
        thumb = client.get(file_url + "?variant=thumbnail&max_size=200")
        assert thumb.headers["content-type"] == "image/jpeg"
        with Image.open(io.BytesIO(thumb.content)) as image:
            assert image.height == 200 and image.width <= 200
        deleted = client.request(
            "DELETE",
            "/api/images/library",
            json={"storage_id": "local-0", "filename": first["filename"]},
        )
        assert deleted.json() == {
            "deleted": True,
            "storage_id": "local-0",
            "filename": first["filename"],
        }
        assert client.get(file_url).status_code == 404
        remaining = client.get("/api/images/library", headers={"If-None-Match": etag})
        assert remaining.status_code == 200
        assert remaining.headers["etag"] != etag
        assert [r["id"] for r in remaining.json()["images"]] == [second["id"]]
        assert not (tmp_path / first["filename"]).exists()
        assert (tmp_path / second["filename"]).exists()


def test_delete_cleans_catalog_and_derivatives_when_original_is_missing(tmp_path):
    settings = {"IMAGEDIALS_DATA_DIR": str(tmp_path)}
    with TestClient(create_app(settings)) as client:
        target = save_image(client, "missing-original")
        other = save_image(client, "keep-original")
        other_bytes = (tmp_path / other["filename"]).read_bytes()
        client.app.state.watermarks.analyze(client.app.state.store.image(target["id"]))
        listed = client.get("/api/images/library/page")
        thumbnail = (
            f"/api/images/library/file/local-0/{target['filename']}?variant=thumbnail"
        )
        assert client.get(thumbnail).status_code == 200
        (tmp_path / target["filename"]).unlink()
        assert (
            client.get(
                f"/api/images/library/file/local-0/{target['filename']}"
            ).status_code
            == 404
        )
        identity = {"storage_id": "local-0", "filename": target["filename"]}
        deleted = client.request("DELETE", "/api/images/library", json=identity)
        assert deleted.status_code == 200, deleted.text
        assert deleted.json() == {"deleted": True, **identity}
        assert client.app.state.store.image(target["id"]) is None
        assert not (tmp_path / "derivatives" / target["id"]).exists()
        with client.app.state.store.connect() as database:
            assert (
                database.execute(
                    "SELECT count(*) FROM thumbnail_cache WHERE image_id=?",
                    (target["id"],),
                ).fetchone()[0]
                == 0
            )
        refreshed = client.get(
            "/api/images/library/page",
            headers={"If-None-Match": listed.headers["etag"]},
        )
        assert refreshed.status_code == 200
        assert [record["id"] for record in refreshed.json()["images"]] == [other["id"]]
        assert (tmp_path / other["filename"]).read_bytes() == other_bytes
        assert (
            client.request("DELETE", "/api/images/library", json=identity).status_code
            == 404
        )
    with TestClient(create_app(settings)) as client:
        assert [
            record["id"]
            for record in client.get("/api/images/library").json()["images"]
        ] == [other["id"]]


@pytest.mark.parametrize("max_size,expected", [("bad", 384), ("0", 96), ("9999", 768)])
def test_thumbnail_clamp_transparency_and_decode_fallback(tmp_path, max_size, expected):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        saved = save_image(client, "thumb")
        path = tmp_path / saved["filename"]
        Image.new("RGBA", (800, 800), (0, 0, 0, 0)).save(path)
        url = f"/api/images/library/file/local-0/{saved['filename']}?variant=thumbnail&max_size={max_size}"
        response = client.get(url)
        with Image.open(io.BytesIO(response.content)) as image:
            assert image.size == (expected, expected)
            assert image.getpixel((0, 0)) == (255, 255, 255)
        path.write_bytes(b"undecodable-original")
        response = client.get(url)
        assert response.content == b"undecodable-original"
        assert response.headers["content-type"] == "image/png"


def test_library_validation_disabled_and_storage_failure(tmp_path, monkeypatch):
    app = create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})
    with TestClient(app) as client:
        for body in [{}, {"storage_id": "local-0", "filename": "../outside.png"}]:
            assert (
                client.request("DELETE", "/api/images/library", json=body).status_code
                == 400
            )
        assert (
            client.get("/api/images/library/file/unknown/safe.png").status_code == 404
        )
        assert (
            client.get("/api/images/library/file/local-0/safe.png").status_code == 404
        )

        def broken():
            raise sqlite3.OperationalError("unavailable")

        monkeypatch.setattr(app.state.store, "images", broken)
        response = client.get("/api/images/library")
        assert response.status_code == 502
        assert "unavailable" in response.json()["detail"]
    with TestClient(
        create_app(
            {"IMAGEDIALS_DATA_DIR": str(tmp_path), "SHARED_LIBRARY_ENABLED": "false"}
        )
    ) as client:
        assert client.get("/api/images/library").status_code == 403
        assert (
            client.get("/api/images/library/file/local-0/safe.png").status_code == 403
        )
        assert (
            client.request(
                "DELETE",
                "/api/images/library",
                json={"storage_id": "local-0", "filename": "safe.png"},
            ).status_code
            == 403
        )


def test_nullable_historical_record_preserves_extensions():
    from app.wire import image_record

    record = image_record(
        {
            "id": "historical",
            "created_at": None,
            "composition": None,
            "historical_extension": {"retained": True},
        }
    )
    assert record["dimensions"] is None
    assert record["prompt"] is None
    assert record["final_prompt"] is None
    assert record["alt_text"] is None
    assert record["prompt_creation_request"] is None
    assert record["created_at_iso"] is None
    assert record["historical_extension"] == {"retained": True}


def test_recovery_preserves_unmatched_files_and_existing_schema(tmp_path):
    from app.store import Store

    (tmp_path / "unmatched.png").write_bytes(b"preserve image bytes")
    (tmp_path / "interrupted.tmp").write_bytes(b"preserve partial bytes")
    store = Store(tmp_path)
    assert sorted(p.read_bytes() for p in (tmp_path / "recovery").iterdir()) == [
        b"preserve image bytes",
        b"preserve partial bytes",
    ]
    assert store.images() == []
    with store.connect() as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == 6
        assert db.execute("SELECT COUNT(*) FROM generation_groups").fetchone()[0] == 0
        db.execute("PRAGMA user_version=99")
    with pytest.raises(ValueError, match="newer"):
        Store(tmp_path)


def test_failed_file_delete_retains_record_and_source(tmp_path, monkeypatch):
    from pathlib import Path

    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        saved = save_image(client, "delete-failure")
        original = (tmp_path / saved["filename"]).read_bytes()
        real_replace = Path.replace

        def denied(path, *args, **kwargs):
            if path.name == saved["filename"]:
                raise PermissionError("Deletion denied")
            return real_replace(path, *args, **kwargs)

        monkeypatch.setattr(Path, "replace", denied)
        response = client.request(
            "DELETE",
            "/api/images/library",
            json={"storage_id": "local-0", "filename": saved["filename"]},
        )
        assert response.status_code == 502
        assert client.get("/api/images/library").json()["count"] == 1
        assert (tmp_path / saved["filename"]).read_bytes() == original


def test_browser_private_generation_is_not_promoted_when_shared_library_is_enabled(
    tmp_path,
):
    settings = {"IMAGEDIALS_DATA_DIR": str(tmp_path)}
    with TestClient(
        create_app({**settings, "SHARED_LIBRARY_ENABLED": "false"})
    ) as client:
        record = save_image(client, "private-result")
        assert record["visibility"] == "private"
        original = client.get(record["image_url"]).content
        assert original
        assert client.get("/api/images").json()["total"] == 0
        assert client.get("/api/images/library").status_code == 403
    with TestClient(create_app(settings)) as client:
        assert client.get("/api/images/library").json()["count"] == 0
        assert client.get("/api/images").json()["total"] == 0
        assert (
            client.get(
                f"/api/images/library/file/local-0/{record['filename']}"
            ).status_code
            == 404
        )
        assert (
            client.post(
                "/api/images/library/watermark",
                json={"storage_id": "local-0", "filename": record["filename"]},
            ).status_code
            == 404
        )
        # The accepted job's original remains recoverable for its browser owner.
        assert client.get(record["image_url"]).content == original


def test_unreadable_original_is_reported_before_response_headers(tmp_path, monkeypatch):
    from pathlib import Path

    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        record = save_image(client, "unreadable-source")
        original = tmp_path / record["filename"]
        path_open = Path.open

        def denied(path, *args, **kwargs):
            if path == original:
                raise PermissionError("Read denied")
            return path_open(path, *args, **kwargs)

        monkeypatch.setattr(Path, "open", denied)
        response = client.get(f"/api/images/library/file/local-0/{record['filename']}")
        assert response.status_code == 502
        assert response.headers["content-type"].startswith("application/json")
        assert response.json()["detail"] == "Image storage is unavailable"
        assert client.get(record["image_url"]).status_code == 502


def test_file_symlink_cannot_escape_configured_storage(tmp_path):
    with TestClient(
        create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path / "library")})
    ) as client:
        record = save_image(client, "symlink-source")
        source = tmp_path / "library" / record["filename"]
        outside = tmp_path / "outside.png"
        outside.write_bytes(b"outside storage")
        original = source.read_bytes()
        source.unlink()
        try:
            source.symlink_to(outside)
        except OSError:
            source.write_bytes(original)
            pytest.skip("Symbolic links unavailable on this platform")
        canonical = client.get(f"/api/images/library/file/local-0/{record['filename']}")
        assert canonical.status_code == 400
        assert client.get(record["image_url"]).status_code == 400
        assert outside.read_bytes() == b"outside storage"
        assert original != outside.read_bytes()
