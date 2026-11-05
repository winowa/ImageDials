"""Selected-model reference limits: discovery, validation and rendering agree.

All providers here are the deterministic mock or a ComfyUI adapter whose
network calls are never reached (refused requests) or replaced by test
doubles; nothing performs model inference.
"""

import base64
import json

import pytest
from app.image_editing import (
    MAX_QWEN_REFERENCE_SLOTS,
    add_reference_nodes,
    load_edit_workflow,
)
from app.main import create_app
from app.prompt_strategies import QWEN_IMAGE_21
from app.providers import ImageProvider
from app.reference_capability import REFERENCE_LIMIT_SETTING, reference_limit
from app.reference_types import MAX_REFERENCE_SLOTS
from fastapi.testclient import TestClient
from test_image_editing_provider import edit_graph
from test_reference_analysis import png
from test_reference_analysis import post as analyze
from test_reference_generation import finish, post, source, submission

OVERRIDE = "x-imagedials-provider-overrides"


def images(count):
    return [source((index * 20 % 255, 40, 90)) for index in range(1, count + 1)]


def override(**values):
    return base64.b64encode(json.dumps(values).encode()).decode()


def comfy_settings(tmp_path, **extra):
    workflow = tmp_path / "edit.json"
    workflow.write_text(json.dumps(edit_graph()), encoding="utf-8")
    return {
        "IMAGEDIALS_DATA_DIR": str(tmp_path / "data"),
        "IMAGE_PROVIDER": "comfyui",
        "IMAGE_MODEL_ENDPOINT_1": "http://provider.invalid",
        "IMAGE_EDIT_WORKFLOW_PATH": str(workflow),
        **extra,
    }


def test_documented_qwen_maximum_is_distinct_from_the_slot_envelope():
    assert QWEN_IMAGE_21.max_references == 10
    assert MAX_REFERENCE_SLOTS > QWEN_IMAGE_21.max_references
    # The adapter's genuine slot bound must carry the documented maximum.
    assert MAX_QWEN_REFERENCE_SLOTS >= QWEN_IMAGE_21.max_references
    assert reference_limit({}, QWEN_IMAGE_21, MAX_QWEN_REFERENCE_SLOTS) == (10, False)
    assert reference_limit(
        {REFERENCE_LIMIT_SETTING: "3"}, QWEN_IMAGE_21, MAX_QWEN_REFERENCE_SLOTS
    ) == (3, True)


@pytest.mark.parametrize("value", ["0", "11", "-1", "four", "2.5"])
def test_configured_limit_may_only_lower_the_documented_maximum(value):
    with pytest.raises(ValueError, match="from 1 to 10 for Qwen-Image-2.1"):
        ImageProvider({REFERENCE_LIMIT_SETTING: value})


def test_undocumented_model_maximum_offers_no_slots():
    class Undocumented:
        max_references = None
        model = "Unknown"

    assert reference_limit({}, Undocumented, 16) == (0, False)


def test_ten_references_are_accepted_saved_and_eleven_are_refused(tmp_path):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        editing = client.get("/api/app-capabilities").json()["image_editing"]
        assert editing["max_references"] == 10
        assert editing["model_max_references"] == 10
        assert editing["limit_source"] == "model"
        assert list(editing["prompting"]["labels"]) == [str(n) for n in range(1, 11)]
        assert editing["prompting"]["labels"]["10"][-1] == "<image10>"

        ten = images(10)
        accepted = post(client, submission(ten, key="ten"), ten)
        assert accepted.status_code == 202, accepted.text
        result = finish(client, accepted.json()["generation_job_id"])["result"]
        assert [ref["index"] for ref in result["reference_images"]] == list(
            range(1, 11)
        )
        assert all(f"<image{n}>" in result["final_prompt"] for n in range(1, 11))
        assert "<image11>" not in result["final_prompt"]
        saved = client.get(f"/api/images/{result['image_id']}").json()
        assert len(saved["reference_images"]) == 10

        eleven = images(11)
        refused = post(client, submission(eleven, key="eleven"), eleven)
        assert refused.status_code == 400
        assert "at most 10 reference images" in refused.json()["detail"]
        assert client.get("/api/images").json()["total"] == 1


def test_envelope_still_bounds_parsing_beyond_any_model(tmp_path):
    with TestClient(create_app({"IMAGEDIALS_DATA_DIR": str(tmp_path)})) as client:
        many = images(MAX_REFERENCE_SLOTS + 1)
        refused = post(client, submission(many, key="envelope"), many)
        assert refused.status_code == 400


def test_configured_lower_limit_drives_discovery_upload_and_analysis(tmp_path):
    settings = {
        "IMAGEDIALS_DATA_DIR": str(tmp_path),
        "IMAGE_DESCRIPTION_PROVIDER": "mock",
        REFERENCE_LIMIT_SETTING: "3",
    }
    with TestClient(create_app(settings)) as client:
        for path in ("/api/app-capabilities", "/api/models"):
            editing = client.get(path).json()["image_editing"]
            assert editing["max_references"] == 3
            assert editing["model_max_references"] == 10
            assert editing["limit_source"] == "configured"
            assert list(editing["prompting"]["labels"]) == ["1", "2", "3"]
        three = images(3)
        assert post(client, submission(three, key="three"), three).status_code == 202
        four = images(4)
        refused = post(client, submission(four, key="four"), four)
        assert refused.status_code == 400
        assert "at most 3 reference images" in refused.json()["detail"]

        earlier = [{"id": f"r{n}", "description": f"Image {n}"} for n in range(1, 4)]
        assert (
            analyze(client, png(), {"reference_images": earlier[:2]}).status_code == 200
        )
        too_many = analyze(client, png(), {"reference_images": earlier})
        assert too_many.status_code == 400
        assert "At most 3 reference images" in too_many.json()["detail"]


def test_analysis_context_carries_every_earlier_reference_up_to_the_model(tmp_path):
    settings = {
        "IMAGEDIALS_DATA_DIR": str(tmp_path),
        "IMAGE_DESCRIPTION_PROVIDER": "mock",
    }
    with TestClient(create_app(settings)) as client:
        earlier = [
            {"id": f"r{n}", "description": f"Image {n}", "role": "reference"}
            for n in range(1, 11)
        ]
        # Full-length descriptions for every earlier slot fit the context envelope.
        full = [{**item, "description": "x" * 4000} for item in earlier]
        nine = analyze(
            client, png(), {"prompt": "Combine", "reference_images": earlier[:9]}
        )
        assert nine.status_code == 200, nine.text
        assert nine.json()["reference_index"] == 10
        assert nine.json()["suggested_prompt"] is None
        assert analyze(client, png(), {"reference_images": earlier}).status_code == 400
        # Inspection only hashes; it stays within the envelope.
        inspected = client.post(
            "/api/images/reference-analysis?inspect_only=true",
            data={"context": json.dumps({"reference_images": full})},
            files={"image": ("reference.png", png(), "image/png")},
        )
        assert inspected.status_code == 200


def test_provider_override_switches_capability_and_validation_together(tmp_path):
    settings = comfy_settings(tmp_path)
    disabled = {OVERRIDE: override(IMAGE_MODEL_ENDPOINT_1="")}
    other = {OVERRIDE: override(IMAGE_MODEL_ENDPOINT_1="http://other.invalid")}
    with TestClient(create_app(settings)) as client:
        default = client.get("/api/models").json()["image_editing"]
        assert default["enabled"] is True and default["max_references"] == 10
        unconfigured = client.get("/api/models", headers=disabled).json()
        assert unconfigured["image_editing"]["enabled"] is False
        assert unconfigured["image_editing"]["max_references"] == 0
        assert unconfigured["image_editing"]["prompting"]["labels"] == {}
        assert (
            client.get("/api/models", headers=other).json()["image_editing"][
                "max_references"
            ]
            == 10
        )
        two = images(2)
        refused = post(client, submission(two, key="none"), two, headers=disabled)
        assert refused.status_code == 503
        eleven = images(11)
        over = post(client, submission(eleven, key="over"), eleven, headers=other)
        assert over.status_code == 400
        assert client.get("/api/images").json()["total"] == 0


def test_comfy_adapter_links_ten_ordered_inputs(tmp_path):
    workflow = tmp_path / "edit.json"
    workflow.write_text(json.dumps(edit_graph()), encoding="utf-8")
    graph, encoder = load_edit_workflow(workflow)
    names = [f"ref-{n}.png [temp]" for n in range(1, 11)]
    linked = add_reference_nodes(graph, encoder, names)
    inputs = linked[encoder]["inputs"]
    slots = sorted(
        (key for key in inputs if key.startswith("images.image_")),
        key=lambda key: int(key.rsplit("_", 1)[1]),
    )
    assert slots == [f"images.image_{n}" for n in range(1, 11)]
    assert [linked[inputs[slot][0]]["inputs"]["image"] for slot in slots] == names
