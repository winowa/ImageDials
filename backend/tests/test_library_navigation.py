"""Bounded bidirectional traversal survives ordinary concurrent catalog writes."""

import pytest
from app.library_pages import decode_cursor, encode_cursor
from app.main import create_app
from fastapi.testclient import TestClient
from test_library import save_image
from test_library_pages import seed


def ids(page):
    return [row["id"] for row in page["images"]]


def read_page(client, **params):
    response = client.get("/api/images/library/page", params=params)
    assert response.status_code == 200, response.text
    return response.json()


@pytest.mark.parametrize("order", ["newest", "oldest"])
def test_forward_backward_pages_keep_display_order_and_exact_positions(tmp_path, order):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        seed(client.app.state.store)
        features = client.get("/api/app-capabilities").json()["shared_library"][
            "paging"
        ]
        assert features["backward_navigation_enabled"] is True
        assert features["revision_tolerant_cursors"] is True
        params = {"limit": 2, "order": order}
        pages = [read_page(client, **params)]
        while pages[-1]["next_cursor"]:
            pages.append(read_page(client, **params, cursor=pages[-1]["next_cursor"]))
        expected = [f"sample-{number:06d}" for number in range(7)]
        if order == "newest":
            expected.reverse()
        assert [identity for page in pages for identity in ids(page)] == expected
        assert [page["position"] for page in pages] == [0, 2, 4, 6]
        assert pages[0]["previous_cursor"] is None
        current = pages[-1]
        for expected_page in reversed(pages[:-1]):
            current = read_page(client, **params, cursor=current["previous_cursor"])
            assert ids(current) == ids(expected_page)
            assert current["position"] == expected_page["position"]
            forward = read_page(client, **params, cursor=current["next_cursor"])
            assert forward["position"] == current["position"] + len(current["images"])
        assert current["previous_cursor"] is None


def test_save_delete_and_watermark_changes_do_not_restart_deep_traversal(tmp_path):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        store = client.app.state.store
        seed(store)
        first = read_page(client, limit=2)
        second = read_page(client, limit=2, cursor=first["next_cursor"])
        saved = save_image(client, "independent-arrival")
        original = (tmp_path / saved["filename"]).read_bytes()
        client.app.state.watermarks.analyze(store.image(saved["id"]))
        deleted = client.request(
            "DELETE",
            "/api/images/library",
            json={"storage_id": "local-0", "filename": "sample-000002.png"},
        )
        assert deleted.status_code == 200
        cursor = second["next_cursor"]
        remaining = []
        while cursor:
            page = read_page(client, limit=2, cursor=cursor)
            assert page["position"] is None
            remaining.extend(ids(page))
            cursor = page["next_cursor"]
        assert remaining == ["sample-000001", "sample-000000"]
        assert (tmp_path / saved["filename"]).read_bytes() == original
        assert ids(read_page(client, limit=2))[0] == saved["id"]
        assert read_page(client, limit=2)["position"] == 0


def test_revision_changes_revalidate_etags_without_invalidating_boundaries(tmp_path):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        seed(client.app.state.store)
        first = read_page(client, limit=2)
        params = {"limit": 2, "cursor": first["next_cursor"]}
        before = client.get("/api/images/library/page", params=params)
        client.app.state.store.notify_library("watermark")
        after = client.get(
            "/api/images/library/page",
            params=params,
            headers={"If-None-Match": before.headers["etag"]},
        )
        assert after.status_code == 200
        assert after.headers["etag"] != before.headers["etag"]
        assert ids(after.json()) == ids(before.json())
        assert after.json()["position"] is None
        cached = client.get(
            "/api/images/library/page",
            params=params,
            headers={"If-None-Match": after.headers["etag"]},
        )
        assert cached.status_code == 304 and cached.content == b""


def test_deleted_tail_has_a_bounded_return_cursor_including_its_boundary(tmp_path):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        seed(client.app.state.store)
        first = read_page(client, limit=4)
        for number in range(3):
            client.app.state.store.delete(f"sample-{number:06d}")
        empty = read_page(client, limit=4, cursor=first["next_cursor"])
        assert empty["images"] == [] and empty["total"] == 4
        assert empty["next_cursor"] is None and empty["previous_cursor"]
        returned = read_page(client, limit=4, cursor=empty["previous_cursor"])
        assert ids(returned) == ids(first)
        assert returned["previous_cursor"] is None
        assert returned["next_cursor"] is None


def test_legacy_forward_cursor_remains_usable_without_claiming_an_exact_position(
    tmp_path,
):
    import base64
    import json

    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        seed(client.app.state.store)
        cursor = read_page(client, limit=2)["next_cursor"]
        data = json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))
        for field in ("direction", "position", "index_version", "inclusive"):
            data.pop(field)
        page = read_page(client, limit=2, cursor=encode_cursor(data))
        assert ids(page) == ["sample-000004", "sample-000003"]
        assert page["position"] is None
        assert page["previous_cursor"]


@pytest.mark.parametrize(
    "field,value",
    [
        ("v", True),
        ("position", False),
        ("position", -1),
        ("direction", "sideways"),
        ("inclusive", 1),
    ],
)
def test_malformed_navigation_fields_are_rejected(field, value):
    from fastapi import HTTPException

    data = {"v": 1, "query": "query", "revision": 1, "time": 0, "id": "image"}
    data[field] = value
    with pytest.raises(HTTPException) as failure:
        decode_cursor(encode_cursor(data), "query")
    assert failure.value.status_code == 400
