"""Recognize byte-exact reviewed dependency binaries in frontend output."""

import hashlib
import json
import re
from dataclasses import dataclass


@dataclass(frozen=True)
class ReviewedBinary:
    package: str
    version: str
    source: str
    output_pattern: str
    sha256: str


# This MIT-licensed SDK asset includes upstream compiler diagnostics and build
# paths. Reviewed bytes are public dependency content, not application data.
# An upgrade requires another explicit artifact review and digest update.
REVIEWED_BINARIES = (
    ReviewedBinary(
        package="@contentauth/c2pa-web",
        version="0.15.5",
        source="dist/resources/c2pa_bg.wasm",
        output_pattern=r"assets/c2pa_bg-[A-Za-z0-9_-]+\.wasm",
        sha256="e6a3817fc7a4d5dddc66a26e9e21d5159bc73f60e95f27e76e249b3e70a37b95",
    ),
)


def is_reviewed_binary(root, path, content):
    """Only accept an exact output, installed package and lockfile match."""
    try:
        relative = path.relative_to(root / "frontend/dist").as_posix()
        digest = hashlib.sha256(content).hexdigest()
        for binary in REVIEWED_BINARIES:
            if not re.fullmatch(binary.output_pattern, relative):
                continue
            if digest != binary.sha256:
                return False
            package = root / "frontend/node_modules" / binary.package
            installed = json.loads((package / "package.json").read_text())
            lock = json.loads((root / "frontend/package-lock.json").read_text())
            locked = lock["packages"]["node_modules/" + binary.package]
            return (
                installed["name"] == binary.package
                and installed["version"] == binary.version
                and locked["version"] == binary.version
                and hashlib.sha256((package / binary.source).read_bytes()).hexdigest()
                == binary.sha256
            )
    except (OSError, ValueError, KeyError, TypeError):
        return False
    return False
