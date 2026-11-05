"""Validated deployment presentation scope, independent of authorization."""

import json
import re
from dataclasses import dataclass

from fastapi import HTTPException

MAX_EVENT_NAME_CHARACTERS = 200
MAX_GALLERY_EVENTS = 100


def event_name(value):
    if (
        not isinstance(value, str)
        or not value.strip()
        or len(value.strip()) > MAX_EVENT_NAME_CHARACTERS
    ):
        raise ValueError(
            "Event names must be nonempty strings of at most 200 characters"
        )
    return value.strip()


@dataclass(frozen=True)
class DeploymentProfile:
    environment: str
    experience: str
    base_path: str
    active_event: str | None
    gallery_events: tuple[str, ...]

    @classmethod
    def from_env(cls, env):
        environment = env.get("APP_ENVIRONMENT", "local").strip()
        experience = env.get("EXPERIENCE_PROFILE", "public").strip()
        if environment not in {"local", "cloud"}:
            raise ValueError("APP_ENVIRONMENT must be local or cloud")
        if experience not in {"public", "event"}:
            raise ValueError("EXPERIENCE_PROFILE must be public or event")
        base = env.get("APP_BASE_PATH", "").strip().rstrip("/")
        if base and not re.fullmatch(r"(?:/[A-Za-z0-9_-]+)+", base):
            raise ValueError(
                "APP_BASE_PATH must contain only slash-separated path segments"
            )
        active = env.get("ACTIVE_EVENT_NAME", "").strip()
        try:
            raw = json.loads(env.get("GALLERY_EVENT_NAMES", "[]"))
        except (ValueError, TypeError) as exc:
            raise ValueError(
                "GALLERY_EVENT_NAMES must be a JSON array of event names"
            ) from exc
        if not isinstance(raw, list) or len(raw) > MAX_GALLERY_EVENTS:
            raise ValueError(
                "GALLERY_EVENT_NAMES must be a JSON array of at most 100 names"
            )
        gallery = tuple(dict.fromkeys(event_name(value) for value in raw))
        return cls(
            environment,
            experience,
            base,
            event_name(active) if active else None,
            gallery,
        )

    def scope(self, requested=None):
        configured = self.gallery_events or (
            (self.active_event,) if self.active_event else ()
        )
        if requested is not None:
            try:
                selected = event_name(requested)
            except ValueError as exc:
                raise HTTPException(400, str(exc)) from exc
            if configured and selected not in configured:
                # Never broaden a misspelled or unknown scope to all records.
                raise HTTPException(
                    400, "Requested event is outside the configured gallery scope"
                )
            return (selected,)
        return configured

    def event_capabilities(self):
        return {
            "active_event_name": self.active_event,
            "active_event_id": self.active_event,
            "gallery_event_names": list(self.gallery_events),
            "gallery_event_ids": list(self.gallery_events),
        }
