"""Correlation identifiers for every HTTP response.

A caller may send its own ``X-Request-ID``; a well-formed value is echoed so
the browser can match a failure to its request. Anything else is replaced with
a fresh opaque identifier. The value is never derived from request content.
"""

import re
from uuid import uuid4

REQUEST_ID_HEADER = b"x-request-id"
_VALID = re.compile(rb"^[A-Za-z0-9._-]{1,64}$")


def request_id_from(headers):
    """The caller's identifier when exactly one well-formed value was sent."""
    values = [value for key, value in headers if key.lower() == REQUEST_ID_HEADER]
    if len(values) == 1 and _VALID.match(values[0]):
        return values[0]
    return uuid4().hex.encode()


class RequestIds:
    """Outermost ASGI middleware: tag responses, including early rejections."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        request_id = request_id_from(scope.get("headers") or [])

        async def tagged(message):
            if message["type"] == "http.response.start":
                headers = [
                    (key, value)
                    for key, value in message.get("headers") or []
                    if key.lower() != REQUEST_ID_HEADER
                ]
                headers.append((REQUEST_ID_HEADER, request_id))
                message = {**message, "headers": headers}
            await send(message)

        return await self.app(scope, receive, tagged)
