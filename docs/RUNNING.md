# Running ImageDials

The application is currently a scaffold. Standard development commands support
Windows, macOS and Linux using Node 24.15+ (24.x) or 26+ and Python 3.11 or newer.
Windows/macOS checks are configured in CI; do not infer they passed from Linux results.

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
