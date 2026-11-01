#!/usr/bin/env python3
"""Run local CI from an immutable, privacy-checked snapshot, without a hosted service."""

import argparse
import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import check_privacy


def validate_snapshot(files, rules):
    for name, content in files.items():
        if check_privacy.private_path(name) or check_privacy.content_findings(
            content, rules
        ):
            raise ValueError(
                "Captured source failed the privacy gate; no snapshot will be created."
            )


def snapshot_files(root):
    names = subprocess.check_output(
        [
            "git",
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
        ],
        cwd=root,
    ).split(b"\0")
    files = {}
    for raw in names:
        if not raw:
            continue
        name = raw.decode()
        path = root / name
        if path.is_symlink():
            raise ValueError(
                "Source snapshots do not follow symlinks; review the source path."
            )
        if path.is_file():
            files[name] = path.read_bytes()
    return files


def fingerprint(files):
    digest = hashlib.sha256()
    for name, content in sorted(files.items()):
        digest.update(name.encode() + b"\0" + hashlib.sha256(content).digest())
    return digest.hexdigest()


def clean_environment(work, original=None):
    original = os.environ if original is None else original
    allowed = {
        "PATH",
        "PATHEXT",
        "SYSTEMROOT",
        "SystemRoot",
        "COMSPEC",
        "WINDIR",
        "HOME",
        "USERPROFILE",
        "LANG",
        "LC_ALL",
    }
    env = {name: value for name, value in original.items() if name in allowed}
    temporary = work / "temp"
    temporary.mkdir(parents=True, exist_ok=True)
    env.update(
        {
            "TMPDIR": str(temporary),
            "TMP": str(temporary),
            "TEMP": str(temporary),
            "PIP_CACHE_DIR": str(work / "cache/pip"),
            "UV_CACHE_DIR": str(work / "cache/uv"),
            "npm_config_cache": str(work / "cache/npm"),
            "npm_config_min_release_age": "5",
            "UV_PYTHON_DOWNLOADS": "never",
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_CONFIG_NOSYSTEM": "1",
            "PYTHONDONTWRITEBYTECODE": "1",
            "CI": "true",
        }
    )
    return env


def write_json(path, value):
    temporary = path.with_suffix(path.suffix + ".new")
    temporary.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--work-root",
        type=Path,
        help="Private CI workspace; otherwise IMAGEDIALS_CI_WORK_ROOT or .local/ci.",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Run even if an identical snapshot was already checked.",
    )
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    work = (
        args.work_root
        or Path(os.environ.get("IMAGEDIALS_CI_WORK_ROOT", str(root / ".local/ci")))
    ).resolve()
    if (
        work == root
        or work in root.parents
        or root in work.parents
        and subprocess.run(
            ["git", "check-ignore", "--quiet", str(work)], cwd=root
        ).returncode
    ):
        parser.error(
            "A workspace inside the project must be Git-ignored before CI writes to it."
        )
    work.mkdir(parents=True, exist_ok=True)
    lock = sqlite3.connect(work / "runner.sqlite", timeout=0)
    try:
        lock.execute("BEGIN EXCLUSIVE")
    except sqlite3.OperationalError:
        print("Local CI is already running.")
        return 0
    report = {
        "status": "checking",
        "started_at": datetime.now(timezone.utc).isoformat(),
        "platform": sys.platform,
        "steps": [],
    }
    latest = work / "latest.json"
    try:
        privacy = subprocess.run(
            [sys.executable, str(root / "scripts/check_privacy.py"), "--scope", "all"],
            cwd=root,
            capture_output=True,
            text=True,
        )
        if privacy.returncode:
            report.update(
                status="blocked",
                reason="Source or Git history failed the privacy gate.",
            )
            (work / "privacy.log").write_text(
                privacy.stdout + privacy.stderr, encoding="utf-8"
            )
            write_json(latest, report)
            return 1
        files = snapshot_files(root)
        # Recheck captured bytes so edits racing the initial audit cannot enter a run.
        validate_snapshot(
            files, check_privacy.load_rules(root / ".local/publication-denylist.json")
        )
        source_hash = fingerprint(files)
        previous = (
            json.loads(latest.read_text(encoding="utf-8")) if latest.exists() else {}
        )
        if (
            not args.force
            and previous.get("source_fingerprint") == source_hash
            and previous.get("status") in {"passed", "failed"}
        ):
            print("Source snapshot unchanged; previous result retained.")
            return 0
        revision = subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=root, text=True
        ).strip()
        report.update(
            status="running", source_fingerprint=source_hash, source_revision=revision
        )
        report["source_dirty"] = bool(
            subprocess.check_output(["git", "status", "--porcelain"], cwd=root)
        )
        run_id = (
            datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
            + "-"
            + source_hash[:10]
        )
        directory = work / "runs" / run_id
        checkout = directory / "source"
        checkout.mkdir(parents=True)
        for name, content in files.items():
            target = checkout / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
        (checkout / ".env").write_bytes(files[".env.example"])
        write_json(
            directory / "source-manifest.json",
            {
                name: hashlib.sha256(content).hexdigest()
                for name, content in sorted(files.items())
            },
        )
        report["run_directory"] = str(directory)
        env = clean_environment(work)
        node = shutil.which("node", path=env.get("PATH"))
        if not node:
            raise RuntimeError(
                "A compatible Node executable must be on the CI service PATH."
            )
        node_path = Path(node).resolve()
        npm_command = shutil.which("npm", path=env.get("PATH"))
        candidates = [
            node_path.parent / "node_modules/npm/bin/npm-cli.js",
            node_path.parent.parent / "lib/node_modules/npm/bin/npm-cli.js",
        ]
        if npm_command:
            resolved = Path(npm_command).resolve()
            if resolved.suffix == ".js":
                candidates.append(resolved)
            candidates.append(resolved.parent / "node_modules/npm/bin/npm-cli.js")
        npm = next((str(path) for path in candidates if path.is_file()), None)
        if not npm:
            raise RuntimeError(
                "Cannot resolve npm's JS entry point; select a standard Node installation."
            )
        python = (
            checkout
            / "backend/.venv"
            / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
        )
        steps = [
            (
                "snapshot Git metadata",
                ["git", "-c", "init.templateDir=", "init", "--quiet"],
            ),
            (
                "Python environment",
                [sys.executable, "-m", "venv", str(checkout / "backend/.venv")],
            ),
            (
                "locked Python install",
                [
                    str(python),
                    "-m",
                    "pip",
                    "install",
                    "--require-hashes",
                    "-r",
                    "backend/requirements-dev.lock",
                ],
            ),
            ("locked frontend install", [node, npm, "--prefix", "frontend", "ci"]),
            (
                "shared CI checks",
                [str(python), "scripts/ci.py", "--python", str(python)],
            ),
        ]
        for index, (label, command) in enumerate(steps):
            log = directory / f"{index:02d}.log"
            started = time.monotonic()
            write_json(latest, report)
            with log.open("w") as output:
                result = subprocess.run(
                    command,
                    cwd=checkout,
                    env=env,
                    stdout=output,
                    stderr=subprocess.STDOUT,
                )
            report["steps"].append(
                {
                    "name": label,
                    "exit_code": result.returncode,
                    "seconds": round(time.monotonic() - started, 3),
                    "log": log.name,
                }
            )
            if result.returncode:
                report["status"] = "failed"
                break
        else:
            report["status"] = "passed"
        if (
            report["status"] == "passed"
            and fingerprint(snapshot_files(checkout)) != source_hash
        ):
            report.update(
                status="failed",
                reason="CI modified the source snapshot; the recorded input is no longer exact.",
            )
        report["finished_at"] = datetime.now(timezone.utc).isoformat()
        write_json(directory / "result.json", report)
        write_json(latest, report)
        print(f"Local CI {report['status']}; private report saved.")
        return 0 if report["status"] == "passed" else 1
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        report.update(
            status="failed",
            reason=f"Runner failure ({type(error).__name__}). See private runner logs.",
        )
        write_json(latest, report)
        raise
    finally:
        lock.rollback()
        lock.close()


if __name__ == "__main__":
    raise SystemExit(main())
