"""Portable tests for an optional OS-specific adapter; never write real units."""

import contextlib
import importlib.util
import io
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "service_adapter", Path(__file__).with_name("install-user-services.py")
)
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


class ServiceAdapterTests(unittest.TestCase):
    def test_quotes_spaces_unicode_and_systemd_expansion(self):
        path = "/example/Project ü $value 100%"
        self.assertEqual(
            adapter.quote_systemd(path), '"/example/Project ü $value 100%%"'
        )
        self.assertEqual(
            adapter.quote_systemd(path, exec_argument=True),
            '"/example/Project ü $$value 100%%"',
        )
        self.assertEqual(adapter.systemd_path(path), "/example/Project ü $value 100%%")
        with self.assertRaises(ValueError):
            adapter.quote_systemd("bad\npath")

    def test_unsupported_platform_fails_before_writes(self):
        for platform in ("win32", "darwin"):
            with self.subTest(platform=platform):
                with (
                    patch.object(adapter.sys, "platform", platform),
                    patch.object(adapter.sys, "argv", ["installer"]),
                    patch.object(adapter.shutil, "which", return_value="/example/node"),
                    patch.object(Path, "mkdir") as mkdir,
                    contextlib.redirect_stderr(io.StringIO()),
                ):
                    with self.assertRaises(SystemExit) as result:
                        adapter.main()
                    self.assertEqual(result.exception.code, 2)
                    mkdir.assert_not_called()


if __name__ == "__main__":
    unittest.main()
