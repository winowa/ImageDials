import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


class HookTests(unittest.TestCase):
    def repository(self, root):
        subprocess.run(["git", "init", "--quiet"], cwd=root, check=True)
        scripts = root / "scripts"
        scripts.mkdir()
        for name in ("install-hooks.py", "check_privacy.py"):
            shutil.copyfile(Path(__file__).with_name(name), scripts / name)

    def test_hook_blocks_private_commit_without_echoing_the_value(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.repository(root)
            subprocess.run(
                [sys.executable, "scripts/install-hooks.py"],
                cwd=root,
                check=True,
                capture_output=True,
            )
            value = "sample." + "home" + ".arpa"
            (root / "fixture.txt").write_text(value, encoding="utf-8")
            subprocess.run(["git", "add", "."], cwd=root, check=True)
            result = subprocess.run(
                [
                    "git",
                    "-c",
                    "user.name=Example Author",
                    "-c",
                    "user.email=author@example.com",
                    "commit",
                    "-m",
                    "Blocked fixture",
                ],
                cwd=root,
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("BLOCKED", result.stderr)
            self.assertNotIn(value, result.stderr)
            self.assertNotEqual(
                subprocess.run(
                    ["git", "rev-parse", "--verify", "HEAD"],
                    cwd=root,
                    capture_output=True,
                ).returncode,
                0,
            )

    def test_unrelated_hooks_are_preserved_before_any_install(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.repository(root)
            existing = root / ".git/hooks/pre-push"
            existing.write_text("unrelated fixture\n", encoding="utf-8")
            result = subprocess.run(
                [sys.executable, "scripts/install-hooks.py"],
                cwd=root,
                capture_output=True,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((root / ".git/hooks/pre-commit").exists())
            self.assertEqual(
                existing.read_text(encoding="utf-8"), "unrelated fixture\n"
            )
