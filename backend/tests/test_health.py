from app.main import create_app
from fastapi.testclient import TestClient


def test_health(tmp_path):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        response = client.get("/api/health")
        assert response.status_code == 200
        assert response.json()["status"] == "ok"
        assert response.json()["providers"]["image"]["kind"] == "mock"
