import json
import os
import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Query, Request

from .browser_settings import (
    BrowserProviderOverrides,
    current_providers,
    register_browser_settings,
)
from .creation import CreationToolsProvider, register_creation_routes
from .domain import Draft, Generation, PromptDraft
from .gallery_sessions import GallerySessionPolicy, GallerySessions
from .generation_groups import (
    MAX_QUEUED_GENERATION_JOBS,
    GenerationGroups,
    generation_fingerprint,
)
from .image_routing import image_provider, validate_deployment
from .imports import ImageDescriptionProvider, register_import_routes
from .library import library_snapshots, register_library_routes
from .media import image_pixel_limit, positive_integer
from .profile import DeploymentProfile
from .prompt_strategies import reference_prompt_strategy
from .providers import ControlsProvider, ImageProvider, PromptComposer, ProviderError
from .reference_adaptation import register_reference_adaptation_routes
from .reference_analysis import register_reference_analysis_routes
from .reference_capability import too_many_references
from .region_edits import composite_region, selection_mask
from .request_ids import RequestIds
from .responses import local_file_response
from .store import JobNoLongerActive, Store
from .streams import register_stream_routes
from .watermark_api import register_watermark_routes
from .watermark_batches import DEFAULT_BATCH_MAX_RECORDS
from .watermarks import WatermarkService
from .wire import configured_dimensions, enabled, register_canonical_routes


def create_app(settings=None):
    env = dict(os.environ if settings is None else settings)
    image_dimensions = configured_dimensions(env)
    reference_prompt_strategy(env)
    validate_deployment(env)
    deployment = DeploymentProfile.from_env(env)
    gallery_session_policy = GallerySessionPolicy.from_env(env)
    analysis_batch_max_records = positive_integer(
        env, "WATERMARK_BATCH_MAX_RECORDS", DEFAULT_BATCH_MAX_RECORDS
    )

    def require_inference():
        if not enabled(env, "INFERENCE_ENABLED"):
            raise HTTPException(503, "Inference is disabled")

    @asynccontextmanager
    async def lifespan(app):
        root = env.get("IMAGEDIALS_DATA_DIR")
        if not root or not root.strip():
            raise ValueError(
                "Set IMAGEDIALS_DATA_DIR to a private writable data directory"
            )
        app.state.store = Store(
            root, max_image_pixels=image_pixel_limit(env), worker=True
        )
        app.state.thumbnail_cache.trim(app.state.store)
        app.state.gallery_sessions = GallerySessions(
            app.state.store, gallery_session_policy
        )
        app.state.controls = ControlsProvider(env)
        app.state.creation = CreationToolsProvider(env)
        app.state.description = ImageDescriptionProvider(env)
        app.state.watermarks = WatermarkService(
            app.state.store, batch_max_records=analysis_batch_max_records
        )
        app.state.analysis_pool = ThreadPoolExecutor(max_workers=1)
        app.state.renderer = image_provider(env)
        app.state.composer = PromptComposer(env)
        app.state.pool = ThreadPoolExecutor(max_workers=1)
        app.state.lock = threading.Lock()
        app.state.generation_groups = GenerationGroups(
            app.state.store, app.state.pool, app.state.lock, run
        )
        try:
            yield
        finally:
            app.state.pool.shutdown(wait=True)
            app.state.analysis_pool.shutdown(wait=True)
            app.state.gallery_sessions.close()
            app.state.store.close()

    app = FastAPI(title="ImageDials API", lifespan=lifespan)
    app.state.deployment = deployment
    app.state.provider_environment = env
    app.add_middleware(BrowserProviderOverrides, owner=app)
    register_browser_settings(app)

    @app.get("/api/health")
    def health(request: Request):
        state = request.app.state
        # Health remains safe before application startup in simple transport probes.
        renderer = getattr(state, "renderer", ImageProvider(env))
        controls = getattr(state, "controls", ControlsProvider(env))
        return {
            "status": "ok",
            "providers": {
                "image": {"configured": renderer.ready, "kind": renderer.kind},
                "controls": {"configured": True, "kind": controls.kind},
            },
        }

    @app.post("/api/controls")
    def controls(draft: Draft):
        require_inference()
        try:
            categories = current_providers(app).controls.controls(draft)
            return {
                "revision": draft.revision,
                "categories": categories,
                "provider": current_providers(app).controls.kind,
            }
        except ProviderError as exc:
            raise HTTPException(502, str(exc)) from exc

    @app.post("/api/ideas")
    def ideas():
        require_inference()
        try:
            return {
                "prompt": current_providers(app).creation.suggestions("standard")[0],
                "provider": current_providers(app).creation.kind,
            }
        except ProviderError as exc:
            raise HTTPException(502, str(exc)) from exc

    @app.post("/api/prompts")
    def final_prompt(draft: PromptDraft):
        require_inference()
        try:
            prompt, metadata = current_providers(app).composer.compose(
                draft, draft.categories
            )
            return {"revision": draft.revision, "final_prompt": prompt, **metadata}
        except ProviderError as exc:
            raise HTTPException(502, str(exc)) from exc

    def run(job, draft, providers):
        store = app.state.store

        def publish_job():
            if not store.update_job(job):
                raise JobNoLongerActive("Generation job is already terminal")

        try:
            categories = draft.categories
            if not categories and draft.selected_controls is None:
                job["stage"] = "categories"
                publish_job()
                categories = providers.controls.controls(draft)
            job.update(
                stage="composing", categories=[c.model_dump() for c in categories]
            )
            publish_job()
            final_prompt, composition = providers.composer.compose(draft, categories)
            job["final_prompt"] = final_prompt
            job["composition"] = composition
            width, height = draft.requested_dimensions or image_dimensions[draft.aspect]
            job["stage"] = "rendering"
            publish_job()
            if draft.reference_images:
                data, diagnostics = providers.renderer.render(
                    final_prompt, width, height, references=draft._reference_inputs
                )
            else:
                data, diagnostics = providers.renderer.render(
                    final_prompt, width, height
                )
            region_result = None
            if draft.region_edit:
                data, region_result = composite_region(
                    draft._reference_inputs[0]["data"],
                    data,
                    draft.region_edit,
                    image_pixel_limit(env),
                )
            image_id = job["id"]
            snapshot = {
                "id": image_id,
                "title": draft.prompt[:120],
                "alt_text": "",
                "accessibility": {},
                "prompt": draft.prompt,
                "final_prompt": final_prompt,
                "mode": draft.mode,
                "aspect": draft.aspect,
                "categories": job["categories"],
                "provider": providers.renderer.kind,
                "model": providers.renderer.model,
                "created_at": datetime.now(UTC).isoformat(),
                "image_url": f"/api/images/{image_id}/content",
                "diagnostics": diagnostics,
                "composition": composition,
                "selected_controls": draft.selected_controls,
                "resolved_controls": draft.resolved_controls,
                "dynamic_controls_metadata": draft.dynamic_controls_metadata,
                **(
                    {"additional_controls_metadata": draft.additional_controls_metadata}
                    if draft.additional_controls_metadata
                    else {}
                ),
                "requested_dimensions": {"width": width, "height": height},
                "must_have_terms": draft.must_have_terms,
                **(
                    {
                        "reference_images": [
                            item.model_dump(exclude_none=True)
                            for item in draft.reference_images
                        ],
                        "generation_type": "image-edit",
                    }
                    if draft.reference_images
                    else {}
                ),
                **({"variation": draft._variation} if draft._variation else {}),
                **(
                    {
                        "region_edit": draft.region_edit.model_dump(),
                        "region_edit_result": region_result,
                    }
                    if draft.region_edit
                    else {}
                ),
                "event_id": deployment.active_event,
                "visibility": "shared"
                if enabled(env, "SHARED_LIBRARY_ENABLED")
                else "private",
            }
            preview = {
                **snapshot,
                "image_url": f"/api/generation-jobs/{image_id}/preview",
            }
            store.save_preview(preview, data, job)
            job["stage"] = "enriching"
            publish_job()
            enrichment = providers.composer.enrich(draft, final_prompt)
            snapshot.update(
                **enrichment,
                accessibility={
                    "alt_text": enrichment["alt_text"],
                    "prompt_source": "final_prompt",
                    "accessibility_features": ["alt_text"],
                    "image_url": snapshot["image_url"],
                },
            )
            job["stage"] = "saving"
            publish_job()
            store.save(snapshot, data, job)
        except JobNoLongerActive:
            return
        except Exception as exc:
            job.update(
                stage="failed",
                result=None,
                error=str(exc)
                if isinstance(exc, ProviderError)
                else "Unable to validate or save generation; check API logs and storage",
            )
            store.update_job(job)

    @app.post("/api/generations", status_code=202)
    def generate(draft: Generation):
        require_inference()
        store = app.state.store
        providers = current_providers(app)
        if draft.reference_context and not draft.reference_images:
            raise HTTPException(400, "Attach the original reference image files")
        if draft.reference_images:
            if len(draft.reference_images) != len(draft._reference_inputs):
                raise HTTPException(400, "Attach the original reference image files")
            if not providers.renderer.editing_ready:
                raise HTTPException(
                    503, "This image provider does not support reference editing"
                )
            limit_problem = too_many_references(
                providers.renderer, len(draft.reference_images)
            )
            if limit_problem:
                raise HTTPException(400, limit_problem)
        if draft.region_edit and draft.region_edit.feather:
            try:
                # Refuse a feathered selection that rounds to zero opacity
                # before reserving jobs or asking the image provider to render.
                selection_mask(draft.region_edit)
            except ValueError as exc:
                raise HTTPException(400, str(exc)) from exc
        if draft.variation_count > 1 or draft.retry_variations:
            if not providers.renderer.ready and not draft.reference_images:
                raise HTTPException(503, "Image provider is not configured")
            return app.state.generation_groups.submit(draft, providers)
        fingerprint = generation_fingerprint(draft, providers)
        with app.state.lock, store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT fingerprint,data FROM jobs WHERE key=?",
                (draft.idempotency_key,),
            ).fetchone()
            if row:
                if row[0] != fingerprint:
                    raise HTTPException(
                        409, "Idempotency key already belongs to another draft"
                    )
                return json.loads(row[1])
            if not providers.renderer.ready and not draft.reference_images:
                raise HTTPException(503, "Image provider is not configured")
            active = db.execute("SELECT data FROM jobs").fetchall()
            if (
                sum(
                    json.loads(r[0])["stage"] not in {"complete", "failed"}
                    for r in active
                )
                >= MAX_QUEUED_GENERATION_JOBS
            ):
                raise HTTPException(
                    429, "Generation queue is full; retry after a job finishes"
                )
            job = {
                "id": str(uuid4()),
                "revision": draft.revision,
                "stage": "queued",
                "result": None,
                "error": None,
                "categories": [],
            }
            try:
                db.execute(
                    "INSERT INTO jobs VALUES (?,?,?,?)",
                    (job["id"], draft.idempotency_key, fingerprint, json.dumps(job)),
                )
                store.record_job_update(db, job)
                store.track_job(job["id"])
                db.commit()
            except sqlite3.IntegrityError as exc:
                store.finish_job(job["id"])
                raise HTTPException(409, "Duplicate generation submission") from exc
            except BaseException:
                store.finish_job(job["id"])
                raise
            try:
                future = app.state.pool.submit(
                    run, job.copy(), draft.model_copy(deep=True), providers
                )
            except RuntimeError as exc:
                store.finish_job(job["id"])
                raise HTTPException(503, "Generation worker is unavailable") from exc
            future.add_done_callback(lambda completed: store.finish_job(job["id"]))
        return job

    @app.get("/api/generations/{job_id}")
    def get_job(job_id: str):
        try:
            job = app.state.store.job(job_id)
        except (sqlite3.Error, OSError, ValueError) as exc:
            raise HTTPException(502, "Generation storage is unavailable") from exc
        if not job:
            raise HTTPException(404, "Generation not found")
        return job

    register_canonical_routes(app, env, generate, get_job)
    register_stream_routes(app, env)
    register_library_routes(app, env)
    register_creation_routes(app, env)
    register_import_routes(app, env)
    register_reference_analysis_routes(app, env)
    register_reference_adaptation_routes(app, env)
    register_watermark_routes(app, env)

    @app.get("/api/images")
    def images(
        q: str = "",
        aspect: str | None = None,
        offset: int = Query(0, ge=0),
        limit: int = Query(100, ge=1, le=200),
    ):
        all_items = library_snapshots(app.state.store)
        items = [
            i
            for i in all_items
            if q.casefold() in (i["prompt"] + " " + i["final_prompt"]).casefold()
            and (not aspect or i["aspect"] == aspect)
        ]
        return {
            "items": items[offset : offset + limit],
            "total": len(items),
            "library_total": len(all_items),
        }

    @app.get("/api/images/{image_id}")
    def image(image_id: str):
        result = app.state.store.image(image_id)
        if not result:
            raise HTTPException(404, "Image not found")
        return result

    @app.get("/api/images/{image_id}/content")
    def content(image_id: str, download: bool = False):
        image(image_id)
        path = app.state.store.root / (image_id + ".png")
        if not path.is_file():
            raise HTTPException(410, "Image file is missing")
        return local_file_response(
            path,
            media_type="image/png",
            filename=f"{image_id}.png" if download else None,
            missing_status=410,
        )

    @app.delete("/api/images/{image_id}")
    def delete(image_id: str):
        image(image_id)
        app.state.store.delete(image_id)
        return {"deleted": image_id}

    # Added last so it wraps every other middleware, including early rejections.
    app.add_middleware(RequestIds)
    return app


app = create_app()
