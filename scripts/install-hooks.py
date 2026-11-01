#!/usr/bin/env python3
"""Install optional local Git hooks without changing tracked configuration."""

import argparse
import shlex
import subprocess
import sys
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--python",
        type=Path,
        default=Path(sys.executable),
        help="Locked development interpreter for the checks.",
    )
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    custom = subprocess.run(
        ["git", "config", "--get", "core.hooksPath"],
        cwd=root,
        capture_output=True,
        text=True,
    )
    if custom.stdout.strip():
        parser.error(
            "An existing core.hooksPath is configured; integrate the check commands there explicitly."
        )
    directory = Path(
        subprocess.check_output(
            ["git", "rev-parse", "--git-path", "hooks"], cwd=root, text=True
        ).strip()
    )
    if not directory.is_absolute():
        directory = root / directory
    marker = "# ImageDials managed quality hook"
    python = args.python.absolute().as_posix()
    if not args.python.absolute().is_file():
        parser.error("Select an existing locked development interpreter.")
    pending = []
    for hook, script, arguments in (
        ("pre-commit", "scripts/check_privacy.py", ["--scope", "all"]),
        ("pre-push", "scripts/ci.py", ["--python", python]),
    ):
        path = directory / hook
        if path.exists() and marker not in path.read_text(encoding="utf-8"):
            parser.error(
                f"Existing {hook} is not managed by this installer; nothing will overwrite it."
            )
        command = [python, (root / script).as_posix(), *arguments]
        content = (
            "#!/bin/sh\n"
            + marker
            + "\nexec "
            + " ".join(shlex.quote(part) for part in command)
            + "\n"
        )
        pending.append((path, content, hook))
    directory.mkdir(parents=True, exist_ok=True)
    for path, content, hook in pending:
        path.write_text(content, newline="\n", encoding="utf-8")
        path.chmod(path.stat().st_mode | 0o111)
        print(f"Installed {hook}.")


if __name__ == "__main__":
    main()
