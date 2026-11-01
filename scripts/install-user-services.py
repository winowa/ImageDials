#!/usr/bin/env python3
"""Optional Linux/systemd adapter. Renders units; never starts services."""

import argparse
import shutil
import sys
from pathlib import Path


def quote_systemd(value, *, exec_argument=False):
    if any(ord(character) < 32 for character in value):
        raise ValueError("Systemd values cannot contain control characters.")
    value = value.replace("\\", "\\\\").replace('"', '\\"').replace("%", "%%")
    if exec_argument:
        value = value.replace("$", "$$")
    return '"' + value + '"'


def systemd_path(value):
    """Single path directives take the whole value, not shell-style quotes."""
    if any(ord(character) < 32 for character in value):
        raise ValueError("Systemd paths cannot contain control characters.")
    return value.replace("%", "%%")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--node",
        default=shutil.which("node"),
        help="Compatible Node executable (defaults to PATH).",
    )
    args = parser.parse_args()
    if sys.platform != "linux" or shutil.which("systemctl") is None:
        parser.error(
            "This optional adapter requires Linux with systemd; use node scripts/run.mjs on other platforms."
        )
    if not args.node or not Path(args.node).is_file():
        parser.error("Provide a compatible Node executable using --node.")
    root = Path(__file__).resolve().parent.parent
    replacements = {
        "@PROJECT_ROOT@": systemd_path(str(root)),
        "@NODE_BIN@": quote_systemd(str(Path(args.node).resolve()), exec_argument=True),
        "@LAUNCHER@": quote_systemd(str(root / "scripts/run.mjs"), exec_argument=True),
    }
    target = Path.home() / ".config/systemd/user"
    units = []
    for name in ("imagedials-api", "imagedials-frontend"):
        content = (root / f"deploy/{name}.service.in").read_text(encoding="utf-8")
        for key, value in replacements.items():
            content = content.replace(key, value)
        path = target / f"{name}.service"
        if path.exists() and path.read_text(encoding="utf-8") != content:
            raise SystemExit(
                f"{path} differs; inspect and back it up before replacement."
            )
        units.append((path, content))
    target.mkdir(parents=True, exist_ok=True)
    for path, content in units:
        path.write_text(content, encoding="utf-8")
        print(path)


if __name__ == "__main__":
    main()
