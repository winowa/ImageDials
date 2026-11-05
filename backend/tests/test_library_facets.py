"""Bounded, scope-safe event choices from transactional count metadata."""

import base64
import json
import sqlite3
from pathlib import Path

import pytest
from app.library_facets import event_choices
from app.library_index import write_projection
from app.main import create_app
from fastapi.testclient import TestClient

PATH = "/api/images/library/event-facets"


def test_shared_facet_fixture_matches_native_api(tmp_path):
    fixture = json.loads(
        (
            Path(__file__).resolve().parents[2]
            / "fixtures/api/library-event-facets.json"
        ).read_text()
    )
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        assert seed_events(client.app.state.store) == fixture["source_records"]
        for name in ("first", "next", "accent_search", "literal_search"):
            expected = fixture[name]
            response = client.get(PATH, params=expected["request"])
            assert response.status_code == 200
            assert response.json() == expected["response"]
            assert response.headers["etag"] == expected["etag"]
    with TestClient(
        create_app(
            {
                "IMAGEDIALS_DATA_DIR": str(tmp_path / "scoped"),
                "GALLERY_EVENT_NAMES": json.dumps(fixture["configured"]["events"]),
            }
        )
    ) as client:
        seed_events(client.app.state.store)
        response = client.get(PATH)
        assert response.json() == fixture["configured"]["response"]
        assert response.headers["etag"] == fixture["configured"]["etag"]


def seed_events(store):
    records = [
        {"id": "one", "event_id": "Alpha", "width": 300, "height": 200},
        {"id": "two", "event_id": "Alpha", "width": 200, "height": 300},
        {"id": "three", "event_id": "Beta", "width": 200, "height": 200},
        {"id": "four", "event_id": "Éclair"},
        {"id": "five", "event_id": "E\u0301clair", "width": 300, "height": 200},
        {"id": "six", "event_id": "100%_real", "width": 300, "height": 200},
        {"id": "seven", "event_id": None, "width": 200, "height": 200},
        {"id": "eight", "event_id": " Alpha "},
        {"id": "private", "event_id": "Alpha", "visibility": "private"},
    ]
    with store.write_transaction() as database:
        for record in records:
            database.execute(
                "INSERT INTO images VALUES (?,?)", (record["id"], json.dumps(record))
            )
            write_projection(database, record, store.library_search_available)
        store.record_library_change(database, "saved")
    return records


def test_facets_page_counts_and_unicode_search_without_record_hydration(
    tmp_path, monkeypatch
):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        store = client.app.state.store
        seed_events(store)
        with store.connect() as database:
            before = database.execute(
                "SELECT id,data FROM images ORDER BY id"
            ).fetchall()

        def forbidden(*args):
            raise AssertionError("Event choices must not hydrate image records")

        monkeypatch.setattr(store, "images", forbidden)
        monkeypatch.setattr(store, "image", forbidden)
        names, cursor = [], None
        while True:
            response = client.get(
                PATH, params={"limit": 2, **({"cursor": cursor} if cursor else {})}
            )
            assert response.status_code == 200, response.text
            page = response.json()
            assert page["count"] <= 2 and page["total_images"] == 8
            assert page["orientation_counts"] == {
                "landscape": 3,
                "portrait": 1,
                "square": 2,
                "unknown": 2,
            }
            assert len(response.content) < 4096
            names.extend(choice["name"] for choice in page["events"])
            for choice in page["events"]:
                assert choice["count"] == sum(choice["orientation_counts"].values())
            cursor = page["next_cursor"]
            if cursor is None:
                break
        assert names == sorted(["Alpha", "Beta", "Éclair", "E\u0301clair", "100%_real"])
        alpha = client.get(PATH, params={"q": "ALPHA"}).json()["events"]
        assert len(alpha) == 1 and alpha[0]["count"] == 2
        accents = client.get(PATH, params={"q": "éCL"}).json()["events"]
        assert {choice["name"] for choice in accents} == {"Éclair", "E\u0301clair"}
        assert (
            client.get(PATH, params={"q": "%_"}).json()["events"][0]["name"]
            == "100%_real"
        )
        assert client.get(PATH, params={"q": "missing"}).json()["events"] == []
        with store.connect() as database:
            assert (
                database.execute("SELECT id,data FROM images ORDER BY id").fetchall()
                == before
            )


def test_configured_zero_count_events_and_scope_never_broaden(tmp_path):
    with TestClient(
        create_app(
            {
                "IMAGEDIALS_DATA_DIR": str(tmp_path),
                "GALLERY_EVENT_NAMES": '["Alpha","Absent"]',
            }
        )
    ) as client:
        seed_events(client.app.state.store)
        page = client.get(PATH).json()
        assert page["configured"] is True and page["total_images"] == 2
        assert [(entry["name"], entry["count"]) for entry in page["events"]] == [
            ("Absent", 0),
            ("Alpha", 2),
        ]
        assert client.get(PATH, params={"event_name": "Beta"}).status_code == 400
        scoped = client.get(PATH, params={"event_name": "Absent"}).json()
        assert scoped["total_images"] == 0 and scoped["events"][0]["count"] == 0
        assert client.get(PATH, params={"q": "Beta"}).json()["events"] == []


def test_cursor_survives_revision_changes_and_is_bound_to_query(tmp_path):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        store = client.app.state.store
        seed_events(store)
        first = client.get(PATH, params={"limit": 2})
        cursor = first.json()["next_cursor"]
        assert first.json()["events"][-1]["name"] == "Alpha"
        for changes in ({"limit": 1}, {"q": "Beta"}, {"event_name": "Alpha"}):
            assert (
                client.get(
                    PATH, params={"limit": 2, "cursor": cursor, **changes}
                ).status_code
                == 400
            )
        store.delete("one")
        store.delete("two")
        with store.write_transaction() as database:
            record = {"id": "late", "event_id": "Basil"}
            database.execute(
                "INSERT INTO images VALUES (?,?)", (record["id"], json.dumps(record))
            )
            write_projection(database, record, store.library_search_available)
            store.record_library_change(database, "saved")
        following = client.get(PATH, params={"limit": 2, "cursor": cursor})
        assert following.status_code == 200
        assert [entry["name"] for entry in following.json()["events"]] == [
            "Basil",
            "Beta",
        ]
        assert following.json()["revision"] != first.json()["revision"]
        assert (
            client.get(
                PATH,
                params={"limit": 2},
                headers={"If-None-Match": first.headers["etag"]},
            ).status_code
            == 200
        )


@pytest.mark.parametrize(
    "params",
    [
        {"limit": 0},
        {"limit": 201},
        {"q": "x" * 201},
        {"q": "\x00"},
        {"cursor": ""},
        {"cursor": "!invalid"},
        {"cursor": "x" * 2049},
        {"cursor": base64.urlsafe_b64encode(b"[]").decode()},
    ],
)
def test_invalid_facet_queries_return_controlled_errors(tmp_path, params):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        assert client.get(PATH, params=params).status_code == 400


def test_conditional_facets_skip_bucket_queries_and_metadata_plan_is_indexed(
    tmp_path, monkeypatch
):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        store = client.app.state.store
        seed_events(store)
        first = client.get(PATH)
        statements = []
        original = store.connect

        def traced():
            database = original()
            database.set_trace_callback(statements.append)
            return database

        monkeypatch.setattr(store, "connect", traced)
        cached = client.get(PATH, headers={"If-None-Match": first.headers["etag"]})
        assert cached.status_code == 304 and not cached.content
        assert not any("library_orientation_counts" in query for query in statements)
        with store.connect() as database:
            statements.clear()
            choices = event_choices(database, (), "", "Alpha", 2)
            assert len(choices) == 3  # One bounded lookahead.
            query = next(
                query for query in statements if "SELECT json_extract" in query
            )
            plan = database.execute("EXPLAIN QUERY PLAN " + query).fetchall()
            assert any(
                "library_event_name_order" in row[3] and "SEARCH" in row[3]
                for row in plan
            )
            assert not any("TEMP B-TREE" in row[3] for row in plan)
            assert " images " not in query and "library_catalog" not in query


def test_aliases_and_shared_disabled_facets(tmp_path):
    with TestClient(
        create_app(
            {"IMAGEDIALS_DATA_DIR": str(tmp_path), "APP_BASE_PATH": "/studio/v1"}
        )
    ) as client:
        seed_events(client.app.state.store)
        expected = client.get(PATH).json()
        for alias in ["/images/library/event-facets", "/studio/v1" + PATH]:
            assert client.get(alias).json() == expected
        assert (
            client.get("/api/app-capabilities").json()["shared_library"]["paging"][
                "event_facets"
            ]["enabled"]
            is True
        )
    with TestClient(
        create_app(
            {
                "IMAGEDIALS_DATA_DIR": str(tmp_path / "disabled"),
                "SHARED_LIBRARY_ENABLED": "false",
            }
        )
    ) as client:
        assert client.get(PATH).status_code == 403
        assert (
            client.get("/api/app-capabilities").json()["shared_library"]["paging"][
                "event_facets"
            ]["enabled"]
            is False
        )


def test_facet_storage_failure_is_controlled_and_does_not_echo_internal_error(
    tmp_path, monkeypatch
):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        original = client.app.state.store.connect

        def broken():
            raise sqlite3.OperationalError("simulated database fault")

        monkeypatch.setattr(client.app.state.store, "connect", broken)
        response = client.get(PATH)
        assert response.status_code == 502
        assert response.json() == {"detail": "Image storage is unavailable"}
        assert "simulated database fault" not in response.text
        monkeypatch.setattr(client.app.state.store, "connect", original)
