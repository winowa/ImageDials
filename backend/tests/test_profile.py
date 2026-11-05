"""Deployment scope and prefix contracts, including upload-limit aliases."""

import json

import pytest
from app.main import create_app
from fastapi.testclient import TestClient
from test_canonical import FIXTURE, wait_for_job


def generate(client, key):
    body = {**json.loads(FIXTURE.read_text()), "idempotency_key": key}
    job_id = client.post("/api/generate-image", json=body).json()["generation_job_id"]
    result = wait_for_job(client, job_id)
    assert result["status"] == "complete"
    return result["result"]


def test_active_event_scope_and_unknown_scope_never_broadens(tmp_path):
    settings = {"IMAGEDIALS_DATA_DIR": str(tmp_path)}
    with TestClient(create_app(settings)) as client:
        unscoped = generate(client, "public")
        assert unscoped["event_id"] is None
    with TestClient(
        create_app(
            {**settings, "EXPERIENCE_PROFILE": "event", "ACTIVE_EVENT_NAME": "Spring"}
        )
    ) as client:
        scoped = generate(client, "spring")
        assert scoped["event_id"] == "Spring"
        capabilities = client.get("/api/app-capabilities").json()
        assert capabilities["experience_profile"] == "event"
        assert capabilities["events"]["active_event_id"] == "Spring"
        assert [
            record["id"]
            for record in client.get("/api/images/library").json()["images"]
        ] == [scoped["id"]]
        for path in ["/api/images/library", "/api/images/library/events"]:
            assert client.get(path + "?event_name=Unknown").status_code == 400
    with TestClient(
        create_app({**settings, "GALLERY_EVENT_NAMES": '["Spring","Winter","Spring"]'})
    ) as client:
        caps = client.get("/api/app-capabilities").json()
        assert caps["events"]["gallery_event_names"] == ["Spring", "Winter"]
        assert client.get("/api/images/library?event_name=Winter").json()["count"] == 0
        assert client.get("/api/images/library").json()["count"] == 1
    with TestClient(create_app(settings)) as client:
        assert client.get("/api/images/library").json()["count"] == 2


def test_prefix_aliases_keep_root_health_and_upload_bounds(tmp_path):
    settings = {
        "IMAGEDIALS_DATA_DIR": str(tmp_path),
        "APP_BASE_PATH": "/studio/v1/",
        "IMPORT_MAX_BYTES": "16",
    }
    with TestClient(create_app(settings)) as client:
        for path in [
            "/studio/v1/api/models",
            "/studio/v1/models",
            "/api/models",
            "/models",
        ]:
            assert client.get(path).status_code == 200
        assert client.get("/healthz").status_code == 200
        assert client.get("/studio/v1/healthz").status_code == 404
        assert client.get("/api/healthz").status_code == 404
        for path in [
            "/studio/v1/api/images/import-analysis",
            "/studio/v1/images/import-analysis",
        ]:
            assert (
                client.post(
                    path, files={"image": ("image.png", b"x" * 17, "image/png")}
                ).status_code
                == 413
            )
        response = client.get("/studio/v1/api/generation-jobs/missing/events")
        assert response.status_code == 200 and "event: failed" in response.text
        assert client.get("/studio/v1/api/images/library").status_code == 200


@pytest.mark.parametrize(
    "settings",
    [
        {"APP_ENVIRONMENT": "invalid"},
        {"EXPERIENCE_PROFILE": "invalid"},
        {"APP_BASE_PATH": "/../escape"},
        {"APP_BASE_PATH": "https://example.invalid"},
        {"GALLERY_EVENT_NAMES": "{}"},
        {"GALLERY_EVENT_NAMES": '[""]'},
        {"GALLERY_EVENT_NAMES": "[12]"},
    ],
)
def test_invalid_profile_fails_before_startup(settings):
    with pytest.raises(ValueError):
        create_app(settings)


def test_unrelated_event_sidecar_failure_does_not_break_scoped_library(tmp_path):
    base = {"IMAGEDIALS_DATA_DIR": str(tmp_path)}
    with TestClient(create_app({**base, "ACTIVE_EVENT_NAME": "Winter"})) as client:
        winter = generate(client, "winter-sidecar")
    with TestClient(create_app({**base, "ACTIVE_EVENT_NAME": "Spring"})) as client:
        spring = generate(client, "spring-sidecar")
        directory = tmp_path / "derivatives" / winter["image_id"]
        directory.mkdir(parents=True)
        (directory / "analysis.json").write_text("invalid stored metadata")
        response = client.get("/api/images/library")
        assert response.status_code == 200, response.text
        assert [record["id"] for record in response.json()["images"]] == [
            spring["image_id"]
        ]
        assert (
            client.get(
                "/api/images/library",
                headers={"If-None-Match": response.headers["etag"]},
            ).status_code
            == 304
        )
    with TestClient(create_app({**base, "ACTIVE_EVENT_NAME": "Winter"})) as client:
        assert client.get("/api/images/library").status_code == 502
