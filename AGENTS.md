# ImageDials

Before working, read `AGENTS.local.md` if it exists. It contains optional project-scoped private instructions and is intentionally ignored by Git. Keep this shared file complete for contributors who do not have a local overlay. Do not create `AGENTS.override.md` just to add local settings, because it can replace this directory's shared instructions in agents that support that filename.

Project agent skills belong in `.agents/skills/<name>/SKILL.md` with YAML `name` and `description` frontmatter. Keep each skill limited to project-relevant implementation guidance; do not create a parallel top-level `skills/` directory.

For ImageDials implementation guidance, read [.agents/skills/imagedials/SKILL.md](.agents/skills/imagedials/SKILL.md).

Prefer `YYYY-MM-DD-short-description` names under `docs/plans/`. Use a directory for a detailed plan with separate progress, tasks, scripts or evidence; use a standalone `YYYY-MM-DD-short-description.md` directly under `docs/plans/` for a smaller plan. Treat `docs/plans/` as a collection of plans, not one plan's working directory. Local research and screenshots remain ignored; do not force-add them. Track only project specifications and skills intended for contributors. Record observations separately from implementation proposals and unverified assumptions.

## Runtime configuration

Use the repository-root `.env` as the shared runtime source for both frontend and API. Document every added variable in `.env.example`, with a comment unless its meaning is obvious. Never commit `.env` or put credentials in frontend-exposed variables.

Do not hard-code deployment ports, bind addresses, hostnames, API upstreams, provider URLs, or data locations in application code, launch scripts, or service units. Read appropriate environment variables and fail clearly on missing/invalid values. Keep frontend/API ports distinct and use strict port binding; never silently select another port. Keep `API_UPSTREAM_URL` consistent with `API_PORT`. The browser should use relative `/api` URLs.

Before starting or publishing services, inspect current listeners and routing reservations. Do not stop another service to free a preferred port. Use `node scripts/run.mjs api` and `node scripts/run.mjs frontend`; update `.env.example` and generic deployment documentation when configuration changes. Update local plan progress as work proceeds.

## Multi-platform support

Support Windows, macOS and Linux for installation, configuration, development, tests and builds. Keep the normal launch path independent of Bash, POSIX-only utilities, systemd, fixed filesystem layouts and local infrastructure. Use portable runtime APIs, native path handling, argument arrays and subprocesses without shell interpolation; handle spaces and Unicode in paths. Parse dotenv files as data, never execute them as shell scripts. Document prerequisite runtime versions and OS-specific virtual-environment paths.

Keep platform-specific service-manager adapters optional, explicitly labelled and guarded against use on unsupported systems before any writes. Test portable configuration and launch behavior on all three OS families in CI. Do not claim a platform was verified unless its checks actually ran; record local-only verification accurately.

## Required quality gates

Use `python scripts/ci.py` as the common quality gate for local development, local continuous checks and optional hosted CI. Install the locked development dependencies first; pass `--python` if selecting another development interpreter. Do not maintain separate competing command lists across runners. The shared gate covers privacy, lock/export consistency, format, lint, tests and build output.

Before staging or creating a commit/checkpoint, run `python scripts/check_privacy.py --scope all` and review the intended diff. Before pushing or declaring a code change complete, run the common gate. Install the optional local hooks with the development interpreter using `scripts/install-hooks.py`; do not replace unrelated hooks. Automatic checkpoints can bypass hooks, so ignored-first handling remains mandatory.

Python dependency changes must update `pyproject.toml`, universal `uv.lock` and both hashed `backend/requirements*.lock` exports together, using the pinned development tool version. Normal installs must consume the existing locks and verify hashes. JavaScript changes must keep `frontend/package.json`, its lock and the native minimum-age setting consistent. Use Ruff for Python and Prettier/Oxlint for JS/docs; apply `.editorconfig` and `.gitattributes`.

Local CI must test an immutable snapshot of Git-visible source using the public environment template, isolated dependency environments and caches, and a source fingerprint in its results. Never copy live `.env`, personal instructions, private skills or operational evidence into a build snapshot. Store actual worker paths, service configuration, logs and reports only in ignored local storage. A passing Linux run is not proof of Windows/macOS execution.

## Private configuration and publication

Never commit anything specific to an individual machine, account, private network or homelab. This includes real hostnames/IP addresses, usernames, absolute installation/storage paths, device inventories, assigned service ports/IDs, local service instances, routing/dashboard configuration, deployment backups, private screenshots, logs and operational skills. These details must live only in Git-ignored `.env`, `.local/`, or `docs/plans/` storage. Never force-add them or place them in tracked docs, examples, tests, workflows, application code, bundles or public artifacts.

Track only generic, portable configuration templates with safe localhost defaults or clearly fictional examples. Keep generic platform adapters separate from private rendered configuration. When creating a new kind of local artifact, add an appropriate ignore rule before writing it. Before staging or committing, inspect tracked files, newly added candidates and the staged diff for private details and secrets; `.gitignore` does not protect already tracked files. If private data is found, remove it from publishable files and verify whether history or built artifacts also need remediation. Do not publish, push or rewrite history without the relevant authorization.

## Checkpoint-safe private data handling

Assume the development application may automatically commit uncommitted and untracked files into checkpoint refs. Keeping a value out of a normal commit is insufficient: never write private details into Git-visible files, even temporarily. Establish and verify the ignore rule with `git check-ignore` BEFORE writing a local artifact. Verify private files are also absent from `git ls-files`; an ignore match does not untrack existing content. Write public templates and documentation from sanitized requirements rather than copying a private file and cleaning it afterward.

Before staging, committing, checkpointing, exporting or publishing, review all Git-visible candidate files and the staged diff, plus generated bundles and any publication archives. Before publishing history, inspect all refs, including development-tool checkpoints, reflogs and unreachable objects; checking only the default branch is insufficient. Never use an all-refs mirror or export a local Git directory without this review. Ignore rules and commit hooks are additional safeguards, not proof that checkpoints or old objects are clean.

If private content enters Git, stop publication and report it. After obtaining authorization for the specific history cleanup, preserve the affected source files and hashes as ordinary files in verified ignored storage. Remove or sanitize affected refs, determine exact object reachability, and purge only the authorized private objects while preserving shared clean objects and unrelated work. Verify the old content is no longer retrievable, scan remaining objects and refs, and run `git fsck`. Keep remediation manifests and raw private evidence ignored; never create a publishable backup ref or Git bundle that retains the data. Do not claim remote copies, application backups or other clones were cleaned without verifying them separately.
