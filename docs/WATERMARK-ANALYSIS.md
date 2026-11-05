# Browser-only watermark analysis

`POST /api/watermark/analyze-image` accepts one multipart `image` or `file`
containing PNG, JPEG or WebP bytes. This additive endpoint runs the same
independent deterministic pixel analyzer as shared-library analysis. It works
with inference and the shared library disabled and creates no image, job,
sidecar or prepared-file record. Uploaded bytes exist only for the request. A bounded metadata-only memory cache
may reuse analysis by source hash, analysis version and geometry policy; it
retains no image bytes. `?force=true` with a `previous_analysis` JSON field
regenerates that mark using bounded alternatives. The context must belong to the
same source hash. Without force, current context preserves the selected mark while
issuing a key for current content. A forced request without context recomputes the
baseline, which is also used for transport/policy recovery. Settings changes
reuse current analysis while producing a new opaque derivative key.

EXIF rotation and reflection are applied before pixel analysis, matching browser
image display. Reported dimensions describe that display orientation; source
hashes still cover the unchanged uploaded file.

The response contains `print_watermark`, opaque `print_watermark_key`,
`source_sha256`, actual `dimensions`, current `watermark_settings` and
`storage: "transient"`. The key binds source bytes, analysis, renderer policy
and active content. The browser supplies its normalized local content through
the `watermark_settings` field; omitted content uses the server defaults. Request
a new key after settings change before preparing a new derivative; compatible
pixel analysis can be reused separately from the content-dependent prepared
image. Use the existing browser renderer. Keep
prepared blobs in the bounded browser cache; do not submit fabricated storage
identities to shared-library file, print-ready or delete endpoints.

`WATERMARK_ANALYSIS_MAX_BYTES` sets the file-byte limit (default 32 MiB).
Capabilities expose it as `uploads.watermark_analysis_max_bytes`, alongside
`uploads.max_decoded_pixels`, `uploads.image_mime_types` and
`watermark.transient_analysis_enabled`. The whole multipart request is bounded
with a fixed overhead allowance. Empty, invalid and excessive decoded-size
images return 400; excessive upload bytes return 413; unavailable settings
storage returns 502. Root and configured base-path aliases match other
canonical application routes.

`fixtures/api/transient-watermark.json` is an independently generated actual
endpoint response. `backend/tests/test_transient_watermarks.py` checks all
three formats, disabled capabilities, deterministic reuse and key invalidation,
no persistence, aliases, byte limits and decoded pixel limits. This endpoint
is separate from the model-based image-description import operation.

## Browser-private preparation

Library details expose Analyze, Download watermarked and Print for browser-private
and imported images when transient analysis is enabled. With Watermarks on,
the settled visible Library page recovers missing or outdated analyses serially.
Shared originals use the existing shared analysis route; private originals use
the transient endpoint. Page, source, content/policy, visibility and unmount
changes cancel observation. Failed rows display a retry action and do not loop.
No catalog-wide batch is started by visibility, and historical completed batches
are not evidence of current page readiness. Counts use current placements.

Explicit Regenerate compares the previous corner and colors separately. Eligible
corners lie within 0.045 of the best measured score; a stable ring selects another
eligible corner when possible. Tonal alternatives move OKLCH lightness by 0.04
within the existing image hue, gamut and material contrast limits. A unique
quiet-corner margin or consistent palette hue with measured local contrast can
justify retention. Reasons and lack of alternatives appear in regeneration
provenance behind the per-image details disclosure, without an invented confidence
percentage. This is pixel analysis, not semantic object detection.

The browser sends its original bytes to the transient endpoint,
checks the returned display dimensions, and draws a source-size PNG with the same
renderer used for shared images. Download and Print use that prepared file.

Analysis metadata and one prepared PNG are stored beside the local entry without
changing its original record or bytes. Reload can reuse a matching derivative.
Changes to content or renderer policy invalidate the prepared key; a settings
change during preparation causes one refresh and retry. Force analysis bypasses
analysis reuse. Local removal and replacement reject late preparation writes.

Private preparation never calls shared-library file, delete, backfill or
print-ready upload routes. If a prepared PNG exceeds the browser budget or cannot
be stored, the action can still use it and reports that it was not saved.
The settings panel and Library editor save browser-local content through the
validation endpoint, without changing shared settings. Reset reads the server
defaults again. Local removal does not remove server job files.

## Shared analysis batches

`POST /api/images/library/watermarks/backfill` keeps the legacy `{force:false}`
request and 200 queued response with an exact `queued_count`. Eligibility checks
run outside the event loop and writer transaction. Admission captures compact
identities in a disk-backed temporary snapshot and installs them in small
transactions; workers load only the current record, never a full-library list.
Current server-prepared files are excluded unless forced, and a missing or stale
prepared file remains eligible. Completion means analysis, not prepared PNGs.

For fast admission, add `async_preparation:true`. This returns 202 with
`phase:preparing`, `count_pending:true`, `queued_count:null`, a scoped
`candidate_count` and `analysis_batch_id`. Null is an unknown eligible total,
not zero work. The scope is the configured event set or optional `event_name`;
it does not include the Library's text or orientation filters. The catalog
membership snapshot is captured when preparation starts. Arrivals after that
snapshot do not join it; a removed or newly private member fails without analysis.

`GET /api/images/library/watermarks/status` returns bounded global batch progress
with ETag/304. `phase:analysis` and `count_pending:false` establish the exact
eligible `queued_count`. Completed and failed counts are durable and updated at
least every 128 items or about 0.5 seconds between finished items; a slow item
does not invent intermediate progress. Terminal counters are exact. The status
contains one bounded `error_sample` when available, and a concise top-level error
for interrupted work. It does not return the full diagnostic array.

At most 20 per-image errors of 512 characters are retained. `omitted_error_count`
reports the rest, and errors from storage exceptions do not expose filesystem
paths. Queued membership is removed as progress commits and after completion or
failure. Source PNGs, saved generation JSON and shared watermark content are
unchanged. Valid work survives another worker's startup; abandoned work fails
and its disposable queue is removed. A lost task in a still-running process is
also recovered, rather than remaining busy forever.

`WATERMARK_BATCH_MAX_RECORDS` defaults to 250000 scoped candidates. Exceeding it
returns 422 without truncating the batch; narrow the event scope or configure a
larger tested capacity. A concurrent batch returns 409, disabled shared storage
403, an unavailable worker 503, and oversized JSON requests 413 (8192 bytes).
Capabilities expose `watermark.backfill.async_preparation_enabled` and
`max_candidate_records`. All workers must run the same application version and
configuration. The additive mode must be connected and verified in the UI before
claiming full bulk-analysis acceptance. Shared fixtures are in
`fixtures/api/watermark-batches.json`.

## Chromatic analysis policy

The current analysis version is `pixel-analysis-v5`, paired with renderer
`edge-tonal-watermark-v4`. Analysis uses a working image bounded to 1024 pixels
and a global palette sample bounded to 256 pixels. It scores the actual mark
square plus 4% sampling padding, the corner-side text band, and an inward
neighborhood 1.6 times the square side. Their weights are 30%, 45% and 25%.
Each region combines edge activity (60%), tonal spread (20%) and quantized
color entropy (20%). A measured shortfall below the practical 2.1:1 contrast floor adds a placement
penalty; the aspirational 4.5:1 target does not override a quieter corner.
corners within 0.01 resolve bottom-left, bottom-right, top-left, top-right.
This is a pixel heuristic with no semantic subject or face detection.

Colors come from the image's sixteen-color palette and an eight-color local
neighborhood palette. Chromatic single-hue images retain that hue. Gray images
receive a restrained neutral tint. OKLCH chroma is capped at 0.12, endpoint hue
drift at 28 degrees; gamut fitting reduces chroma instead of changing hue.
Lightness moves toward a 4.5:1 local contrast target. The second endpoint changes
tone, with a related palette hue when available. The target is not guaranteed.
Provenance records actual minimum contrast against material local palette
colors (at least 10% prevalence), weighted contrast and the share of sampled
footprint pixels at target, separately for each endpoint. These measurements
exclude the halo and do not certify contrast at every glyph pixel.

Placement now measures the inset from the image's true edges on both axes,
using 3.5% of the image's short side. The former centered print-safe rectangle
still controls mark sizing through reference aspect ratios, but no longer
creates horizontal gutters on square or panoramic images. Text and its rules
anchor toward the selected corner inside the square. Analysis scores that same
corner band; taller text and SVG artwork also participate through the full
square score. The band is a content-independent estimate, not an exact glyph
mask, because analysis is reusable across browser-local content settings.

Rules are 0.036 of the square side, down from 0.044: at mark sizes 160, 200,
240 and 256 pixels the rounded thickness changes from 7/9/11/11 to 6/7/9/9.
The glyph-to-rule gap stays 0.064, rounded independently. A 0.03 inner padding
keeps the restrained halo inside the square. Text fitting includes accents and
descenders. Preview and source-size preparation use one renderer, including
the corner anchor and diagonal gradient with a 20% start-color hold. Explicit
legacy policies retain their previous geometry and v1 text layout.

Printing uses the complete prepared image with `object-fit: contain`; it does
not crop to a reference rectangle. The closer edge placement is therefore
preserved by the application print path. External crop-to-fill or borderless
printer trimming can remove an edge mark; the new policy does not claim the
old centered crop-safe placement. Originals are never rewritten.

Analysis version and geometry fingerprint changes invalidate old placement and
colors. Current compact summaries carry their analysis version through repeated
projection. Stale or unversioned summaries are unavailable until analysis runs
again. The full rendering policy participates in derivative keys, so renderer
changes invalidate prepared copies even when pixel analysis remains reusable.
Browser-local content and settings race protections remain independent of the
pixel algorithm. Baked derivatives never receive another overlay.

`POST /api/watermark/embed-metadata` accepts a separately rendered PNG in `file`
and derivative JSON in `metadata`. Required fields are `source_image`,
`source_sha256`, `print_watermark`, `watermark_settings`, `watermark_key` and
`dimensions`. The source hash and dimensions must match the analysis; a stale
key returns 409. The response is a metadata-bearing PNG with unchanged rendered
pixels, not the original image. No image, job, settings or sidecar is written.
The browser must store this returned derivative within its existing byte budget
and use the same bytes for download and print, without falling back to the source.

The derivative's embedded `ImageDials` record retains generation controls and
prompts, adds watermark content, analysis and the current key, and identifies
its original through `derivative_of`. It has its own identity to avoid merging
an imported watermarked copy with the original. Temporary browser URLs and the
source file's hash are not mislabeled as properties of the new PNG. The upload
limits are 64 MiB for the PNG, 1 MiB for metadata and 65 MiB for the whole request.
Invalid input returns 400/422, excessive metadata/request bytes return 413. Root
and configured-prefix aliases are supported. This endpoint embeds supplied
rendering provenance; it does not independently certify that a visual mark was
drawn or create signed Content Credentials.
