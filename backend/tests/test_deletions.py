"""File/database crash boundaries for deleting originals and related media."""

import json
import os
import sqlite3
import subprocess
import sys
from contextlib import contextmanager
from pathlib import Path

import pytest
from app.deletions import PendingDeletion
from app.store import Store


def library_with_assets(root):
    store = Store(root)
    with store.connect() as db:
        for identity in ["target", "other"]:
            db.execute(
                "INSERT INTO images VALUES (?,?)",
                (identity, json.dumps({"id": identity})),
            )
            (root / (identity + ".png")).write_bytes((identity + " original").encode())
    (root / "derivatives/target").mkdir(parents=True)
    (root / "derivatives/target/analysis.json").write_bytes(b'{"placement":"preserve"}')
    (root / "derivatives/target/prepared.png").write_bytes(b"prepared bytes")
    (root / "previews").mkdir()
    (root / "previews/target.png").write_bytes(b"preview bytes")
    return store


def asset_bytes(root):
    return {
        str(path.relative_to(root)): path.read_bytes()
        for path in root.rglob("*")
        if path.is_file()
        and path.name != "library.sqlite3"
        and ".deletions" not in path.parts
    }


def test_failed_move_restores_all_assets_and_database(tmp_path, monkeypatch):
    store = library_with_assets(tmp_path)
    before = asset_bytes(tmp_path)
    replace = Path.replace

    def denied(path, target):
        if path == tmp_path / "derivatives/target":
            raise PermissionError("Sidecar move denied")
        return replace(path, target)

    monkeypatch.setattr(Path, "replace", denied)
    with pytest.raises(PermissionError):
        store.delete("target")
    assert asset_bytes(tmp_path) == before
    assert store.image("target") == {"id": "target"}
    assert store.library_changes(0) == []


def test_failed_commit_restores_all_assets(tmp_path, monkeypatch):
    store = library_with_assets(tmp_path)
    before = asset_bytes(tmp_path)
    transaction = store.write_transaction
    should_fail = True

    @contextmanager
    def failed_commit():
        nonlocal should_fail
        with transaction() as db:
            yield db
            if should_fail:
                should_fail = False
                raise sqlite3.OperationalError("Commit failed")

    monkeypatch.setattr(store, "write_transaction", failed_commit)
    with pytest.raises(sqlite3.OperationalError):
        store.delete("target")
    assert store.image("target") == {"id": "target"}
    assert asset_bytes(tmp_path) == before
    assert store.library_changes(0) == []


@pytest.mark.parametrize(
    "boundary,exit_code", [("before-commit", 27), ("after-commit", 28)]
)
def test_process_crash_recovers_deletion_according_to_database(
    tmp_path, boundary, exit_code
):
    store = library_with_assets(tmp_path)
    before = asset_bytes(tmp_path)
    code = """
import os,sys
from app.store import Store
from app.deletions import PendingDeletion
store=Store(sys.argv[1])
if sys.argv[2]=='before-commit':
    store.record_library_change=lambda *args,**kwargs:os._exit(27)
else:
    PendingDeletion.purge=lambda self:os._exit(28)
store.delete('target')
"""
    environment = dict(os.environ, PYTHONPATH=str(Path(__file__).resolve().parents[1]))
    result = subprocess.run(
        [sys.executable, "-c", code, str(tmp_path), boundary],
        env=environment,
        check=False,
        timeout=10,
    )
    assert result.returncode == exit_code
    assert any((tmp_path / ".deletions").iterdir())
    reopened = Store(tmp_path)
    if boundary == "before-commit":
        assert reopened.image("target") == {"id": "target"}
        assert asset_bytes(tmp_path) == before
        assert reopened.library_changes(0) == []
    else:
        assert reopened.image("target") is None
        assert asset_bytes(tmp_path) == {"other.png": before["other.png"]}
        assert reopened.library_changes(0)[-1][1]["action"] == "deleted"
    assert reopened.image("other") == {"id": "other"}
    assert list((tmp_path / ".deletions").iterdir()) == []
    assert store.image("target") == reopened.image("target")


def test_committed_delete_defers_failed_purge_without_restoring_record(
    tmp_path, monkeypatch
):
    store = library_with_assets(tmp_path)

    def denied(*args):
        raise PermissionError("Cleanup denied")

    with monkeypatch.context() as patch:
        patch.setattr(PendingDeletion, "purge", denied)
        store.delete("target")
    assert store.image("target") is None
    assert not (tmp_path / "target.png").exists()
    assert any((tmp_path / ".deletions").iterdir())
    Store(tmp_path)
    assert list((tmp_path / ".deletions").iterdir()) == []
    assert (tmp_path / "other.png").read_bytes() == b"other original"


def test_invalid_recovery_identity_preserves_files(tmp_path):
    store = library_with_assets(tmp_path)
    before = asset_bytes(tmp_path)
    directory = tmp_path / ".deletions/bad"
    directory.mkdir(parents=True)
    (directory / "manifest.json").write_text(
        json.dumps({"version": 1, "image_id": "../outside"})
    )
    with pytest.raises(OSError, match="identity"):
        Store(tmp_path)
    assert asset_bytes(tmp_path) == before
    assert store.image("target") == {"id": "target"}
