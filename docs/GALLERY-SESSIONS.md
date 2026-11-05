# Gallery shuffle sessions

The shared Gallery uses these APIs to read compact summaries in one stable
shuffled order, with bounded pages and an exact record read for the displayed
image. They complement the creation-time summary listing used by Create and
Library. Browser-private history has its own local sequence.

`POST /api/images/library/shuffle-sessions` accepts an object with optional
`event_name`, `orientations` and `first_image_id`. Omitted or null orientations include all shapes;
an empty list selects none. Valid values are `landscape`, `portrait`, `square`
and `unknown`. Unknown body fields return 400, and bodies over 8192 bytes return 413. The configured event scope applies without broadening access.

Acceptance returns 202 with `session_id`, `state: building`, `first_image_member: null` and `expires_at` in
Unix seconds. Construction runs in one background worker. It reads identities
from the indexed catalog, generates keyed pseudorandom sort keys, and assigns
consecutive ranks starting at zero. It never hydrates full image metadata. The
first image is randomized too unless `first_image_id` names a member of the
filtered shared snapshot. That member takes rank zero; all other members retain
their seeded relative order. A missing, private, filtered or out-of-scope target
does not broaden the query and instead leaves the random first member unchanged.
Targets must be nonempty IDs of at most 200 characters without NULs. Membership describes one catalog revision captured
during construction, rather than when the request was accepted.

`GET /api/images/library/shuffle-sessions/{session_id}` returns 202 while building,
or 200 with `state: ready` or `state: failed`. A failure includes an error and
must not be mistaken for an empty gallery. Ready responses include:

- `snapshot_revision`, `snapshot_total`: membership at construction time.
- `revision`: current catalog revision, covering metadata refresh and deletion.
- `images`: compact summaries with `session_rank`; never full saved drafts.
- `count`, `next_rank`, `previous_rank`: bounded page navigation.
- `first_image_member`: whether the requested first image belonged to the built
  snapshot. This is false when omitted or not a member. Sessions created before
  this field was introduced return null without changing their stored order.

A building response may include `preview: {snapshot_revision, image}` after the
complete identity order has been staged, while its durable membership is still
being installed. `image` is one compact summary of the staged first image,
without `session_rank`. It does not expose a partial `images` page or enable
navigation. Clients may display it while continuing to wait for ready state.
The server checks its scope, orientation and catalog revision again on every
read. Any catalog change suppresses the candidate until a new attempt stages a
current order. Empty, failed, expired and abandoned builds offer no preview.
The ready first member matches the preview when that revision remains current.

Page parameters are `rank` (inclusive, default zero), `direction` (`forward` or
`backward`) and `limit` (default 48, maximum 96). Both directions return images
in ascending session order. Use `next_rank` with forward and `previous_rank`
with backward. Home starts at zero; End starts at `snapshot_total - 1` backward
when the snapshot is nonempty. Rank seeks use the composite primary key without
deep OFFSET scans. ETags cover response format, session, expiry, page and current catalog revision;
unchanged requests return 304 before reading members or summaries.

Metadata changes do not reshuffle. Deleted members disappear and leave rank
gaps; original ranks stay stable. `snapshot_total` is not a live filtered count.
Navigation ranks are present only when an eligible member exists in that
direction. Removed or filtered-out images at either edge do not advertise an
empty neighboring page. The opposite-edge check uses an indexed rank probe
without loading source records or image bytes.

## Event choices without loading the image catalog

`GET /api/images/library/event-facets` supplies event names, exact image counts
and per-orientation counts from transactional metadata buckets. Its capability
is `shared_library.paging.event_facets`. The existing `/images/library/events`
route remains the library change stream.

Parameters are `limit` (default 100, maximum 200), `cursor`, optional `event_name`
and `q` (at most 200 characters). Name search is a literal substring comparison
after NFC normalization and Unicode case folding; `%` and `_` are ordinary
characters. Results preserve original names, ordered by their exact names.
An opaque cursor is bound to query, scope, page size and response version, and
remains usable across ordinary catalog revisions. Invalid or mismatched cursors
return 400. Refresh the head to discover names inserted before a boundary.

The response contains `events: [{name, count, orientation_counts}]`, `count`,
`next_cursor`, `revision`, `configured`, `orientation_counts` and `total_images`.
The last two values describe the entire selected event scope before the name
search; they do not shrink when searching the event chooser. Configured events
remain available at count zero. Without configured scope, only names accepted
unchanged by the existing event-scope validator are offered. Unassigned or
unselectable legacy event values remain included in the all-images counts.

Conditional reads use ETag/304 and skip bucket queries when unchanged. Shared
library disabled returns 403; canonical root and deployment-prefix aliases work
as for the other library routes. No image records, image bytes, prompts or full
generation metadata are read for these choices. The added partial event-name
index changes only disposable count metadata, leaving originals intact.

Shared native fixtures: `fixtures/api/library-event-facets.json`. Consumers must
bound loaded options and page/search event choices; this endpoint does not imply
that a client can render an arbitrarily large dropdown or fetch every page.
Use the summary listing's current counts for that purpose. Newly saved images
are not inserted into an existing permutation. The client must handle its bounded
arrival/hold queue explicitly, preserving the cursor, then create a new session
at the next cycle. Reaching the end must not randomly seek an existing session.

Sessions persist across an API restart. A lost building worker returns failed;
ready membership remains reusable. Expired sessions return 410 until cleaned up,
then 404. Changed session formats return 409. A scope mismatch or missing session
returns 404; disabled shared storage returns 403. Clients must restart a session
after expiry and preserve the current image while its replacement builds.

`DELETE /api/images/library/shuffle-sessions/{session_id}` releases only that
session and returns 204. It never deletes an image. Release obsolete sessions on
route or filter changes. Session IDs identify disposable shared state, not an
authentication mechanism; ordinary deployment access controls still apply.

`POST /api/images/library/shuffle-sessions/{session_id}/renew` extends an active
building or ready session to the current server time plus its configured TTL.
It returns the session status and new `expires_at` with `Cache-Control: no-store`.
It accepts the same optional `event_name` scope as reads. It never changes ranks,
membership, source records or settings. Client-supplied durations have no effect:
the server controls the lease cap. A failed or abandoned build returns 409;
expired, missing and scope-mismatched sessions keep the 410/404 semantics above.
Renew before expiry during an active slideshow, release on route/filter changes,
and stop renewal when that session is no longer used. Reads alone do not renew.
Repeated renewals can support a cycle longer than the initial TTL while unused
sessions still expire. If renewal fails, retain the displayed image while a
replacement session builds, using `first_image_id` to preserve it when eligible.

`GALLERY_SESSION_MAX_COUNT` defaults to four across all API workers, including
failed and building sessions. `GALLERY_SESSION_MAX_RECORDS` defaults to 250000
per session; larger matches fail explicitly without truncation. Capacity returns
429 and Retry-After. `GALLERY_SESSION_TTL_SECONDS` defaults to 1800; expiry is
fixed per lease, extended only by explicit renewal. New allocations remove expired rows.
On startup, reduced budgets discard oversized sessions and then the oldest
allocations beyond the new count limit. This removes only derived permutations;
source records and images remain intact. Configure all API workers consistently.
These limits bound persistent member rows by count times records. Temporary
sorting uses a disk-backed table and batches of 1024 identities; provision extra
disk space and benchmark construction before choosing larger limits.

Construction reads bounded identity ranges from a covering index. Each range
checks the catalog revision; hashing and sorting use a separate, automatically
removed SQLite temporary database. They do not hold the library writer lock.
Installation writes at most 4096 identities per transaction, yielding 5 ms
between chunks so other writers can proceed. Every chunk and the final
publication check the session state, expiry and catalog revision. Member pages
remain unavailable until the complete order is published atomically; the
separate single-image preview does not change that boundary. A retry
discards its unpublished prefix in bounded chunks before installing a new order.
The installer reuses one caller-owned connection with a 32 MiB SQLite page-cache
target between chunks; it does not retain a writer transaction across the gaps.
A catalog change retries construction once; a second change fails explicitly
instead of publishing mixed membership. Releasing or expiring a session cancels
its next batch or installation without recreating it.

Individual installation chunks briefly serialize writers. Readers can observe
building state. No partial order is published after a crash.
Source images, generation JSON and watermark settings are unchanged. These APIs
do not yet establish responsive gallery completion; measure first usable content,
construction, concurrent writes, page latency and browser memory separately.
