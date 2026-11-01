"""Privacy regressions use synthetic values, never actual deployment details."""

import importlib.util
import subprocess
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "privacy", Path(__file__).with_name("check_privacy.py")
)
privacy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(privacy)


class PrivacyTests(unittest.TestCase):
    def test_private_addresses_and_paths(self):
        private = ".".join(["10", "23", "45", "67"]).encode()
        hostname = ("sample." + "home" + ".arpa").encode()
        home = ("/ho" + "me/example-user/project").encode()
        for value in (private, hostname, home):
            self.assertTrue(privacy.content_findings(value))
        self.assertFalse(
            privacy.content_findings(
                b"http://127.0.0.1:8000 https://example.com 192.0.2.10"
            )
        )

    def test_local_rules_and_protected_paths(self):
        self.assertEqual(
            privacy.content_findings(
                b"sample-private-value", ([b"sample-private-value"], [])
            ),
            ["private local rule"],
        )
        for name in (
            ".env",
            "nested/.env.production",
            "AGENTS.local.md",
            ".local/evidence.json",
            "docs/plans/example.md",
        ):
            self.assertTrue(privacy.private_path(name), name)
        self.assertFalse(privacy.private_path(".env.example"))

    def test_staged_checkpoint_and_unreachable_content_are_checked(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)

            def git(*args, **kwargs):
                return subprocess.check_output(
                    ["git", *args], cwd=root, stderr=subprocess.DEVNULL, **kwargs
                )

            git("init", "--quiet")
            (root / "safe.txt").write_text("public example\n", encoding="utf-8")
            git("add", "safe.txt")
            git(
                "-c",
                "user.name=Example Author",
                "-c",
                "user.email=author@example.com",
                "commit",
                "--quiet",
                "-m",
                "Fixture",
            )
            private = ("sample." + "home" + ".arpa").encode()
            (root / "safe.txt").write_bytes(private)
            git("add", "safe.txt")
            self.assertTrue(privacy.scan_files(root, True, ([], [])))
            tree = git("write-tree").decode().strip()
            commit = (
                git(
                    "-c",
                    "user.name=Example Author",
                    "-c",
                    "user.email=author@example.com",
                    "commit-tree",
                    tree,
                    "-p",
                    "HEAD",
                    input=b"Checkpoint\n",
                )
                .decode()
                .strip()
            )
            git("update-ref", "refs/checkpoints/example", commit)
            self.assertTrue(privacy.scan_history(root, ([], [])))
            git("update-ref", "-d", "refs/checkpoints/example")
            self.assertTrue(
                privacy.scan_history(root, ([], [])),
                "Unreachable private objects must still block publication",
            )
