"""One revision-checked first image can precede the complete permutation."""

import json
import sqlite3
import threading

import pytest
from app.library_index import write_projection
from app.main import create_app
from fastapi.testclient import TestClient
from test_gallery_sessions import PATH, create, ready
from test_library_pages import seed


@pytest.mark.parametrize("change", [None, "delete", "orientation"])
def test_preview_is_scoped_compact_and_never_exposes_partial_members(
    tmp_path, monkeypatch, change
):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        store = client.app.state.store
        records = seed(store, 20)
        first = records[3]["id"]
        service = client.app.state.gallery_sessions
        install = service.install_members
        paused, resume = threading.Event(), threading.Event()

        def pause_once(*args):
            if not paused.is_set():
                paused.set()
                assert resume.wait(5), "Test did not release the owned installer"
            return install(*args)

        monkeypatch.setattr(service, "install_members", pause_once)
        identity = create(
            client,
            event_name="exhibit",
            orientations=["landscape"],
            first_image_id=first,
        )
        try:
            assert paused.wait(5)
            response = client.get(
                f"{PATH}/{identity}", params={"event_name": "exhibit"}
            )
            assert response.status_code == 202
            assert response.headers["cache-control"] == "no-store"
            building = response.json()
            preview = building["preview"]["image"]
            assert preview["id"] == first
            assert preview["event_id"] == "exhibit"
            assert preview["orientation"] == "landscape"
            assert "selected_controls" not in preview and "session_rank" not in preview
            assert "images" not in building and "next_rank" not in building
            with store.connect() as database:
                assert (
                    database.execute(
                        "SELECT count(*) FROM gallery_session_members WHERE session_id=?",
                        (identity,),
                    ).fetchone()[0]
                    == 0
                )
            assert (
                client.get(
                    f"{PATH}/{identity}", params={"event_name": "workshop"}
                ).status_code
                == 404
            )

            if change == "delete":
                store.delete(first)
            elif change == "orientation":
                snapshot = {**store.image(first), "width": 200, "height": 300}
                with store.write_transaction() as database:
                    database.execute(
                        "UPDATE images SET data=? WHERE id=?",
                        (json.dumps(snapshot), first),
                    )
                    write_projection(database, snapshot, store.library_search_available)
                    store.record_library_change(database, "changed")
            if change:
                changed = client.get(
                    f"{PATH}/{identity}", params={"event_name": "exhibit"}
                )
                assert changed.status_code == 202
                assert "preview" not in changed.json()
        finally:
            resume.set()
        final = ready(client, identity, event_name="exhibit").json()
        assert "preview" not in final
        assert (final["images"][0]["id"] == first) is (change is None)
        if change is None:
            assert (
                final["snapshot_revision"] == building["preview"]["snapshot_revision"]
            )


@pytest.mark.parametrize("record_count", [0, 5])
def test_empty_build_has_no_preview_and_released_preview_cannot_revive(
    tmp_path, monkeypatch, record_count
):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        seed(client.app.state.store, record_count)
        service = client.app.state.gallery_sessions
        install = service.install_members
        paused, resume = threading.Event(), threading.Event()

        def wait(*args):
            paused.set()
            assert resume.wait(5)
            return install(*args)

        monkeypatch.setattr(service, "install_members", wait)
        identity = create(client)
        try:
            assert paused.wait(5)
            building = client.get(f"{PATH}/{identity}")
            assert building.status_code == 202
            assert ("preview" in building.json()) is bool(record_count)
            assert client.delete(f"{PATH}/{identity}").status_code == 204
        finally:
            resume.set()
        service.close()
        assert client.get(f"{PATH}/{identity}").status_code == 404
        with client.app.state.store.connect() as database:
            assert (
                database.execute(
                    "SELECT count(*) FROM gallery_session_members"
                ).fetchone()[0]
                == 0
            )


def test_adding_preview_columns_preserves_ready_session_and_source_records(tmp_path):
    settings = {"IMAGEDIALS_DATA_DIR": str(tmp_path)}
    with TestClient(create_app(settings)) as client:
        store = client.app.state.store
        seed(store)
        identity = create(client)
        before = ready(client, identity).json()["images"]
        with store.connect() as database:
            originals = database.execute(
                "SELECT id,data FROM images ORDER BY id"
            ).fetchall()
    with sqlite3.connect(tmp_path / "library.sqlite3") as database:
        database.execute("ALTER TABLE gallery_sessions DROP COLUMN preview_image_id")
        database.execute("ALTER TABLE gallery_sessions DROP COLUMN preview_revision")
    with TestClient(create_app(settings)) as client:
        assert ready(client, identity).json()["images"] == before
        with client.app.state.store.connect() as database:
            assert (
                database.execute("SELECT id,data FROM images ORDER BY id").fetchall()
                == originals
            )
