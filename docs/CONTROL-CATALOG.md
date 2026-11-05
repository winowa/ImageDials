# Fixed controls and generated-category context

Fixed category and option identities remain stable as the catalog grows. Saved
image records retain the exact original control kinds, values, custom options
and unknown fields; a catalog update never rewrites their provenance.

Standard Style, Color, Lighting, Composition, Texture and Mood use multi-select
chips. Camera angle and Background use single-choice chips. Asset Material,
Finish, Form, Color, Surface detail, Construction and Lighting allow multiple
attributes; asset View remains a single-choice dropdown. Camera angle and asset
View both include `wide-shot` (Wide shot).

Multi-select values are arrays. A retained initial default becomes a one-item
array; an unset multi-select is `[]`. Older single-choice Control objects remain
valid for generation. Editable restored drafts may adopt the current fixed
catalog presentation and add new fixed choices while preserving their stored
source snapshot. Unknown/generated controls are not converted by display label.

## Edit controls and explicit randomization

`GET /api/controls/static?generation_mode=standard&image_edit=true` returns the
edit catalog. The same editing catalog is available with `generation_mode=trellis`.
Its six fixed controls have versioned `edit-*-v1` IDs: Preserve identity,
Preserve pose, Preserve composition, Background change, Object changes and
Appearance change. Preservation choices name details to prioritize during other
changes; the three text fields accept specific change instructions. They are
prompt instructions, not renderer parameters or guarantees of exact preservation.
Keep selected instructions consistent with the change prompt.

Every fresh edit control starts empty and off (`apply_to_edit: false`). A
person's choice opts the adjustment in; Apply can turn it off while retaining
its value. The existing wire resolver and edit composer resolve selected labels
and omit off adjustments. The catalog adds no mandatory instructions, strength
parameter or automatic model call. Saved edit catalogs, selected values, custom
choices, unknown fields and original snapshots remain intact. Switching tools
keeps each tool's Standard choices; Undo restores the full draft snapshot.

The Standard panel remains visible in every mode. Categories disclose
individually, and the compact bulk action expands or collapses them together.
Text and Asset offer Randomize for Standard selections only. This explicit
operation uses the existing sampler: Style retains its 70% Photography bias;
multi-selects pick one option, then continue with conditional probabilities
50%, 40%, 30%, 20%, 10% and 0%. Single-choice and bounded ranges use the same
shared sampler, including custom options. Free text and unknown kinds stay
unchanged. Randomize retains off flags, records one Undo step, and changes no
prompt, generated control, reference, model request or frozen retry. Edit offers
no randomizer, so it cannot randomly restyle a source image.

## Image-grounded import selections

Text-to-image Load image can obtain initial generated and Standard choices from
actual bounded pixels through the description provider's structured vision API.
The strict eight named slots and existing category/value validators apply;
Standard selections must cover the actual catalog with valid IDs. Unknown,
duplicate, malformed or capped suggestions fail this import analysis rather than
invoking the ordinary random fallback. Generated multi/checkbox values are kept
exactly as observed, including empty arrays. Null leaves a supported control to
the composer. Manual/custom/unknown state is retained losslessly.

These prepared choices survive episode settlement and are reused by the one
automatic text generation and later unchanged Generate submissions. No second
dynamic call, multi sampler or Photography bias runs over them. Explicit
Randomize remains available. Exact embedded snapshots outrank vision selections;
ComfyUI positive prompt text outranks the description while pixels supply controls.
See [import ownership and retries](IMAGE-EDITING.md#importing-an-image-without-editing).

## Initial generation

`POST /api/controls/dynamic` requests one and only one generated control of each
supported kind: slider, dropdown, multi-select, single-select, radio, checkbox,
text-input and binary. The provider's internal schema spells these `range`,
`select`, `multi`, `single`, `radio`, `checkbox`, `text` and `binary`. Configured
model responses with missing, repeated or extra types are rejected as invalid
rather than displaying several sliders. Existing bounded client retries and
base-control fallback still apply; the mock adapter is not real-model proof.

The request accepts optional `categories`, a list of current category summaries.
Only `id` (optional), `label`, `kind` and `description` (optional) enter model
context. Values, option lists and unknown metadata are excluded. At most 30
summaries are accepted. Existing `controls` retain their original meaning and
may remain empty when the client maintains its base controls separately.

The provider also supplies fixed category summaries. It asks for distinct,
subject-specific attributes and avoids duplicating the visual scope of fixed
or current categories. The eight-type restriction applies to this initial
control-generation request only.

Initial generation sends a JSON-schema `response_format` with eight typed array
positions, using the standard structured-output interface described in the
[vLLM documentation](https://docs.vllm.ai/en/latest/features/structured_outputs/).
Values are constrained to their numeric, boolean, text or list type; initial
choice controls have three to five options. Full domain validation still checks
bounds, option identities and the exact type set after decoding.

An endpoint that explicitly rejects schema output with an unsupported-format
400/422 response gets one plain-format compatibility retry. Authentication,
transport and unrelated provider failures do not trigger that downgrade. Plain
responses must still pass the same eight-type validation. The actual format and
fallback status are included in opaque generation metadata. Option expansion
never uses this initial-generation schema.

## More options

`POST /api/add-control-options` continues to accept one bare, complete choice
Control object. An additive context form is also accepted:

```json
{
  "control": {
    "id": "surface",
    "label": "Surface",
    "kind": "multi-select",
    "value": ["woven"],
    "options": { "woven": "Woven" }
  },
  "categories": [{ "id": "color", "label": "Color", "kind": "multi-select" }]
}
```

The target keeps its existing options so new choices can avoid existing keys
and meanings. The other categories are summaries without their options or
values. The expansion prompt expands only the target's choices and contains no
eight-type generation restriction. A wrapper containing only `control` remains
invalid. A bare Control with unknown extension fields named `control` or
`categories` still retains those fields.

The response is the complete updated target, preserving selection and unknown
fields. Context is transport data and is not added to the returned Control.
Each successful expansion appends exactly five new choices as one alphabetized
batch. Existing option order and values stay unchanged. Duplicate keys and
display labels are excluded after case, spacing and punctuation normalization.
Send the updated complete Control on subsequent clicks so earlier additions are
excluded too.

The provider is asked to avoid repeated meanings and choices outside the target's
scope. Its internal response can use a typed options array, constrained through
the standard JSON-schema response format; the public response remains an options
map. At most two generation attempts fill the requested batch. Only an explicit
unsupported-format response permits retrying without the schema. An outage is
not a reason to substitute mock choices. If five distinct valid choices cannot
be obtained, the endpoint returns 502 without a partial update.

Shared native fixtures are in `fixtures/api/expanded-static-controls.json` and
`fixtures/api/control-context.json`; `fixtures/api/option-expansion.json` covers
two successive five-choice batches. Frontend integration and actual-provider
qualification are recorded separately from these contracts.

## More controls

`POST /api/controls/additional` is additive. Send `prompt`, `generation_mode`
(`standard` or `trellis`), and `categories` containing the current category
descriptors. Include all fixed, generated and custom categories, with their
labels and descriptions; their values and option lists are excluded from model
context. Optional `count` is 1–5, default 3. A batch is reduced to the remaining
capacity near the 30-control total limit; at capacity the endpoint returns 400.
Request bodies are limited to 65536 bytes.

The response contains only new `controls` and an opaque
`additional_controls_metadata` object. Append controls in response order while
preserving existing selections, options, unknown fields and original order.
Unlike initial generation, additions can use any relevant supported kind,
including repeated kinds. Normalized duplicate IDs and labels are excluded.
The prompt also excludes existing visual scopes. A separate structured model
review compares current and proposed descriptors to reject scope synonyms,
retaining the earlier proposal when two new controls overlap. This semantic
review is probabilistic; exact identity checks and domain validation remain
deterministic. Review failure never silently accepts the proposals.

At most two generation attempts fill the batch, each with at most one scope
review. Rejected scopes and invalid selected IDs are fed back for the missing
part of the next attempt. The public response is all-or-nothing: an incomplete
batch or invalid review returns 502 and leaves existing controls unchanged.
Inference disabled returns 503. Schema fallback follows the explicit
unsupported-format rule above. There is no mock substitution for an upstream
failure. Current descriptors are sent without options during both stages.

For provenance, append each returned metadata object to the optional
`additional_controls_metadata` list in `/api/generate-image`. Keep the initial
`dynamic_controls_metadata` object unchanged. The additive list is retained
without interpreting unknown fields in the saved record and embedded PNG.
Empty additive metadata preserves earlier idempotency fingerprints; a nonempty
list participates in request identity. Saved-image restore must retain the list
when building a new draft. Shared fixtures: `fixtures/api/additional-controls.json`.
