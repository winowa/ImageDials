import io
import json

import pytest
from app import providers
from app.providers import ImageProvider, ProviderError
from app.store import Store
from PIL import Image


@pytest.mark.parametrize(
    "status,message,fallback",
    [
        (400, b"response_format json_schema is not supported", True),
        (422, b"response_format extra_forbidden", True),
        (503, b"response_format json_schema is not supported", False),
        (400, b"Invalid prompt input", False),
    ],
)
def test_tool_json_schema_fallback_requires_an_explicit_unsupported_format(
    monkeypatch, status, message, fallback
):
    import copy
    import urllib.error

    calls = []

    def respond(base, path, payload=None, **kwargs):
        calls.append(copy.deepcopy(payload))
        if len(calls) == 1:
            cause = urllib.error.HTTPError(
                "http://localhost", status, "Rejected", {}, io.BytesIO(message)
            )
            raise ProviderError("Provider rejected request") from cause
        return {"choices": [{"message": {"content": '{"valid":true}'}}]}

    monkeypatch.setattr(providers, "request", respond)
    provider = providers.LanguageProvider(
        {"LLM_MODEL_ENDPOINT_1": "http://localhost", "LLM_MODEL_NAME": "fixture-model"}
    )
    schema = {"type": "object", "properties": {"valid": {"type": "boolean"}}}
    if fallback:
        assert provider.generate_json(
            "Return a value", {"input": 0}, schema=schema
        ) == {"valid": True}
        assert len(calls) == 2
        assert calls[0]["response_format"]["json_schema"]["schema"] == schema
        assert "response_format" not in calls[1]
        assert calls[0]["messages"] == calls[1]["messages"]
    else:
        with pytest.raises(ProviderError):
            provider.generate_json("Return a value", {"input": 0}, schema=schema)
        assert len(calls) == 1


def test_comfy_workflow_substitution_and_exact_output(tmp_path, monkeypatch):
    workflow = tmp_path / "workflow.json"
    workflow.write_text(
        json.dumps(
            {
                "node": {
                    "inputs": {
                        "text": "$prompt",
                        "width": "$width",
                        "height": "$height",
                        "seed": "$seed",
                    }
                }
            }
        )
    )
    image = io.BytesIO()
    Image.new("RGB", (16, 16)).save(image, format="PNG")
    calls = []

    def request(base, path, payload=None, **kwargs):
        calls.append((path, payload))
        if path == "/prompt":
            return {"prompt_id": "job"}
        if path.startswith("/history"):
            return {
                "job": {
                    "outputs": {
                        "output": {
                            "images": [
                                {"filename": "a.png", "subfolder": "", "type": "output"}
                            ]
                        }
                    }
                }
            }
        return image.getvalue()

    monkeypatch.setattr(providers, "request", request)
    provider = ImageProvider(
        {
            "IMAGE_PROVIDER": "comfyui",
            "IMAGE_MODEL_ENDPOINT_1": "http://localhost",
            "IMAGE_WORKFLOW_PATH": str(workflow),
        }
    )
    data, diagnostics = provider.render("A literal $width in the prompt", 768, 1152)
    assert data == image.getvalue()
    inputs = calls[0][1]["prompt"]["node"]["inputs"]
    assert inputs["text"] == "A literal $width in the prompt"
    assert inputs["width"] == 768 and inputs["height"] == 1152
    assert inputs["seed"] == diagnostics["seed"]


def test_provider_failure_is_not_mock_fallback(tmp_path, monkeypatch):
    workflow = tmp_path / "workflow.json"
    workflow.write_text("{}")

    def failed(*args, **kwargs):
        raise ProviderError("Provider unavailable")

    monkeypatch.setattr(providers, "request", failed)
    with pytest.raises(ProviderError, match="unavailable"):
        ImageProvider(
            {
                "IMAGE_PROVIDER": "comfyui",
                "IMAGE_MODEL_ENDPOINT_1": "http://localhost",
                "IMAGE_WORKFLOW_PATH": str(workflow),
            }
        ).render("Bird", 768, 1152)


def test_restart_marks_interrupted_jobs_failed_and_cleans_orphans(tmp_path):
    store = Store(tmp_path)
    with store.connect() as db:
        db.execute(
            "INSERT INTO jobs VALUES (?,?,?,?)",
            (
                "j",
                "k",
                "f",
                json.dumps({"id": "j", "stage": "rendering", "result": None}),
            ),
        )
    (tmp_path / "orphan.png").write_bytes(b"partial")
    (tmp_path / "unfinished.tmp").write_bytes(b"partial")
    store = Store(tmp_path)
    assert store.job("j")["stage"] == "failed"
    assert not (tmp_path / "orphan.png").exists()
    assert not (tmp_path / "unfinished.tmp").exists()


def test_llm_pipeline_resolves_selected_options_then_renders_exact_composition(
    tmp_path, monkeypatch
):
    import time

    from app.main import create_app
    from fastapi.testclient import TestClient

    calls = []
    composed = " A cobalt glazed ceramic cup, bright window light, on pale stone.\n"

    def llm(base, path, payload=None, **kwargs):
        calls.append((path, payload))
        if path == "/models":
            return {"data": [{"id": "test-llm"}]}
        if payload["messages"][0]["content"].startswith('Return JSON {"title"'):
            return {
                "choices": [
                    {
                        "message": {
                            "content": json.dumps(
                                {
                                    "title": "Cobalt cup",
                                    "alt_text": "A cobalt ceramic cup on pale stone.",
                                }
                            )
                        },
                        "finish_reason": "stop",
                    }
                ]
            }
        return {
            "choices": [{"message": {"content": composed}, "finish_reason": "stop"}]
        }

    monkeypatch.setattr(providers, "request", llm)
    app = create_app(
        {
            "IMAGEDIALS_DATA_DIR": str(tmp_path),
            "LLM_MODEL_ENDPOINT_1": "http://localhost",
        }
    )
    with TestClient(app) as client:
        actual_render = app.state.renderer.render
        rendered = []

        def render(prompt, width, height):
            rendered.append(prompt)
            return actual_render(prompt, width, height)

        app.state.renderer.render = render
        draft = {
            "prompt": "A ceramic cup",
            "revision": 2,
            "aspect": "2:3",
            "idempotency_key": "llm-pipeline",
            "categories": [
                {
                    "id": "glaze",
                    "label": "Glaze",
                    "type": "single",
                    "origin": "generated",
                    "value": "blue",
                    "options": [
                        {"id": "blue", "label": "Cobalt"},
                        {"id": "red", "label": "Red"},
                    ],
                },
                {
                    "id": "finish",
                    "label": "Finish",
                    "type": "single",
                    "value": None,
                    "options": [],
                },
            ],
        }
        job = client.post("/api/generations", json=draft).json()
        for _ in range(200):
            job = client.get("/api/generations/" + job["id"]).json()
            if job["stage"] in {"complete", "failed"}:
                break
            time.sleep(0.01)
        assert job["stage"] == "complete", job
        payload = next(p for path, p in calls if path == "/chat/completions")
        assert (
            "Write one final image-generation prompt"
            in payload["messages"][0]["content"]
        )
        sent = json.loads(payload["messages"][1]["content"])
        assert sent["idea"] == "A ceramic cup"
        assert sent["selected_controls"] == [{"category": "Glaze", "value": ["Cobalt"]}]
        assert rendered == [composed]
        assert job["result"]["final_prompt"] == composed
        assert job["result"]["title"] == "Cobalt cup"
        assert job["result"]["accessibility"]["alt_text"] == job["result"]["alt_text"]
        composition = job["result"]["composition"]
        assert composition["provider"] == "openai-compatible"
        assert composition["model"] == "test-llm"
        assert json.loads(composition["prompt_creation_request"]) == payload["messages"]


def test_composition_failure_does_not_send_prompt_to_image_model(tmp_path, monkeypatch):
    import time

    from app.main import create_app
    from fastapi.testclient import TestClient

    def malformed(*args, **kwargs):
        return {"choices": [{"message": {"content": ""}}]}

    monkeypatch.setattr(providers, "request", malformed)
    app = create_app(
        {
            "IMAGEDIALS_DATA_DIR": str(tmp_path),
            "LLM_MODEL_ENDPOINT_1": "http://localhost",
            "LLM_MODEL_NAME": "test-llm",
        }
    )
    with TestClient(app) as client:
        rendered = []
        app.state.renderer.render = lambda *args: rendered.append(args)
        draft = {
            "prompt": "A cup",
            "idempotency_key": "composition-failure",
            "categories": [
                {"id": "size", "label": "Size", "type": "range", "value": 50}
            ],
        }
        job = client.post("/api/generations", json=draft).json()
        for _ in range(200):
            job = client.get("/api/generations/" + job["id"]).json()
            if job["stage"] == "failed":
                break
            time.sleep(0.01)
        assert job["stage"] == "failed"
        assert "composition" in job["error"].lower()
        assert rendered == []
        assert client.get("/api/images").json()["total"] == 0


def mixed_categories():
    from app.domain import Category

    return [
        Category(
            id="cup-count", label="Cup count", type="range", min=0, max=5, value=0
        ),
        Category(
            id="shape",
            label="Cup shape",
            type="single",
            options=[{"id": "round", "label": "Rounded"}],
            value="round",
        ),
        Category(
            id="parts",
            label="Cup parts",
            type="multi",
            options=[{"id": "handle", "label": "Loop handle"}],
            value=["handle"],
        ),
        Category(
            id="glaze",
            label="Glaze",
            type="select",
            options=[{"id": "blue", "label": "Cobalt glaze"}],
            value="blue",
        ),
        Category(
            id="rim",
            label="Rim",
            type="radio",
            options=[{"id": "thin", "label": "Thin rim"}],
            value="thin",
        ),
        Category(
            id="marks",
            label="Surface marks",
            type="checkbox",
            options=[{"id": "grooves", "label": "Shallow grooves"}],
            value=["grooves"],
        ),
        Category(
            id="motif",
            label="Decoration motif",
            type="text",
            placeholder="Optional motif",
            value="Fern",
        ),
        Category(
            id="handle-shape",
            label="Handle shape",
            type="binary",
            true_label="Angular handle",
            false_label="Curved handle",
            value=False,
        ),
    ]


def test_control_instructions_aim_for_diverse_relevant_types(monkeypatch):
    from app.domain import Draft

    captured = []
    categories = mixed_categories()

    def llm(base, path, payload=None, **kwargs):
        captured.append(payload)
        return {
            "choices": [
                {
                    "message": {
                        "content": json.dumps(
                            {"categories": [c.model_dump() for c in categories]}
                        )
                    }
                }
            ]
        }

    monkeypatch.setattr(providers, "request", llm)
    provider = providers.ControlsProvider(
        {"LLM_MODEL_ENDPOINT_1": "http://localhost", "LLM_MODEL_NAME": "test-model"}
    )
    result = provider.controls(Draft(prompt="A ceramic cup"))
    assert {c.type for c in result if c.origin == "generated"} == {
        "single",
        "multi",
        "range",
        "select",
        "radio",
        "checkbox",
        "text",
        "binary",
    }
    instructions = captured[0]["messages"][0]["content"]
    for term in [
        "slider",
        "multi-select",
        "dropdown",
        "radio",
        "checkbox",
        "free text",
        "boolean",
        "highly relevant",
        "distinct",
        "one and only one",
        "exactly eight",
        "no repeated types",
    ]:
        assert term in instructions
    assert json.loads(captured[0]["messages"][1]["content"])["idea"] == "A ceramic cup"


@pytest.mark.parametrize("variant", ["missing", "duplicate-type", "extra"])
def test_generated_types_must_be_exactly_one_of_each(monkeypatch, variant):
    from app.domain import Draft

    categories = mixed_categories()
    if variant == "missing":
        categories = categories[:-1]
    else:
        repeated = categories[0].model_copy(update={"id": "additional-range"})
        categories = (
            categories[:-1] + [repeated]
            if variant == "duplicate-type"
            else [*categories, repeated]
        )

    def llm(*args, **kwargs):
        return {
            "choices": [
                {
                    "message": {
                        "content": json.dumps(
                            {
                                "categories": [
                                    category.model_dump() for category in categories
                                ]
                            }
                        )
                    }
                }
            ]
        }

    monkeypatch.setattr(providers, "request", llm)
    provider = providers.ControlsProvider(
        {"LLM_MODEL_ENDPOINT_1": "http://localhost", "LLM_MODEL_NAME": "fixture-model"}
    )
    with pytest.raises(ProviderError, match="invalid controls"):
        provider.controls(Draft(prompt="A blue paper circle"))


def test_initial_context_has_names_but_no_options_or_values(monkeypatch):
    from app.domain import Draft

    calls = []

    def llm(base, path, payload=None, **kwargs):
        calls.append(payload)
        return {
            "choices": [
                {
                    "message": {
                        "content": json.dumps(
                            {
                                "categories": [
                                    category.model_dump()
                                    for category in mixed_categories()
                                ]
                            }
                        )
                    }
                }
            ]
        }

    monkeypatch.setattr(providers, "request", llm)
    provider = providers.ControlsProvider(
        {"LLM_MODEL_ENDPOINT_1": "http://localhost", "LLM_MODEL_NAME": "fixture-model"}
    )
    provider.controls_with_metadata(
        Draft(prompt="A ceramic cup"),
        [],
        [
            {
                "id": "known",
                "label": "Known detail",
                "kind": "dropdown",
                "options": {"unused": "Do not forward"},
                "value": "unused",
            }
        ],
    )
    data = json.loads(calls[0]["messages"][1]["content"])
    assert data["current_categories"] == [
        {"id": "known", "label": "Known detail", "kind": "dropdown"}
    ]
    assert len(data["fixed_categories"]) == 8
    assert all(
        set(category) <= {"id", "label", "kind", "description"}
        for category in data["fixed_categories"]
    )


def test_structured_schema_enforces_eight_typed_slots_and_relevance():
    # Intentional change (UX02 Option B): relevance order replaces fixed positions.
    from app.control_schema import GENERATED_CONTROL_TYPES, generated_controls_schema

    schema = generated_controls_schema()
    slots = schema["properties"]["categories"]
    assert slots["required"] == list(GENERATED_CONTROL_TYPES)
    assert slots["additionalProperties"] is False
    variants = list(slots["properties"].values())
    assert [item["properties"]["type"]["const"] for item in variants] == list(
        GENERATED_CONTROL_TYPES
    )
    assert variants[0]["properties"]["value"] == {"type": "number"}
    assert variants[2]["properties"]["value"]["type"] == "array"
    assert variants[-1]["properties"]["value"] == {"type": "boolean"}


def test_explicit_unsupported_schema_retries_once_without_changing_messages(
    monkeypatch,
):
    import copy
    import urllib.error

    from app.domain import Draft

    calls = []

    def llm(base, path, payload=None, **kwargs):
        calls.append(copy.deepcopy(payload))
        if len(calls) == 1:
            cause = urllib.error.HTTPError(
                "http://localhost",
                400,
                "Unsupported",
                {},
                io.BytesIO(b'{"error":"response_format json_schema is not supported"}'),
            )
            raise ProviderError("Provider rejected format") from cause
        return {
            "choices": [
                {
                    "message": {
                        "content": json.dumps(
                            {
                                "categories": [
                                    category.model_dump()
                                    for category in mixed_categories()
                                ]
                            }
                        )
                    }
                }
            ]
        }

    monkeypatch.setattr(providers, "request", llm)
    provider = providers.ControlsProvider(
        {"LLM_MODEL_ENDPOINT_1": "http://localhost", "LLM_MODEL_NAME": "fixture-model"}
    )
    result, metadata = provider.controls_with_metadata(Draft(prompt="A ceramic cup"))
    assert (
        len(calls) == 2
        and len([category for category in result if category.origin == "generated"])
        == 8
    )
    assert (
        calls[0]["response_format"]["type"] == "json_schema"
        and "response_format" not in calls[1]
    )
    assert calls[0]["messages"] == calls[1]["messages"]
    assert metadata["schema_fallback"] is True and metadata["response_format"] is None


@pytest.mark.parametrize("status", [400, 401, 503])
def test_schema_fallback_does_not_retry_unrelated_provider_failures(
    monkeypatch, status
):
    import urllib.error

    from app.domain import Draft

    calls = []

    def llm(*args, **kwargs):
        calls.append(1)
        cause = urllib.error.HTTPError(
            "http://localhost",
            status,
            "Failed",
            {},
            io.BytesIO(b'{"error":"Other provider failure"}'),
        )
        raise ProviderError("Provider failed") from cause

    monkeypatch.setattr(providers, "request", llm)
    provider = providers.ControlsProvider(
        {"LLM_MODEL_ENDPOINT_1": "http://localhost", "LLM_MODEL_NAME": "fixture-model"}
    )
    with pytest.raises(ProviderError, match="failed"):
        provider.controls(Draft(prompt="A ceramic cup"))
    assert calls == [1]


def test_every_control_value_reaches_composition_without_false_zero_loss(monkeypatch):
    from app.domain import PromptDraft, compose

    captured = []

    def llm(base, path, payload=None, **kwargs):
        captured.append(payload)
        return {
            "choices": [
                {
                    "message": {
                        "content": "A cup with a fern motif and curved handle."
                    },
                    "finish_reason": "stop",
                }
            ]
        }

    monkeypatch.setattr(providers, "request", llm)
    categories = mixed_categories()
    provider = providers.PromptComposer(
        {"LLM_MODEL_ENDPOINT_1": "http://localhost", "LLM_MODEL_NAME": "test-model"}
    )
    prompt, _ = provider.compose(PromptDraft(prompt="A ceramic cup"), categories)
    selected = json.loads(captured[0]["messages"][1]["content"])["selected_controls"]
    assert selected[0]["value"] == 0 and type(selected[0]["value"]) is float
    assert selected[5]["value"] == ["Shallow grooves"]
    assert selected[6]["value"] == "Fern"
    assert selected[7]["value"] is False
    assert selected[7]["display_value"] == "Curved handle"
    assert prompt == "A cup with a fern motif and curved handle."
    mock = compose(PromptDraft(prompt="A ceramic cup"), categories)
    assert "Cup count: 0" in mock and "Decoration motif: Fern" in mock
    assert "Handle shape: Curved handle" in mock


@pytest.mark.parametrize(
    "kind,value",
    [
        ("binary", 0),
        ("binary", "false"),
        ("range", False),
        ("text", False),
        ("checkbox", False),
        ("radio", False),
    ],
)
def test_invalid_scalar_types_are_not_coerced(kind, value):
    from app.domain import Category

    with pytest.raises(ValueError):
        Category(id="test", label="Test", type=kind, value=value)


def test_canonical_binary_meaning_and_zero_reach_llm(monkeypatch):
    from app.domain import Generation
    from app.wire import resolve_controls

    controls = [
        {
            "kind": "binary",
            "label": "Handle",
            "value": False,
            "trueLabel": "Angular handle",
            "falseLabel": "Curved handle",
        },
        {"kind": "slider", "label": "Tilt", "min": 0, "max": 90, "value": 0},
    ]
    draft = Generation(
        prompt="A ceramic cup",
        idempotency_key="meaning",
        selected_controls=controls,
        resolved_controls=resolve_controls(controls),
    )
    calls = []

    def llm(base, path, payload=None, **kwargs):
        calls.append(payload)
        return {
            "choices": [
                {
                    "message": {
                        "content": "A ceramic cup with a curved handle and no tilt."
                    },
                    "finish_reason": "stop",
                }
            ]
        }

    monkeypatch.setattr(providers, "request", llm)
    provider = providers.PromptComposer(
        {"LLM_MODEL_ENDPOINT_1": "http://localhost", "LLM_MODEL_NAME": "test-model"}
    )
    provider.compose(draft, [])
    selections = json.loads(calls[0]["messages"][1]["content"])["selected_controls"]
    assert (
        selections[0]["value"] is False
        and selections[0]["display_value"] == "Curved handle"
    )
    assert selections[1]["value"] == 0
    assert draft.resolved_controls[0] == {
        "kind": "binary",
        "label": "Handle",
        "value": False,
    }


@pytest.mark.parametrize("valid_keywords", [True, False])
def test_long_prompt_keyword_attempt_retains_original(monkeypatch, valid_keywords):
    from app.domain import PromptDraft

    prompt = "A tiny carved lighthouse made from warm wood with brass windows standing on a slate base under soft studio light"
    calls = []

    def llm(base, path, payload=None, **kwargs):
        calls.append(payload)
        content = (
            json.dumps(
                {"keywords": ["carved lighthouse", "brass windows", "slate base"]}
            )
            if len(calls) == 1 and valid_keywords
            else "Final unchanged prompt."
        )
        return {"choices": [{"message": {"content": content}, "finish_reason": "stop"}]}

    monkeypatch.setattr(providers, "request", llm)
    provider = providers.PromptComposer(
        {"LLM_MODEL_ENDPOINT_1": "http://localhost", "LLM_MODEL_NAME": "test-model"}
    )
    final, metadata = provider.compose(PromptDraft(prompt=prompt), [])
    assert len(calls) == 2
    assert final == "Final unchanged prompt."
    assert json.loads(calls[1]["messages"][1]["content"])["idea"] == prompt
    assert metadata["keyword_extraction"]["status"] == (
        "complete" if valid_keywords else "failed"
    )
