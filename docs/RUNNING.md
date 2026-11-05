# Running ImageDials

Standard development commands support
Windows, macOS and Linux using Node 24.15+ (24.x) or 26+, npm 11.20+ and Python 3.11 or newer.
The npm engine requirement and `engine-strict` prevent older npm versions from
silently ignoring the five-day minimum release age in `frontend/.npmrc`.
CI pins Node 26.12.1 with its bundled npm 11.20.0; older supported Node
versions need a separately compatible npm. Windows/macOS checks are configured
in CI; do not infer they passed from Linux results.

## Environment

Copy `.env.example` to a root `.env`. Both launchers and Vite use the same literal
dotenv parser. Environment variables override file values. Do not use shell commands
or variable interpolation in dotenv values. Quoted paths with spaces and Windows
backslashes are supported; no shell executes this file.

`FRONTEND_PORT` and `API_PORT` must be distinct. `API_UPSTREAM_URL` must be an HTTP(S)
origin with the configured API port. Bind hosts and allowed frontend hostnames are
explicit settings. Browser requests use relative `/api` URLs, which the frontend
proxies to the API. A busy port causes failure instead of automatic reassignment.

`NODE_BIN` optionally overrides the frontend executable; leave it empty to use the
Node running the launcher. `API_PYTHON` optionally overrides the backend interpreter;
leave it empty to select the native interpreter under `backend/.venv`. Every supported
variable is documented in `.env.example`. Never commit `.env` or expose credentials
in browser-prefixed variables.

`MODEL_METADATA_JSON` optionally supplies public model information, keyed by the
exact configured model name. Each entry accepts `publisher`, `detail` and `url`;
URLs must be absolute HTTP(S) links without credentials. The document is limited
to 64 KiB and 128 entries. Missing fields remain empty, and unknown model names
receive no metadata. This information is returned by `/api/models` without
contacting a model provider. Include public information only, never keys or
authenticated URLs. For example:

```dotenv
MODEL_METADATA_JSON='{"example/model-v1":{"publisher":"Example Models","detail":"Image model","url":"https://models.example.test/model-v1"}}'
```

## Portable launch

After dependency installation, run these in separate terminals from the project root:

```text
node scripts/run.mjs api
node scripts/run.mjs frontend
```

The launcher resolves the project directory independently of the current working
directory, uses platform-native virtual-environment paths, passes subprocess arguments
without a shell, and propagates the child exit status. The API health path is
`/api/health`, available through the frontend origin.

The `.sh` launchers are optional POSIX compatibility wrappers. Windows users should
use the Node commands directly; no Bash, WSL, container or service manager is required.

## Optional Linux/systemd integration

`deploy/*.service.in` and `scripts/install-user-services.py` are explicitly Linux-only
adapters. The installer refuses unsupported systems before writing files. It renders
generic templates with the current checkout and Node paths, supports spaces in paths,
and refuses to overwrite differing installed units. It does not start services.

```text
python scripts/install-user-services.py
systemctl --user daemon-reload
systemctl --user enable --now imagedials-api.service imagedials-frontend.service
```

Use `--node` to select a compatible Node executable if needed. Restart these two units
after changing environment settings. Keep rendered units and operational records
private. Other platforms may wrap the same portable commands in their preferred
service manager; those integrations are not currently provided or verified.

## Private deployment configuration

Keep machine-specific instructions in ignored `AGENTS.local.md`, operational scripts
and generated configuration in `.local/`, and private research under `docs/plans/`.
The shared `AGENTS.md` explicitly loads the optional local instructions. Public docs,
examples and workflows must contain only portable instructions and generic values.
Do not commit private endpoints, user paths, network/device inventories or dashboard
configuration. Never force-add ignored records.

## Local continuous checks

Run `python scripts/local_ci.py --force` for a fresh isolated check. The default
workspace is ignored `.local/ci/`; `--work-root` or `IMAGEDIALS_CI_WORK_ROOT` selects
another private workspace. The latest status is `latest.json` in that workspace,
with source fingerprint/revision, platform, per-step outcomes and private log paths.
Unchanged snapshots retain their prior result. Inspect freshness as well as status.

On Linux, `scripts/install-local-ci.py` optionally renders private `.local/ci.env`
and user units from `deploy/imagedials-ci.*.in`. It does not start them. After
reviewing the generated configuration:

```text
systemctl --user daemon-reload
systemctl --user enable --now imagedials-ci.timer
systemctl --user start imagedials-ci.service
```

This timer checks trusted local source once a minute. No network port is needed.
It installs locked packages in a snapshot using the public environment template,
not the running application's settings. The optional GitHub Actions workflow uses
the same gates if a hosted provider is added later. Other operating systems need
their own workers; a local Linux pass is not a cross-platform result.

## Checks

```text
python scripts/ci.py
```

Run backend tests with the installed virtual-environment interpreter from `backend/`.
Verify actual frontend/API health and occupied-port behavior for a deployment. Browser
and tablet evidence belongs in private local storage, not in the public repository.

## Model provider configuration

Configure up to two image and two LLM providers in the root `.env`, using
`IMAGE_MODEL_ENDPOINT_1`, `IMAGE_MODEL_ENDPOINT_2`, `LLM_MODEL_ENDPOINT_1` and
`LLM_MODEL_ENDPOINT_2`. Each has a matching `IMAGE_MODEL_KEY_1/2` or
`LLM_MODEL_KEY_1/2` credential. Use provider base URLs (including an API prefix
when required), and leave credentials blank for unauthenticated services.
Slot 1 is primary; slot 2 is optional, with no implied automatic fallback.

These are backend-only settings; never expose them in frontend variables or
browser responses. The launchers pass root `.env` settings to the API process. A running endpoint
does not establish model residency or successful inference.

## Generation and saved images

Set `IMAGEDIALS_DATA_DIR` to a writable private directory. The API requires it at
startup and stores a SQLite library plus validated PNG originals there. Back up
both together, including any derivative sidecars. Absolute paths are supported;
relative paths resolve from `backend/`. To relocate the library, stop the API
when no jobs are running, copy the complete directory, verify the copies and
database integrity, update `IMAGEDIALS_DATA_DIR` in `.env`, then restart the API.
Verify the saved images before removing the old directory. Completed snapshots
remain available across restarts. Each API worker serializes its generation work;
a shared SQLite transaction bounds the queue and deduplicates submissions across
workers. Workers renew a lease every five seconds. Abandoned jobs become failed
after a 30-second lease expires; starting another healthy worker preserves their
state. Graceful shutdown waits for its work to finish.

Job polling and SSE use the same bounded durable history (up to 64 updates per
job). A validated preview is available before enrichment and remains accessible
if enrichment fails. Only a durable final save publishes a library image and a
`complete` event. Job streams replay retained updates; library streams send new
invalidation signals and retain at most 256 changes for slow subscribers. Both
send keep-alive comments every 25 seconds. Clients must refresh the library after
reconnecting and deduplicate job replays.

The default `IMAGE_PROVIDER=mock` creates labelled geometric test images. To use
ComfyUI, set `IMAGE_PROVIDER=comfyui`, the image endpoint, actual model name, and
`IMAGE_WORKFLOW_PATH`. The workflow file is a ComfyUI API node map. Exact string
values `$prompt`, `$width`, `$height` and `$seed` are substituted recursively with
request values. Keep local model names, paths and workflows in ignored storage.
Use an already qualified installed workflow; the adapter does not download models,
start workers or change shared service settings. A timeout does not cancel the
remote job. PNG output is required and is decoded before publication.

A configured LLM endpoint uses OpenAI-compatible model discovery and chat
completions to generate validated subject controls. Leave it blank for deterministic
mock controls. Provider failures remain visible; there is no silent mock fallback.
Prompt composition uses a separate LLM request with the original idea, mode,
aspect and resolved selected control labels, plus project-owned composition
instructions. The exact LLM response is sent to the image adapter. Without an LLM
endpoint, mock mode composes deterministically. Composition failures stop the job
before image submission. Saved results keep
the original input, resolved prompt, controls, mode, aspect, actual dimensions,
provider/model, creation time and image hash. Reusing a submission key returns the
same job; changing its payload returns a conflict. Failed jobs require a new key.

Canonical generation uses `/api/controls/static`, `/api/controls/dynamic`,
`/api/generate-image` and `/api/generation-jobs/{job_id}`. `/healthz` reports
liveness and the inference gate; model discovery never starts inference. Existing
custom routes remain available during migration. The optional `idempotency_key`
extension makes explicit submission retries safe.

`INFERENCE_ENABLED=false` disables canonical inference actions while preserving
discovery and static controls. `SHARED_LIBRARY_ENABLED` selects the advertised
shared or browser-private source. `DOWNLOAD_ENABLED` and `BROWSER_PRINT_ENABLED`
control the corresponding advertised export actions; external exports are disabled.
`IMAGE_LANDSCAPE_DIMENSIONS`, `IMAGE_PORTRAIT_DIMENSIONS` and
`IMAGE_SQUARE_DIMENSIONS` specify provider-supported requested pixel sizes. Model
discovery exposes these as `supported_dimensions`; saved actual dimensions are
recorded separately. Static controls accept the additive `generation_mode` query
parameter for asset-oriented base controls.

Create remembers the last chosen Landscape, Portrait or Square format in this
browser. New Draft and a page refresh start with no image selected; saved history
is retained. Explicit history selections and edit links restore their complete
saved settings. The format preference does not override the model's configured
pixel sizes. Image import and reference prompting are documented in
[Image editing](IMAGE-EDITING.md).

Deployment capabilities use `APP_ENVIRONMENT` (`local` or `cloud`) and
`EXPERIENCE_PROFILE` (`public` or `event`). `ACTIVE_EVENT_NAME` tags newly saved
images. `GALLERY_EVENT_NAMES` is a JSON array of presentation scopes; the active
event is used when that array is empty. Unknown requested events return 400
instead of broadening a configured scope. These filters provide no authorization.
`APP_BASE_PATH` adds prefixed canonical API aliases while retaining root aliases;
`/healthz` remains root-only. Upload limits also apply to prefixed upload routes.
Frontend route and asset base-path support must be verified for a subpath deployment.

Browser cache budgets and interaction timings are returned in the capabilities
`client_policy` extension. Defaults are shared with browser code in
`shared/client-policy.json`; the `CACHE_*`, `CONTROLS_*`, `JOB_*`, `LIBRARY_*`
and `GALLERY_*` environment variables override them. Byte limits are bytes and
`_MS` durations are milliseconds. All counts/durations/byte budgets must be
positive integers; similarity is a finite ratio from zero to one. Full-detail
JSON uses dedicated `CACHE_SHARED_DETAIL_RECORD_LIMIT` (64 records) and
`CACHE_SHARED_DETAIL_MAX_BYTES` (16 MiB) limits. Page metadata uses
`CACHE_SHARED_PAGE_MANIFEST_LIMIT` (64 manifests), `CACHE_SHARED_PAGE_MAX_BYTES`
(8 MiB), and the shared record count. Image variant bytes have their own budget;
metadata budgets must not be substituted with that image-byte limit. The default
`CONTROLS_SIMILARITY_MINIMUM_RATIO=0.5` resets prompt-specific draft state
when normalized edit similarity reaches or falls below 0.5. Matching uses the
original prompt anchor, with identical normalized text always preserved.
This threshold is independent of the Photography selection probability.

Deletion stages the original, preview and derivatives in a recovery journal
inside the data directory. Database rollback restores all assets; startup
recovery finishes a committed deletion or restores an uncommitted one. A failed
cleanup after commit leaves the image deleted and preserves staged bytes for
the next recovery pass. Back up the complete data directory, including hidden
recovery folders.

When the shared library is disabled, newly generated records keep private
visibility and stay out of shared listings, files and analysis backfills even
if sharing is enabled later. The accepted job still provides its original bytes
for browser persistence. Backend job/media durability remains enabled; this is
a client storage profile, not authentication or a server retention guarantee.

Browser storage follows the source reported by capabilities. Shared listings and
image variants use a bounded IndexedDB cache with ETag validation. Failed reads
retain the cached view and show its stale status. Private generated images and
imports retain their original bytes, thumbnails and metadata in separate bounded
browser history. These copies belong to the current browser origin and profile;
clearing site data removes them. Denied storage falls back to memory with a
notice. A failed write keeps the visible result and offers retry when possible.

“Remove from browser” removes the local entry and its cached files. It does not
delete a generated job's server original. Browser persistence is separate from
server retention and access control.

Private and imported images support explicit watermark analysis, watermarked
PNG download and browser printing when transient analysis is enabled. Preparation
uses the original bytes and this browser's watermark settings, initially read
from the server defaults. The settings panel and Library editor share that local
value; saving it does not change other browsers. The browser stores a separate,
metadata-bearing prepared PNG for reuse; settings or rendering-policy changes
invalidate it. Download and Print use those same bytes. A prepared file that
cannot be stored remains available for the current action with a storage notice.
Printing opens the browser dialog; the app cannot verify physical output. See
[watermark analysis](WATERMARK-ANALYSIS.md).

`API_SHUTDOWN_GRACE_SECONDS` bounds HTTP connection draining during API shutdown
(default 10 seconds). Long-lived event streams are disconnected when the deadline
expires and reconnect after startup. The server may report a nonzero exit when
it cancels those streams; this does not imply an image-generation failure.
Accepted generation work has its own worker lifecycle. Before a managed restart,
check for active jobs and preserve the data directory; the HTTP drain setting
is not permission to interrupt an accepted generation.
