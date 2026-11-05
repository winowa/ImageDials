"""Malformed foreign workflow metadata must not prevent image-description fallback."""

import io
import json

import pytest
from app.comfy_prompt import comfyui_positive_prompt
from app.main import create_app
from fastapi.testclient import TestClient
from PIL import Image, PngImagePlugin


@pytest.mark.parametrize("inputs", [7, True, "positive", {"positive": 1}])
def test_non_list_workflow_inputs_are_ignored(inputs):
    workflow = {
        "nodes": [{"id": 1, "type": "KSampler", "inputs": inputs}],
        "links": [],
    }
    assert comfyui_positive_prompt({"workflow": json.dumps(workflow)}) is None


@pytest.mark.parametrize("inputs", [7, [{"name": "positive", "link": []}]])
def test_import_falls_back_to_description_for_malformed_workflow(tmp_path, inputs):
    workflow = {
        "nodes": [{"id": 1, "type": "KSampler", "inputs": inputs}],
        "links": [],
    }
    metadata = PngImagePlugin.PngInfo()
    metadata.add_text("workflow", json.dumps(workflow))
    output = io.BytesIO()
    Image.new("RGB", (32, 24), "blue").save(output, format="PNG", pnginfo=metadata)
    settings = {
        "IMAGEDIALS_DATA_DIR": str(tmp_path),
        "IMAGE_PROVIDER": "mock",
        "IMAGE_DESCRIPTION_PROVIDER": "mock",
    }
    with TestClient(create_app(settings)) as client:
        response = client.post(
            "/api/images/import-analysis",
            files={"image": ("foreign-workflow.png", output.getvalue(), "image/png")},
        )
        assert response.status_code == 200, response.text
        result = response.json()
        assert result["mode"] == "description"
        assert result["description"]["status"] == "ready"
        assert result["prompt"] == result["description"]["text"]
        assert client.app.state.store.images() == []


@pytest.mark.parametrize("link", [[], {}, True, "1", None])
def test_invalid_workflow_links_cannot_match_a_positive_branch(link):
    workflow = {
        "nodes": [
            {
                "id": 1,
                "type": "KSampler",
                "inputs": [{"name": "positive", "link": link}],
            },
            {
                "id": 2,
                "type": "CLIPTextEncode",
                "widgets_values": ["A blue glass vase"],
            },
        ],
        "links": [[1, 2, 0, 1, 0, "CONDITIONING"]],
    }
    assert comfyui_positive_prompt({"workflow": json.dumps(workflow)}) is None
