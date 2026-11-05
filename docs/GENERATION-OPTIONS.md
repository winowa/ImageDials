# Generation options

Read `/api/app-capabilities` before offering optional request fields. Older
servers may not support control application, variations or region editing.
The default request still creates one image.

## Optional controls

When `control_application.enabled` is true, a text-generation control can include
`apply_to_generation: false`. Its selected value remains in the saved snapshot,
but does not contribute to prompt composition and is not validated as an active
choice. Omitting the flag applies the control as before. Every control may be
inactive; the person's prompt remains required.

Image edits use `apply_to_edit` instead. A text-generation flag does not decide
whether a control changes an edit. Keep inactive values so restoring a saved
result or re-enabling a category recovers its choices.

## Variations

When `variations.enabled` is true, `POST /api/generate-image` accepts integer
`variation_count` from 1 through the advertised `max_count` (currently 4).
Choosing several images must be an explicit action with its count visible before
submission. A count of 1 preserves the single-image response contract.

A request for 2–4 images reserves all its jobs atomically. Insufficient capacity
returns 429 without accepting a partial group. The provider renders serially,
using one shared composed prompt and the action's frozen controls, references
and provider selection. Each result remains a separate saved image with its own
variation index, attempt and provider diagnostics. Different seeds are not a
guarantee of perceptual diversity.

The accepted response includes the existing `generation_job_id` and an additive
`variation_group` with `id`, `count` and `jobs`. Jobs identify their
`generation_job_id`, zero-based `index` and `attempt`. Follow the accepted jobs
or `GET /api/generation-groups/{id}`; reading status never creates work. Group
status is `running`, `complete`, `partial` or `failed`.

Retry only failed slots, after another explicit action. Send the original frozen
request with a new idempotency key, `variation_count` equal to the number retried,
and `retry_variations: {"group_id": "…", "indices": [0]}`. Changed source
settings are refused. Completed siblings are preserved. Replaying an accepted
action's key returns its accepted jobs rather than creating replacements. An
ambiguous network answer must therefore retain the original key and request.

The synthetic response and retry examples are in
[generation-groups.json](../fixtures/api/generation-groups.json).

## Region-focused edits

The `region_editing` capability describes the actual implemented path. Its
`method` is `generated-image-composite` and `native_mask` is false: the model
performs a normal reference edit, then the application keeps generated pixels
only inside the selection. This is not native masked conditioning.

An editing request can include `region_edit` alongside its ordered reference
files. The selection must identify the first reference's original SHA-256 and
EXIF-oriented pixel dimensions. It contains version 1, integer-coordinate
`rectangle` or `brush` shapes, and an optional integer `feather` radius. Published
limits bound dimensions, decoded pixels, shapes, brush points and radii. Invalid,
empty, mismatched or unsupported selections fail before provider work; there is
no text-generation fallback.

Rectangle origins are inclusive and right/bottom edges are exclusive. Brush
circles and paths are clipped to the source canvas. Feathering acts inward only,
so it cannot introduce changes outside the hard selection. A selection too small
to retain effective mask opacity is refused.

The provider output is fitted to the oriented base dimensions using a centered
cover fit before compositing. This does not imply registration between the model
output and the source. The saved output preserves the base's decoded eight-bit
RGBA pixels outside the selection, including transparent pixel channels. It is
a new PNG; original file bytes, encoding and source metadata are not rewritten.

Only the final composite becomes the saved image or preview. Its metadata retains
the selection, source and oriented-pixel hashes, mask hash and encoding, selected
pixel count, bounds, output/provider dimensions, fit policy and compositor
version. Retries and variations bind the complete selection to the frozen
request. See [region-editing.json](../fixtures/api/region-editing.json) for an
independent rectangle mask vector.
