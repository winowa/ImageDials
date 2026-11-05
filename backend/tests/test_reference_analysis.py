import base64
import hashlib
import io
import json

import pytest
from app import reference_analysis
from app.creation import CreationToolsProvider
from app.imports import ImageDescriptionProvider
from app.main import create_app
from fastapi.testclient import TestClient
from PIL import Image, PngImagePlugin


def png(*, orientation=None, metadata=None):
    output = io.BytesIO()
    info = PngImagePlugin.PngInfo()
    if metadata is not None:
        info.add_itxt("ImageDials", metadata)
    image = Image.new("RGB", (32, 20), "#c76345")
    kwargs = {"pnginfo": info} if metadata is not None else {}
    if orientation is not None:
        exif = image.getexif()
        exif[274] = orientation
        kwargs["exif"] = exif
    image.save(output, format="PNG", **kwargs)
    return output.getvalue()


def post(client, image, context=None, *, headers=None):
    fields = {}
    if context is not None:
        fields["context"] = context if isinstance(context, str) else json.dumps(context)
    return client.post(
        "/api/images/reference-analysis",
        data=fields,
        files={"image": ("reference.png", image, "image/png")},
        headers=headers,
    )


def client_for(tmp_path, monkeypatch, **settings):
    env = {"IMAGEDIALS_DATA_DIR": str(tmp_path), **settings}
    app = create_app(env)
    if not any(
        getattr(route, "path", None) == "/api/images/reference-analysis"
        for route in app.routes
    ):
        reference_analysis.register_reference_analysis_routes(
            app, app.state.provider_environment
        )
    return TestClient(app)


def test_pixel_description_ignores_embedded_png_metadata_and_returns_oriented_hash(
    tmp_path, monkeypatch
):
    with client_for(
        tmp_path,
        monkeypatch,
        IMAGE_DESCRIPTION_PROVIDER="mock",
        IMAGE_PROVIDER="mock",
    ) as client:
        source = png(orientation=6, metadata="this is not import metadata")
        response = post(client, source, {"revision": 7})
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["source_sha256"] == hashlib.sha256(source).hexdigest()
        assert body["dimensions"] == {"width": 20, "height": 32}
        assert (
            body["description"]
            == "A mock image description of a small crafted object on a plain background"
        )
        assert body["suggested_prompt"] is None
        assert body["reference_index"] == 1
        assert body["revision"] == 7
        assert body["metadata"]["description"]["provider"] == "mock"
        assert body["metadata"]["prompt"]["provider"] == "not-needed"
        # Import does not trust the malformed snapshot; it describes the pixels.
        imported = client.post(
            "/api/images/import-analysis",
            files={"image": ("reference.png", source, "image/png")},
        ).json()
        assert imported["mode"] == "description"
        assert imported["metadata_notice"] == "Embedded image metadata is invalid"
        with client.app.state.store.connect() as database:
            assert database.execute("SELECT COUNT(*) FROM images").fetchone()[0] == 0
            assert database.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 0


@pytest.mark.parametrize("prompt", ["", "Keep the red fox"])
def test_first_edit_reference_never_proposes_even_with_typed_prompt(
    tmp_path, monkeypatch, prompt
):
    def forbidden(*args, **kwargs):
        raise AssertionError("First image must never compose")

    monkeypatch.setattr(CreationToolsProvider, "generate_json", forbidden)
    with client_for(
        tmp_path, monkeypatch, IMAGE_DESCRIPTION_PROVIDER="mock", IMAGE_PROVIDER="mock"
    ) as client:
        body = post(client, png(), {"prompt": prompt, "revision": 2}).json()
        assert body["suggested_prompt"] is None
        assert body["description"]
        assert body["warnings"] == []


@pytest.mark.parametrize(
    "context",
    [
        "{not json",
        {"unexpected": True},
        {"prompt": 3},
        {"reference_images": [{"id": "x", "description": "a"}] * 2},
        {"reference_images": [{"id": "x", "description": "a", "other": 1}]},
        {"revision": True},
        {"generation_mode": "video"},
    ],
)
def test_malformed_context_is_rejected(tmp_path, monkeypatch, context):
    with client_for(
        tmp_path, monkeypatch, IMAGE_DESCRIPTION_PROVIDER="mock", IMAGE_PROVIDER="mock"
    ) as client:
        response = post(client, png(), context)
        assert response.status_code == 400


def test_upload_limit_inference_and_editing_capability(tmp_path, monkeypatch):
    with client_for(
        tmp_path,
        monkeypatch,
        IMAGE_DESCRIPTION_PROVIDER="mock",
        IMAGE_PROVIDER="mock",
        IMPORT_MAX_BYTES="128",
    ) as client:
        assert post(client, b"x" * 129).status_code == 413
    with client_for(
        tmp_path,
        monkeypatch,
        IMAGE_DESCRIPTION_PROVIDER="mock",
        IMAGE_PROVIDER="mock",
    ) as client:
        assert (
            post(
                client, png(), "x" * (reference_analysis.MAX_CONTEXT_BYTES + 1)
            ).status_code
            == 413
        )

    with client_for(
        tmp_path,
        monkeypatch,
        IMAGE_DESCRIPTION_PROVIDER="mock",
        IMAGE_PROVIDER="mock",
        INFERENCE_ENABLED="false",
    ) as client:
        assert post(client, png()).status_code == 503

    with client_for(
        tmp_path,
        monkeypatch,
        IMAGE_DESCRIPTION_PROVIDER="mock",
        IMAGE_PROVIDER="comfyui",
        IMAGE_MODEL_ENDPOINT_1="https://image.example.invalid",
        IMAGE_WORKFLOW_PATH="/unused/workflow.json",
    ) as client:
        response = post(client, png())
        assert response.status_code == 503
        assert "does not support editing" in response.json()["detail"]


def test_provider_errors_are_reported_as_bad_gateway(tmp_path, monkeypatch):
    def fail(self, jpeg):
        raise reference_analysis.ProviderError("vision unavailable")

    monkeypatch.setattr(ImageDescriptionProvider, "describe", fail)
    with client_for(
        tmp_path,
        monkeypatch,
        IMAGE_DESCRIPTION_PROVIDER="mock",
        IMAGE_PROVIDER="mock",
    ) as client:
        response = post(client, png())
        assert response.status_code == 502
        assert response.json()["detail"] == "vision unavailable"


def test_provider_override_is_used_for_prompt_proposal_in_request_scope(
    tmp_path, monkeypatch
):
    seen = []

    def compose(self, instructions, data, *, schema=None, jpeg=None):
        seen.append((self.base, self.key, self.model, data))
        return {
            "suggested_prompt": "Place the lamp from <image2> on the table in <image1>."
        }

    monkeypatch.setattr(CreationToolsProvider, "generate_json", compose)
    overrides = base64.b64encode(
        json.dumps(
            {
                "LLM_MODEL_ENDPOINT_1": "https://custom.example.invalid/v1",
                "LLM_MODEL_NAME": "browser-model",
                "LLM_MODEL_KEY_1": "browser-key",
            }
        ).encode()
    ).decode()
    with client_for(
        tmp_path,
        monkeypatch,
        IMAGE_DESCRIPTION_PROVIDER="mock",
        IMAGE_PROVIDER="mock",
    ) as client:
        response = post_prompt(
            client,
            ordered_context(2, "Keep this idea"),
            headers={"x-imagedials-provider-overrides": overrides},
        )
        assert response.status_code == 200, response.text
        assert response.json()["metadata"]["prompt"] == {
            "provider": "openai-compatible",
            "model": "browser-model",
        }
        assert seen == [
            (
                "https://custom.example.invalid/v1",
                "browser-key",
                "browser-model",
                seen[0][3],
            )
        ]


def test_reference_inspection_checks_pixels_without_inference_or_provider_calls(
    tmp_path, monkeypatch
):
    def must_not_run(*_args, **_kwargs):
        raise AssertionError("Checksum inspection must not run inference")

    monkeypatch.setattr(ImageDescriptionProvider, "describe", must_not_run)
    monkeypatch.setattr(reference_analysis, "_prompt_proposal", must_not_run)
    with client_for(
        tmp_path,
        monkeypatch,
        INFERENCE_ENABLED="false",
        IMAGE_PROVIDER="comfyui",
        IMAGE_MODEL_ENDPOINT_1="",
    ) as client:
        data = png(orientation=6, metadata="not generation metadata")
        response = client.post(
            "/api/images/reference-analysis?inspect_only=true",
            files={"image": ("original.png", data, "image/png")},
        )
        assert response.status_code == 200, response.text
        assert response.json() == {
            "source_sha256": hashlib.sha256(data).hexdigest(),
            "dimensions": {"width": 20, "height": 32},
            "metadata": {"inspection": {"provider": "local", "method": "sha256"}},
        }
        invalid = client.post(
            "/api/images/reference-analysis?inspect_only=true",
            files={"image": ("invalid.png", b"not an image", "image/png")},
        )
        assert invalid.status_code == 400
        assert client.get("/api/images").json()["total"] == 0


# --- Optional prompt suggestion: a bad suggestion never fails the reference ---

LLM_SETTINGS = {
    "IMAGE_DESCRIPTION_PROVIDER": "mock",
    "IMAGE_PROVIDER": "mock",
    "LLM_MODEL_ENDPOINT_1": "https://llm.example.invalid/v1",
    "LLM_MODEL_NAME": "fixture-model",
}
TWO_REFERENCES = {
    "prompt": "Keep my subject",
    "reference_images": [
        {"id": "base", "description": "A red fox", "role": "base"},
    ],
}


def ordered_context(count, prompt="Keep my subject"):
    return {
        "prompt": prompt,
        "revision": 4,
        "reference_images": [
            {
                "id": f"ref-{index}",
                "description": f"Detail {index}",
                "sha256": hashlib.sha256(png()).hexdigest(),
            }
            for index in range(1, count + 1)
        ],
    }


def post_prompt(client, context, *, headers=None):
    return client.post(
        "/api/images/reference-prompt",
        data={"context": json.dumps(context)},
        files={
            f"reference_{i}": (f"{i}.png", png(), "image/png")
            for i in range(1, len(context.get("reference_images", [])) + 1)
        },
        headers=headers,
    )


def test_wrong_image_markers_twice_keep_the_reference_and_warn(tmp_path, monkeypatch):
    answers = []

    def wrong(self, instructions, data, *, schema=None, jpeg=None):
        answers.append(instructions)
        return {"suggested_prompt": "Blend <image1> with the second picture."}

    monkeypatch.setattr(CreationToolsProvider, "generate_json", wrong)
    with client_for(tmp_path, monkeypatch, **LLM_SETTINGS) as client:
        response = post_prompt(client, ordered_context(2))
        assert response.status_code == 200, response.text
        body = response.json()
        # The corrective retry still happened, then the suggestion was dropped.
        assert len(answers) == 2 and "rejected" in answers[1]
        assert body["suggested_prompt"] is None
        assert body["reference_count"] == 2
        [warning] = body["warnings"]
        assert warning["code"] == "prompt_suggestion_unavailable"
        assert warning["retryable"] is True
        assert "<image2>" in warning["detail"]
        assert "<image2>" not in warning["message"]
        assert body["metadata"]["prompt"]["status"] == "unavailable"


def test_second_attempt_with_valid_labels_returns_a_clean_suggestion(
    tmp_path, monkeypatch
):
    answers = iter(["Use <image1> only.", "Put the subject of <image2> into <image1>."])
    monkeypatch.setattr(
        CreationToolsProvider,
        "generate_json",
        lambda self, instructions, data, *, schema=None, jpeg=None: {
            "suggested_prompt": next(answers)
        },
    )
    with client_for(tmp_path, monkeypatch, **LLM_SETTINGS) as client:
        body = post_prompt(client, ordered_context(2)).json()
        assert body["suggested_prompt"] == "Put the subject of <image2> into <image1>."
        assert body["warnings"] == []


@pytest.mark.parametrize(
    "failure",
    [
        reference_analysis.ProviderError("The language model timed out"),
        reference_analysis.ProviderError("The language model returned invalid JSON"),
    ],
)
def test_provider_failures_in_the_suggestion_are_soft(tmp_path, monkeypatch, failure):
    def fail(self, instructions, data, *, schema=None, jpeg=None):
        raise failure

    monkeypatch.setattr(CreationToolsProvider, "generate_json", fail)
    with client_for(tmp_path, monkeypatch, **LLM_SETTINGS) as client:
        body = post_prompt(client, ordered_context(2)).json()
        assert body["suggested_prompt"] is None
        assert body["warnings"][0]["detail"] == str(failure)


@pytest.mark.parametrize(
    "answer", [None, {}, {"suggested_prompt": "  "}, {"suggested_prompt": "x" * 4001}]
)
def test_malformed_or_oversized_suggestions_are_soft(tmp_path, monkeypatch, answer):
    monkeypatch.setattr(
        CreationToolsProvider,
        "generate_json",
        lambda self, instructions, data, *, schema=None, jpeg=None: answer,
    )
    with client_for(tmp_path, monkeypatch, **LLM_SETTINGS) as client:
        response = post_prompt(client, ordered_context(2))
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["suggested_prompt"] is None
        assert body["warnings"][0]["code"] == "prompt_suggestion_unavailable"


def test_real_file_and_limit_failures_still_fail_hard(tmp_path, monkeypatch):
    monkeypatch.setattr(
        CreationToolsProvider,
        "generate_json",
        lambda self, instructions, data, *, schema=None, jpeg=None: {
            "suggested_prompt": "ok"
        },
    )
    with client_for(
        tmp_path, monkeypatch, IMPORT_MAX_BYTES="2048", **LLM_SETTINGS
    ) as client:
        assert post(client, b"not an image", TWO_REFERENCES).status_code == 400
        assert post(client, b"x" * 4096, TWO_REFERENCES).status_code == 413
        too_many = ordered_context(10)
        assert post(client, png(), too_many).status_code == 400

    def fail(self, jpeg):
        raise reference_analysis.ProviderError("vision unavailable")

    monkeypatch.setattr(ImageDescriptionProvider, "describe", fail)
    with client_for(tmp_path, monkeypatch, **LLM_SETTINGS) as client:
        # No description is a real failure: it is part of the edit context.
        assert post(client, png(), TWO_REFERENCES).status_code == 502


def test_prompt_retry_uses_full_ordered_pixels_without_caption_calls(
    tmp_path, monkeypatch
):
    seen = []

    def compose(self, instructions, data, *, schema=None, jpeg=None):
        seen.append(data)
        assert jpeg and Image.open(io.BytesIO(jpeg)).size == (1280, 1280)
        assert "Panel 1 is the base" in instructions
        assert "treat its donor background as incidental" in instructions
        assert "deliberately assign that reference an environment role" in instructions
        assert "never require matching a discarded donor backdrop" in instructions
        return {"suggested_prompt": "Move <image3> into <image1> beside <image2>."}

    def must_not_run(*_args, **_kwargs):
        raise AssertionError("A prompt retry must not describe an image")

    monkeypatch.setattr(CreationToolsProvider, "generate_json", compose)
    monkeypatch.setattr(ImageDescriptionProvider, "describe", must_not_run)
    with client_for(tmp_path, monkeypatch, **LLM_SETTINGS) as client:
        response = post_prompt(client, ordered_context(3))
        assert response.status_code == 200, response.text
        body = response.json()
        assert (
            body["suggested_prompt"] == "Move <image3> into <image1> beside <image2>."
        )
        assert body["reference_count"] == 3
        assert body["revision"] == 4
        assert body["warnings"] == []
        refs = seen[0]["references"]
        assert [ref["panel"] for ref in refs] == [1, 2, 3]
        assert all("description" not in ref for ref in refs)
        assert [ref["image_marker"] for ref in refs] == [
            "<image1>",
            "<image2>",
            "<image3>",
        ]
        assert seen[0]["existing_prompt"] == "Keep my subject"


def test_prompt_retry_failure_is_a_warning_and_validation_is_hard(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(
        CreationToolsProvider,
        "generate_json",
        lambda self, instructions, data, *, schema=None, jpeg=None: {
            "suggested_prompt": "Only <image1>."
        },
    )
    with client_for(tmp_path, monkeypatch, **LLM_SETTINGS) as client:
        response = post_prompt(client, ordered_context(2))
        assert response.status_code == 200
        body = response.json()
        assert body["suggested_prompt"] is None
        assert body["warnings"][0]["code"] == "prompt_suggestion_unavailable"
        assert post_prompt(client, ordered_context(0)).status_code == 400
        assert post_prompt(client, ordered_context(11)).status_code == 400
        blank = ordered_context(2)
        blank["reference_images"][1]["sha256"] = "0" * 64
        assert post_prompt(client, blank).status_code == 400
        assert post_prompt(client, {"unexpected": 1}).status_code == 400
        assert (
            client.post(
                "/api/images/reference-prompt",
                content=b"x"
                * (
                    reference_analysis.MAX_REFERENCE_TOTAL_BYTES
                    + reference_analysis.MAX_CONTEXT_BYTES
                    + reference_analysis.MULTIPART_OVERHEAD_BYTES
                    + 1
                ),
            ).status_code
            == 413
        )
    with client_for(
        tmp_path, monkeypatch, INFERENCE_ENABLED="false", **LLM_SETTINGS
    ) as client:
        assert post_prompt(client, ordered_context(2)).status_code == 503


def test_prompt_retry_honors_the_provider_override_header_in_request_scope(
    tmp_path, monkeypatch
):
    seen = []

    def compose(self, instructions, data, *, schema=None, jpeg=None):
        seen.append((self.base, self.key, self.model))
        return {"suggested_prompt": "Use <image1> and <image2> together."}

    monkeypatch.setattr(CreationToolsProvider, "generate_json", compose)
    overrides = base64.b64encode(
        json.dumps(
            {
                "LLM_MODEL_ENDPOINT_1": "https://custom.example.invalid/v1",
                "LLM_MODEL_NAME": "browser-model",
                "LLM_MODEL_KEY_1": "browser-key",
            }
        ).encode()
    ).decode()
    with client_for(
        tmp_path,
        monkeypatch,
        IMAGE_DESCRIPTION_PROVIDER="mock",
        IMAGE_PROVIDER="mock",
    ) as client:
        response = post_prompt(
            client,
            ordered_context(2),
            headers={"x-imagedials-provider-overrides": overrides},
        )
        assert response.status_code == 200, response.text
        assert response.json()["metadata"]["prompt"] == {
            "provider": "openai-compatible",
            "model": "browser-model",
        }
        assert seen == [
            ("https://custom.example.invalid/v1", "browser-key", "browser-model")
        ]
        assert (
            post_prompt(
                client,
                ordered_context(2),
                headers={"x-imagedials-provider-overrides": "not base64"},
            ).status_code
            == 400
        )


def test_prompt_retry_route_is_registered_at_every_canonical_alias(
    tmp_path, monkeypatch
):
    with client_for(tmp_path, monkeypatch, **LLM_SETTINGS) as client:
        paths = {getattr(route, "path", None) for route in client.app.routes}
        assert {"/api/images/reference-prompt", "/images/reference-prompt"} <= paths


def test_contact_sheet_is_bounded_oriented_and_keeps_order_without_crop():
    sheet = reference_analysis.contact_sheet_canvas(2, 512)
    assert sheet.size == (512, 256)
    assert reference_analysis.contact_sheet_canvas(2, 64).size == (64, 32)
    # Asymmetric source: EXIF rotates the red half onto the top after orientation 6.
    image = Image.new("RGB", (100, 50), "blue")
    image.paste("red", (0, 0, 50, 50))
    exif = image.getexif()
    exif[274] = 6
    output = io.BytesIO()
    image.save(output, format="PNG", exif=exif)
    reference_analysis.add_contact_panel(sheet, output.getvalue(), 1, 2, 10000)
    other = io.BytesIO()
    Image.new("RGB", (60, 60), "green").save(other, format="PNG")
    reference_analysis.add_contact_panel(sheet, other.getvalue(), 2, 2, 10000)
    assert sheet.getpixel((128, 130))[0] > 200
    assert sheet.getpixel((128, 170))[2] > 200
    assert sheet.getpixel((384, 140))[1] > 100
    assert reference_analysis.contact_sheet_canvas(16, 4000).size == (1280, 1280)


def test_joint_composition_rejects_changed_hash_duplicate_missing_and_oversized_pixels(
    tmp_path, monkeypatch
):
    def forbidden(*args, **kwargs):
        raise AssertionError("Invalid input must not reach the language provider")

    monkeypatch.setattr(CreationToolsProvider, "generate_json", forbidden)
    with client_for(tmp_path, monkeypatch, **LLM_SETTINGS) as client:
        context = ordered_context(2)
        context["reference_images"][0]["sha256"] = "0" * 64
        assert post_prompt(client, context).status_code == 400
        valid = ordered_context(2)
        assert (
            client.post(
                "/api/images/reference-prompt",
                data={"context": json.dumps(valid)},
                files={"reference_1": ("one.png", png(), "image/png")},
            ).status_code
            == 400
        )
        assert (
            client.post(
                "/api/images/reference-prompt",
                data={"context": json.dumps(valid)},
                files=[
                    ("reference_1", ("one.png", png(), "image/png")),
                    ("reference_1", ("two.png", png(), "image/png")),
                ],
            ).status_code
            == 400
        )
    with client_for(
        tmp_path, monkeypatch, IMAGE_MAX_DECODED_PIXELS="1100000", **LLM_SETTINGS
    ) as client:
        buffer = io.BytesIO()
        Image.new("RGB", (1100, 1100), "red").save(buffer, format="PNG")
        source = buffer.getvalue()
        context = ordered_context(2)
        for item in context["reference_images"]:
            item["sha256"] = hashlib.sha256(source).hexdigest()
        assert (
            client.post(
                "/api/images/reference-prompt",
                data={"context": json.dumps(context)},
                files={
                    f"reference_{i}": ("large.png", source, "image/png") for i in (1, 2)
                },
            ).status_code
            == 413
        )


def test_joint_language_wire_has_exactly_one_image_and_preserves_schema_template(
    monkeypatch,
):
    from app import providers

    seen = []

    def wire(base, path, payload, **kwargs):
        seen.append(payload)
        return {
            "choices": [
                {
                    "message": {
                        "content": '{"suggested_prompt":"Edit <image1> with <image2>."}'
                    },
                    "finish_reason": "stop",
                }
            ]
        }

    monkeypatch.setattr(providers, "request", wire)
    provider = CreationToolsProvider(LLM_SETTINGS)
    provider.generate_json(
        "Compose visible images",
        {"references": [1, 2]},
        schema=reference_analysis.PROMPT_SCHEMA,
        jpeg=b"synthetic-jpeg",
    )
    [request] = seen
    parts = request["messages"][1]["content"]
    assert [part["type"] for part in parts] == ["text", "image_url"]
    assert (
        base64.b64decode(parts[1]["image_url"]["url"].split(",")[1])
        == b"synthetic-jpeg"
    )
    assert (
        request["response_format"]["json_schema"]["schema"]
        == reference_analysis.PROMPT_SCHEMA
    )
    assert request["chat_template_kwargs"] == {"enable_thinking": False}
