"""Actual HTTP admission and stored region composites with deterministic providers."""

import hashlib
import io
import json
import time

import pytest
from app.main import create_app
from app.media import PNG_METADATA_KEY
from app.providers import ProviderError
from fastapi.testclient import TestClient
from PIL import Image
from test_reference_generation import finish, post, submission


def source():
    image = Image.new("RGBA", (40, 24))
    image.putdata(
        [
            (x * 4, y * 7, 80, 0 if x % 3 == 0 else 190)
            for y in range(24)
            for x in range(40)
        ]
    )
    output = io.BytesIO()
    image.save(output, "PNG")
    return output.getvalue()


def region(data):
    return {
        "version": 1,
        "source_sha256": hashlib.sha256(data).hexdigest(),
        "width": 40,
        "height": 24,
        "shapes": [{"kind": "rectangle", "x": 5, "y": 6, "width": 10, "height": 8}],
        "feather": 0,
    }


def body_for(data, **patch):
    return {**submission([data]), "region_edit": region(data), **patch}


def renderer(client, *, fail_first=False):
    calls = []

    def render(prompt, width, height, *, references):
        calls.append(references)
        if fail_first and len(calls) == 1:
            raise ProviderError("Synthetic first variation failed")
        output = io.BytesIO()
        Image.new("RGB", (80, 48), (210, 40, 60)).save(output, "PNG")
        return output.getvalue(), {"provider": "mock", "seed": len(calls)}

    client.app.state.renderer.render = render
    return calls


def verify_pixels(data, encoded):
    with Image.open(io.BytesIO(data)) as raw, Image.open(io.BytesIO(encoded)) as output:
        original, composite = raw.convert("RGBA"), output.convert("RGBA")
        assert composite.size == original.size
        for y in range(24):
            for x in range(40):
                expected = (
                    (210, 40, 60, 255)
                    if 5 <= x < 15 and 6 <= y < 14
                    else original.getpixel((x, y))
                )
                assert composite.getpixel((x, y)) == expected
        return json.loads(output.info[PNG_METADATA_KEY])["image"]


def test_http_region_edit_saves_only_the_final_composite_and_preserves_original(
    tmp_path,
):
    data = source()
    original = tmp_path / "original.png"
    original.write_bytes(data)
    settings = {"IMAGEDIALS_DATA_DIR": str(tmp_path / "catalog")}
    with TestClient(create_app(settings)) as client:
        calls = renderer(client)
        body = body_for(data)
        accepted = post(client, body, [data])
        assert accepted.status_code == 202, accepted.text
        identity = accepted.json()["generation_job_id"]
        terminal = finish(client, identity)
        assert terminal["status"] == "complete", terminal
        record = terminal["result"]
        assert record["actual_dimensions"] == {"width": 40, "height": 24}
        assert record["region_edit"] == body["region_edit"]
        assert record["region_edit_result"]["selected_pixels"] == 80
        assert record["region_edit_result"]["method"] == "generated-image-composite"
        assert record["region_edit_result"]["native_mask"] is False
        encoded = client.get(record["image_url"]).content
        metadata = verify_pixels(data, encoded)
        assert metadata["region_edit"] == body["region_edit"]
        assert metadata["region_edit_result"] == record["region_edit_result"]
        assert calls[0][0]["data"] == data
        assert len(calls[0]) == 1  # No mask pretending to be another native reference.
        assert post(client, body, [data]).json()["generation_job_id"] == identity
        changed = {**body, "region_edit": {**body["region_edit"], "feather": 1}}
        assert post(client, changed, [data]).status_code == 409
        assert len(calls) == 1
        assert original.read_bytes() == data
    with TestClient(create_app(settings)) as restarted:
        response = restarted.get(f"/api/images/library/record/{identity}")
        assert response.status_code == 200, response.text
        stored = response.json()
        assert stored["region_edit"] == body["region_edit"]
        verify_pixels(data, restarted.get(stored["image_url"]).content)
        assert original.read_bytes() == data


@pytest.mark.parametrize(
    "change",
    [
        {"source_sha256": "0" * 64},
        {"width": 41},
        {"shapes": []},
        {"shapes": [{"kind": "rectangle", "x": 39, "y": 0, "width": 2, "height": 1}]},
        {"shapes": [{"kind": "brush", "radius": 3, "points": [[0, -1]]}]},
    ],
)
def test_bad_region_is_rejected_before_provider_or_job_admission(tmp_path, change):
    data = source()
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        calls = renderer(client)
        body = body_for(data, region_edit={**region(data), **change})
        assert post(client, body, [data]).status_code == 400
        assert calls == []
        with client.app.state.store.connect() as database:
            assert database.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 0
        assert client.get("/api/images").json()["total"] == 0


def test_json_without_source_and_disabled_providers_do_not_fall_back_to_text(tmp_path):
    data = source()
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        body = body_for(data)
        body.pop("reference_images")
        body["controls"] = [{"kind": "binary", "label": "Gloss", "value": False}]
        assert client.post("/api/generate-image", json=body).status_code == 400
        client.app.state.renderer.kind = "comfyui"
        client.app.state.renderer.base = ""
        assert (
            client.get("/api/app-capabilities").json()["region_editing"]["enabled"]
            is False
        )
        assert post(client, body_for(data), [data]).status_code == 503


def test_empty_effective_feather_is_rejected_before_provider_work(tmp_path):
    buffer = io.BytesIO()
    Image.new("RGB", (1000, 1000), (20, 40, 60)).save(buffer, "PNG")
    data = buffer.getvalue()
    selection = {
        **region(data),
        "width": 1000,
        "height": 1000,
        "feather": 32,
        "shapes": [{"kind": "rectangle", "x": 500, "y": 500, "width": 1, "height": 1}],
    }
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        calls = renderer(client)
        response = post(client, body_for(data, region_edit=selection), [data])
        assert response.status_code == 400, response.text
        assert "reduce feathering" in response.text
        assert calls == []


def test_region_capability_describes_software_path_and_inference_limits(tmp_path):
    with TestClient(
        create_app(
            {
                "IMAGEDIALS_DATA_DIR": str(tmp_path),
                "IMAGE_MAX_DECODED_PIXELS": "2000000",
            }
        )
    ) as client:
        cap = client.get("/api/app-capabilities").json()["region_editing"]
        assert cap["enabled"] is True
        assert cap["native_mask"] is False
        assert cap["method"] == "generated-image-composite"
        assert cap["max_pixels"] == 2_000_000
        assert cap["output_geometry"] == "oriented-base"
    with TestClient(
        create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path), "INFERENCE_ENABLED": "false"})
    ) as client:
        assert (
            client.get("/api/app-capabilities").json()["region_editing"]["enabled"]
            is False
        )
        assert post(client, body_for(source()), [source()]).status_code == 503


def test_region_variation_retry_reuses_selection_and_never_regenerates_success(
    tmp_path,
):
    data = source()
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        calls = renderer(client, fail_first=True)
        body = body_for(data, variation_count=2)
        accepted = post(client, body, [data])
        assert accepted.status_code == 202, accepted.text
        group_id = accepted.json()["variation_group"]["id"]

        def wait():
            for _ in range(300):
                result = client.get(f"/api/generation-groups/{group_id}").json()
                if result["status"] != "running":
                    return result
                time.sleep(0.01)
            pytest.fail("Variation group did not finish")

        partial = wait()
        assert partial["status"] == "partial"
        successful_id = partial["jobs"][1]["generation_job_id"]
        retry = {
            **body,
            "idempotency_key": "retry-region",
            "variation_count": 1,
            "retry_variations": {"group_id": group_id, "indices": [0]},
        }
        changed = {**retry, "region_edit": {**body["region_edit"], "feather": 1}}
        assert post(client, changed, [data]).status_code == 409
        assert post(client, retry, [data]).status_code == 202
        completed = wait()
        assert completed["status"] == "complete"
        assert len(calls) == 3
        assert completed["jobs"][1]["generation_job_id"] == successful_id
        for job in completed["jobs"]:
            record = job["result"]
            assert record["region_edit"] == body["region_edit"]
            verify_pixels(data, client.get(record["image_url"]).content)
