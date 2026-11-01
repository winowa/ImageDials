---
name: imagedials
description: Implement the ImageDials prompt-to-controls-to-image workflow, including dynamic control generation, prompt composition, saved-result restoration, gallery and print-library behavior.
---

# ImageDials implementation

Implement ImageDials with a React/Vite frontend and FastAPI backend. Use this skill for the project's image-prompt workflow, not deployment or general agent configuration. Read the relevant task within the applicable dated plan directory under `docs/plans/` when local planning notes are available; this skill remains usable without those ignored notes.

## Prompt pipeline

1. Accept an image idea, aspect ratio and mode in an editable draft.
2. Generate subject-specific control categories from that idea. Keep these separate from fixed controls that are always available.
3. Validate the category schema and resolve selected values before composing a final image prompt using project-owned templates.
4. Generate an image through a configurable provider, save its bytes and generation snapshot, then select that result in the viewer and saved library.
5. Control edits change the draft. Regenerate produces a new saved result without rewriting the previous result's provenance.

Keep control generation, prompt composition and image rendering behind separate provider interfaces. Start with deterministic mock providers for development and state-transition tests; distinguish mock results from actual inference results.

## Control model

- Give categories and options stable IDs independent of display labels. Store label, description, input type, selected value, options or numeric bounds, and generated/fixed/custom origin.
- Support numeric ranges, single-choice chips, multi-choice chips and select menus. Validate each value against its type; reject malformed provider output with a recoverable error.
- Support custom choices, additional generated options, category removal, generated-category refresh and fixed-control reset. Preserve valid selections when expanding option lists.
- Standard fixed categories cover style, color, lighting and composition. Asset-image mode uses material, finish, form and view controls plus subject-specific categories. This mode prepares an image; it does not imply mesh generation or 3D export.
- Use portrait 2:3, landscape 3:2 and square 1:1, with landscape as the initial selection. Actual pixel dimensions are provider configuration and must be saved with the output.

## Draft, job and result state

Maintain distinct editable drafts, asynchronous jobs and immutable saved results. Associate every job with a draft revision so delayed responses cannot overwrite newer edits. Represent control generation, prompt composition, rendering, saving, ready and failed states accurately. Controls may become available before the image completes.

Disable blank-prompt and duplicate submission. Preserve the last valid image and draft selections on recoverable failure. Make retries idempotent so they cannot create duplicate saved records. Publish a completed result only after valid image bytes and matching metadata are durably stored.

Save original input, resolved prompt, selected controls, mode, aspect, actual dimensions, provider/model identity, timestamps and result title together. Image thumbnails, expanded views, downloads and derivatives must refer to that same result. Editing a saved image restores its complete snapshot into a new draft. Changing a draft's aspect or mode must not relabel the old image's actual properties.

## Workspaces

| Route      | Implementation requirements                                                                                                                                                                   |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`        | Prompt editor, aspect/mode selection, fresh draft, idea assistance, dynamic and fixed controls, generation/refinement, result viewer, prompt provenance disclosures and saved-image carousel. |
| `/gallery` | Saved-image slideshow, orientation filters, current selection, play/pause, speed, transitions, watermark visibility, hideable controls/carousel and image metadata.                           |
| `/print`   | Metadata search, card density, page size and pagination, image details, download/edit, watermark settings, explicit print and delete actions.                                                 |

Gallery filters must distinguish zero matches from an empty library. Keep playback and carousel selection synchronized and clean up timers when changing routes or eligible images. Respect reduced motion for transitions. Library search must clamp pagination after the result set changes; closing a detail view should retain browsing context.

Watermark editing needs a cancellable draft and previews before saving. Text supports at most four lines of sixteen characters per line; define Unicode counting consistently. If SVG mode is implemented, validate or sanitize it without permitting active or external content. Bind derivatives to the source image and watermark-config version, never overwrite the source. Printing and deletion require explicit actions; implement a mock print adapter before real device integration.

## Implementation checks

Test dynamic input types and validation, selection-preserving option expansion, stale-job rejection, recoverable failures, retry idempotency, durable save/reload, saved-draft restoration, image identity across views/downloads, gallery filtering/timers, library pagination and watermark cancel/save. Use original test prompts and fixtures. Write new component structure, schemas, copy, templates and assets with project-owned code and content.
