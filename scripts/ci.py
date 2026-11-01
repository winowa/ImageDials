#!/usr/bin/env python3
"""Run the same portable quality gates locally and in any CI provider."""

import argparse
import shutil
import subprocess
import sys
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--python",
        type=Path,
        help="Interpreter with locked development dependencies installed.",
    )
    parser.add_argument("--privacy-scope", choices=["all", "worktree"], default="all")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    environment_python = (
        root
        / "backend/.venv"
        / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
    )
    python = args.python or (
        environment_python if environment_python.is_file() else Path(sys.executable)
    )
    # Preserve the venv path: resolving its symlink selects the base environment.
    python = str(python.absolute())
    node = shutil.which("node")
    if not node or not Path(python).is_file():
        parser.error(
            "Install Node and the locked Python development environment first."
        )
    prettier = str(root / "frontend/node_modules/prettier/bin/prettier.cjs")
    oxlint = str(root / "frontend/node_modules/oxlint/bin/oxlint")
    commands = [
        (
            "privacy",
            [python, "scripts/check_privacy.py", "--scope", args.privacy_scope],
        ),
        ("whitespace", ["git", "diff", "--check"]),
        ("Python locks", [python, "scripts/check_locks.py"]),
        ("Python lint", [python, "-m", "ruff", "check", "."]),
        ("Python format", [python, "-m", "ruff", "format", "--check", "."]),
        (
            "JS/docs format",
            [node, prettier, "--check", ".", "--ignore-path", ".prettierignore"],
        ),
        (
            "JS lint",
            [node, oxlint, "--config", ".oxlintrc.json", "--deny-warnings", "."],
        ),
        ("portable launch", [node, "--test", "scripts/runtime.test.mjs"]),
        (
            "tooling tests",
            [python, "-m", "unittest", "discover", "-s", "scripts", "-p", "test_*.py"],
        ),
        (
            "frontend tests",
            [
                node,
                "frontend/node_modules/vitest/vitest.mjs",
                "run",
                "--root",
                "frontend",
            ],
        ),
        (
            "frontend build",
            [node, "frontend/node_modules/vite/bin/vite.js", "build", "frontend"],
        ),
        (
            "backend tests",
            [python, "-m", "pytest", "backend/tests", "-c", "backend/pytest.ini"],
        ),
    ]
    for label, command in commands:
        print(f"\nCHECK: {label}", flush=True)
        subprocess.run(command, cwd=root, check=True)
    # Build output is ignored by Git, so inspect its bytes separately.
    import check_privacy

    rules = check_privacy.load_rules(root / ".local/publication-denylist.json")
    for path in (root / "frontend/dist").rglob("*"):
        if path.is_file() and check_privacy.content_findings(path.read_bytes(), rules):
            raise SystemExit("Generated frontend output contains blocked content.")
    print("\nAll CI gates passed.")


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as error:
        raise SystemExit(error.returncode) from None
