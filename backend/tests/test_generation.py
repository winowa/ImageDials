import time
from concurrent.futures import ThreadPoolExecutor

import pytest
from app.domain import Category
from app.main import create_app
from fastapi.testclient import TestClient

GENERATION_COMPLETION_TIMEOUT_SECONDS = 10
GENERATION_STATUS_POLL_SECONDS = 0.02


def complete(client, payload):
    accepted = client.post("/api/generations", json=payload)
    assert accepted.status_code == 202, accepted.text
    job = accepted.json()
    deadline = time.monotonic() + GENERATION_COMPLETION_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        response = client.get("/api/generations/" + job["id"])
        assert response.status_code == 200, response.text
        job = response.json()
        if job["stage"] in {"complete", "failed"}:
            return job
        time.sleep(GENERATION_STATUS_POLL_SECONDS)
    pytest.fail(f"Generation did not finish before the test deadline: {job}")


@pytest.fixture
def payload():
    return dict(
        prompt="An amber glass bird",
        mode="image",
        aspect="3:2",
        revision=3,
        categories=[],
        idempotency_key="first",
    )


def test_generation_persistence_identity_and_idempotency(tmp_path, payload):
    settings = {"IMAGEDIALS_DATA_DIR": str(tmp_path)}
    with TestClient(create_app(settings)) as client:
        categories = client.post("/api/controls", json=payload).json()["categories"]
        next(category for category in categories if category["id"] == "style")[
            "value"
        ] = ["watercolor"]
        payload["categories"] = categories
        job = complete(client, payload)
        assert job["stage"] == "complete", job
        result = job["result"]
        assert "Watercolor" in result["final_prompt"]
        assert result["width"] == 1152 and result["height"] == 768
        assert result["provider"] == "mock"
        content = client.get(result["image_url"]).content
        import hashlib

        assert hashlib.sha256(content).hexdigest() == result["sha256"]
        assert client.post("/api/generations", json=payload).json()["id"] == job["id"]
        payload["prompt"] = "Changed idea"
        assert client.post("/api/generations", json=payload).status_code == 409
    with TestClient(create_app(settings)) as client:
        assert client.get("/api/images").json()["items"] == [result]
        assert client.get("/api/generations/" + job["id"]).json()["result"] == result
        assert client.get(result["image_url"]).content == content
        assert client.get("/api/images?q=notpresent").json()["total"] == 0
        assert client.delete("/api/images/" + result["id"]).status_code == 200
        assert client.get(result["image_url"]).status_code == 404


def test_invalid_and_duplicate_submission(tmp_path, payload):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        assert (
            client.post(
                "/api/generations", json={**payload, "prompt": "  "}
            ).status_code
            == 422
        )
        with ThreadPoolExecutor(max_workers=4) as pool:
            jobs = list(
                pool.map(
                    lambda _: client.post("/api/generations", json=payload).json(),
                    range(4),
                )
            )
        assert len({j["id"] for j in jobs}) == 1
        assert complete(client, payload)["stage"] == "complete"
        assert client.get("/api/images").json()["total"] == 1


def test_failure_preserves_library(tmp_path, payload):
    app = create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})
    with TestClient(app) as client:
        assert complete(client, payload)["stage"] == "complete"

        def broken(*args):
            return b"bad image", {}

        app.state.renderer.render = broken
        payload["idempotency_key"] = "bad"
        assert complete(client, payload)["stage"] == "failed"
        assert client.get("/api/images").json()["total"] == 1


@pytest.mark.parametrize(
    "category",
    [
        dict(type="range", value=101),
        dict(type="single", value="missing"),
        dict(type="multi", value=["missing"]),
        dict(type="select", value="missing"),
    ],
)
def test_control_validation(category):
    with pytest.raises(ValueError):
        Category(id="c", label="Test", **category)


def test_valid_control_types():
    for kind, value in [("single", "a"), ("select", "a"), ("multi", ["a"])]:
        assert (
            Category(
                id="c",
                label="Test",
                type=kind,
                value=value,
                options=[{"id": "a", "label": "A"}],
            ).value
            == value
        )
    assert Category(id="c", label="Test", type="range", value=25).value == 25


def test_unset_fixed_controls_are_valid(tmp_path, payload):
    payload["categories"] = [
        dict(
            id="style",
            label="Style",
            type="single",
            origin="fixed",
            value=None,
            options=[dict(id="photo", label="Photo")],
        )
    ]
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        job = complete(client, payload)
        assert job["stage"] == "complete"
        assert "Style:" not in job["result"]["final_prompt"]
