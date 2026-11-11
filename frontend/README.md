# ImageDials frontend

React 19 and Vite. Runtime configuration comes from the repository-root `.env` (see the [running guide](../docs/RUNNING.md)); the browser only calls relative `/api` URLs. Run the commands below from `frontend/`.

```text
npm test                       # all Vitest suites (jsdom unless a file says otherwise)
npx vitest run src/features/gallery          # one feature
npx vitest run tests/integration             # cross-feature workflows
npm run build                  # production bundle (frontend/dist, ignored by Git)
```

## Layers and imports

The usual dependency direction is `shared` ← `data` ← `features` ← `app`, with the explicit exceptions below. Every import is an explicit relative path; there are no aliases, barrel files or generic `components/`, `hooks/` or `utils/` folders. A directory holds everything one subject needs: components, hooks, pure rules, styles and their focused tests.

| Layer       | May import                                   | Notes                                                                                                          |
| ----------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `shared/`   | `shared/` only                               | Generic UI, JSON viewer, diagnostics and browser helpers. Nothing here knows an image, a control or a route.   |
| `data/`     | `shared/`, `data/`                           | HTTP, storage, records and media. It never imports `app/`, and never a feature component or hook (list below). |
| `features/` | lower layers, other features, two app leaves | One user-facing subject each. Another feature is imported only along the edges in the architecture test.       |
| `app/`      | everything                                   | Composition: routes, discovery, the studio state hook and the header.                                          |

`tests/architecture/dependencies.test.js` enforces these rules, the allowed feature-to-feature edges and the absence of import cycles. Change a rule there and here together.

Intentional exceptions:

- Features use the pure URL and capability helpers exported by `app/routes.js` and `app/discovery.js`. The discovery module also owns the stateful `useDiscovery` hook used by app orchestration; features do not consume that hook.
- Pure, React-free feature modules that `data/` imports: the watermark geometry and renderer (the private thumbnail and the overlay draw with the one renderer), `privateWatermark.js` (private watermark state beside the stored record), `controls.js` (browse filters) and `controlPresets.js` (the preset store persists its wire shape).
- `create` and `results` depend on each other: the generator embeds the result viewer, and the viewer re-submits through the pure draft-to-request rules (`submission.js`, `outputFraming.js`). No other feature pair is mutual.

## Map

| Directory              | Owns                                                                                                                                                           |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main.jsx`         | Entry: mounts `app/App.jsx` and the stylesheet manifest.                                                                                                       |
| `app/`                 | `App.jsx` (shell, header, routes), `studio.js` (`useStudio`, the generator state), `app/studio/*` (parts of it), routing, discovery, model pills.              |
| `features/create`      | Prompt editor, ideas, import, draft undo, history ledger and reveal, request building (`submission.js`), split panel, walkthrough.                             |
| `features/controls`    | Fixed and generated controls, selection provenance and intent, retention on refresh, prompt anchoring, standard randomization. `presets/` holds saved presets. |
| `features/references`  | Reference uploads, composition, kept originals, reordering, region editor, draft reference persistence.                                                        |
| `features/results`     | Viewer, comparison, full view, downloads, variations, model-call inspector, annotation actions.                                                                |
| `features/gallery`     | Slideshow, filmstrip, shuffle sessions, effects and transitions, hidden-chrome layout.                                                                         |
| `features/library`     | Search, paging, change sync, annotations and collections, delete confirmation, card motion.                                                                    |
| `features/watermarks`  | Settings editor, geometry, SVG checks, renderer, local prepare service, bulk analysis, explicit printing.                                                      |
| `features/settings`    | Settings dialog and browser-private provider overrides UI.                                                                                                     |
| `features/appearance`  | Theme state, Accent Lab and the appearance menu.                                                                                                               |
| `features/credentials` | Content Credentials reader and disclosure.                                                                                                                     |
| `data/api`             | The one HTTP client, client policy, provider override transport, job state machine and job event stream.                                                       |
| `data/storage`         | IndexedDB (`cacheDb.js`), the cache store composition and its shared, variant and private parts, durable domain stores, private history and library windows.   |
| `data/records`         | Saved-image identity and view data, exact-record pool, browse policy, measured sizes, display labels.                                                          |
| `data/media`           | Original bytes, cached variants, object-URL ledger, private media leases, thumbnails, `SavedImg` and the watermark overlay.                                    |
| `shared/ui`            | Icons, tooltips, popovers, disclosure, modal, segmented control, result menu, strip keys.                                                                      |
| `shared/json`          | JSON tokenizer, tree, viewer and resize handle.                                                                                                                |
| `shared/diagnostics`   | Diagnostic records, sanitization and the error details control.                                                                                                |
| `shared/browser`       | Preferences with in-memory fallback, shared runs, date formatting.                                                                                             |
| `styles/`              | Fonts, tokens, base and the manifest `index.css` (see Styles).                                                                                                 |
| `tests/integration`    | Cross-feature workflows that mount the whole app or span features.                                                                                             |
| `tests/helpers`        | Shared test support: API fakes, in-memory IndexedDB, control UI helpers, stylesheet reader.                                                                    |
| `tests/architecture`   | Layer, edge and cycle checks.                                                                                                                                  |

Canonical JSON contracts live in the repository-level `fixtures/` and `shared/` directories; tests import them from there rather than copying them. `proof/cacheScenarios.js` exercises the real cache modules against native IndexedDB from a browser page.

## Core workflow: prompt → controls → job → result

1. **Draft.** `features/create/Create.jsx` edits the draft held by `useStudio` in `app/studio.js`. Every edit bumps a draft revision; async work records the revision it started from, so a late answer cannot overwrite newer input.
2. **Controls.** A settled prompt asks for subject-specific controls in the background (`app/studio/controlRequests.js`, bounded retries, stale-response protection by prompt anchor in `features/controls/promptAnchor.js`). They are kept apart from the fixed controls. Refresh keeps valid selections (`controlRetention.js`); `selectionProvenance.js` records who decided each value.
3. **Submit.** `features/create/submission.js` freezes the draft into one request (original idea, original and resolved selections, size, references). One submission can wait for or reuse the background controls request.
4. **Job.** `data/api/jobs.js` is the state machine; `data/api/jobStream.js` observes an accepted job over its event stream and falls back to polling. Status recovery never resubmits an accepted job. Retrying an uncertain submission reuses its frozen request and idempotency key; an explicit new generation or failed-variation retry uses a new key.
5. **Result.** `features/results/Viewer.jsx` shows the saved result and its provenance. Completion publishes only after valid bytes and metadata are stored. `features/library` and `data/storage` keep the history strip and library current; browser-private results use `data/storage/privateHistory.js` and never touch the shared library.

## Styles

`styles/index.css` is a manifest of `@import` lines. **Its order is the cascade**: the files are concatenated exactly in that order, and the production CSS is byte-identical to the former single stylesheet. A rule that must override another has to stay after it. Component styles that belong to one component sit beside it and are imported by that component (before the manifest, as before); larger feature and shared sections sit in their feature or `shared/ui` directory and are listed in the manifest.

`tests/helpers/styles.js` (`readStylesheet`) inlines the manifest for tests that guard rule order, specificity or `@media` blocks (`src/styles/*.test.js`, `fonts.test.js`, `appearance.test.js`).

## Tests

- **Next to the code**: unit and component tests for one module or feature, such as `data/storage/cachePrivate.test.js` or `features/gallery/galleryPlayback.test.js`.
- **`tests/integration`**: tests that mount `App`/`useStudio` or cross feature boundaries, named for the behavior (`ControlGenerationLifecycle`, `LiveUpdatesAndJobTransport`, `HistoryLibraryBrowsing`, `PrivateHistoryWorkflow`, …).
- **Where to look**: control generation and retention → `features/controls`, `tests/integration/ControlGenerationLifecycle`; job/stream transport → `data/api`, `tests/integration/LiveUpdatesAndJobTransport`; private versus shared history → `data/storage`, `tests/integration/PrivateHistoryWorkflow`; watermark workflow → `features/watermarks`, `tests/integration/WatermarkWorkflow`.
- Run everything with `npm test`, or the shared gate from the repository root: `python scripts/ci.py`.

## Known boundary: `app/studio.js`

`useStudio` is still one large hook. Its draft edits, option expansion, generated and base controls, submission and job tracking, restore, import and reference sections share about forty mutable refs (revision counters, abort controllers, the live draft mirror, episode state) and setters. The project's lint rules (`react-hooks/exhaustive-deps`, `react/immutability`) cannot verify refs and setters that arrive as hook parameters, and they forbid mutating ref parameters, so moving those sections into separate hooks would first need a single owner per ref with imperative accessors. Only the parts that depend on plain values were extracted (`app/studio/`).
