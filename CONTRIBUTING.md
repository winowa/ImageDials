# Contributing

ImageDials is currently a scaffold. See [README.md](README.md) for supported runtimes,
environment setup and launch commands.

## Install and check

Create `backend/.venv`, install `backend/requirements-dev.txt` with that interpreter,
and run `npm --prefix frontend ci`. Python requirements enforce artifact hashes;
JavaScript installs retain the native five-day release-age gate.

Run the common quality gates from the project root:

```text
python scripts/ci.py
```

The command uses `backend/.venv` when available, or the current Python interpreter.
Use `--python` for another environment with the locked development dependencies.
It checks privacy, Python lock/export consistency, formatting, lint, tooling tests,
frontend tests/build and backend tests. The optional GitHub Actions matrix and local
CI runner invoke this same command. Report which platforms actually ran.

Format code and docs before checking:

```text
npm --prefix frontend run format
```

Run `python -m ruff check --fix .` and `python -m ruff format .` with the development
interpreter for Python formatting and import ordering. Formatting/lint changes
should accompany the behavior they support rather than obscure unrelated changes.

## Dependency updates

Edit Python direct dependencies in `pyproject.toml`, then run the pinned `uv lock`.
Export both hashed pip locks with the pinned development interpreter:

```text
python -m uv export --frozen --no-dev --no-emit-project --no-header -o backend/requirements.lock
python -m uv export --frozen --all-groups --no-emit-project --no-header -o backend/requirements-dev.lock
```

Check in `pyproject.toml`, `uv.lock` and both exports together. Do not edit generated
hashes manually. Normal installs consume the existing locks and do not resolve new
versions. Commit frontend `package.json` and `package-lock.json` together; keep the
minimum release-age setting in `frontend/.npmrc`.

## Privacy and local configuration

Read `AGENTS.md` and, when present, ignored `AGENTS.local.md`. Never write private
deployment details into Git-visible files, even temporarily: development tools may
snapshot uncommitted files. Keep actual configuration in `.env`, operational files in
`.local/`, and private plans under ignored `docs/plans/`. Public templates use generic
localhost defaults and no credentials.

```text
python scripts/check_privacy.py --scope all
python scripts/install-hooks.py
```

The optional hook installer uses the current Python interpreter; run it with the
locked development interpreter so the pre-push CI gate has its dependencies. It
refuses to overwrite unrelated hooks. Pre-commit scans files, staging and all stored
Git objects; pre-push runs the common gates. Hooks do not intercept every automatic
checkpoint and are not a substitute for ignoring private files before creation.

For additional local identifiers, create ignored `.local/publication-denylist.json`
with `literals` and/or `patterns` arrays. Values never belong in tracked configuration.
Checks print finding locations and categories, not matching private content. They
are heuristic safeguards: review the staged diff, intended publication refs, build
artifacts and dependency changes as well. If a finding is already in history, stop
publication and follow the authorized cleanup procedure in `AGENTS.md`.

## Commits and reviews

Use cohesive, tested commits that describe a functional checkpoint. Fold immediate
related corrections into the preceding unpublished checkpoint when authorized.
Keep unrelated work separate and do not rewrite shared history without approval.
PR descriptions should explain the resulting behavior, checks run and remaining
limitations. Never include private logs, endpoints or configuration in a PR.

## Local continuous checks

No hosted CI account is required for:

```text
python scripts/local_ci.py --force
```

The runner audits the source repository, copies only Git-visible files into a private
immutable snapshot, creates a fresh Python environment, installs locked dependencies,
uses `.env.example` instead of the live `.env`, and runs the common gates. Reports
and per-step logs default to ignored `.local/ci/`. A SQLite lock prevents overlapping
runs, including after a crashed runner releases its process lock.

Set `IMAGEDIALS_CI_WORK_ROOT` or `--work-root` to select private storage. A local timer
can invoke the runner periodically; unchanged snapshots retain their previous result.
Use it only for trusted local source. It is not an isolated runner for untrusted PRs.
Linux checks cannot establish Windows or macOS compatibility; those require workers
running those operating systems or the optional hosted matrix.
