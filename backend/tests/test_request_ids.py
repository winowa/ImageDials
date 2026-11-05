from app.main import create_app
from app.request_ids import request_id_from
from fastapi.testclient import TestClient


def test_every_response_carries_a_request_id(tmp_path):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        ok = client.get("/api/health")
        missing = client.get("/api/images/not-a-real-image")
        assert len(ok.headers["x-request-id"]) == 32
        assert missing.status_code == 404
        assert missing.headers["x-request-id"] != ok.headers["x-request-id"]


def test_early_rejections_are_tagged(tmp_path):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        response = client.get(
            "/api/health",
            headers={"X-ImageDials-Provider-Overrides": "not-base64!"},
        )
        assert response.status_code == 400
        assert response.headers["x-request-id"]


def test_well_formed_caller_ids_are_echoed(tmp_path):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        echoed = client.get("/api/health", headers={"X-Request-ID": "trace-1.a_b"})
        replaced = client.get("/api/health", headers={"X-Request-ID": "<bad id>"})
        assert echoed.headers["x-request-id"] == "trace-1.a_b"
        assert replaced.headers["x-request-id"] != "<bad id>"
        assert len(replaced.headers.get_list("x-request-id")) == 1


def test_duplicate_or_oversized_ids_are_replaced():
    assert request_id_from([(b"x-request-id", b"a"), (b"X-Request-ID", b"b")]) not in {
        b"a",
        b"b",
    }
    assert request_id_from([(b"x-request-id", b"a" * 65)]) != b"a" * 65
