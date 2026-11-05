# Image reference editing

Create accepts ordered image references separately from text-only generation.
Use Add reference to attach images, edit the prompt, and select Generate edit.
Only controls marked Apply contribute to the edit prompt. Capability discovery reports
whether the configured provider supports editing; descriptions alone are not
image editing.

## Provider configuration

`IMAGE_WORKFLOW_PATH` remains the text-generation graph. For ComfyUI, optionally
set `IMAGE_EDIT_WORKFLOW_PATH` to a separate API-format editing graph. An empty
value disables editing. No new model, download or service is installed.

The editing graph must use `TextEncodeQwenImage21`. Put
`"$reference_images": true` in that encoder's inputs. The adapter removes this
marker, uploads normalized reference PNGs and supplies ordered `images.image_1`,
`images.image_2`, and subsequent connections. The sampler must use the encoder's
positive output 0, negative output 1 and latent output 2. Do not include a separate
empty-latent path. The first reference determines the native canvas geometry.
Text-only requests continue using their existing graph and requested dimensions.
References use ComfyUI temporary uploads and annotated temporary `LoadImage`
paths; the permanent input directory can remain read-only.

The mock provider consumes reference pixels and applies a deterministic test
change. Its diagnostics identify `mock-reference-edit`; it is not learned editing.

## Generation request

`POST /api/generate-image` continues accepting ordinary JSON for text generation.
For editing, send multipart form data with:

- `request`: the usual generation JSON plus an ordered `reference_images` array.
- `reference_1` through `reference_N`: files in the same order as that array,
  where N is at most the selected model's `max_references`.

Each reference descriptor contains `id`, `sha256`, `description` and optional
`role` (default `reference`). The hash binds the description to the exact model
bytes. The server derives filename, oriented dimensions, actual MIME
type and index. Descriptors without matching files fail; there is no fallback to
text-only generation. Empty `controls` are valid for editing, so preserving the
source does not require applying unrelated defaults.

In editing requests, each control may include boolean `apply_to_edit`. False
preserves its original/resolved values in the snapshot but omits it from the
composition request. Omitted or true applies the control. Text-only behavior is
independent and may use `apply_to_generation` when supported. Clients must visibly
distinguish inactive controls from explicit edits. See
[generation options](GENERATION-OPTIONS.md) for optional controls, explicit
variation counts and source-preserving region compositing.

The reference count limit belongs to the selected image model.
Qwen-Image-2.1 documents support for up to 10 reference images
([model card](https://huggingface.co/Qwen/Qwen-Image-2.1), "Versatile Editing",
read 2026-11-04), so that is the default. `IMAGE_EDIT_MAX_REFERENCES` may lower it
for a deployment; it cannot raise it. A strategy without a documented maximum
offers no editing. Separately, every request is bounded by a fixed parsing
envelope of 16 slots, which is not a model capability. Other limits are 32 MiB per
image and 64 MiB combined, with the existing `IMAGE_MAX_DECODED_PIXELS` limit.

The effective limit is published as `image_editing` by both `/api/app-capabilities`
(server default providers) and `/api/models`. `/api/models` honors the browser
provider-settings header, so it describes the provider that will actually run
that browser's requests; clients should read the limit there. The object carries
`enabled`, `model`, `max_references`, `model_max_references`, `limit_source`
(`model` or `configured`) and prompting labels for exactly 1 to `max_references`
references. A provider that cannot edit reports `enabled: false` and
`max_references: 0`. Upload parsing, analysis context, rendering and the
ComfyUI adapter enforce the same value; a request over it fails with 400 before
any file is decoded or provider called.

When the limit drops below the references already in a draft (for example a
settings change), the client keeps every file and blocks submission with the
count to remove. A request already accepted or frozen for retry keeps its
original provider and files. PNG, JPEG and WebP are accepted. Uploads are
orientation-normalized and stripped of source metadata for provider conditioning;
original bytes are not rewritten. Original and conditioning hashes are recorded.

Accepted jobs freeze reference bytes, order and descriptors. The idempotency key
covers those descriptors, controls and prompt. A retry with changed references
returns 409 rather than creating another job. PNG metadata, previews and saved
records retain reference provenance without raw bytes, credentials, object URLs
or private file paths. Actual output dimensions remain authoritative. Saved edit `aspect` follows the
actual output shape; a differing request is retained as `requested_aspect`
alongside `requested_dimensions`. Original
references must remain available in the client to submit an edited result again.

## Reference analysis and prompt proposals

`POST /api/images/reference-analysis` accepts one multipart `image` and optional
JSON `context`. Context supports `prompt`, `generation_mode`, `revision` and every
earlier `reference_images` entry (`id`, `description`, optional `role`), up to one
fewer than the selected model's limit.

The response contains `source_sha256`, oriented `dimensions`, `description`,
`suggested_prompt`, `reference_index`, `revision`, and provider/model metadata.
Analysis always uses visible pixels, even when a PNG carries generation metadata.
It creates no image or generation job. Metadata restoration remains the separate
`/api/images/import-analysis` action.

Attaching the first/base Edit image never fills, replaces or proposes prompt text.
Its description is internal reference/accessibility metadata. Text-to-image Load
image retains its independent app-PNG, ComfyUI and description precedence.

After preparing an upload gesture, the client requests one joint visual composition
for the final ordered set, only when at least two references are attached. The
proposal uses the current prompt and actual images, retaining an interesting feature
of the base and assigning every new reference a meaningful role in one coherent
edit. It does not insert the new image's caption as the edit prompt.

`POST /api/images/reference-prompt` accepts multipart `context` JSON (`prompt`,
`generation_mode`, `revision`, ordered `reference_images` with `id`, `sha256`,
`description` and optional `role`) plus exactly `reference_1` through
`reference_N`. At least two references are required, within the selected model's
limit. Each file must match its descriptor hash and the existing per-file,
total-body and decoded-pixel limits. Descriptions may be empty; they do not supply
the visual composition. Files and contact sheets are transient and never become
library records or generation jobs.

The language model receives one deterministically oriented, fitted, labeled contact
sheet, bounded to the configured description edge and at most 1280 pixels per edge.
Panel 1 maps to the editing model's first/base input, and subsequent panels map to
its ordered inputs. The contact sheet is for understanding only; generation still
uses each separate original or explicitly adapted reference with its exact bytes.
Small details may be lost at this bounded analysis resolution.

`IMAGE_EDIT_PROMPT_STRATEGY` selects the model's naming rules. Currently only
`qwen-image-2.1` is supported. Multi-image proposals use literal `<image1>`,
`<image2>`, etc.; other model families' aliases are invalid. Proposal and final
composition validate the markers and allow one corrective model request.

A failed optional proposal returns `suggested_prompt: null` and a retryable
`prompt_suggestion_unavailable` warning, with provider detail behind disclosure.
Valid references remain available for explicit Generate. Retry prompt resends the
current valid ordered pixels and requests only a prompt, without re-describing,
rendering or storing an image. The response carries `reference_count`,
`prompt_strategy`, `revision`, `warnings` and provider metadata.

Clients discard answers after a change of reference order, hash, provider, mode or
draft identity, including removal back to one reference. A prompt edited while the
request runs receives a Use proposal; an eligible automatic update has Undo.
Restoring saved references never automatically calls a model. Attachment never
generates an image or applies arbitrary edit controls.

`reference_context` on dynamic/additional-control requests supplies the same
ordered id/description/role context without uploading pixels again. A reference
change must invalidate obsolete control work in the client.

The shared synthetic contract is [image-editing.json](../fixtures/api/image-editing.json).

For reattaching an exact original where browser hashing is unavailable (such as
an HTTP origin), `POST /api/images/reference-analysis?inspect_only=true` accepts
the same `image` upload and returns only `source_sha256`, oriented `dimensions`
and local-inspection metadata. It validates image/file limits without calling
models, proposing a prompt, storing an image or requiring inference. Compare
the returned hash with the saved reference before accepting the attachment.

## Reference files in the browser

Uploaded references are held in the current tab unless the person chooses
Keep in this browser from that reference's actions. A kept original is stored
in the browser's IndexedDB (never in web storage), identified by its SHA-256,
within a bounded file count and byte total (`CACHE_REFERENCE_*`). Nothing is
evicted to make room: a refused, denied or full save leaves the file in the
draft and reports it as not kept. Kept files are listed by metadata only; their
bytes are read when one is chosen, previewed, compared or needed to restore a
saved edit. Settings shows usage and removes a kept copy after confirmation;
removing it never detaches a reference already in the draft, and removing a
reference from the draft never removes its kept copy. A new page or draft starts
without references, and kept files are never attached automatically.

Reopening a saved edit restores its reference descriptors, then fills each slot
with the exact original from this tab, a kept file with the same hash, or the
saved image it names, without describing, proposing or generating. Any missing
original is asked for again. The app verifies the original hash before accepting
a replacement attachment. Generated edit results use the normal shared or browser-private image storage.

## Importing an image without editing

`POST /api/images/import-analysis` works independently of image editing support.
Every valid import attempts a pixel-based VLM description when inference is
enabled. The draft prompt source follows this order:

1. Matching ImageDials PNG metadata restores the saved snapshot.
2. A ComfyUI PNG graph supplies positive-conditioning prompt text.
3. Otherwise, the VLM description supplies the prompt.

The response retains `description` with its actual `status`, `text`, `message`,
`provider` and `model`, plus `prompt_source`. Malformed or foreign metadata falls
back without being executed. Metadata size and image limits still apply. A
description failure does not discard usable metadata or a ComfyUI prompt; it is
reported separately. With no usable prompt, the request fails honestly.
Inference-disabled metadata imports remain usable with an unavailable description.
Analysis itself creates no image or generation job. With
`uploads.image_grounded_controls: true`, Text-to-image Load image authorizes one
normal text-to-image generation after its settings are ready. The uploaded image
is never attached to that image-provider request.

For plain images and ComfyUI prompt imports, a separate structured vision call
receives the bounded JPEG pixels and the server-owned Standard catalog. It
returns exactly eight named generated control kinds, relevance order, observed
selected values, and a complete set of validated Standard selections. Unobservable
Standard attributes use null (model decides) or an empty multi-selection. Invalid
or partial choices produce a warning and **Retry image controls**, with no random
fallback or automatic image job. The description and any usable prompt remain.
Existing manual/custom choices retain their intent and opaque fields.

Exact ImageDials metadata takes precedence over visual guesses. Its saved choices
can submit directly without another dynamic-controls call. A restored Asset or
Edit mode does not auto-generate; missing edit originals still block generation.
Inference disabled, unavailable vision or unavailable image-provider capabilities
also block automatic submission. Asset and Edit load/reference behavior is unchanged.

Multipart `context` selects `image-controls`, `retry-controls` or `description-only`
and includes `revision`, `request_id` and `provider_id`. The response echoes this
binding and the original `source_sha256`. The browser uses `description-only`
first, then `retry-controls` with the same request, revision and provider identity.
This exposes real photo-analysis and control-generation boundaries without extra
model calls. It uploads the same bounded source twice, verifies both hashes and
bindings, and retains the first response's prompt, metadata and description.
Exact metadata and disabled inference skip the second request. Existing callers
can still use the combined `image-controls` action.

One progress overlay stays at the bottom of the image stage through analysis,
controls, synchronous option application and the existing generation job. Option
application adds no artificial wait; generation detail comes from the job's real
stage. Description retry shows analysis alone. Control evidence records the bounded
JPEG hash and byte count with an explicit image-data omission, never its base64.
Saved generation metadata keeps the original source hash, prompt source,
description, binding and validated selection evidence. The source file is unchanged.

A later draft/control/aspect/mode/provider change, New draft, new file, dismissal,
unmount, active submission or newer image pick supersedes pending automatic work.
Submission uses the existing frozen request and idempotency key; reconnects and
React effects cannot replay the import. Description retry updates only the
retained description. Controls retry is a separate bounded call and cannot
replace an edited draft. Manual Generate remains available under normal rules.

The reference-help popover links to the configured model's prompting guide and
shows its reference syntax. For Qwen-Image-2.1, use `<image1>`, `<image2>`, etc.
for multiple images in upload order. Name the subject or region supplied by each
image, the change to make, and what must remain unchanged. A single image uses
natural wording without numbered tags. See the [official editing guidance](https://github.com/QwenLM/Qwen-Image-2.1/blob/main/prompt_rewrite/prompts/system_prompt_edit.txt).

## Large reference uploads

The Add reference chooser accepts multiple files in one selection. A selection
that exceeds the selected model's remaining slots is refused as a whole; individual
file failures report the rejected count and leave accepted files in order.

Before analysis, references above `IMAGE_MAX_DECODED_PIXELS` use
`POST /api/images/reference-adapt` with multipart `file`. This transient endpoint
stores nothing and calls no provider. A 204 response leaves the original bytes
unchanged. A 200 response supplies a proportional, oriented copy with source and
adapted SHA-256 and dimension headers (`X-Source-*`, `X-Adapted-*`). The copy uses
Lanczos resizing without cropping, preserves alpha and carries the ICC profile.
`IMAGE_MAX_SOURCE_PIXELS` bounds original decoding independently of model inputs;
provider output, region output, watermark and print limits remain unchanged.

The draft previews and sends the copy and shows `Sent as W×H (original W×H)` as a
status warning. Its descriptor's `sha256` and dimensions describe the model bytes.
Optional `source: {sha256, width, height}` records the original's lineage; ordinary
references omit this field. The original stays available in memory and is the file
saved by Keep in this browser. Recovery from a kept or reattached original prepares
a fresh copy and verifies the recorded model hash before filling the slot. A
conversion failure keeps the original and blocks that slot with its actual error.

Load image continues to inspect the original, validating embedded metadata against
its oriented dimensions. Only description pixels use a bounded thumbnail; metadata
precedence and the original file retained by browser history are preserved.
