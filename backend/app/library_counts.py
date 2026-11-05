"""Transactional catalog count buckets and a bounded filtered-count cache."""

import json
import threading
from collections import OrderedDict

COUNT_CACHE_MAX_ENTRIES = 128
COUNT_PROJECTION_VERSION = 1
COUNT_VERSION_SETTING = "library-counts-version"
EVENT_NAME_ORDER_INDEX = "library_event_name_order"
COUNT_TRIGGERS = (
    "library_counts_insert",
    "library_counts_delete",
    "library_counts_update",
)


def _increment_counts(alias):
    return f"""
        INSERT INTO library_orientation_counts
            (visibility,scope_kind,event_key,orientation,image_count)
        VALUES ({alias}.visibility,'all','',{alias}.orientation,1),
               ({alias}.visibility,'event',json_quote({alias}.event_id),{alias}.orientation,1)
        ON CONFLICT(visibility,scope_kind,event_key,orientation)
        DO UPDATE SET image_count=image_count+1;
    """


def _decrement_counts(alias):
    statements = []
    for kind, event in (("all", "''"), ("event", f"json_quote({alias}.event_id)")):
        conditions = (
            f"visibility={alias}.visibility AND scope_kind='{kind}' "
            f"AND event_key={event} AND orientation={alias}.orientation"
        )
        statements.append(f"""
            UPDATE library_orientation_counts SET image_count=image_count-1 WHERE {conditions};
            DELETE FROM library_orientation_counts WHERE {conditions} AND image_count=0;
        """)
    return "\n".join(statements)


def initialize_orientation_counts(database, *, rebuild=False):
    """Backfill once inside the catalog migration's existing transaction."""
    row = database.execute(
        "SELECT data FROM settings WHERE name=?", (COUNT_VERSION_SETTING,)
    ).fetchone()
    try:
        version = json.loads(row[0]) if row else None
    except (ValueError, TypeError):
        version = None
    table_exists = database.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='library_orientation_counts'"
    ).fetchone()
    rebuild = (
        rebuild
        or not table_exists
        or type(version) is not int
        or version != COUNT_PROJECTION_VERSION
    )
    if rebuild:
        for trigger in COUNT_TRIGGERS:
            database.execute(f"DROP TRIGGER IF EXISTS {trigger}")
        database.execute("DROP TABLE IF EXISTS library_orientation_counts")
    database.execute("""
        CREATE TABLE IF NOT EXISTS library_orientation_counts (
            visibility TEXT NOT NULL,scope_kind TEXT NOT NULL,event_key TEXT NOT NULL,
            orientation TEXT NOT NULL,image_count INTEGER NOT NULL CHECK(image_count>=0),
            PRIMARY KEY(visibility,scope_kind,event_key,orientation)
        ) WITHOUT ROWID
    """)
    database.execute(f"""
        CREATE INDEX IF NOT EXISTS {EVENT_NAME_ORDER_INDEX}
        ON library_orientation_counts(visibility,json_extract(event_key,'$'),orientation)
        WHERE scope_kind='event'
    """)
    if rebuild:
        database.execute("""
            INSERT INTO library_orientation_counts
            SELECT visibility,'event',json_quote(event_id),orientation,COUNT(*) FROM library_catalog
            GROUP BY visibility,event_id,orientation
        """)
        database.execute("""
            INSERT INTO library_orientation_counts
            SELECT visibility,'all','',orientation,SUM(image_count) FROM library_orientation_counts
            WHERE scope_kind='event' GROUP BY visibility,orientation
        """)
        database.execute(
            "INSERT INTO settings(name,data) VALUES (?,?) ON CONFLICT(name) DO UPDATE SET data=excluded.data",
            (COUNT_VERSION_SETTING, json.dumps(COUNT_PROJECTION_VERSION)),
        )
    database.execute(f"""
        CREATE TRIGGER IF NOT EXISTS library_counts_insert AFTER INSERT ON library_catalog
        BEGIN {_increment_counts("NEW")} END
    """)
    database.execute(f"""
        CREATE TRIGGER IF NOT EXISTS library_counts_delete AFTER DELETE ON library_catalog
        BEGIN {_decrement_counts("OLD")} END
    """)
    database.execute(f"""
        CREATE TRIGGER IF NOT EXISTS library_counts_update
        AFTER UPDATE OF visibility,event_id,orientation ON library_catalog
        WHEN OLD.visibility IS NOT NEW.visibility OR OLD.event_id IS NOT NEW.event_id
          OR OLD.orientation IS NOT NEW.orientation
        BEGIN {_decrement_counts("OLD")} {_increment_counts("NEW")} END
    """)


def orientation_count_rows(database, scope):
    """Read four global buckets or at most four per configured event."""
    if scope:
        conditions = (
            "scope_kind='event' AND event_key IN ("
            + ",".join("json_quote(?)" for _ in scope)
            + ")"
        )
    else:
        conditions = "scope_kind='all' AND event_key=''"
    return database.execute(
        "SELECT orientation,SUM(image_count) FROM library_orientation_counts "
        f"WHERE visibility='shared' AND {conditions} GROUP BY orientation",
        list(scope),
    )


class OrientationCountsCache:
    def __init__(self, max_entries=COUNT_CACHE_MAX_ENTRIES):
        self.max_entries = max_entries
        self.values = OrderedDict()
        self.lock = threading.Lock()

    def get(self, key):
        with self.lock:
            value = self.values.get(key)
            if value is None:
                return None
            self.values.move_to_end(key)
            return dict(value)

    def put(self, key, counts):
        with self.lock:
            self.values[key] = dict(counts)
            self.values.move_to_end(key)
            while len(self.values) > self.max_entries:
                self.values.popitem(last=False)
