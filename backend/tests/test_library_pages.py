"""Indexed library contract, migration and consistency without whole-list reads."""

import json
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest
from app.library_index import initialize_index, projection, write_projection
from app.main import create_app
from app.store import Store
from fastapi.testclient import TestClient
from test_library import save_image


def seed(store, count=7):
    records = []
    with store.write_transaction() as database:
        for index in range(count):
            snapshot = {
                "id": f"sample-{index:06d}",
                "created_at": index // 3,
                "title": f"Ceramic vessel {index}",
                "prompt": "A blue paper circle",
                "width": 300 if index % 2 else 200,
                "height": 200,
                "event_id": "exhibit" if index % 2 else "workshop",
                "extensions": {"enabled": False, "number": 0, "label": "ÉCLAIR"},
            }
            database.execute(
                "INSERT INTO images VALUES (?,?)",
                (snapshot["id"], json.dumps(snapshot)),
            )
            write_projection(database, snapshot, store.library_search_available)
            records.append(snapshot)
        store.record_library_change(database, "saved")
    return records


def test_v2_projection_migrates_without_rewriting_originals(tmp_path):
    store = Store(tmp_path)
    records = seed(store)
    with store.connect() as database:
        originals = database.execute(
            "SELECT id,data FROM images ORDER BY id"
        ).fetchall()
        database.execute("ALTER TABLE library_catalog ADD COLUMN search_text TEXT")
        database.execute(
            "UPDATE settings SET data=? WHERE name='library-index-version'",
            (json.dumps({"version": 2, "search": True}),),
        )
        database.execute("DROP TABLE library_search_short")
    store.close()
    migrated = Store(tmp_path)
    with migrated.connect() as database:
        assert (
            database.execute("SELECT id,data FROM images ORDER BY id").fetchall()
            == originals
        )
        assert "search_text" not in {
            row[1] for row in database.execute("PRAGMA table_info(library_catalog)")
        }
        assert database.execute("SELECT count(*) FROM library_search_short").fetchone()[
            0
        ] == len(records)
        assert database.execute(
            "SELECT count(*) FROM library_search WHERE library_search MATCH '\"éclair\"'"
        ).fetchone()[0] == len(records)
        plan = database.execute(
            "EXPLAIN QUERY PLAN SELECT count(*) FROM library_catalog WHERE visibility='shared' AND event_id='exhibit' AND orientation='landscape'"
        ).fetchall()
        assert any(
            "COVERING INDEX library_catalog_event_shape" in row[3] for row in plan
        )
    migrated.close()


def test_paging_is_bounded_ordered_and_does_not_load_full_records(
    tmp_path, monkeypatch
):
    app = create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})
    with TestClient(app) as client:
        seed(app.state.store)

        def forbidden(*args):
            raise AssertionError("Whole catalog or sidecars read during summary query")

        monkeypatch.setattr(app.state.store, "images", forbidden)
        monkeypatch.setattr(app.state.watermarks, "record", forbidden)
        keys, cursor = [], None
        while True:
            response = client.get(
                "/api/images/library/page",
                params={"limit": 2, **({"cursor": cursor} if cursor else {})},
            )
            assert response.status_code == 200
            page = response.json()
            assert page["count"] <= 2 and page["total"] == 7
            assert page["listing_kind"] == "summary-page"
            assert "extensions" not in page["images"][0]
            assert "selected_controls" not in page["images"][0]
            keys.extend(record["id"] for record in page["images"])
            cursor = page["next_cursor"]
            if not cursor:
                break
        assert keys == [f"sample-{index:06d}" for index in reversed(range(7))]
        assert len(set(keys)) == 7


def test_page_etag_short_circuits_all_catalog_queries(tmp_path, monkeypatch):
    app = create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})
    with TestClient(app) as client:
        seed(app.state.store)
        first = client.get("/api/images/library/page")
        queries = []
        connect = app.state.store.connect

        def traced():
            database = connect()
            database.set_trace_callback(queries.append)
            return database

        monkeypatch.setattr(app.state.store, "connect", traced)
        cached = client.get(
            "/api/images/library/page", headers={"If-None-Match": first.headers["etag"]}
        )
        assert cached.status_code == 304 and not cached.content
        assert all("library_catalog" not in query for query in queries)
        assert first.headers["cache-control"] == "private, max-age=0, must-revalidate"
        different_query = client.get(
            "/api/images/library/page?q=vessel",
            headers={"If-None-Match": first.headers["etag"]},
        )
        assert different_query.status_code == 200


def test_search_preserves_substrings_unknown_metadata_false_zero_unicode_and_quoting(
    tmp_path,
):
    app = create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})
    with TestClient(app) as client:
        seed(app.state.store)
        for query in [
            "ess",
            "false 0",
            "Éclair",
            "circle vessel",
            "local-0",
            "300x200",
            "ci",
        ]:
            response = client.get("/api/images/library/page", params={"q": query})
            assert response.status_code == 200, response.text
            assert response.json()["total"] == (3 if query == "300x200" else 7)
        assert (
            client.get("/api/images/library/page", params={"q": '" OR * --'}).json()[
                "total"
            ]
            == 0
        )
        assert (
            client.get("/api/images/library/page", params={"q": "missing"}).json()[
                "total"
            ]
            == 0
        )


def test_filters_counts_scope_detail_and_aliases(tmp_path):
    app = create_app(
        {
            "IMAGEDIALS_DATA_DIR": str(tmp_path),
            "APP_BASE_PATH": "/studio/v1",
            "GALLERY_EVENT_NAMES": '["exhibit"]',
        }
    )
    with TestClient(app) as client:
        records = seed(app.state.store)
        response = client.get(
            "/studio/v1/api/images/library/page?orientation=landscape"
        )
        assert response.json()["total"] == 3
        assert response.json()["orientation_counts"] == {
            "landscape": 3,
            "square": 0,
            "portrait": 0,
            "unknown": 0,
        }
        assert client.get("/images/library/page").json() == response.json()
        assert (
            client.get("/api/images/library/page?event_name=workshop").status_code
            == 400
        )
        assert client.get("/api/images/library/record/sample-000000").status_code == 404
        detail = client.get("/studio/v1/images/library/record/sample-000001")
        assert detail.status_code == 200
        assert detail.json()["extensions"] == records[1]["extensions"]
        assert (
            client.get(
                "/api/images/library/record/sample-000001",
                headers={"If-None-Match": detail.headers["etag"]},
            ).status_code
            == 304
        )


@pytest.mark.parametrize(
    "params",
    [
        {"limit": 0},
        {"limit": 97},
        {"cursor": "bad!"},
        {"cursor": "a" * 2049},
        {"orientation": "other"},
        {"q": "x" * 201},
        {"q": "\x00"},
    ],
)
def test_rejects_invalid_page_arguments(tmp_path, params):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        assert client.get("/api/images/library/page", params=params).status_code == 400


def test_cursors_bind_queries_but_survive_library_revisions(tmp_path, monkeypatch):
    import app.library_pages as library_pages

    app = create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})
    with TestClient(app) as client:
        seed(app.state.store)
        first = client.get("/api/images/library/page?limit=2").json()
        assert (
            client.get(
                "/api/images/library/page",
                params={"cursor": first["next_cursor"], "limit": 3},
            ).status_code
            == 400
        )
        app.state.store.notify_library("saved")
        advanced = client.get(
            "/api/images/library/page",
            params={"cursor": first["next_cursor"], "limit": 2},
        )
        assert advanced.status_code == 200
        assert [row["id"] for row in advanced.json()["images"]] == [
            "sample-000004",
            "sample-000003",
        ]
        assert advanced.json()["position"] is None
        monkeypatch.setattr(
            library_pages, "INDEX_VERSION", library_pages.INDEX_VERSION + 1
        )
        assert (
            client.get(
                "/api/images/library/page",
                params={"cursor": first["next_cursor"], "limit": 2},
            ).status_code
            == 409
        )


def test_real_save_and_delete_update_projection_in_same_transaction(tmp_path):
    app = create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})
    with TestClient(app) as client:
        record = save_image(client, "paged-save")
        assert (
            client.get("/api/images/library/page").json()["images"][0]["id"]
            == record["id"]
        )
        with app.state.store.connect() as database:
            assert (
                database.execute("SELECT COUNT(*) FROM library_search").fetchone()[0]
                == 1
            )
        assert (
            client.request(
                "DELETE",
                "/api/images/library",
                json={"storage_id": "local-0", "filename": record["filename"]},
            ).status_code
            == 200
        )
        assert client.get("/api/images/library/page").json()["total"] == 0
        with app.state.store.connect() as database:
            assert (
                database.execute("SELECT COUNT(*) FROM library_search").fetchone()[0]
                == 0
            )


def test_private_records_never_enter_public_queries(tmp_path):
    app = create_app(
        {"IMAGEDIALS_DATA_DIR": str(tmp_path), "SHARED_LIBRARY_ENABLED": "false"}
    )
    with TestClient(app) as client:
        record = save_image(client, "private-paged-save")
        assert client.get("/api/images/library/page").status_code == 403
        assert (
            client.get(f"/api/images/library/record/{record['id']}").status_code == 403
        )
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        assert client.get("/api/images/library/page").json()["total"] == 0
        assert (
            client.get(f"/api/images/library/record/{record['id']}").status_code == 404
        )


def test_v4_migration_preserves_json_original_and_restarts_without_rebuild(
    tmp_path, monkeypatch
):
    import app.library_index as index_module

    snapshot = {
        "id": "historic",
        "created_at": None,
        "dimensions": "105x100",
        "extension": {"zero": 0, "false": False},
    }
    raw = json.dumps(snapshot)
    with sqlite3.connect(tmp_path / "library.sqlite3") as database:
        database.executescript(
            "CREATE TABLE images(id TEXT PRIMARY KEY,data TEXT); PRAGMA user_version=4;"
        )
        database.execute("INSERT INTO images VALUES (?,?)", (snapshot["id"], raw))
    original = tmp_path / "historic.png"
    original.write_bytes(b"unchanged original")
    store = Store(tmp_path)
    with store.connect() as database:
        assert database.execute("SELECT data FROM images").fetchone()[0] == raw
        assert (
            database.execute("SELECT orientation FROM library_catalog").fetchone()[0]
            == "square"
        )
        assert database.execute("PRAGMA user_version").fetchone()[0] == 6
        assert (
            database.execute("SELECT COUNT(*) FROM generation_groups").fetchone()[0]
            == 0
        )
    assert original.read_bytes() == b"unchanged original"

    def forbidden(*args):
        raise AssertionError("Unchanged index rebuilt")

    monkeypatch.setattr(index_module, "write_projection", forbidden)
    Store(tmp_path)


def test_migration_failure_rolls_back_and_retry_preserves_source(tmp_path, monkeypatch):
    import app.library_index as index_module

    store = Store(tmp_path)
    seed(store)
    with store.connect() as database:
        database.execute("DELETE FROM settings WHERE name='library-index-version'")
        before = database.execute(
            "SELECT * FROM library_catalog ORDER BY id"
        ).fetchall()
    original = index_module.write_projection

    def broken(*args):
        raise OSError("Interrupted index migration")

    monkeypatch.setattr(index_module, "write_projection", broken)
    with pytest.raises(OSError, match="Interrupted"):
        with store.write_transaction() as database:
            initialize_index(database)
    with store.connect() as database:
        assert (
            database.execute("SELECT * FROM library_catalog ORDER BY id").fetchall()
            == before
        )
    monkeypatch.setattr(index_module, "write_projection", original)
    Store(tmp_path)


def test_summary_is_compact_and_search_does_not_include_data_urls():
    summary, text = projection(
        {
            "id": "compact",
            "prompt": "x" * 10_000,
            "title": "y" * 1000,
            "unknown": {"inline": "data:secret", "enabled": False},
        }
    )
    assert len(summary["display_prompt"]) == 160
    assert len(summary["title"]) == 512
    assert "data:secret" not in text and "false" in text


def test_order_query_uses_composite_index(tmp_path):
    store = Store(tmp_path)
    seed(store, 100)
    with store.connect() as database:
        plans = database.execute(
            "EXPLAIN QUERY PLAN SELECT summary FROM library_catalog WHERE visibility='shared' AND (created_at,id)<(?,?) ORDER BY created_at DESC,id DESC LIMIT ?",
            (25, "sample-000080", 48),
        ).fetchall()
    assert any("library_catalog_order" in row[3] for row in plans)
    assert not any("TEMP B-TREE" in row[3] for row in plans)


def test_missing_trigram_support_keeps_listing_but_reports_search_unavailable(tmp_path):
    app = create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})
    with TestClient(app) as client:
        seed(app.state.store)
        app.state.store.library_search_available = False
        assert client.get("/api/images/library/page").status_code == 200
        assert client.get("/api/images/library/page?q=vessel").status_code == 503
        paging = client.get("/api/app-capabilities").json()["shared_library"]["paging"]
        assert paging["enabled"] is True and paging["indexed_search_enabled"] is False


def test_recovery_uses_partial_index_and_ignores_terminal_job_payloads(tmp_path):
    from app.store import ACTIVE_JOB_PREDICATE

    store = Store(tmp_path)
    with store.connect() as database:
        database.execute(
            "INSERT INTO jobs VALUES (?,?,?,?)",
            ("terminal", "terminal", "fixed", json.dumps({"stage": "complete"})),
        )
        queries = []
        database.set_trace_callback(queries.append)
        store.recover_jobs(database)
        plans = database.execute(
            "EXPLAIN QUERY PLAN SELECT jobs.id,jobs.data,job_owners.worker_id FROM jobs LEFT JOIN job_owners ON job_owners.job_id=jobs.id WHERE "
            + ACTIVE_JOB_PREDICATE
        ).fetchall()
    assert any("jobs_active" in row[3] for row in plans)
    assert any(ACTIVE_JOB_PREDICATE in query for query in queries)


def test_shared_paging_fixture_matches_native_endpoint(tmp_path):
    fixture = json.loads(
        (
            Path(__file__).resolve().parents[2] / "fixtures/api/library-pages.json"
        ).read_text()
    )
    app = create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})
    with TestClient(app) as client:
        with app.state.store.write_transaction() as database:
            for record in fixture["source_records"]:
                database.execute(
                    "INSERT INTO images VALUES (?,?)",
                    (record["id"], json.dumps(record)),
                )
                write_projection(
                    database, record, app.state.store.library_search_available
                )
            app.state.store.record_library_change(database, "saved")
        for key in (
            "first",
            "next",
            "previous",
            "oldest",
            "oldest_next",
            "oldest_previous",
            "around",
            "last",
        ):
            response = client.get(
                "/api/images/library/page", params=fixture[key]["request"]
            )
            assert response.json() == fixture[key]["response"]
            assert response.headers["etag"] == fixture[key]["etag"]
        progress = client.get("/api/images/library/watermarks/status")
        assert progress.json() == fixture["watermark_status"]["response"]
        assert progress.headers["etag"] == fixture["watermark_status"]["etag"]
        assert (
            client.get("/api/images/library/record/catalog-example-2").json()
            == fixture["detail"]
        )
        app.state.store.notify_library("saved")
        changed = client.get(
            "/api/images/library/page", params=fixture["next"]["request"]
        )
        assert changed.status_code == 200
        assert changed.json() == fixture["changed_revision"]["response"]


def test_annotation_migration_and_refresh_keep_search_current_without_source_rewrite(
    tmp_path,
):
    app = create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})
    with TestClient(app) as client:
        record = save_image(client, "indexed-annotations")
        source = tmp_path / record["filename"]
        original = source.read_bytes()
        with app.state.store.connect() as database:
            original_json = database.execute(
                "SELECT data FROM images WHERE id=?", (record["id"],)
            ).fetchone()[0]
        _, decorated = app.state.watermarks.analyze(record)
        corner = decorated["print_watermark"]["position"]["corner"]
        color = decorated["print_watermark"]["presentation"]["gradient_start"]
        for term in (corner, color):
            result = client.get("/api/images/library/page", params={"q": term}).json()
            assert (
                result["total"] == 1
                and result["images"][0]["has_watermark_analysis"] is True
            )
        with app.state.store.write_transaction() as database:
            database.execute("DELETE FROM settings WHERE name='library-index-version'")
            initialize_index(database, tmp_path)
        assert (
            client.get("/api/images/library/page", params={"q": color}).json()["total"]
            == 1
        )
        assert source.read_bytes() == original
        with app.state.store.connect() as database:
            assert (
                database.execute(
                    "SELECT data FROM images WHERE id=?", (record["id"],)
                ).fetchone()[0]
                == original_json
            )


def test_index_migration_refuses_sidecar_symlink_escape(tmp_path):
    from app.library_index import with_stored_annotations

    root = tmp_path / "store"
    (root / "derivatives").mkdir(parents=True)
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "analysis.json").write_text('{"private":"outside"}')
    try:
        (root / "derivatives" / "example").symlink_to(outside, target_is_directory=True)
    except OSError:
        pytest.skip("Symbolic links unavailable on this platform")
    with pytest.raises(OSError, match="outside"):
        with_stored_annotations(root, {"id": "example"})


def test_process_exit_between_sidecar_and_commit_repairs_index_on_restart(tmp_path):
    store = Store(tmp_path)
    seed(store, 1)
    before = store.image("sample-000000")
    sequence = store.library_change_sequence()
    program = """
import os, sys
from pathlib import Path
from app.files import atomic_write
from app.library_index import with_stored_annotations, write_projection
from app.store import Store
store = Store(Path(sys.argv[1]))
with store.annotation_transaction('sample-000000') as (database, mark_dirty):
    mark_dirty()
    atomic_write(store.root / 'derivatives/sample-000000/analysis.json', b'{"audit":"recovered-annotation"}')
    snapshot = with_stored_annotations(store.root, store.image('sample-000000'))
    write_projection(database, snapshot, store.library_search_available)
    os._exit(23)
"""
    child = subprocess.run(
        [sys.executable, "-c", program, str(tmp_path)],
        cwd=Path(__file__).resolve().parents[1],
    )
    assert child.returncode == 23
    with store.connect() as database:
        assert (
            "recovered-annotation"
            not in database.execute("SELECT text FROM library_search").fetchone()[0]
        )
    assert list((tmp_path / ".catalog-pending").glob("*.json"))
    restarted = Store(tmp_path)
    with restarted.connect() as database:
        assert (
            "recovered-annotation"
            in database.execute("SELECT text FROM library_search").fetchone()[0]
        )
    assert restarted.image("sample-000000") == before
    assert restarted.library_change_sequence() == sequence + 1
    assert list((tmp_path / ".catalog-pending").iterdir()) == []
    Store(tmp_path)
    assert restarted.library_change_sequence() == sequence + 1


def test_read_only_annotation_transaction_does_not_create_journal(tmp_path):
    store = Store(tmp_path)
    with store.annotation_transaction("unused") as (database, mark_dirty):
        assert database.execute("SELECT 1").fetchone()[0] == 1
    assert not (tmp_path / ".catalog-pending").exists()


def test_startup_tolerates_a_committed_workers_concurrent_journal_cleanup(
    tmp_path, monkeypatch
):
    from app.library_index import begin_annotation_update

    store = Store(tmp_path)
    seed(store, 1)
    marker = begin_annotation_update(tmp_path, "sample-000000")
    read_text = Path.read_text

    def removed_after_listing(path, *args, **kwargs):
        if path == marker:
            path.unlink()
            raise FileNotFoundError()
        return read_text(path, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", removed_after_listing)
    restarted = Store(tmp_path)
    assert restarted.image("sample-000000") == store.image("sample-000000")


def test_search_updates_and_etags_follow_new_annotation_values(tmp_path):
    app = create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})
    with TestClient(app) as client:
        record = save_image(client, "annotation-refresh")
        _, decorated = app.state.watermarks.analyze(record)
        old = client.get("/api/images/library/page")
        analysis_path = tmp_path / "derivatives" / record["id"] / "analysis.json"
        analysis = json.loads(analysis_path.read_text())
        analysis["independent_extension"] = "annotation-marker"
        analysis_path.write_text(json.dumps(analysis))
        # Force analysis preserves unknown annotation extensions and refreshes
        # the projection in the same transaction as the change notification.
        app.state.watermarks.analyze(record, force=True)
        assert (
            client.get(
                "/api/images/library/page",
                headers={"If-None-Match": old.headers["etag"]},
            ).status_code
            == 200
        )
        assert (
            client.get("/api/images/library/page?q=annotation-marker").json()["total"]
            == 1
        )


@pytest.mark.parametrize("order", ["newest", "oldest"])
def test_both_keyset_orders_traverse_tied_timestamps_without_skips(tmp_path, order):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        seed(client.app.state.store, 17)
        identities, cursor = [], None
        while True:
            response = client.get(
                "/api/images/library/page",
                params={
                    "order": order,
                    "limit": 3,
                    **({"cursor": cursor} if cursor else {}),
                },
            )
            assert response.status_code == 200, response.text
            data = response.json()
            assert data["order"] == order and data["count"] <= 3 and data["total"] == 17
            identities.extend(item["id"] for item in data["images"])
            cursor = data["next_cursor"]
            if cursor is None:
                break
        expected = [f"sample-{number:06d}" for number in range(17)]
        assert identities == (
            list(reversed(expected)) if order == "newest" else expected
        )


def test_order_is_bound_to_cursor_and_etag_and_oldest_seek_uses_index(tmp_path):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        store = client.app.state.store
        seed(store)
        newest = client.get("/api/images/library/page", params={"limit": 2})
        cursor = newest.json()["next_cursor"]
        assert (
            client.get(
                "/api/images/library/page",
                params={"limit": 2, "order": "oldest", "cursor": cursor},
            ).status_code
            == 400
        )
        oldest = client.get(
            "/api/images/library/page",
            params={"limit": 2, "order": "oldest"},
            headers={"If-None-Match": newest.headers["etag"]},
        )
        assert oldest.status_code == 200
        assert oldest.json()["images"][0]["id"] == "sample-000000"
        assert client.get("/api/images/library/page?order=random").status_code == 400
        with store.connect() as database:
            plan = database.execute(
                "EXPLAIN QUERY PLAN SELECT summary FROM library_catalog WHERE visibility='shared' AND (created_at,id)>(?,?) ORDER BY created_at,id LIMIT 3",
                (0, "sample-000000"),
            ).fetchall()
            assert any("library_catalog_order" in row[3] for row in plan)
            assert all("TEMP B-TREE" not in row[3] for row in plan)


def test_count_cache_reuses_query_across_page_order_and_limit_then_invalidates(
    tmp_path, monkeypatch
):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        store = client.app.state.store
        seed(store)
        queries, connect = [], store.connect

        def traced():
            database = connect()
            database.set_trace_callback(queries.append)
            return database

        monkeypatch.setattr(store, "connect", traced)
        first = client.get("/api/images/library/page?limit=2").json()

        def count_reads():
            return sum("GROUP BY orientation" in query for query in queries)

        assert count_reads() == 1
        assert (
            client.get(
                "/api/images/library/page",
                params={"limit": 2, "cursor": first["next_cursor"]},
            ).status_code
            == 200
        )
        assert (
            client.get("/api/images/library/page?limit=3&order=oldest").status_code
            == 200
        )
        assert count_reads() == 1
        assert (
            client.get("/api/images/library/page?event_name=exhibit").json()["total"]
            == 3
        )
        assert count_reads() == 2
        writer = Store(tmp_path)
        with writer.write_transaction() as database:
            record = {"id": "arrival", "width": 400, "height": 200}
            database.execute(
                "INSERT INTO images VALUES (?,?)", (record["id"], json.dumps(record))
            )
            write_projection(database, record, writer.library_search_available)
            writer.record_library_change(database, "saved")
        writer.close()
        assert client.get("/api/images/library/page").json()["total"] == 8
        assert count_reads() == 3


def test_empty_counts_avoid_ordered_row_reads_and_do_not_hide_later_arrivals(
    tmp_path, monkeypatch
):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        store = client.app.state.store
        seed(store)
        queries, connect = [], store.connect

        def traced():
            database = connect()
            database.set_trace_callback(queries.append)
            return database

        monkeypatch.setattr(store, "connect", traced)
        for parameters in ({"q": "nevermatched"}, {"orientation": "portrait"}):
            response = client.get("/api/images/library/page", params=parameters)
            assert response.status_code == 200
            assert response.json()["images"] == []
            assert response.json()["total"] == 0
            assert response.json()["next_cursor"] is None
        assert not any(query.startswith("SELECT summary,") for query in queries)
        record = {
            "id": "arrival",
            "prompt": "nevermatched",
            "width": 200,
            "height": 300,
        }
        with store.write_transaction() as database:
            database.execute(
                "INSERT INTO images VALUES (?,?)", (record["id"], json.dumps(record))
            )
            write_projection(database, record, store.library_search_available)
            store.record_library_change(database, "saved")
        for parameters in ({"q": "nevermatched"}, {"orientation": "portrait"}):
            response = client.get("/api/images/library/page", params=parameters)
            assert response.status_code == 200
            assert [item["id"] for item in response.json()["images"]] == ["arrival"]
