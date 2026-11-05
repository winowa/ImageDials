"""Recoverable deletion: stage media, commit visibility, then remove staged bytes."""

import json
import re
import shutil
from dataclasses import dataclass
from pathlib import Path
from uuid import uuid4

from .files import atomic_write, sync_directory

DELETION_MANIFEST_VERSION = 1


def image_assets(image_id):
    if not isinstance(image_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", image_id):
        raise OSError("Invalid image identity in deletion journal")
    return (
        ("original", Path(image_id + ".png")),
        ("derivatives", Path("derivatives") / image_id),
        ("preview", Path("previews") / (image_id + ".png")),
    )


def move_asset(source, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    source.replace(target)
    sync_directory(source.parent)
    sync_directory(target.parent)


@dataclass
class PendingDeletion:
    root: Path
    directory: Path
    image_id: str

    def restore(self):
        for entry, relative in image_assets(self.image_id):
            staged, destination = self.directory / entry, self.root / relative
            if staged.exists() or staged.is_symlink():
                if destination.exists() or destination.is_symlink():
                    raise OSError(
                        "Deletion recovery conflicts with an existing image asset"
                    )
                move_asset(staged, destination)
        self.purge()

    def purge(self):
        if not self.directory.exists():
            return
        shutil.rmtree(self.directory)
        sync_directory(self.directory.parent)


class DeletionJournal:
    def __init__(self, root):
        self.root = root
        self.directory = root / ".deletions"
        if self.directory.is_symlink():
            raise OSError("Deletion journal must be a local directory")

    def stage(self, image_id):
        assets = image_assets(image_id)
        directory = self.directory / str(uuid4())
        pending = PendingDeletion(self.root, directory, image_id)
        atomic_write(
            directory / "manifest.json",
            json.dumps(
                {"version": DELETION_MANIFEST_VERSION, "image_id": image_id}
            ).encode(),
        )
        sync_directory(self.directory)
        sync_directory(self.root)
        try:
            for entry, relative in assets:
                source = self.root / relative
                if source.exists() or source.is_symlink():
                    move_asset(source, directory / entry)
        except BaseException:
            # Keep the manifest if restoration also fails; startup can retry it.
            pending.restore()
            raise
        return pending

    def recover(self, image_exists):
        if not self.directory.exists():
            return
        for directory in sorted(self.directory.iterdir()):
            if not directory.is_dir() or directory.is_symlink():
                raise OSError("Invalid deletion journal entry")
            manifest = directory / "manifest.json"
            if not manifest.exists():
                # A crash while creating the manifest precedes all asset moves.
                # Preserve incomplete metadata instead of guessing what it means.
                if any(
                    (directory / name).exists()
                    for name in ("original", "derivatives", "preview")
                ):
                    raise OSError("Deletion journal is missing its manifest")
                continue
            try:
                data = json.loads(manifest.read_text(encoding="utf-8"))
                if (
                    not isinstance(data, dict)
                    or data.get("version") != DELETION_MANIFEST_VERSION
                ):
                    raise ValueError()
                image_id = data["image_id"]
                image_assets(image_id)
            except (ValueError, KeyError, TypeError) as exc:
                raise OSError("Deletion journal manifest is invalid") from exc
            pending = PendingDeletion(self.root, directory, image_id)
            if image_exists(image_id):
                pending.restore()
            else:
                pending.purge()
