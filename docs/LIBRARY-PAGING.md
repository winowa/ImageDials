# Paged library API

The complete `GET /api/images/library` contract remains compatible. New clients
should use the bounded summary endpoint and fetch full provenance only when an
image is selected. These endpoints have the same unprefixed and configured base-
path aliases as the other canonical routes.

## Summary pages

`GET /api/images/library/page?limit=48&q=ceramic&orientation=landscape`

Parameters:

- `limit`: 1–96 records; default 48.
- `q`: case-insensitive whitespace-separated substring terms, all required;
  maximum 200 characters and 20 terms. Readable nested metadata, false and zero
  are searchable. Inline data URLs and strings longer than 20,000 characters
  are excluded, matching the existing client search bounds.
- `orientation`: optional `landscape`, `portrait`, `square` or `unknown`.
  Square tolerance is 5% of the longer side.
- `event_name`: optional event within the deployment's configured scope.
- `cursor`: opaque continuation returned by the preceding page. Keep the other
  parameters unchanged.
- `order`: `newest` (default) or `oldest`, with creation time and id both sorted
  in the corresponding direction. Oldest-first supports reaching the end of a
  history without downloading all intervening pages. Cursors cannot cross orders.
- `around`: an exact image ID. Returns up to `limit` adjacent summaries containing
  that image, with `anchor_index` identifying it in the returned array. Context
  is split around the target and filled from the available side near an edge.
  A missing, private or filtered-out target returns 404 and never broadens scope.
- `edge`: `first` or `last`. Last seeks backward from the end and returns rows
  in the requested display order, without walking earlier pages or using OFFSET.
  `cursor`, `around` and `edge` are mutually exclusive; invalid combinations
  return 400. Follow their returned cursors without repeating around/edge.

The response has `images`, `count` (this page), `total` (all matching records),
`orientation_counts`, `next_cursor`, `previous_cursor`, `position`, `anchor_index`, `revision`, `order` and
`listing_kind: summary-page`.
Orientation counts reflect search and event scope before the orientation filter.
Summaries contain identity, source hash, bounded title/display prompt, size,
orientation, event, mode, stored analysis/prepared-record flags and relative
thumbnail/detail URLs plus `image_url`, identical to the selected detail's original
content URL. Serving URLs are added at read time; this additive response does
not rebuild the catalog projection or rewrite saved generation records.
Stored flags do not establish that analysis or a prepared
file is current; fetch the detail before preparing or downloading. Summaries deliberately
omit full generation controls and full watermark sidecars. An analyzed summary
includes a compact `print_watermark`: its corner and the four accepted rendering
colors, without palettes or provenance. `watermark_preview_status` distinguishes
`available` from `unavailable` analysis previews. Older projections can obtain
this small preview from a bounded analysis-sidecar read; this does not decode
source pixels, hydrate generation records, or rebuild the catalog. Baked copies
retain `derivative_type: watermarked` so clients avoid applying a second overlay.
A summary must never be
used as a full saved draft for restoration or generation.

Each cursor is bound to its normalized query, scope, page size, sort order and
catalog projection version. Invalid or mismatched cursors return 400; a changed
projection version returns 409 and requires a fresh traversal. Ordinary saves,
deletes and watermark updates do not invalidate a keyset boundary. New records
ahead of that boundary appear when the client refreshes the head; deleted rows
are omitted. Each page reads one consistent current database snapshot rather
than retaining an old snapshot for the whole traversal.

Use `next_cursor` or `previous_cursor` as the next request's opaque `cursor`,
keeping other parameters unchanged. Both directions return rows in the requested
display order. The first page has no previous cursor. An emptied range can
provide a return cursor toward the remaining records. No client-side cursor
history or deep OFFSET query is needed.

`position` is the zero-based index of the first returned row when known. It is
zero on the first page and remains exact during unchanged-revision traversal.
The last edge has the exact current position `total - count`. An around-window
does not compute a catalog-wide rank: its position is null unless it starts at
the head, where it is zero. Use `anchor_index` to locate the requested image;
keep navigation relative until a head/end refresh establishes an exact position.
After a catalog revision changes, it is null: the cursor remains usable, but
the client must not infer an exact page number from an old position. Earlier
forward-only cursors remain usable with unknown positions. Query counts and
response revisions always describe the current snapshot. Cancel obsolete
requests and do not merge different-revision pages as a complete catalog.

Page ETags are query-specific. `If-None-Match` returns 304 without reading catalog
rows when the page revision is unchanged. A page ETag describes that page, not a
complete offline library. Cache page manifests with their scope/query/cursor and
revision, and distinguish incomplete offline results from exhaustive search.

Non-cursor windows also include `watermark_backfill`: bounded global batch
progress or null. It includes id, status, preparation phase, completion scope,
candidate/queued/completed/failed counts and force. `count_pending` distinguishes
an unknown eligible count from zero. It includes omitted-diagnostic counts and
at most one bounded error sample; it omits the diagnostic array and does not imply that the
batch is limited to the current search or event. Cursor pages omit this field.
`GET /api/images/library/watermarks/status` returns that same bounded progress
without reading catalog rows, supports ETag/304, and returns 403 when the shared
library is disabled. Use it when revalidating a retained deep window instead of
requesting a complete library just to update batch progress.

Without a text query, orientation counts come from transactional count buckets.
Global reads visit at most four buckets; scoped reads visit at most four per
configured event. Catalog insert, delete and changes to event, orientation or
visibility update those buckets in the same transaction. Private-image counts
are kept separate and never included in shared results. Event keys distinguish
missing values from literal names, including a name such as `null`.

Filtered orientation counts are memoized per query, event scope and catalog
revision in a 128-entry LRU. Page position, limit and order reuse those counts.
Any writer's library revision invalidates old results; each read still uses one
consistent SQLite snapshot. This cache contains only count maps, never complete
records, and does not turn an incomplete browser cache into exhaustive search.
When those counts prove the result is empty, the server skips the ordered row
query. Computing a first uncached text-search count can still depend on query cardinality
and storage performance.

The index uses SQLite FTS5 with a case-sensitive trigram tokenizer over normalized
lowercase text for exact substring matching. A separate position-free index of
encoded characters and adjacent pairs handles one- and two-character terms.
Both paths query index postings without scanning full saved metadata. If the
installed SQLite lacks trigram support, paging still
works, capabilities advertise `indexed_search_enabled: false`, and nonempty
search returns 503 rather than loading the full catalog into application memory.
Broad matching terms and exact filtered counts can still visit many index rows;
measure representative query cardinalities when sizing a deployment.

## Selected image

`GET /api/images/library/record/{image_id}` returns the full canonical image record,
including unknown fields, original controls and current watermark sidecar state.
It supports its own ETag/304 and optional `event_name`. Private or out-of-scope
records return 404. With the shared library disabled, both endpoints return 403.
A missing selected record never broadens scope or switches history source.

Explicit deletion uses the exact storage identity. A listed image whose original
file is missing can still be deleted: the transaction removes its remaining
catalog entry, thumbnail cache and derivative assets. Missing file reads remain
404; a repeat delete after the record is gone also returns 404. A storage failure
keeps the record and reports the failure rather than claiming deletion succeeded.

## Storage and migration

Schema version 5 adds a separate indexed catalog/search projection. Existing
original bytes and image JSON remain untouched. The initial backfill reads JSON
in batches of 128 inside an atomic transaction; interruption rolls it back and
startup retries. Large initial migrations delay API readiness and must be
measured before deployment. Subsequent normal startups reuse the index.
Application saves and deletes update the projection in the same transaction as
image visibility. Direct SQL modification of image JSON is not a supported write
interface; migrations must update/rebuild the projection explicitly.

Projection version 3 rebuilds the derived catalog and search indexes from saved
records, removes duplicated search text from catalog rows and adds a covering
event/orientation index. It preserves source JSON and media. The projection
version is separate from the database schema version and invalidates old page
cursors when a migration changes query semantics.

Count projection version 1 adds derived global/event/orientation buckets. Its
one-time backfill runs inside the existing catalog migration transaction and
does not rewrite saved image JSON or media. Normal startup reuses it; a catalog
projection rebuild also rebuilds the counts. Interrupted migration rolls back
both derived tables and their version markers, so startup can retry. Measure
initial migration time separately from subsequent first-page requests.

Stored watermark analysis and prepared-record annotations are indexed too.
Analysis/render updates refresh their search projection and library revision.
A durable per-update journal repairs an interrupted sidecar/SQLite boundary at
startup. Recovery refreshes affected records and invalidates stale page ETags;
it never rewrites original image bytes or generation JSON. Dynamic serving URLs
and keys calculated from current global settings are not durable search fields.

Worker recovery uses a partial active-job index so the periodic lease check does
not decode all historical completed jobs. Completed write transactions also renew
their worker's lease, so sustained catalog writes do not depend solely on a
competing heartbeat transaction. Store read/write scopes close their SQLite
connections after commit or rollback. Startup file recovery checks only the files
present on disk, in batches of 128, without loading all saved identities. Each
batch releases its writer transaction and preserves unmatched files in recovery
storage. Legacy complete-list callers remain a separate scale consideration.

While a startup writer holds the catalog migration transaction, other workers
cannot commit heartbeat renewals. Recovery evaluates their leases at lock
acquisition and preserves the age of then-valid leases across that blocked
interval. Owners already expired at acquisition are still recovered, and a
preserved lease expires normally afterward if its worker does not renew it.

The library uses SQLite write-ahead logging with FULL synchronous commits. A long
metadata read retains a consistent snapshot while generation, settings and lease
writes can commit. Storage must be a local writable filesystem supporting SQLite
WAL and its companion files. Use SQLite's backup API for a live backup; copying
only the database file while it is open can omit committed WAL contents. Initial
migrations and atomic multi-row writes still serialize writers and must be timed
separately from reads.

These additive endpoints do not establish frontend scale completion. Production
carousels, paged browsing, bounded browser storage, server thumbnail caching and
whole-system measurements must be connected and verified separately.

## Server thumbnail cache

The existing file route caches JPEG thumbnail derivatives in SQLite BLOB rows,
separate from image records and original files. Keys cover image identity/source
hash, file size/modification time, requested edge size and encoder version. ETags
allow unchanged requests to return 304 without decoding. JPEGs use EXIF-oriented
dimensions and a white background for transparency.

`THUMBNAIL_CACHE_MAX_BYTES` (default 268435456 bytes) and
`THUMBNAIL_CACHE_MAX_ENTRIES` (default 4096) are independent server limits. They
are separate from browser IndexedDB budgets. Startup trims cached rows after a
budget reduction. Indexed LRU eviction and transactionally
maintained counters avoid a full cache scan on insertion. Oversize results are
served without evicting existing entries. Cache write failures serve the rendered
bytes without deleting originals or clearing the cache.

Each API process coalesces identical misses with a fixed lock pool and permits
at most two simultaneous thumbnail decodes. Multiple API workers can still
decode the same initial miss independently; the database stores one keyed copy.
Repeated access timestamps are batched at 30-second intervals. A saved image's
delete transaction also deletes its cached BLOBs, and late rendering cannot
reinsert them. No thumbnail files or partial-file recovery are required.

The byte budget covers stored JPEG payloads. SQLite indexes, metadata and
transaction journals require additional space. SQLite may retain freed pages
for reuse, so eviction does not promise an immediate decrease in database file
size. Include the database in backups and measure actual disk high-water usage.
