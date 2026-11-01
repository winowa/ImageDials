#!/usr/bin/env python3
"""Optional Linux adapter: install a local CI timer without starting services."""

import argparse
import importlib.util
import os
import shutil
import subprocess
import sys
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--work-root",
        type=Path,
        help="Private workspace outside the checkout, or an ignored directory inside it.",
    )
    parser.add_argument("--python", type=Path, default=Path(sys.executable))
    parser.add_argument(
        "--node", type=Path, default=Path(shutil.which("node") or "node")
    )
    args = parser.parse_args()
    if sys.platform != "linux" or not shutil.which("systemctl"):
        parser.error("This optional timer adapter requires Linux with systemd.")
    root = Path(__file__).resolve().parent.parent
    spec = importlib.util.spec_from_file_location(
        "service_adapter", root / "scripts/install-user-services.py"
    )
    adapter = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(adapter)
    quote = adapter.quote_systemd
    work = (args.work_root or root / ".local/ci").absolute()
    if work == root or work in root.parents:
        parser.error("CI must not write into the project root or its parents.")
    if (
        root in work.parents
        and subprocess.run(
            ["git", "check-ignore", "--quiet", str(work)], cwd=root
        ).returncode
    ):
        parser.error("The selected project-local workspace is not ignored.")
    env_file = root / ".local/ci.env"
    if subprocess.run(
        ["git", "check-ignore", "--quiet", str(env_file)], cwd=root
    ).returncode:
        parser.error("Ignore the private environment file before installation.")
    node = args.node.absolute()
    python = args.python.absolute()
    if not node.is_file() or not python.is_file():
        parser.error("Select actual compatible Node and Python executable paths.")
    environment = f"IMAGEDIALS_CI_WORK_ROOT={quote(str(work))}\nPATH={quote(str(node.parent) + os.pathsep + os.defpath)}\n"
    replacements = {
        "@PROJECT_ROOT@": adapter.systemd_path(str(root)),
        "@ENV_FILE@": adapter.systemd_path(str(env_file)),
        "@WORK_ROOT@": quote(str(work)),
        "@PYTHON@": quote(str(python), exec_argument=True),
        "@CI_SCRIPT@": quote(str(root / "scripts/local_ci.py"), exec_argument=True),
    }
    target = Path.home() / ".config/systemd/user"
    pending = [(env_file, environment)]
    for suffix in ("service", "timer"):
        source = root / f"deploy/imagedials-ci.{suffix}.in"
        content = source.read_text(encoding="utf-8")
        for key, value in replacements.items():
            content = content.replace(key, value)
        pending.append((target / f"imagedials-ci.{suffix}", content))
    for path, content in pending:
        if path.exists() and path.read_text(encoding="utf-8") != content:
            parser.error(
                f"Existing {path.name} differs; inspect and back it up before replacement."
            )
    work.mkdir(parents=True, exist_ok=True)
    for path, content in pending:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        path.chmod(0o600)
    print(
        "Installed private CI configuration and optional user timer units; services were not started."
    )


if __name__ == "__main__":
    main()
