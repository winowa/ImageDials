import importlib.util
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "local_ci", Path(__file__).with_name("local_ci.py")
)
local_ci = importlib.util.module_from_spec(spec)
spec.loader.exec_module(local_ci)


class LocalCITests(unittest.TestCase):
    def test_captured_bytes_are_checked_again_before_copy(self):
        with self.assertRaises(ValueError):
            local_ci.validate_snapshot(
                {"fixture.txt": ("sample." + "home" + ".arpa").encode()}, ([], [])
            )
        with self.assertRaises(ValueError):
            local_ci.validate_snapshot({".env": b"generic fixture"}, ([], []))

    def test_privacy_failure_blocks_snapshot_and_dependency_install(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subprocess.run(["git", "init", "--quiet"], cwd=root, check=True)
            (root / ".gitignore").write_text(".local/\n", encoding="utf-8")
            (root / "scripts").mkdir()
            for name in ("local_ci.py", "check_privacy.py"):
                shutil.copyfile(Path(__file__).with_name(name), root / "scripts" / name)
            (root / "fixture.txt").write_text(
                "sample." + "home" + ".arpa", encoding="utf-8"
            )
            result = subprocess.run(
                [sys.executable, "scripts/local_ci.py"], cwd=root, capture_output=True
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(
                json.loads(
                    (root / ".local/ci/latest.json").read_text(encoding="utf-8")
                )["status"],
                "blocked",
            )
            self.assertFalse((root / ".local/ci/runs").exists())

    def test_snapshot_excludes_local_files_and_fingerprint_tracks_content(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subprocess.run(["git", "init", "--quiet"], cwd=root, check=True)
            (root / ".gitignore").write_text(".local/\n.env\n", encoding="utf-8")
            (root / ".local").mkdir()
            (root / ".local/private.json").write_text(
                "private fixture", encoding="utf-8"
            )
            (root / ".env").write_text("SECRET=fixture", encoding="utf-8")
            (root / "source.txt").write_text("first", encoding="utf-8")
            first = local_ci.snapshot_files(root)
            self.assertNotIn(".env", first)
            self.assertNotIn(".local/private.json", first)
            (root / "source.txt").write_text("second", encoding="utf-8")
            self.assertNotEqual(
                local_ci.fingerprint(first),
                local_ci.fingerprint(local_ci.snapshot_files(root)),
            )

    def test_environment_does_not_inherit_app_settings_or_secrets(self):
        with tempfile.TemporaryDirectory() as directory:
            env = local_ci.clean_environment(
                Path(directory),
                {
                    "PATH": "example",
                    "VITE_SECRET": "fixture",
                    "API_HOST": "fixture",
                    "TOKEN": "fixture",
                },
            )
            self.assertEqual(env["PATH"], "example")
            self.assertNotIn("VITE_SECRET", env)
            self.assertNotIn("API_HOST", env)
            self.assertNotIn("TOKEN", env)
            self.assertEqual(env["npm_config_min_release_age"], "5")
