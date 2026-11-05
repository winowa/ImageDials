"""Session replacement and renewal preserve an established gallery sequence."""

import json
from pathlib import Path
from types import SimpleNamespace
from uuid import UUID

import pytest
from app.main import create_app
from fastapi.testclient import TestClient
from test_gallery_sessions import PATH, create, ready
from test_library_pages import seed


def keys(page):
    return [record["id"] for record in page["images"]]


def test_requested_first_member_moves_only_it_to_rank_zero(tmp_path, monkeypatch):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        seed(client.app.state.store, 20)
        monkeypatch.setattr(
            "app.gallery_sessions.secrets.token_bytes", lambda _: b"x" * 16
        )
        original = ready(client, create(client)).json()
        target = keys(original)[11]
        replacement = ready(client, create(client, first_image_id=target)).json()
        assert replacement["first_image_member"] is True
        assert keys(replacement) == [
            target,
            *[key for key in keys(original) if key != target],
        ]
        assert [item["session_rank"] for item in replacement["images"]] == list(
            range(20)
        )
        adjacent = ready(client, replacement["session_id"], rank=1, limit=2).json()
        assert keys(adjacent) == keys(replacement)[1:3]


@pytest.mark.parametrize("target", ["missing", "sample-000002"])
def test_nonmember_first_target_does_not_broaden_scope(tmp_path, monkeypatch, target):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        seed(client.app.state.store, 12)
        monkeypatch.setattr(
            "app.gallery_sessions.secrets.token_bytes", lambda _: b"x" * 16
        )
        original = ready(
            client, create(client, event_name="exhibit"), event_name="exhibit"
        ).json()
        replacement = ready(
            client,
            create(client, event_name="exhibit", first_image_id=target),
            event_name="exhibit",
        ).json()
        assert replacement["first_image_member"] is False
        assert keys(replacement) == keys(original)
        assert target not in keys(replacement)


@pytest.mark.parametrize("target", [False, 1, "", "x" * 201, "bad\x00id", []])
def test_invalid_first_target_does_not_allocate(tmp_path, target):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        assert client.post(PATH, json={"first_image_id": target}).status_code == 400
        with client.app.state.store.connect() as database:
            assert (
                database.execute("SELECT count(*) FROM gallery_sessions").fetchone()[0]
                == 0
            )


def test_renewal_outlives_original_ttl_without_reordering_or_unbounded_extension(
    tmp_path, monkeypatch
):
    settings = {
        "IMAGEDIALS_DATA_DIR": str(tmp_path),
        "GALLERY_SESSION_TTL_SECONDS": "10",
    }
    with TestClient(create_app(settings)) as client:
        store = client.app.state.store
        seed(store, 12)
        identity = create(client, event_name="exhibit")
        first = ready(client, identity, event_name="exhibit")
        original = first.json()
        now = original["expires_at"] - 1
        monkeypatch.setattr(
            "app.gallery_sessions.time", SimpleNamespace(time=lambda: now)
        )
        renewal = client.post(
            f"{PATH}/{identity}/renew",
            params={"event_name": "exhibit"},
            json={"ttl_seconds": 999999},
        )
        assert renewal.status_code == 200
        assert renewal.headers["cache-control"] == "no-store"
        assert renewal.json()["expires_at"] == now + 10
        now += 9
        second = ready(client, identity, event_name="exhibit")
        assert keys(second.json()) == keys(original)
        assert second.json()["snapshot_revision"] == original["snapshot_revision"]
        assert second.headers["etag"] != first.headers["etag"]
        repeated = client.post(
            f"{PATH}/{identity}/renew", params={"event_name": "exhibit"}
        )
        assert repeated.json()["expires_at"] == now + 10
        assert (
            client.post(
                f"{PATH}/{identity}/renew", params={"event_name": "workshop"}
            ).status_code
            == 404
        )
        now += 11
        assert (
            client.post(
                f"{PATH}/{identity}/renew", params={"event_name": "exhibit"}
            ).status_code
            == 410
        )


def test_missing_failed_or_disabled_session_cannot_be_renewed(tmp_path):
    settings = {"IMAGEDIALS_DATA_DIR": str(tmp_path)}
    with TestClient(create_app(settings)) as client:
        seed(client.app.state.store)
        identity = create(client)
        ready(client, identity)
        with client.app.state.store.write_transaction() as database:
            database.execute(
                "UPDATE gallery_sessions SET state='building',owner='missing' WHERE id=?",
                (identity,),
            )
        assert client.post(f"{PATH}/{identity}/renew").status_code == 409
        assert client.post(f"{PATH}/missing/renew").status_code == 404
    with TestClient(
        create_app({**settings, "SHARED_LIBRARY_ENABLED": "false"})
    ) as client:
        assert client.post(f"{PATH}/{identity}/renew").status_code == 403


def test_old_session_schema_is_extended_without_changing_members_or_sources(tmp_path):
    settings = {"IMAGEDIALS_DATA_DIR": str(tmp_path)}
    with TestClient(create_app(settings)) as client:
        store = client.app.state.store
        seed(store)
        identity = create(client)
        first = ready(client, identity).json()
        with store.write_transaction() as database:
            original = database.execute(
                "SELECT id,data FROM images ORDER BY id"
            ).fetchall()
            database.execute("ALTER TABLE gallery_sessions DROP COLUMN first_image_id")
            database.execute(
                "ALTER TABLE gallery_sessions DROP COLUMN first_image_member"
            )
    with TestClient(create_app(settings)) as client:
        migrated = ready(client, identity).json()
        assert migrated["images"] == first["images"]
        assert migrated["first_image_member"] is None
        with client.app.state.store.connect() as database:
            assert (
                database.execute("SELECT id,data FROM images ORDER BY id").fetchall()
                == original
            )


def test_shared_gallery_fixture_matches_the_native_session_contract(
    tmp_path, monkeypatch
):
    fixture = json.loads(
        (
            Path(__file__).resolve().parents[2] / "fixtures/api/gallery-sessions.json"
        ).read_text()
    )
    now = [1700000010.0]
    identities = iter(
        (
            UUID("11111111-1111-4111-8111-111111111111"),
            UUID("22222222-2222-4222-8222-222222222222"),
        )
    )
    monkeypatch.setattr(
        "app.gallery_sessions.time", SimpleNamespace(time=lambda: now[0])
    )
    monkeypatch.setattr("app.gallery_sessions.uuid4", lambda: next(identities))
    monkeypatch.setattr("app.gallery_sessions.secrets.token_bytes", lambda _: b"x" * 16)
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        assert seed(client.app.state.store) == fixture["source_records"]
        created = client.post(PATH, json=fixture["create"]["request"])
        assert created.json() == fixture["create"]["response"]
        identity = created.json()["session_id"]
        for key in ("page", "backward_page"):
            assert (
                ready(client, identity, **fixture[key]["request"]).json()
                == fixture[key]["response"]
            )
        anchored = client.post(PATH, json=fixture["create_anchored"]["request"])
        assert anchored.json() == fixture["create_anchored"]["response"]
        assert (
            ready(
                client,
                anchored.json()["session_id"],
                **fixture["anchored_page"]["request"],
            ).json()
            == fixture["anchored_page"]["response"]
        )
        now[0] += 900
        renewal = client.post(f"{PATH}/{identity}/renew")
        assert renewal.json() == fixture["renew"]["response"]
        now[0] += 1801
        expired = client.post(f"{PATH}/{identity}/renew")
        assert expired.status_code == fixture["expired_renewal"]["status"]
        assert expired.json() == fixture["expired_renewal"]["response"]
