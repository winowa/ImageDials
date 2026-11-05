"""Direct bounded context windows, end navigation and compact progress transport."""

import hashlib

import pytest
from app.main import create_app
from fastapi.testclient import TestClient
from test_library import save_image
from test_library_navigation import ids, read_page
from test_library_pages import seed


@pytest.mark.parametrize("order", ["newest", "oldest"])
@pytest.mark.parametrize("target", [0, 1, 7, 13, 14])
def test_around_window_contains_target_and_uses_adjacent_keyset_pages(
    tmp_path, order, target
):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        seed(client.app.state.store, 15)
        params = {"limit": 4, "order": order}
        page = read_page(client, **params, around=f"sample-{target:06d}")
        expected = [f"sample-{number:06d}" for number in range(15)]
        if order == "newest":
            expected.reverse()
        start = expected.index(ids(page)[0])
        assert ids(page) == expected[start : start + 4]
        assert page["count"] == 4
        assert page["images"][page["anchor_index"]]["id"] == f"sample-{target:06d}"
        assert page["position"] == (0 if start == 0 else None)
        for field, direction in (("previous_cursor", -1), ("next_cursor", 1)):
            if page[field]:
                adjacent = read_page(client, **params, cursor=page[field])
                assert set(ids(adjacent)).isdisjoint(ids(page))
                if direction == 1:
                    assert ids(adjacent) == expected[start + 4 : start + 8]
                else:
                    assert ids(adjacent) == expected[max(0, start - 4) : start]
                assert adjacent["anchor_index"] is None


@pytest.mark.parametrize("order", ["newest", "oldest"])
def test_last_edge_is_exact_and_return_navigation_survives_a_save(tmp_path, order):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        store = client.app.state.store
        seed(store, 15)
        params = {"limit": 4, "order": order}
        page = read_page(client, **params, edge="last")
        expected = [f"sample-{number:06d}" for number in range(15)]
        if order == "newest":
            expected.reverse()
        assert ids(page) == expected[-4:]
        assert page["position"] == 11 and page["next_cursor"] is None
        previous = read_page(client, **params, cursor=page["previous_cursor"])
        assert ids(previous) == expected[-8:-4]
        assert previous["position"] == 7
        store.notify_library("watermark")
        revised = read_page(client, **params, cursor=page["previous_cursor"])
        assert ids(revised) == ids(previous) and revised["position"] is None


def test_anchor_respects_event_orientation_search_and_private_visibility(tmp_path):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        store = client.app.state.store
        seed(store, 9)
        for parameters in (
            {"around": "missing"},
            {"around": "sample-000002", "event_name": "exhibit"},
            {"around": "sample-000002", "orientation": "landscape"},
            {"around": "sample-000002", "q": "vessel 3"},
        ):
            assert (
                client.get("/api/images/library/page", params=parameters).status_code
                == 404
            )
        from app.library_index import write_projection

        with store.write_transaction() as database:
            write_projection(
                database,
                {"id": "hidden", "visibility": "private"},
                store.library_search_available,
            )
            store.record_library_change(database, "saved")
        assert (
            client.get(
                "/api/images/library/page", params={"around": "hidden"}
            ).status_code
            == 404
        )
        filtered = read_page(client, around="sample-000003", q="vessel 3")
        assert filtered["images"][filtered["anchor_index"]]["id"] == "sample-000003"
        empty = read_page(client, q="absent", edge="last")
        assert empty["images"] == [] and empty["position"] == 0


@pytest.mark.parametrize(
    "parameters",
    [
        {"around": "a", "cursor": "b"},
        {"around": "a", "edge": "last"},
        {"cursor": "b", "edge": "first"},
        {"around": ""},
        {"around": "x" * 201},
        {"around": "bad\x00id"},
        {"edge": "middle"},
        {"cursor": ""},
    ],
)
def test_invalid_direct_navigation_cannot_fall_back_to_the_head(tmp_path, parameters):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        assert (
            client.get("/api/images/library/page", params=parameters).status_code == 400
        )


def test_anchor_etag_and_content_url_match_actual_detail_and_original_bytes(tmp_path):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        saved = save_image(client, "anchor-original")
        parameters = {"around": saved["id"]}
        response = client.get("/api/images/library/page", params=parameters)
        summary = response.json()["images"][0]
        detail = client.get(summary["detail_url"]).json()
        assert summary["image_url"] == detail["image_url"]
        original = client.get(summary["image_url"])
        assert original.status_code == 200
        assert hashlib.sha256(original.content).hexdigest() == saved["sha256"]
        assert (
            client.get(
                "/api/images/library/page",
                params=parameters,
                headers={"If-None-Match": response.headers["etag"]},
            ).status_code
            == 304
        )


def test_progress_is_bounded_independent_of_library_rows_and_has_its_own_etag(
    tmp_path, monkeypatch
):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        store = client.app.state.store
        seed(store)
        batch = {
            "id": "batch-example",
            "status": "running",
            "completion_scope": "analysis",
            "queued_count": 100000,
            "completed_count": 600,
            "failed_count": 500,
            "force": False,
            "errors": ["large error"] * 10000,
        }
        store.set_setting("watermark-backfill", batch)
        page = read_page(client, limit=2)
        assert page["watermark_backfill"]["failed_count"] == 500
        assert "errors" not in page["watermark_backfill"]
        assert "watermark_backfill" not in read_page(
            client, limit=2, cursor=page["next_cursor"]
        )
        endpoint = "/api/images/library/watermarks/status"
        response = client.get(endpoint)
        assert len(response.content) < 512
        assert response.json()["watermark_backfill"] == page["watermark_backfill"]

        def forbidden(*args):
            raise AssertionError("Progress must not load the library or full batch")

        monkeypatch.setattr(store, "images", forbidden)
        monkeypatch.setattr(store, "setting", forbidden)
        assert (
            client.get(
                endpoint, headers={"If-None-Match": response.headers["etag"]}
            ).status_code
            == 304
        )
        store.set_setting("watermark-backfill", {**batch, "completed_count": 601})
        updated = client.get(
            endpoint, headers={"If-None-Match": response.headers["etag"]}
        )
        assert (
            updated.status_code == 200
            and updated.json()["watermark_backfill"]["completed_count"] == 601
        )


def test_progress_and_anchors_respect_disabled_shared_library_and_base_alias(tmp_path):
    settings = {"IMAGEDIALS_DATA_DIR": str(tmp_path), "APP_BASE_PATH": "/studio/v1"}
    with TestClient(create_app(settings)) as client:
        seed(client.app.state.store)
        assert (
            client.get(
                "/studio/v1/api/images/library/page", params={"around": "sample-000002"}
            ).status_code
            == 200
        )
        assert client.get("/studio/v1/api/images/library/watermarks/status").json() == {
            "watermark_backfill": None
        }
    with TestClient(
        create_app({**settings, "SHARED_LIBRARY_ENABLED": "false"})
    ) as client:
        assert (
            client.get(
                "/api/images/library/page", params={"around": "sample-000002"}
            ).status_code
            == 403
        )
        assert client.get("/api/images/library/watermarks/status").status_code == 403
