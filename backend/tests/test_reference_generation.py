"""The editing generation transport uses actual reference bytes, not descriptions alone."""

import base64
import hashlib
import io
import json
import time
from pathlib import Path

import pytest
from app.domain import PromptDraft
from app.main import create_app
from app.media import PNG_METADATA_KEY
from app.providers import PromptComposer
from fastapi.testclient import TestClient
from PIL import Image


def source(color, size=(40, 24)):
    output = io.BytesIO()
    Image.new("RGB", size, color).save(output, "PNG")
    return output.getvalue()


def submission(images, key="reference-generation"):
    descriptors = [
        {
            "id": f"reference-{index}",
            "sha256": hashlib.sha256(data).hexdigest(),
            "description": f"Source color {index}",
            "role": "base" if index == 1 else "reference",
        }
        for index, data in enumerate(images, start=1)
    ]
    return {
        "prompt": "Change the base image using the reference colors",
        "controls": [],
        "dimensions": "96x64",
        "idempotency_key": key,
        "reference_images": descriptors,
    }


def post(client, body, images, **kwargs):
    return client.post(
        "/api/generate-image",
        data={"request": json.dumps(body)},
        files=[
            (f"reference_{index}", (f"source-{index}.png", data, "image/png"))
            for index, data in enumerate(images, start=1)
        ],
        **kwargs,
    )


def finish(client, identity):
    for _ in range(200):
        result = client.get(f"/api/generation-jobs/{identity}").json()
        if result["status"] != "running":
            return result
        time.sleep(0.01)
    pytest.fail("Reference generation did not complete")


@pytest.mark.parametrize("count", [1, 2, 4, 10])
def test_reference_pixels_order_metadata_retry_and_restart(tmp_path, count):
    images = [source((index * 40, 50, 90)) for index in range(1, count + 1)]
    body = submission(images)
    settings = {"IMAGEDIALS_DATA_DIR": str(tmp_path)}
    with TestClient(create_app(settings)) as client:
        renderer = client.app.state.renderer
        render = renderer.render
        calls = []

        def record_render(prompt, width, height, **kwargs):
            calls.append(kwargs.get("references"))
            return render(prompt, width, height, **kwargs)

        renderer.render = record_render
        accepted = post(client, body, images)
        assert accepted.status_code == 202, accepted.text
        identity = accepted.json()["generation_job_id"]
        status = finish(client, identity)
        assert status["status"] == "complete", status
        assert [row["data"] for row in calls[0]] == images
        assert post(client, body, images).json()["generation_job_id"] == identity
        assert len(calls) == 1
        result = status["result"]
        assert result["generation_type"] == "image-edit"
        assert result["actual_dimensions"] == {"width": 40, "height": 24}
        assert result["original_selected_controls"] == []
        assert [ref["sha256"] for ref in result["reference_images"]] == [
            hashlib.sha256(data).hexdigest() for data in images
        ]
        assert [ref["index"] for ref in result["reference_images"]] == list(
            range(1, count + 1)
        )
        if count > 1:
            assert all(
                f"<image{index}>" in result["final_prompt"]
                for index in range(1, count + 1)
            )
        original = client.get(result["image_url"]).content
        with Image.open(io.BytesIO(original)) as image:
            embedded = json.loads(image.info[PNG_METADATA_KEY])["image"]
        assert embedded["reference_images"] == result["reference_images"]
        assert "data" not in embedded["reference_images"][0]
        assert original != images[0]
        changed = [source((240, 10, 10)), *images[1:]]
        assert post(client, submission(changed), changed).status_code == 409
    with TestClient(create_app(settings)) as client:
        assert client.get(result["image_url"]).content == original
        assert client.get(f"/api/generation-jobs/{identity}").json() == status


def test_reference_file_hash_binding_and_missing_files_never_fall_back(tmp_path):
    images = [source((50, 60, 70))]
    body = submission(images)
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        assert client.post("/api/generate-image", json=body).status_code == 400
        mismatched = [source((80, 90, 100))]
        assert post(client, body, mismatched).status_code == 400
        duplicate = submission(images * 2)
        duplicate["reference_images"][1]["id"] = duplicate["reference_images"][0]["id"]
        assert post(client, duplicate, images * 2).status_code == 400
        assert client.get("/api/images").json()["total"] == 0


def test_reference_editing_capability_and_disabled_provider(tmp_path):
    settings = {"IMAGEDIALS_DATA_DIR": str(tmp_path)}
    images = [source((20, 30, 40))]
    with TestClient(create_app(settings)) as client:
        editing = client.get("/api/app-capabilities").json()["image_editing"]
        assert editing["enabled"] is True
        assert editing["max_references"] == 10
        client.app.state.renderer.kind = "comfyui"
        client.app.state.renderer.base = ""
        assert post(client, submission(images), images).status_code == 503
        assert client.get("/api/images").json()["total"] == 0


def test_reference_json_context_without_pixels_is_rejected_on_legacy_generation(
    tmp_path,
):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        result = client.post(
            "/api/generations",
            json={
                "prompt": "Edit this image",
                "idempotency_key": "missing-reference-pixels",
                "reference_context": [{"id": "one", "description": "Red rectangle"}],
            },
        )
        assert result.status_code == 400


def test_reference_context_reaches_edit_composition_in_order(monkeypatch):
    from app import providers

    calls = []
    composer = PromptComposer({"LLM_MODEL_ENDPOINT_1": "http://provider.invalid"})
    monkeypatch.setattr(composer, "model_id", lambda: "fixture-model")
    monkeypatch.setattr(composer, "visual_keywords", lambda _: {"keywords": []})

    def respond(_base, _path, body, **_kwargs):
        calls.append(body)
        return {
            "choices": [
                {"message": {"content": "Edit <image1> using the color of <image2>."}}
            ]
        }

    monkeypatch.setattr(providers, "request", respond)
    draft = PromptDraft(
        prompt="Change only the color",
        reference_context=[
            {"id": "base", "description": "A red object", "role": "base"},
            {"id": "color", "description": "A blue color sample", "role": "palette"},
        ],
    )
    result, _ = composer.compose(draft, [])
    assert result == "Edit <image1> using the color of <image2>."
    payload = json.loads(calls[0]["messages"][1]["content"])
    assert [row["role"] for row in payload["reference_images"]] == ["base", "palette"]
    assert [row["index"] for row in payload["reference_images"]] == [1, 2]
    assert "Preserve unmentioned" in calls[0]["messages"][0]["content"]


def test_edit_controls_can_preserve_original_without_losing_snapshot_values(tmp_path):
    images = [source((50, 80, 90))]
    body = submission(images)
    body["controls"] = [
        {
            "id": "lighting",
            "label": "Lighting",
            "kind": "single-select",
            "options": {"dramatic": "Dramatic light"},
            "value": "dramatic",
            "apply_to_edit": False,
        }
    ]
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        accepted = post(client, body, images)
        assert accepted.status_code == 202, accepted.text
        result = finish(client, accepted.json()["generation_job_id"])["result"]
        assert result["original_selected_controls"] == body["controls"]
        assert result["resolved_controls"][0]["apply_to_edit"] is False
        assert "Dramatic light" not in result["final_prompt"]
        invalid = json.loads(json.dumps(body))
        invalid["controls"][0]["apply_to_edit"] = "false"
        invalid["idempotency_key"] = "invalid-edit-application"
        assert post(client, invalid, images).status_code == 400


CANVAS_CASES = json.loads(
    (
        Path(__file__).resolve().parents[2] / "fixtures/api/image-editing.json"
    ).read_text()
)["canvas_cases"]


@pytest.mark.parametrize("case", CANVAS_CASES, ids=lambda case: case["name"])
def test_edit_metadata_uses_actual_canvas_instead_of_text_request_aspect(
    tmp_path, case
):
    data = base64.b64decode(case["source"]["base64"])
    images = [data]
    body = case["request"]
    expected = case["expected"]
    assert hashlib.sha256(data).hexdigest() == case["source"]["sha256"]
    with Image.open(io.BytesIO(data)) as source_image:
        size = source_image.size
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        accepted = post(client, body, images)
        assert accepted.status_code == 202, accepted.text
        state = finish(client, accepted.json()["generation_job_id"])
        assert state["status"] == "complete", state
        result = state["result"]
        assert {key: result[key] for key in expected} == expected
        assert result["actual_dimensions"] == {"width": size[0], "height": size[1]}
        data = client.get(result["image_url"]).content
        with Image.open(io.BytesIO(data)) as image:
            snapshot = json.loads(image.info[PNG_METADATA_KEY])["image"]
            assert image.size == size
        assert {key: snapshot[key] for key in case["embedded"]} == case["embedded"]
        preview = client.get(
            f"/api/generation-jobs/{result['generation_job_id']}/preview"
        )
        assert preview.status_code == 200
        with Image.open(io.BytesIO(preview.content)) as image:
            preview_snapshot = json.loads(image.info[PNG_METADATA_KEY])["image"]
        assert {key: preview_snapshot[key] for key in case["embedded"]} == case[
            "embedded"
        ]
        record = client.get(f"/api/images/library/record/{result['image_id']}").json()
        assert record["aspect"] == expected["aspect"]
        assert record["dimensions"] == expected["actual_dimensions"]
