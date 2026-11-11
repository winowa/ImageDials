# ImageDials

Before working, read `AGENTS.local.md` if it exists. It contains optional project-scoped private instructions and is intentionally ignored by Git. Keep this shared file complete for contributors who do not have a local overlay. Do not create `AGENTS.override.md` just to add local settings, because it can replace this directory's shared instructions in agents that support that filename.

Project agent skills belong in `.agents/skills/<name>/SKILL.md` with YAML `name` and `description` frontmatter. Keep each skill limited to project-relevant implementation guidance; do not create a parallel top-level `skills/` directory.

For ImageDials implementation guidance, read [.agents/skills/imagedials/SKILL.md](.agents/skills/imagedials/SKILL.md).

## Runtime configuration

Use the repository-root `.env` as the shared runtime source for both frontend and API. Document every added variable in `.env.example`, with a comment unless its meaning is obvious. Never commit `.env` or put credentials in frontend-exposed variables.

Do not hard-code deployment ports, bind addresses, hostnames, API upstreams, provider URLs, or data locations in application code, launch scripts, or service units. Read appropriate environment variables and fail clearly on missing/invalid values. Keep frontend/API ports distinct and use strict port binding; never silently select another port. Keep `API_UPSTREAM_URL` consistent with `API_PORT`. The browser should use relative `/api` URLs.

## Multi-platform support

Support Windows, macOS and Linux for installation, configuration, development, tests and builds. Keep the normal launch path independent of Bash, POSIX-only utilities, systemd, fixed filesystem layouts and local infrastructure. Use portable runtime APIs, native path handling, argument arrays and subprocesses without shell interpolation; handle spaces and Unicode in paths. Parse dotenv files as data, never execute them as shell scripts. Document prerequisite runtime versions and OS-specific virtual-environment paths.

Keep platform-specific service-manager adapters optional, explicitly labelled and guarded against use on unsupported systems before any writes. Test portable configuration and launch behavior on all three OS families in CI. Do not claim a platform was verified unless its checks actually ran; record local-only verification accurately.

## Responsive layout and input requirements

Every UI change must preserve usable desktop, mobile and tablet layouts in both portrait and landscape. Both orientations are required acceptance targets, not optional polish. These requirements apply whether or not a contributor has `AGENTS.local.md`.

Use generic responsive CSS, flexible layouts, relative sizing and content-driven breakpoints. Do not hard-code device model checks, physical display dimensions or device-specific CSS rules. Check intermediate widths and reduced usable heights as well as these CSS viewport fixtures:

- Desktop: 1280×800, 1440×900 and 1920×1080, plus portrait windows such as 900×1440.
- Touch-enabled tablet: 800×1280 and 876×1400 portrait; 1280×800 and 1400×876 landscape.
- Mobile: narrow phone layouts in both orientations, including widths smaller than the tablet fixtures.

These are CSS viewport fixtures, not physical device resolutions. For physical-device checks, record the actual CSS viewport, scale and available height instead of deriving them from native screen dimensions. Account for browser chrome and the on-screen keyboard.

Check readable text, aligned controls, reachable popovers, working media, usable comparisons and no accidental page-wide horizontal overflow. Rotate the same session and retain drafts, selection, focus and review context. Exercise the history carousel and expanding panels. Resizing and orientation changes during rapid input, async arrivals or interrupted transitions must not cause flicker, stale content, trapped focus, accidental scrolling or blocked input.

### Mouse, keyboard and touch

Support mouse, keyboard and mobile/touchscreen interaction with semantic controls and meaningful accessible labels. Do not require hover, precision-only targets or mouse-only dragging for essential actions. Provide accessible alternatives for essential dragging and gestures. Use at least 44×44 CSS-pixel effective touch targets, adequate spacing and visible focus.

Every tooltip must be custom-styled with popover behavior. Do not use native browser `title` tooltips, including on icon-only controls. Provide accessible names through labels or `aria-label`; a tooltip must not be the only way to identify an action.

Tooltips and popovers must support mouse hover, keyboard focus and an explicit tap/click affordance. Support Escape, outside click/tap and a suitable repeat-trigger dismissal. Keep popovers within the viewport and outside clipping from scrolling containers. Interactive popovers must allow focus and pointer movement into their contents without disappearing, with appropriate popover/dialog semantics rather than interactive controls inside an ARIA tooltip. Essential information and actions must not require hover or long-press.

Verify actual click, hover, focus, tap, scroll and relevant drag/slider behavior. Check dismissals, nested scrolling, touch scrolling versus dragging, and popover positioning in both orientations. Use touch-enabled browser contexts and touch APIs in emulation; mouse clicks in a resized desktop window do not qualify as touchscreen verification. Record emulation separately from physical-device tests and do not claim unexecuted checks passed.

## Motion and transitions

Treat motion as a core requirement on every UI task. Intentionally consider transitions for controls appearing, changing or being removed; panel collapse/expand; images entering or leaving the history carousel; selection changes; popovers; dialogs; route/view changes; and loading, success and error states.

Choose motion that communicates the action: coordinated entrances/exits, spatial continuity, deliberate timing and responsive feedback. Do not apply one generic fade everywhere. Animate additions, removals and surrounding rearrangement when they help the user follow a change. Keep motion fluid, performant and restrained for repeated use, without delaying the response to input.

Support interrupted/reversed transitions, rapid repeated input and async arrivals without flicker, stale content, trapped focus, accidental scrolling or blocked input. Follow the responsive and input verification requirements above. Honor `prefers-reduced-motion` with immediate changes or gentle alternatives that preserve functionality; avoid distracting loops, flashing and excessive movement. When animation would obstruct usability or accessibility, simplify or omit it deliberately and record why in the task notes.

## Required quality gates

Use `python scripts/ci.py` as the common quality gate for local development, local continuous checks and optional hosted CI. Install the locked development dependencies first; pass `--python` if selecting another development interpreter. Do not substitute a weaker manual checklist or maintain separate competing command lists across runners. The shared gate covers privacy, lock/export consistency, format, lint, tests and build output.

Before staging or creating a commit/checkpoint, run `python scripts/check_privacy.py --scope all` and review the intended diff. Before pushing or declaring a code change complete, run the common gate. Install the optional local hooks with the development interpreter using `scripts/install-hooks.py`; do not replace unrelated hooks. Automatic checkpoints can bypass hooks, so ignored-first handling remains mandatory.

Python dependency changes must update `pyproject.toml`, universal `uv.lock` and both hashed `backend/requirements*.lock` exports together, using the pinned development tool version. Normal installs must consume the existing locks and verify hashes. JavaScript changes must keep `frontend/package.json`, its lock and the native minimum-age setting consistent. Use Ruff for Python and Prettier/Oxlint for JS/docs; apply `.editorconfig` and `.gitattributes`.

Local CI must test an immutable snapshot of Git-visible source using the public environment template, isolated dependency environments and caches, and a source fingerprint in its results. Never copy live `.env`, personal instructions, private skills or operational evidence into a build snapshot. Store actual worker paths, service configuration, logs and reports only in ignored local storage. A passing Linux run is not proof of Windows/macOS execution.

Verify the actual source fingerprint, platform and step logs before reporting a CI run as passing for the current source. Run local CI automation only against trusted source.

## Clean commits

Keep commits cohesive checkpoints of working functionality. Group related implementation, tests and documentation into a reviewable unit. Avoid a trail of tiny incremental commits unless a small standalone change is independently useful. Check the relevant tests and intended staged diff, exclude unrelated edits and private data, and describe the resulting behavior in the commit message.

If an immediate fix or user-requested adjustment belongs to the same functional checkpoint as the preceding unpublished commit, amend that commit rather than creating a separate correction commit, provided committing is authorized and its contents are understood. Preserve existing work and authorship; do not fold unrelated changes into it. Adjacent unpublished correction commits may be consolidated only when they belong to that same checkpoint and no intervening work would be lost.

Do not amend or squash published/shared history, another contributor's work or unrelated commits without explicit authorization for that rewrite. Never force-push merely to make history look cleaner. Inspect branch history and publication status before amending; if publication status cannot be established, do not assume rewriting is safe. These rules do not authorize commits or pushes that were not otherwise requested.

Use the configured Git author/committer identity. Do not change identity settings or override authorship without the user's instruction. Keep actual identity values in local Git configuration, not public project instructions or examples.

## Private configuration and publication

Never commit anything specific to an individual machine, account, private network or homelab. This includes real hostnames/IP addresses, usernames, absolute installation/storage paths, device inventories, assigned service ports/IDs, local service instances, routing/dashboard configuration, deployment backups, private screenshots, logs and operational skills. These details must live only in Git-ignored `.env`, `.local/`, `docs/local/`, or `docs/plans/` storage. Never force-add them or place them in tracked docs, examples, tests, workflows, application code, bundles or public artifacts.

Track only generic, portable configuration templates with safe localhost defaults or clearly fictional examples. Keep generic platform adapters separate from private rendered configuration. When creating a new kind of local artifact, add an appropriate ignore rule before writing it. Before staging or committing, inspect tracked files, newly added candidates and the staged diff for private details and secrets; `.gitignore` does not protect already tracked files. If private data is found, remove it from publishable files and verify whether history or built artifacts also need remediation. Do not publish, push or rewrite history without the relevant authorization.

## Checkpoint-safe private data handling

Assume the development application may automatically commit uncommitted and untracked files into checkpoint refs. Keeping a value out of a normal commit is insufficient: never write private details into Git-visible files, even temporarily. Establish and verify the ignore rule with `git check-ignore` BEFORE writing a local artifact. Verify private files are also absent from `git ls-files`; an ignore match does not untrack existing content. Write public templates and documentation from sanitized requirements rather than copying a private file and cleaning it afterward.

Before staging, committing, checkpointing, exporting or publishing, review all Git-visible candidate files and the staged diff, plus generated bundles and any publication archives. Before publishing history, inspect all refs, including development-tool checkpoints, reflogs and unreachable objects; checking only the default branch is insufficient. Never use an all-refs mirror or export a local Git directory without this review. Ignore rules and commit hooks are additional safeguards, not proof that checkpoints or old objects are clean.

If private content enters Git, stop publication and report it. After obtaining authorization for the specific history cleanup, preserve the affected source files and hashes as ordinary files in verified ignored storage. Remove or sanitize affected refs, determine exact object reachability, and purge only the authorized private objects while preserving shared clean objects and unrelated work. Verify the old content is no longer retrievable, scan remaining objects and refs, and run `git fsck`. Keep remediation manifests and raw private evidence ignored; never create a publishable backup ref or Git bundle that retains the data. Do not claim remote copies, application backups or other clones were cleaned without verifying them separately.
