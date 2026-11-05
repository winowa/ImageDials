"""Which image provider runs text-to-image versus reference editing.

Editing follows the generation provider unless a separate editing endpoint is
selected, by the deployment (`IMAGE_EDIT_MODEL_ENDPOINT`) or by one browser's
request-scoped override. A separate route reuses the deployment's adapter,
workflows and model configuration and changes only where the editing requests
go and which key they carry. Credentials never cross routes: the generation
key is never sent to an editing endpoint, and the deployment's editing key is
sent only to the deployment's own editing endpoint.
"""

from urllib.parse import urlsplit

EDIT_ROUTE_FIELD = "IMAGE_EDIT_ROUTE"
EDIT_ENDPOINT_FIELD = "IMAGE_EDIT_MODEL_ENDPOINT"
EDIT_KEY_FIELD = "IMAGE_EDIT_MODEL_KEY"
EDIT_FIELDS = (EDIT_ROUTE_FIELD, EDIT_ENDPOINT_FIELD, EDIT_KEY_FIELD)
ROUTE_GENERATION = "generation"
ROUTE_SEPARATE = "separate"
EDIT_ROUTES = (ROUTE_GENERATION, ROUTE_SEPARATE)
# Recorded in a saved result's diagnostics; never an address or key.
SEPARATE_ROUTE_DIAGNOSTIC = "separate-edit-endpoint"


def endpoint_problem(value):
    """Why `value` is not an acceptable provider endpoint, or None."""
    try:
        parsed = urlsplit(value)
        valid = (
            parsed.scheme in {"http", "https"}
            and bool(parsed.hostname)
            and not parsed.username
            and not parsed.password
            and not parsed.query
            and not parsed.fragment
        )
        parsed.port  # Validate an explicitly supplied port as well.
    except ValueError:
        valid = False
    if valid:
        return None
    return "Provider endpoints must be HTTP(S) URLs without credentials or queries"


def default_route(env):
    """The deployment's route: separate only when it names an editing endpoint."""
    return (
        ROUTE_SEPARATE
        if (env.get(EDIT_ENDPOINT_FIELD) or "").strip()
        else (ROUTE_GENERATION)
    )


def effective_route(env):
    route = (env.get(EDIT_ROUTE_FIELD) or "").strip()
    return route if route in EDIT_ROUTES else default_route(env)


def validate_deployment(env):
    """Fail clearly at startup on an unusable deployment editing route."""
    endpoint = (env.get(EDIT_ENDPOINT_FIELD) or "").strip()
    if endpoint and endpoint_problem(endpoint):
        raise ValueError(
            f"{EDIT_ENDPOINT_FIELD} must be an HTTP(S) URL without credentials, "
            "query or fragment"
        )
    route = (env.get(EDIT_ROUTE_FIELD) or "").strip()
    if route:
        # The route is a browser choice; the deployment chooses by endpoint.
        raise ValueError(
            f"{EDIT_ROUTE_FIELD} is not a deployment setting; set or clear "
            f"{EDIT_ENDPOINT_FIELD} instead"
        )


def apply_edit_overrides(defaults, changes, env):
    """Merge one browser's editing choices into `env` (already merged).

    `changes` holds only the browser's validated editing fields. Raises
    ValueError for combinations that cannot be honoured.
    """
    route = changes.get(EDIT_ROUTE_FIELD)
    if route is not None and route not in EDIT_ROUTES:
        raise ValueError("Image editing route must be generation or separate")
    effective = route or default_route(defaults)
    custom_fields = [
        name for name in (EDIT_ENDPOINT_FIELD, EDIT_KEY_FIELD) if name in changes
    ]
    if effective == ROUTE_GENERATION:
        if custom_fields:
            raise ValueError(
                "Image editing endpoint and key apply only to a separate editing route"
            )
        env[EDIT_ROUTE_FIELD] = ROUTE_GENERATION
        env[EDIT_ENDPOINT_FIELD] = ""
        env[EDIT_KEY_FIELD] = ""
        return env
    endpoint = (
        changes.get(EDIT_ENDPOINT_FIELD) or defaults.get(EDIT_ENDPOINT_FIELD) or ""
    ).strip()
    if not endpoint:
        raise ValueError("Enter an image editing endpoint for the separate route")
    env[EDIT_ROUTE_FIELD] = ROUTE_SEPARATE
    env[EDIT_ENDPOINT_FIELD] = endpoint
    if EDIT_KEY_FIELD in changes:
        env[EDIT_KEY_FIELD] = changes[EDIT_KEY_FIELD]
    elif endpoint != (defaults.get(EDIT_ENDPOINT_FIELD) or "").strip():
        # Never forward the deployment's editing key to a browser endpoint.
        env[EDIT_KEY_FIELD] = ""
    return env


def editing_environment(env):
    """The environment an editing provider runs with, or None for same-as."""
    if effective_route(env) != ROUTE_SEPARATE:
        return None
    endpoint = (env.get(EDIT_ENDPOINT_FIELD) or "").strip()
    return {
        **env,
        "IMAGE_MODEL_ENDPOINT_1": endpoint,
        # Only the editing key; the generation key never reaches this route.
        "IMAGE_MODEL_KEY_1": env.get(EDIT_KEY_FIELD, ""),
    }


class RoutedImageProvider:
    """One image provider selection with a separate editing endpoint.

    Text-to-image identity and readiness come from `generation`; reference
    editing readiness, limits, prompting strategy and the edit itself come
    from `editing`. Anything else reads the generation provider.
    """

    route = ROUTE_SEPARATE

    def __init__(self, generation, editing):
        self.generation = generation
        self.editing = editing

    def __getattr__(self, name):
        return getattr(self.generation, name)

    @property
    def editing_ready(self):
        return self.editing.editing_ready

    @property
    def max_references(self):
        return self.editing.max_references

    @property
    def reference_limit_configured(self):
        return self.editing.reference_limit_configured

    @property
    def reference_strategy(self):
        return self.editing.reference_strategy

    def render(self, prompt, width, height, *, references=()):
        if not references:
            return self.generation.render(prompt, width, height)
        data, diagnostics = self.editing.render(
            prompt, width, height, references=references
        )
        return data, {**diagnostics, "image_route": SEPARATE_ROUTE_DIAGNOSTIC}


def image_provider(env):
    """The routed image provider for `env` (plain when editing is same-as)."""
    from .providers import ImageProvider

    generation = ImageProvider(env)
    editing_env = editing_environment(env)
    if editing_env is None:
        return generation
    return RoutedImageProvider(generation, ImageProvider(editing_env))


def editing_route(provider):
    return getattr(provider, "route", ROUTE_GENERATION)
