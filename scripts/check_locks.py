#!/usr/bin/env python3
"""Verify Python project metadata, universal lock and hashed pip exports agree."""

import subprocess
import sys
from pathlib import Path


def main():
    root = Path(__file__).resolve().parent.parent
    subprocess.run(
        [sys.executable, "-m", "uv", "lock", "--check", "--offline"],
        cwd=root,
        check=True,
    )
    for file, selection in (
        ("requirements.lock", "--no-dev"),
        ("requirements-dev.lock", "--all-groups"),
    ):
        generated = subprocess.check_output(
            [
                sys.executable,
                "-m",
                "uv",
                "export",
                "--frozen",
                selection,
                "--no-emit-project",
                "--no-header",
            ],
            cwd=root,
            text=True,
        )
        if (
            generated.splitlines()
            != (root / "backend" / file).read_text(encoding="utf-8").splitlines()
        ):
            raise SystemExit(f"backend/{file} is stale; regenerate the Python locks.")
    print("Python lock and hash exports agree.")


if __name__ == "__main__":
    main()
