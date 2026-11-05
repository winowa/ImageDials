"""A reviewed dependency must never exempt modified or unrelated output."""

import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import build_artifacts
import check_privacy


class ReviewedBinaryTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.content = b"\0asm\1\0\0\0" + ("/ho" + "me/ci-builder").encode()
        self.binary = build_artifacts.ReviewedBinary(
            "example-sdk",
            "1.2.3",
            "dist/module.wasm",
            r"assets/module-[A-Za-z0-9_-]+\.wasm",
            hashlib.sha256(self.content).hexdigest(),
        )
        self.output = self.root / "frontend/dist/assets/module-abc.wasm"
        self.package = self.root / "frontend/node_modules/example-sdk"
        (self.package / "dist").mkdir(parents=True)
        (self.package / self.binary.source).write_bytes(self.content)
        (self.package / "package.json").write_text(
            json.dumps({"name": "example-sdk", "version": "1.2.3"})
        )
        self.lock = self.root / "frontend/package-lock.json"
        self.lock.write_text(
            json.dumps({"packages": {"node_modules/example-sdk": {"version": "1.2.3"}}})
        )
        patched = patch.object(build_artifacts, "REVIEWED_BINARIES", (self.binary,))
        patched.start()
        self.addCleanup(patched.stop)

    def approved(self, content=None, path=None):
        return build_artifacts.is_reviewed_binary(
            self.root,
            path or self.output,
            self.content if content is None else content,
        )

    def test_exact_reviewed_dependency_and_locked_version(self):
        self.assertTrue(check_privacy.content_findings(self.content))
        self.assertTrue(self.approved())

    def test_changed_or_appended_bytes_still_require_privacy_scan(self):
        self.assertFalse(self.approved(self.content + b"extra bytes"))
        self.assertFalse(self.approved(self.content[:-1]))

    def test_identical_bytes_at_unreviewed_paths_are_not_exempt(self):
        for relative in (
            "assets/other-abc.wasm",
            "assets/module-abc.js",
            "module-abc.wasm",
        ):
            self.assertFalse(self.approved(path=self.root / "frontend/dist" / relative))
        self.assertFalse(self.approved(path=self.root / "outside/module-abc.wasm"))

    def test_changed_installed_binary_version_or_lock_is_not_exempt(self):
        source = self.package / self.binary.source
        source.write_bytes(self.content + b"changed")
        self.assertFalse(self.approved())
        source.write_bytes(self.content)
        (self.package / "package.json").write_text(
            json.dumps({"name": "example-sdk", "version": "1.2.4"})
        )
        self.assertFalse(self.approved())
        (self.package / "package.json").write_text(
            json.dumps({"name": "example-sdk", "version": "1.2.3"})
        )
        self.lock.write_text(
            json.dumps({"packages": {"node_modules/example-sdk": {"version": "1.2.4"}}})
        )
        self.assertFalse(self.approved())

    def test_missing_or_malformed_provenance_fails_closed(self):
        self.lock.write_text("not JSON")
        self.assertFalse(self.approved())
        self.lock.unlink()
        self.assertFalse(self.approved())
