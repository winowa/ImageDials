from app.main import app
from fastapi.testclient import TestClient


def test_health():
    response = TestClient(app).get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
