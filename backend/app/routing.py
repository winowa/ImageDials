"""Shared canonical API registration and compatibility aliases."""

from urllib.parse import quote


def image_content_url(image_id):
    return "/api/images/" + quote(image_id, safe="") + "/content"


def canonical_paths(app, path):
    paths = ["/api" + path, path]
    prefix = app.state.deployment.base_path
    return paths + [prefix + item for item in paths] if prefix else paths


def canonical_routes(app):
    def route(path, methods=("GET",)):
        def register(handler):
            for index, alias in enumerate(canonical_paths(app, path)):
                app.add_api_route(
                    alias, handler, methods=list(methods), include_in_schema=index == 0
                )
            return handler

        return register

    return route
