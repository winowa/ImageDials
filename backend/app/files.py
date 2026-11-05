"""Durable same-filesystem replacement, with portable directory synchronization."""

import os
from uuid import uuid4


def sync_directory(path):
    # Windows does not expose directory handles through os.open. File fsync and
    # atomic replacement still apply there; directory fsync is a POSIX safeguard.
    if os.name == "posix":
        descriptor = os.open(path, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)


def atomic_write(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + f".{uuid4()}.tmp")
    try:
        with temporary.open("xb") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        sync_directory(path.parent)
    finally:
        temporary.unlink(missing_ok=True)
