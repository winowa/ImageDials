"""Request-scoped browser provider choices; secrets never enter saved records."""

import base64
import binascii
import contextvars
import json
from dataclasses import dataclass
from urllib.parse import urlsplit

from fastapi import HTTPException, Request
from starlette.responses import JSONResponse

from .image_routing import (
    EDIT_ENDPOINT_FIELD,
    EDIT_FIELDS,
    EDIT_KEY_FIELD,
    EDIT_ROUTES,
    apply_edit_overrides,
    default_route,
    endpoint_problem,
)
from .routing import canonical_paths, canonical_routes
from .watermark_settings import (
    MAX_SETTINGS_JSON_BYTES,
    normalize_settings,
    settings_response,
)

PROVIDER_OVERRIDE_HEADER = "x-imagedials-provider-overrides"
MAX_OVERRIDE_HEADER_BYTES = 6144
MAX_PROVIDER_VALUE_CHARACTERS = 1024
ENDPOINT_FIELDS = (
    "LLM_MODEL_ENDPOINT_1",
    "IMAGE_MODEL_ENDPOINT_1",
    "DESCRIPTION_MODEL_ENDPOINT",
)
KEY_FIELDS = ("LLM_MODEL_KEY_1", "IMAGE_MODEL_KEY_1", "DESCRIPTION_MODEL_KEY")
MODEL_FIELDS = ("LLM_MODEL_NAME", "DESCRIPTION_MODEL_NAME")
PROVIDER_FIELDS = (*ENDPOINT_FIELDS, *KEY_FIELDS, *MODEL_FIELDS, *EDIT_FIELDS)
CURRENT_PROVIDERS = contextvars.ContextVar("browser_providers", default=None)


@dataclass(frozen=True)
class ProviderSelection:
    env: dict
    controls: object
    composer: object
    renderer: object
    creation: object
    description: object
    overridden: bool = False


def current_providers(app):
    selection = CURRENT_PROVIDERS.get()
    if selection is not None:
        return selection
    state = app.state
    return ProviderSelection(
        state.provider_environment,
        state.controls,
        state.composer,
        state.renderer,
        state.creation,
        state.description,
    )


def override_environment(defaults, encoded):
    if len(encoded) > MAX_OVERRIDE_HEADER_BYTES:
        raise ValueError("Provider settings exceed the request size limit")
    try:
        changes = json.loads(base64.b64decode(encoded, validate=True).decode("utf-8"))
    except (ValueError, UnicodeError, binascii.Error) as exc:
        raise ValueError("Provider settings must be base64-encoded JSON") from exc
    if not isinstance(changes, dict) or any(
        key not in PROVIDER_FIELDS for key in changes
    ):
        raise ValueError("Provider settings contain unsupported fields")
    for name, value in changes.items():
        if (
            not isinstance(value, str)
            or len(value) > MAX_PROVIDER_VALUE_CHARACTERS
            or any(ord(character) < 32 or ord(character) == 127 for character in value)
        ):
            raise ValueError(
                "Provider settings must contain bounded single-line strings"
            )
        if name in (*ENDPOINT_FIELDS, EDIT_ENDPOINT_FIELD) and value:
            problem = endpoint_problem(value)
            if problem:
                raise ValueError(problem)
    edit_changes = {name: changes.pop(name) for name in EDIT_FIELDS if name in changes}
    env = {**defaults, **changes}
    for endpoint, key in zip(ENDPOINT_FIELDS, KEY_FIELDS, strict=True):
        if endpoint in changes and changes[endpoint] != defaults.get(endpoint, ""):
            # Never forward a server-owned secret to a browser-selected endpoint.
            if key not in changes:
                env[key] = ""
    if edit_changes:
        apply_edit_overrides(defaults, edit_changes, env)
    return env


def selected_providers(env):
    # Local imports avoid cycles between canonical route registration modules.
    from .creation import CreationToolsProvider
    from .image_routing import image_provider
    from .imports import ImageDescriptionProvider
    from .providers import ControlsProvider, PromptComposer

    return ProviderSelection(
        env,
        ControlsProvider(env),
        PromptComposer(env),
        image_provider(env),
        CreationToolsProvider(env),
        ImageDescriptionProvider(env),
        overridden=True,
    )


class BrowserProviderOverrides:
    def __init__(self, app, owner):
        self.app = app
        self.owner = owner

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        values = [
            value
            for key, value in scope["headers"]
            if key.lower() == PROVIDER_OVERRIDE_HEADER.encode()
        ]
        if not values:
            return await self.app(scope, receive, send)
        try:
            if len(values) != 1:
                raise ValueError("Provide one provider settings header")
            selection = selected_providers(
                override_environment(self.owner.state.provider_environment, values[0])
            )
        except ValueError as exc:
            return await JSONResponse({"detail": str(exc)}, status_code=400)(
                scope, receive, send
            )
        token = CURRENT_PROVIDERS.set(selection)
        try:
            await self.app(scope, receive, send)
        finally:
            CURRENT_PROVIDERS.reset(token)


def register_browser_settings(app):
    from .imports import UploadBodyLimits

    route = canonical_routes(app)
    app.add_middleware(
        UploadBodyLimits,
        limits={
            path: MAX_SETTINGS_JSON_BYTES
            for path in canonical_paths(app, "/browser-settings/watermark/validate")
        },
    )

    @route("/browser-settings/defaults")
    def defaults():
        env = app.state.provider_environment
        values = {
            name: env.get(name, "")
            for name in (
                *ENDPOINT_FIELDS,
                EDIT_ENDPOINT_FIELD,
                *MODEL_FIELDS,
                "IMAGE_PROVIDER",
            )
        }
        values["IMAGE_PROVIDER"] = env.get("IMAGE_PROVIDER", "mock")
        values["IMAGE_MODEL_NAME"] = app.state.renderer.model
        for name in (*ENDPOINT_FIELDS, EDIT_ENDPOINT_FIELD):
            # A default URL must not expose accidentally embedded credentials.
            parsed = urlsplit(values[name])
            values[name] = parsed._replace(
                netloc=parsed.netloc.rsplit("@", 1)[-1], query="", fragment=""
            ).geturl()
        return JSONResponse(
            {
                "providers": values,
                "keys_configured": {
                    name: bool(env.get(name)) for name in (*KEY_FIELDS, EDIT_KEY_FIELD)
                },
                # Presence tells a browser this server accepts editing routes.
                "editing": {
                    "route": default_route(env),
                    "routes": list(EDIT_ROUTES),
                    "model": app.state.renderer.reference_strategy.model,
                },
                "watermark": (
                    settings_response(
                        normalize_settings(
                            {"type": "text", "text": env["WATERMARK_DEFAULT_TEXT"]}
                        )
                    )
                    if env.get("WATERMARK_DEFAULT_TEXT", "").strip()
                    else app.state.watermarks.settings()
                ),
                "storage": "browser",
            },
            headers={"Cache-Control": "no-store"},
        )

    @route("/browser-settings/watermark/validate", ("POST",))
    async def validate_watermark(request: Request):
        try:
            return settings_response(normalize_settings(await request.json()))
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
