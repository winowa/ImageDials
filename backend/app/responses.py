"""Local-file HTTP responses with storage failures checked before headers."""

import os

from fastapi import HTTPException
from fastapi.responses import FileResponse


def local_file_response(
    path, media_type, *, headers=None, filename=None, missing_status=404
):
    if path.is_symlink():
        raise HTTPException(400, "Image files must not be symbolic links")
    try:
        with path.open("rb") as handle:
            stat = os.fstat(handle.fileno())
            handle.read(1)
    except FileNotFoundError as exc:
        raise HTTPException(missing_status, "Image file is missing") from exc
    except OSError as exc:
        raise HTTPException(502, "Image storage is unavailable") from exc
    return FileResponse(
        path,
        media_type=media_type,
        headers=headers,
        filename=filename,
        stat_result=stat,
    )
