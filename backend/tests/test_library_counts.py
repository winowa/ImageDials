"""Revision-bound metadata count caching never exposes shared mutable results."""

import json
import os
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest
from app.library_counts import (
    COUNT_TRIGGERS,
    COUNT_VERSION_SETTING,
    OrientationCountsCache,
    initialize_orientation_counts,
    orientation_count_rows,
)
from app.library_index import initialize_index, remove_projection, write_projection
from app.store import Store


def test_lru_count_cache_is_bounded_and_copies_values():
    cache = OrientationCountsCache(max_entries=2)
    counts = {"portrait": 0, "landscape": 7}
    cache.put(("scope", "one", 1), counts)
    counts["landscape"] = 999
    cache.put(("scope", "two", 1), {"portrait": 1})
    first = cache.get(("scope", "one", 1))
    assert first["landscape"] == 7
    first["landscape"] = 500
    cache.put(("scope", "three", 1), {"portrait": 3})
    assert cache.get(("scope", "two", 1)) is None
    assert cache.get(("scope", "one", 1))["landscape"] == 7
    assert cache.get(("scope", "one", 2)) is None
    assert cache.get(("another-scope", "one", 1)) is None


def insert(database, record, search_available):
    database.execute(
        "INSERT INTO images VALUES (?,?)", (record["id"], json.dumps(record))
    )
    write_projection(database, record, search_available)


def counted(database, scope=()):
    return dict(orientation_count_rows(database, scope))


def reference(database, scope=()):
    conditions = "visibility='shared'"
    if scope:
        conditions += " AND event_id IN (" + ",".join("?" for _ in scope) + ")"
    return dict(
        database.execute(
            f"SELECT orientation,COUNT(*) FROM library_catalog WHERE {conditions} GROUP BY orientation",
            scope,
        )
    )


def snapshots():
    return [
        {"id": "landscape", "width": 300, "height": 200, "event_id": 'Évent "one"'},
        {"id": "portrait", "width": 200, "height": 300, "event_id": "two"},
        {"id": "square", "width": 200, "height": 200, "event_id": None},
        {"id": "unknown", "event_id": ""},
        {"id": "literal-null", "width": 200, "height": 200, "event_id": "null"},
        {"id": "private", "visibility": "private", "event_id": 'Évent "one"'},
    ]


def test_count_buckets_match_catalog_for_visibility_scope_updates_and_deletes(tmp_path):
    store = Store(tmp_path)
    with store.write_transaction() as database:
        for record in snapshots():
            insert(database, record, store.library_search_available)
        for scope in (
            (),
            ('Évent "one"',),
            ("two",),
            ('Évent "one"', "two"),
            ("missing",),
            ("null",),
            ("",),
        ):
            assert counted(database, scope) == reference(database, scope)
        for condition in (
            "visibility='shared' AND scope_kind='all' AND event_key=''",
            "visibility='shared' AND scope_kind='event' AND event_key=json_quote('two')",
        ):
            plan = database.execute(
                f"EXPLAIN QUERY PLAN SELECT orientation,image_count FROM library_orientation_counts WHERE {condition}"
            ).fetchall()
            assert any("USING PRIMARY KEY" in row[3] for row in plan)
            assert all("SCAN" not in row[3] for row in plan)
        # UPSERT of unchanged count fields must not add to the totals.
        record = {**snapshots()[0], "title": "Only metadata changed"}
        write_projection(database, record, store.library_search_available)
        assert counted(database) == reference(database)
        # A change of event, orientation and visibility moves both global and
        # per-event buckets. Unknown size and private counts remain separate.
        database.execute(
            "UPDATE library_catalog SET event_id='two',orientation='portrait',visibility='private' WHERE id='landscape'"
        )
        database.execute(
            "UPDATE library_catalog SET visibility='shared' WHERE id='private'"
        )
        remove_projection(database, "portrait", store.library_search_available)
        for scope in ((), ('Évent "one"',), ("two",)):
            assert counted(database, scope) == reference(database, scope)
        assert (
            database.execute(
                "SELECT count(*) FROM library_orientation_counts WHERE image_count<=0"
            ).fetchone()[0]
            == 0
        )
        assert (
            database.execute(
                "SELECT count(*) FROM library_orientation_counts WHERE scope_kind='event' AND event_key=json_quote('two') AND visibility='shared'"
            ).fetchone()[0]
            == 0
        )
    store.close()


def test_count_backfill_process_exit_rolls_back_without_changing_original_json(
    tmp_path,
):
    store = Store(tmp_path)
    with store.write_transaction() as database:
        for record in snapshots():
            insert(database, record, store.library_search_available)
        originals = database.execute(
            "SELECT id,data FROM images ORDER BY id"
        ).fetchall()
        expected = counted(database)
    store.close()
    code = """
import os,sys
from app.store import Store
from app.library_counts import initialize_orientation_counts
store=Store(sys.argv[1])
with store.write_transaction() as database:
    class InterruptedDatabase:
        @staticmethod
        def execute(statement,*args):
            result=database.execute(statement,*args)
            if statement.lstrip().startswith('INSERT INTO library_orientation_counts'):
                os._exit(37)
            return result
    initialize_orientation_counts(InterruptedDatabase(),rebuild=True)
"""
    result = subprocess.run(
        [sys.executable, "-c", code, str(tmp_path)],
        env={**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parents[1])},
        timeout=10,
        check=False,
    )
    assert result.returncode == 37
    restarted = Store(tmp_path)
    with restarted.connect() as database:
        assert counted(database) == expected
        assert (
            database.execute("SELECT id,data FROM images ORDER BY id").fetchall()
            == originals
        )
    restarted.close()


def test_count_migration_preserves_original_json_and_restart_avoids_backfill(tmp_path):
    store = Store(tmp_path)
    with store.write_transaction() as database:
        for record in snapshots():
            insert(database, record, store.library_search_available)
        originals = database.execute(
            "SELECT id,data FROM images ORDER BY id"
        ).fetchall()
        for trigger in COUNT_TRIGGERS:
            database.execute(f"DROP TRIGGER {trigger}")
        database.execute("DROP TABLE library_orientation_counts")
        database.execute("DELETE FROM settings WHERE name=?", (COUNT_VERSION_SETTING,))
    store.close()
    migrated = Store(tmp_path)
    with migrated.connect() as database:
        assert (
            database.execute("SELECT id,data FROM images ORDER BY id").fetchall()
            == originals
        )
        assert counted(database) == reference(database)
        queries = []
        database.set_trace_callback(queries.append)
        initialize_orientation_counts(database)
        assert not any("FROM library_catalog" in query for query in queries)
        assert not any("DROP" in query for query in queries)
    migrated.close()


def test_catalog_rebuild_recreates_counts_and_rolls_back_together(tmp_path):
    store = Store(tmp_path)
    with store.write_transaction() as database:
        for record in snapshots():
            insert(database, record, store.library_search_available)
        expected = counted(database)
        database.execute("UPDATE library_orientation_counts SET image_count=999")
        database.execute(
            "UPDATE settings SET data=? WHERE name='library-index-version'",
            (json.dumps({"version": 2, "search": True}),),
        )
        initialize_index(database)
        assert counted(database) == expected
    with pytest.raises(RuntimeError):
        with store.write_transaction() as database:
            remove_projection(database, "portrait", store.library_search_available)
            insert(database, {"id": "aborted"}, store.library_search_available)
            initialize_orientation_counts(database, rebuild=True)
            raise RuntimeError("Abort write and derived counts")
    with store.connect() as database:
        assert counted(database) == expected
        assert (
            database.execute(
                "SELECT 1 FROM library_catalog WHERE id='aborted'"
            ).fetchone()
            is None
        )
    store.close()


def test_two_workers_keep_count_reads_in_their_snapshot(tmp_path):
    first, second = Store(tmp_path), Store(tmp_path)
    with first.write_transaction() as database:
        insert(database, snapshots()[0], first.library_search_available)
    with first.connect() as reader:
        reader.execute("BEGIN")
        assert counted(reader) == {"landscape": 1}
        with second.write_transaction() as writer:
            insert(writer, snapshots()[1], second.library_search_available)
        assert counted(reader) == {"landscape": 1}
    with first.connect() as reader:
        assert counted(reader) == {"landscape": 1, "portrait": 1}
    first.close()
    second.close()


def test_failed_count_backfill_leaves_previous_state_and_can_retry(tmp_path):
    store = Store(tmp_path)
    with store.write_transaction() as database:
        insert(database, snapshots()[0], store.library_search_available)
    with pytest.raises(sqlite3.OperationalError, match="synthetic"):
        with store.write_transaction() as database:

            def fail(statement, *arguments):
                if statement.lstrip().startswith(
                    "INSERT INTO library_orientation_counts"
                ):
                    raise sqlite3.OperationalError("synthetic interrupted backfill")
                return database.execute(statement, *arguments)

            class InterruptedDatabase:
                execute = staticmethod(fail)

            initialize_orientation_counts(InterruptedDatabase(), rebuild=True)
    with store.connect() as database:
        assert counted(database) == {"landscape": 1}
        initialize_orientation_counts(database, rebuild=True)
        assert counted(database) == {"landscape": 1}
    store.close()
