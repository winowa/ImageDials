#!/usr/bin/env python3
"""Check publication candidates without printing private matching content."""

import argparse
import hashlib
import ipaddress
import json
import re
import subprocess
import sys
from pathlib import Path

TEXT_RULES = [
    ("internal hostname", re.compile(rb"(?i)\b(?:[a-z0-9-]+\.)+home\.arpa\b")),
    (
        "personal home path",
        re.compile(
            rb"(?i)(?:/(?:home|Users)/[a-z0-9_.-]+|[a-z]:[\\/]Users[\\/][^\s\\/]+)"
        ),
    ),
    ("private storage path", re.compile(rb"/(?:tank\b|srv/containers\b)")),
    ("private key", re.compile(rb"-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----")),
    (
        "access token",
        re.compile(
            rb"\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|AKIA[A-Z0-9]{16})\b"
        ),
    ),
    ("URL credentials", re.compile(rb"https?://[^\s/:@]+:[^\s/@]+@")),
]
IPV4 = re.compile(rb"\b(?:\d{1,3}\.){3}\d{1,3}\b")
PRIVATE_NETWORKS = tuple(
    ipaddress.ip_network(value)
    for value in (
        (0x0A000000, 8),
        (0xAC100000, 12),
        (0xC0A80000, 16),
        (0x64400000, 10),
    )
)


def git(root, *args):
    return subprocess.check_output(["git", *args], cwd=root, stderr=subprocess.PIPE)


def private_path(name):
    parts = Path(name).parts
    if any(part in {".local", ".aws", ".codex", "AGENTS.local.md"} for part in parts):
        return True
    if any(
        part == ".env" or (part.startswith(".env.") and part != ".env.example")
        for part in parts
    ):
        return True
    normalized = "/".join(parts)
    return normalized.startswith(("docs/plans/", "docs/local/", "deploy/generated/"))


def load_rules(path):
    if not path.exists():
        return [], []
    data = json.loads(path.read_text(encoding="utf-8"))
    literals = [value.encode() for value in data.get("literals", []) if value]
    patterns = [
        re.compile(value.encode(), re.IGNORECASE) for value in data.get("patterns", [])
    ]
    return literals, patterns


def content_findings(content, local_rules=((), ())):
    labels = {label for label, pattern in TEXT_RULES if pattern.search(content)}
    for match in IPV4.finditer(content):
        try:
            address = ipaddress.ip_address(match.group().decode())
        except ValueError:
            continue
        if any(address in network for network in PRIVATE_NETWORKS):
            labels.add("private network address")
    literals, patterns = local_rules
    if any(value.lower() in content.lower() for value in literals) or any(
        pattern.search(content) for pattern in patterns
    ):
        labels.add("private local rule")
    return sorted(labels)


def safe_location(name, rules):
    if content_findings(name.encode(), rules):
        return "private-path-" + hashlib.sha256(name.encode()).hexdigest()[:12]
    return name


def scan_files(root, staged, rules):
    args = (
        ("diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z")
        if staged
        else (
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
        )
    )
    findings = []
    for raw in git(root, *args).split(b"\0"):
        if not raw:
            continue
        name = raw.decode("utf-8")
        location = safe_location(name, rules)
        if private_path(name):
            findings.append((location, "private artifact path"))
        if staged:
            content = git(root, "show", ":" + name)
        else:
            path = root / name
            if not path.is_file():
                continue
            content = path.read_bytes()
        findings.extend((location, label) for label in content_findings(content, rules))
    return findings


def scan_history(root, rules):
    """Inspect every stored object, including checkpoints and unreachable objects."""
    findings = []
    rows = git(
        root,
        "cat-file",
        "--batch-all-objects",
        "--batch-check=%(objectname) %(objecttype)",
    ).splitlines()
    for row in rows:
        oid, kind = row.decode().split()
        content = git(root, "cat-file", kind, oid)
        findings.extend(
            (f"object {oid}", label) for label in content_findings(content, rules)
        )
        if kind == "tree":
            for raw in git(root, "ls-tree", "-r", "--name-only", "-z", oid).split(
                b"\0"
            ):
                if raw and private_path(raw.decode()):
                    findings.append((f"tree {oid}", "private artifact path"))
    return findings


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--scope", choices=["worktree", "staged", "history", "all"], default="worktree"
    )
    parser.add_argument(
        "--rules",
        type=Path,
        help="Optional ignored local denylist JSON; values are never printed.",
    )
    args = parser.parse_args()
    try:
        root = Path(git(Path.cwd(), "rev-parse", "--show-toplevel").decode().strip())
        rules = load_rules(args.rules or root / ".local/publication-denylist.json")
        findings = []
        if args.scope in {"worktree", "all"}:
            findings.extend(scan_files(root, False, rules))
        if args.scope in {"staged", "all"}:
            findings.extend(scan_files(root, True, rules))
        if args.scope in {"history", "all"}:
            findings.extend(scan_history(root, rules))
    except (OSError, ValueError, re.error, subprocess.CalledProcessError) as error:
        print(
            f"Privacy check could not complete ({type(error).__name__}).",
            file=sys.stderr,
        )
        return 2
    for location, label in sorted(set(findings)):
        print(f"BLOCKED: {location}: {label}", file=sys.stderr)
    if findings:
        return 1
    print(f"Privacy check passed ({args.scope}).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
