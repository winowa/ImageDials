"""Actual bounded session transport and durable permutation lifecycle."""

import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import pytest
from app.gallery_sessions import (
    MAX_SESSION_REQUEST_BYTES,
    has_session_neighbor,
    session_conditions,
)
from app.library_index import write_projection
from app.main import create_app
from fastapi.testclient import TestClient
from test_library_pages import seed

PATH = "/api/images/library/shuffle-sessions"


def ready(client, identity, **parameters):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        response = client.get(f"{PATH}/{identity}", params=parameters)
        assert response.status_code in {200, 202}, response.text
        if response.status_code == 200:
            assert response.json()["state"] == "ready", response.text
            return response
        time.sleep(0.005)
    raise AssertionError("Owned gallery session did not become ready")


def create(client, **body):
    response = client.post(PATH, json=body)
    assert response.status_code == 202, response.text
    return response.json()["session_id"]


def test_randomized_membership_pages_are_adjacent_bounded_and_restartable(tmp_path):
    settings = {"IMAGEDIALS_DATA_DIR": str(tmp_path)}
    with TestClient(create_app(settings)) as client:
        store = client.app.state.store
        records = seed(store, 100)
        identity = create(client)
        page = ready(client, identity, limit=7).json()
        first = page
        ordered = []
        while True:
            assert page["count"] <= 7
            ordered.extend(record["id"] for record in page["images"])
            if page["next_rank"] is None:
                break
            page = ready(client, identity, rank=page["next_rank"], limit=7).json()
        assert len(ordered) == len(set(ordered)) == 100
        assert set(ordered) == {record["id"] for record in records}
        assert ordered != [record["id"] for record in reversed(records)]
        backward = ready(
            client, identity, rank=99, direction="backward", limit=7
        ).json()
        assert [item["id"] for item in backward["images"]] == ordered[-7:]
        assert [item["session_rank"] for item in first["images"]] == list(range(7))
        assert "selected_controls" not in first["images"][0]
    with TestClient(create_app(settings)) as client:
        assert ready(client, identity, limit=7).json()["images"] == first["images"]


def test_first_item_is_randomized_without_newest_bias(tmp_path, monkeypatch):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        seed(client.app.state.store, 100)
        monkeypatch.setattr(
            "app.gallery_sessions.secrets.token_bytes", lambda _: b"\x00" * 16
        )
        one = ready(client, create(client)).json()["images"]
        monkeypatch.setattr(
            "app.gallery_sessions.secrets.token_bytes", lambda _: b"\x01" * 16
        )
        two = ready(client, create(client)).json()["images"]
        monkeypatch.setattr(
            "app.gallery_sessions.secrets.token_bytes", lambda _: b"\x02" * 16
        )
        three = ready(client, create(client)).json()["images"]
        assert one[0]["id"] != "sample-000099"
        assert len({one[0]["id"], two[0]["id"], three[0]["id"]}) >= 2
        assert one != two


def test_filters_scope_deletes_arrivals_and_metadata_keep_snapshot_order(tmp_path):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        store = client.app.state.store
        seed(store, 20)
        identity = create(client, event_name="exhibit", orientations=["landscape"])
        before = ready(client, identity, event_name="exhibit").json()
        assert before["snapshot_total"] == 10
        keys = [record["id"] for record in before["images"]]
        assert all(record["event_id"] == "exhibit" for record in before["images"])
        assert (
            client.get(
                f"{PATH}/{identity}", params={"event_name": "workshop"}
            ).status_code
            == 404
        )
        store.delete(keys[2])
        after = ready(client, identity, event_name="exhibit").json()
        assert [record["id"] for record in after["images"]] == [
            key for key in keys if key != keys[2]
        ]
        assert after["snapshot_total"] == 10  # Snapshot positions survive holes.
        with store.write_transaction() as database:
            database.execute(
                "INSERT INTO images VALUES ('late',?)",
                (
                    json.dumps(
                        {
                            "id": "late",
                            "event_id": "exhibit",
                            "width": 300,
                            "height": 200,
                        }
                    ),
                ),
            )
            write_projection(
                database,
                {"id": "late", "event_id": "exhibit", "width": 300, "height": 200},
                store.library_search_available,
            )
            store.record_library_change(database, "saved")
        assert "late" not in [
            record["id"]
            for record in ready(client, identity, event_name="exhibit").json()["images"]
        ]


@pytest.mark.parametrize("change", ["delete", "orientation"])
def test_removed_session_edges_do_not_advertise_empty_neighbor_pages(tmp_path, change):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        store = client.app.state.store
        seed(store, 12)
        identity = create(client, orientations=["landscape", "square"])
        original = ready(client, identity, limit=12).json()
        removed = original["images"][:2] + original["images"][-2:]
        for record in removed:
            if change == "delete":
                store.delete(record["id"])
            else:
                snapshot = {**store.image(record["id"]), "width": 200, "height": 300}
                with store.write_transaction() as database:
                    write_projection(database, snapshot, store.library_search_available)
                    store.record_library_change(database, "changed")

        # Snapshot ranks keep their holes, but the navigation must reflect
        # surviving eligible members rather than the original rank bounds.
        forward = ready(client, identity, limit=12).json()
        assert forward["images"][0]["session_rank"] == 2
        assert forward["images"][-1]["session_rank"] == 9
        assert forward["previous_rank"] is None
        assert forward["next_rank"] is None
        backward = ready(
            client, identity, rank=11, direction="backward", limit=12
        ).json()
        assert backward["images"] == forward["images"]
        assert backward["previous_rank"] is None
        assert backward["next_rank"] is None

        # Smaller windows still expose a genuine neighbor in both directions.
        first = ready(client, identity, limit=3).json()
        assert first["previous_rank"] is None
        assert first["next_rank"] is not None
        last = ready(client, identity, rank=11, direction="backward", limit=3).json()
        assert last["next_rank"] is None
        assert last["previous_rank"] is not None


def test_session_neighbor_probe_uses_rank_and_identity_indexes(tmp_path):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        store = client.app.state.store
        seed(store, 20)
        identity = create(client)
        ready(client, identity)
        conditions, parameters = session_conditions((), None)
        with store.connect() as database:
            statements = []
            database.set_trace_callback(statements.append)
            for before in (True, False):
                assert has_session_neighbor(
                    database, identity, 10, conditions, parameters, before=before
                )
            database.set_trace_callback(None)
            assert len(statements) == 2
            for statement in statements:
                plan = database.execute("EXPLAIN QUERY PLAN " + statement).fetchall()
                assert any("SEARCH member USING PRIMARY KEY" in row[3] for row in plan)
                assert any(
                    "SEARCH catalog" in row[3] and "id=?" in row[3] for row in plan
                )
                assert not any(
                    "SCAN" in row[3] or "TEMP B-TREE" in row[3] for row in plan
                )


def test_session_limit_release_expiry_and_record_limit_are_explicit(tmp_path):
    with TestClient(
        create_app(
            {
                "IMAGEDIALS_DATA_DIR": str(tmp_path),
                "GALLERY_SESSION_MAX_COUNT": "1",
                "GALLERY_SESSION_MAX_RECORDS": "2",
            }
        )
    ) as client:
        store = client.app.state.store
        seed(store, 3)
        identity = create(client)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            response = client.get(f"{PATH}/{identity}")
            if response.status_code == 200:
                break
            time.sleep(0.005)
        assert response.json()["state"] == "failed"
        assert "record limit" in response.json()["error"]
        assert client.post(PATH, json={}).status_code == 429
        assert client.delete(f"{PATH}/{identity}").status_code == 204
        replacement = create(client, orientations=[])
        assert ready(client, replacement).json()["snapshot_total"] == 0
        with store.write_transaction() as database:
            database.execute(
                "UPDATE gallery_sessions SET expires_at=0 WHERE id=?", (replacement,)
            )
        assert client.get(f"{PATH}/{replacement}").status_code == 410
        newest = create(client, orientations=[])
        assert ready(client, newest).json()["snapshot_total"] == 0
        with store.connect() as database:
            assert (
                database.execute("SELECT count(*) FROM gallery_sessions").fetchone()[0]
                == 1
            )
            assert (
                database.execute(
                    "SELECT count(*) FROM gallery_session_members"
                ).fetchone()[0]
                == 0
            )


def test_etag_and_abandoned_build_and_shared_disabled(tmp_path):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        store = client.app.state.store
        seed(store)
        identity = create(client)
        response = ready(client, identity)
        assert (
            client.get(
                f"{PATH}/{identity}",
                headers={"If-None-Match": response.headers["etag"]},
            ).status_code
            == 304
        )
        with store.write_transaction() as database:
            database.execute(
                "UPDATE gallery_sessions SET state='building',owner='missing-worker' WHERE id=?",
                (identity,),
            )
        assert client.get(f"{PATH}/{identity}").json()["state"] == "failed"
    with TestClient(
        create_app(
            {"IMAGEDIALS_DATA_DIR": str(tmp_path), "SHARED_LIBRARY_ENABLED": "false"}
        )
    ) as client:
        assert client.post(PATH, json={}).status_code == 403
        assert client.get(f"{PATH}/{identity}").status_code == 403


@pytest.mark.parametrize(
    "variable",
    [
        "GALLERY_SESSION_MAX_COUNT",
        "GALLERY_SESSION_MAX_RECORDS",
        "GALLERY_SESSION_TTL_SECONDS",
    ],
)
def test_session_configuration_is_validated_before_starting_workers(tmp_path, variable):
    with pytest.raises(ValueError, match=variable):
        create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path), variable: "0"})
    assert not (tmp_path / "library.sqlite3").exists()


def test_request_budget_and_invalid_navigation_do_not_allocate_sessions(tmp_path):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        assert (
            client.post(
                PATH, content=b" " * (MAX_SESSION_REQUEST_BYTES + 1)
            ).status_code
            == 413
        )
        for parameters in ({"limit": 97}, {"rank": -1}, {"direction": "sideways"}):
            assert client.get(PATH + "/missing", params=parameters).status_code == 400
        with client.app.state.store.connect() as database:
            assert (
                database.execute("SELECT count(*) FROM gallery_sessions").fetchone()[0]
                == 0
            )


@pytest.mark.parametrize(
    "body",
    [
        [],
        {"unknown": 1},
        {"orientations": "portrait"},
        {"orientations": [False]},
        {"orientations": ["sideways"]},
        {"event_name": 4},
    ],
)
def test_invalid_session_filters_are_rejected(tmp_path, body):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        assert client.post(PATH, json=body).status_code == 400


def test_staging_does_not_hold_the_library_writer_lock(tmp_path, monkeypatch):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        store = client.app.state.store
        seed(store, 300)
        service = client.app.state.gallery_sessions
        read_batch = service.read_batch
        staged, resume = threading.Event(), threading.Event()

        def paused(*arguments):
            batch = read_batch(*arguments)
            if not staged.is_set():
                staged.set()
                assert resume.wait(5), "Test did not release the owned builder"
            return batch

        monkeypatch.setattr(service, "read_batch", paused)
        identity = create(client)
        try:
            assert staged.wait(5)
            with ThreadPoolExecutor(max_workers=1) as writer:
                pending = writer.submit(store.set_setting, "concurrent-write", True)
                try:
                    pending.result(timeout=2)
                    assert store.setting("concurrent-write", False) is True
                finally:
                    resume.set()
        finally:
            resume.set()
        assert ready(client, identity).json()["snapshot_total"] == 300


@pytest.mark.parametrize("change", ["setting", "arrival", "release"])
def test_installation_yields_to_writers_without_exposing_partial_membership(
    tmp_path, monkeypatch, change
):
    monkeypatch.setattr("app.gallery_sessions.SESSION_BUILD_BATCH_RECORDS", 32)
    monkeypatch.setattr("app.gallery_sessions.SESSION_INSTALL_BATCH_RECORDS", 32)
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        store = client.app.state.store
        records = seed(store, 70)
        service = client.app.state.gallery_sessions
        install = service.install_members
        paused, resume = threading.Event(), threading.Event()

        class StagingCursor:
            def __init__(self, cursor):
                self.cursor = cursor
                self.reads = 0

            def fetchmany(self, size):
                self.reads += 1
                if self.reads == 2 and not paused.is_set():
                    paused.set()
                    assert resume.wait(5), "Test did not release installation"
                return self.cursor.fetchmany(size)

        class StagingDatabase:
            def __init__(self, database):
                self.database = database

            def execute(self, sql, *arguments):
                cursor = self.database.execute(sql, *arguments)
                return (
                    StagingCursor(cursor)
                    if sql.startswith("SELECT image_id FROM gallery_order ORDER BY")
                    else cursor
                )

        def pause_install(staging, *arguments):
            return install(StagingDatabase(staging), *arguments)

        def write_while_installing(identity):
            if change == "release":
                assert client.delete(f"{PATH}/{identity}").status_code == 204
                return
            with store.write_transaction() as database:
                if change == "setting":
                    store.write_setting(database, "during-install", True)
                else:
                    record = {"id": "arrival", "width": 300, "height": 200}
                    database.execute(
                        "INSERT INTO images VALUES (?,?)",
                        (record["id"], json.dumps(record)),
                    )
                    write_projection(database, record, store.library_search_available)
                    store.record_library_change(database, "saved")

        monkeypatch.setattr(service, "install_members", pause_install)
        identity = create(client)
        try:
            assert paused.wait(5)
            response = client.get(f"{PATH}/{identity}")
            assert response.status_code == 202
            assert "images" not in response.json()
            with store.connect() as database:
                assert (
                    database.execute(
                        "SELECT count(*) FROM gallery_session_members WHERE session_id=?",
                        (identity,),
                    ).fetchone()[0]
                    == 32
                )
            with ThreadPoolExecutor(max_workers=1) as writer:
                pending = writer.submit(write_while_installing, identity)
                try:
                    pending.result(timeout=2)
                finally:
                    resume.set()
        finally:
            resume.set()
        if change == "release":
            service.close()
            assert client.get(f"{PATH}/{identity}").status_code == 404
            with store.connect() as database:
                assert (
                    database.execute(
                        "SELECT count(*) FROM gallery_session_members WHERE session_id=?",
                        (identity,),
                    ).fetchone()[0]
                    == 0
                )
        else:
            result = ready(client, identity, limit=96).json()
            expected = {record["id"] for record in records}
            if change == "arrival":
                expected.add("arrival")
            assert result["snapshot_total"] == len(expected)
            assert {record["id"] for record in result["images"]} == expected
            assert [record["session_rank"] for record in result["images"]] == list(
                range(len(expected))
            )


def test_catalog_mutation_during_staging_retries_without_mixed_membership(
    tmp_path, monkeypatch
):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        store = client.app.state.store
        seed(store)
        service = client.app.state.gallery_sessions
        read_batch, changed = service.read_batch, False

        def mutate(*arguments):
            nonlocal changed
            batch = read_batch(*arguments)
            if not changed:
                changed = True
                record = {"id": "arrival", "title": "New arrival"}
                with store.write_transaction() as database:
                    database.execute(
                        "INSERT INTO images VALUES (?,?)",
                        (record["id"], json.dumps(record)),
                    )
                    write_projection(database, record, store.library_search_available)
                    store.record_library_change(database, "saved")
            return batch

        monkeypatch.setattr(service, "read_batch", mutate)
        result = ready(client, create(client)).json()
        assert result["snapshot_total"] == 8
        assert {item["id"] for item in result["images"]} == {
            "arrival",
            *(f"sample-{number:06d}" for number in range(7)),
        }


def test_continuous_catalog_changes_fail_after_bounded_attempts(tmp_path, monkeypatch):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        store = client.app.state.store
        seed(store)
        service = client.app.state.gallery_sessions
        install, attempts = service.install_members, []

        def change_before_install(*arguments):
            attempts.append(1)
            with store.write_transaction() as database:
                store.record_library_change(database, "saved")
            return install(*arguments)

        monkeypatch.setattr(service, "install_members", change_before_install)
        identity = create(client)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            response = client.get(f"{PATH}/{identity}")
            if response.status_code == 200:
                break
            time.sleep(0.005)
        assert response.json()["state"] == "failed"
        assert "Library changed" in response.json()["error"]
        assert len(attempts) == 2
        with store.connect() as database:
            assert (
                database.execute(
                    "SELECT count(*) FROM gallery_session_members WHERE session_id=?",
                    (identity,),
                ).fetchone()[0]
                == 0
            )


def test_release_between_staging_and_install_cannot_resurrect_members(
    tmp_path, monkeypatch
):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        store = client.app.state.store
        seed(store)
        service = client.app.state.gallery_sessions
        install = service.install_members
        staged, resume = threading.Event(), threading.Event()

        def paused(*arguments):
            staged.set()
            assert resume.wait(5), "Test did not release the owned installer"
            return install(*arguments)

        monkeypatch.setattr(service, "install_members", paused)
        identity = create(client)
        try:
            assert staged.wait(5)
            assert client.delete(f"{PATH}/{identity}").status_code == 204
        finally:
            resume.set()
        service.close()
        assert client.get(f"{PATH}/{identity}").status_code == 404
        with store.connect() as database:
            assert (
                database.execute(
                    "SELECT count(*) FROM gallery_session_members WHERE session_id=?",
                    (identity,),
                ).fetchone()[0]
                == 0
            )


def test_restart_applies_reduced_session_budgets_without_losing_source_records(
    tmp_path,
):
    settings = {"IMAGEDIALS_DATA_DIR": str(tmp_path)}
    with TestClient(create_app(settings)) as client:
        store = client.app.state.store
        seed(store, 3)
        older, newer = create(client), create(client)
        ready(client, older)
        ready(client, newer)
        with store.write_transaction() as database:
            originals = database.execute(
                "SELECT id,data FROM images ORDER BY id"
            ).fetchall()
            now = time.time()
            database.execute(
                "UPDATE gallery_sessions SET expires_at=? WHERE id=?",
                (now + 1000, older),
            )
            database.execute(
                "UPDATE gallery_sessions SET expires_at=? WHERE id=?",
                (now + 2000, newer),
            )
    with TestClient(
        create_app({**settings, "GALLERY_SESSION_MAX_COUNT": "1"})
    ) as client:
        assert client.get(f"{PATH}/{older}").status_code == 404
        assert ready(client, newer).json()["snapshot_total"] == 3
        with client.app.state.store.connect() as database:
            assert (
                database.execute("SELECT count(*) FROM gallery_sessions").fetchone()[0]
                == 1
            )
            assert (
                database.execute(
                    "SELECT count(*) FROM gallery_session_members"
                ).fetchone()[0]
                == 3
            )
    with TestClient(
        create_app({**settings, "GALLERY_SESSION_MAX_RECORDS": "1"})
    ) as client:
        assert client.get(f"{PATH}/{newer}").status_code == 404
        with client.app.state.store.connect() as database:
            assert (
                database.execute(
                    "SELECT count(*) FROM gallery_session_members"
                ).fetchone()[0]
                == 0
            )
            assert (
                database.execute("SELECT id,data FROM images ORDER BY id").fetchall()
                == originals
            )
