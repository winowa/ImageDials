import { ErrorDetails, WarningDetails } from './ErrorDetails.jsx';
import { jobDiagnostic } from './diagnostics.js';

import React, {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  comparisonSources,
  defaultSourceId,
  sourceLabel,
} from './comparison.js';
import { recordControls, selectionSummary } from './controls.js';
import { ExchangeDialog } from './LlmExchange.jsx';
import { savedExchanges } from './llmExchange.js';
import { recordReferences } from './references.js';
import { failedAfterPreview, isActive, PHASE } from './jobs.js';
import { nearestAspect, parseDimensions } from './submission.js';
import {
  aspectName,
  draftModeLabel,
  recordAspect,
  recordModeLabel,
  requestFraming,
} from './outputFraming.js';
import { downloadEnabled } from './discovery.js';
import { STORAGE_STATE, storageLabel } from './privateHistory.js';
import {
  describeImage,
  isBakedWatermark,
  isBrowserUpload,
  isLocalOnly,
} from './imageRecord.js';
import GenerationPhrase from './GenerationPhrase.jsx';
import Variations, { variationBadge } from './Variations.jsx';
import FullImageView from './FullImageView.jsx';
import ImageComparison, { CompareGlyph } from './ImageComparison.jsx';
import ResultDownload from './ResultDownload.jsx';
import ResultMenu from './ResultMenu.jsx';
import { imageAnnotationMenuItems } from './ImageAnnotationActions.jsx';
import { annotationKey } from './imageAnnotations.js';
import { useImageAnnotations } from './useImageAnnotations.js';
import {
  Disclosure,
  formatSaved,
  Icon,
  JsonTree,
  providerLabel,
  SavedImg,
  Tip,
} from './ui.jsx';

/** In the order the backend works: the title and alt text come before saving. */
const STEPS = [
  ['options', 'Options'],
  ['queued', 'Queued'],
  ['composing', 'Prompt'],
  ['rendering', 'Rendering'],
  ['enriching', 'Title and alt text'],
  ['saving', 'Saving'],
];

/** The server's name for the options step. */
const SERVER_OPTIONS_STAGE = 'categories';

/**
 * The progress step a job is on. A stage this client does not know is shown as
 * queued rather than as a different, wrong step.
 */
export function stepIndex(job) {
  const running = job.phase === PHASE.running || job.phase === PHASE.preview;
  let id = 'queued';
  if (job.phase === PHASE.preparing) id = 'options';
  else if (running && job.stage === SERVER_OPTIONS_STAGE) id = 'options';
  else if (running && STEPS.some(([step]) => step === job.stage))
    id = job.stage;
  return STEPS.findIndex(([step]) => step === id);
}

export const fileName = (image) =>
  `${
    (image.title || 'image')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-|-$/g, '') || 'image'
  }.png`;

const IMPORT_STEPS = [
  ['analysis', 'Analyzing photo'],
  ['controls', 'Promptions controls'],
  ['options', 'Selecting options'],
  ['generation', 'Generating image'],
];

function Progress({ job, imported }) {
  const steps = imported
    ? imported.descriptionOnly
      ? IMPORT_STEPS.slice(0, 1)
      : IMPORT_STEPS.map(([id, label]) => [
          id,
          imported.restored && id === 'controls' ? 'Restored controls' : label,
        ])
    : STEPS;
  const index = imported
    ? steps.findIndex(([id]) => id === imported.step)
    : stepIndex(job);
  const detail =
    imported?.step === 'generation' ? STEPS[stepIndex(job)][1] : null;
  return (
    <div className="progress" data-import={Boolean(imported)}>
      <ol className="steps" aria-label="Generation progress">
        {steps.map(([id, label], i) => (
          <li
            key={id}
            data-state={i < index ? 'done' : i === index ? 'active' : 'todo'}
            aria-current={i === index ? 'step' : undefined}
          >
            {label}
          </li>
        ))}
      </ol>
      {detail ? (
        <span className="progress-detail" aria-hidden="true">
          {detail}
        </span>
      ) : null}
      <span
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {imported
          ? `${imported.step === 'controls' ? 'Creating Promptions controls' : steps[index][1]}${detail ? `: ${detail}` : ''}`
          : `Generating: ${steps[index][1]}`}
      </span>
    </div>
  );
}

function JobAlert({ studio }) {
  const { job } = studio;
  // A group's failures, retry and lost status belong to its own results.
  if (job?.group) return null;
  if (job?.phase === PHASE.failed)
    return (
      <div className="alert" role="alert">
        <span>
          <ErrorDetails
            error={job}
            diagnostic={
              job.diagnostic ??
              jobDiagnostic({ jobId: job.id, record: job, reason: job.error })
            }
          />
          {job.error || 'Generation failed.'}
          {failedAfterPreview(job) ? ' The preview was not saved.' : ''}
          {studio.current ? ' The previous image is still shown.' : ''}
        </span>
        <button
          type="button"
          className="btn"
          onClick={() => (studio.retry ?? studio.submit)()}
        >
          <Icon name="refresh" size={18} />
          Retry
        </button>
      </div>
    );
  if (job?.phase === PHASE.lost)
    return (
      <div className="alert" role="alert">
        <span>
          <WarningDetails warning={job} />
          {job.error}
        </span>
        <button type="button" className="btn" onClick={studio.resumeTracking}>
          <Icon name="refresh" size={18} />
          Check again
        </button>
      </div>
    );
  return null;
}

export function Facts({ image }) {
  const { size, requestedSize: requested } = describeImage(image);
  const enrichment = image.enrichment_metadata;
  const sizeDiffers =
    requested &&
    size &&
    (requested.width !== size.width || requested.height !== size.height);
  return (
    <dl className="facts">
      <dt>Provider</dt>
      <dd>{providerLabel(image.provider)}</dd>
      <dt>Model</dt>
      <dd>
        <code>{image.model}</code>
      </dd>
      <dt>Mode</dt>
      <dd>{image.generation_mode ?? image.mode}</dd>
      <dt>Size</dt>
      <dd>
        {size ? `${size.width}×${size.height}` : 'unknown'}
        {sizeDiffers
          ? ` (requested ${requested.width}×${requested.height})`
          : ''}
      </dd>
      <dt>Alt text</dt>
      <dd>{image.alt_text || 'none'}</dd>
      {enrichment ? (
        <>
          <dt>Title and alt text by</dt>
          <dd>
            {[providerLabel(enrichment.provider), enrichment.model]
              .filter(Boolean)
              .join(' · ')}
          </dd>
        </>
      ) : null}
      <dt>ID</dt>
      <dd>
        <code>{image.id}</code>
      </dd>
      <dt>SHA-256</dt>
      <dd>
        <code className="wrap">{image.sha256}</code>
      </dd>
    </dl>
  );
}

/**
 * Actions that apply to this result only some of the time: attaching it as a
 * reference (when the server can edit) and comparing it with an attached
 * reference (when one is held in memory). Inapplicable items are left out.
 */
export function resultMenuItems(studio, image, sources, onCompare) {
  const items = [];
  const capability = studio.editCapability;
  if (capability?.enabled && studio.addImageReference) {
    const reading = studio.referenceReading;
    const busy = reading === describeImage(image).key;
    const full =
      (studio.references?.refs?.length ?? 0) >= capability.maxReferences;
    items.push({
      id: 'reference',
      label: 'Edit image',
      icon: 'plus',
      busy,
      disabled: Boolean(reading) || full,
      hint: busy
        ? 'Adding…'
        : full
          ? `Limit of ${capability.maxReferences} reached`
          : undefined,
      onSelect: () => studio.addImageReference(image),
    });
  }
  if (sources.length) {
    const first = sources.find((s) => s.id === defaultSourceId(sources));
    items.push({
      id: 'compare',
      label: 'Compare',
      icon: <CompareGlyph />,
      hint: `With ${sourceLabel(first).toLowerCase()} ${first.name}${
        sources.length > 1 ? ` (+${sources.length - 1})` : ''
      }`,
      onSelect: onCompare,
    });
  }
  return items;
}

function Result({ studio, image, onEdit, focusStage }) {
  const summary = useMemo(() => selectionSummary(image), [image]);
  const edited = useMemo(() => recordReferences(image), [image]);
  const refs = studio.references?.refs;
  const heldSource = studio.references?.heldSource;
  const { find: findKept, load: loadKept } = studio.retained ?? {};
  // Read-only lookups: a recorded source held in this tab or kept in this
  // browser is offered for Compare without attaching it. Only metadata is
  // known here; a kept file's bytes are read after Compare opens.
  const sources = useMemo(
    () =>
      comparisonSources(image, refs ?? [], {
        held: heldSource,
        kept: findKept,
        load: loadKept,
      }),
    [image, refs, heldSource, findKept, loadKept],
  );
  const [comparing, setComparing] = useState(false);
  const menu = useRef(null);
  const downloads = downloadEnabled(studio.discovery.capabilities);
  const creationRequest = image.prompt_creation_request;
  const local = isLocalOnly(image);
  const imported = isBrowserUpload(image);
  const storage = image.local_storage;
  const annotations = useImageAnnotations(studio.imageAnnotations);
  const identity = annotations.entryFor(image).identity;
  const annotationId = identity ? annotationKey(identity) : null;
  const activeAnnotation = useRef(annotationId);
  const [annotationNotice, setAnnotationNotice] = useState(null);
  useLayoutEffect(() => {
    activeAnnotation.current = annotationId;
    return () => {
      activeAnnotation.current = null;
    };
  }, [annotationId]);
  const exchanges = useMemo(
    () =>
      savedExchanges(
        image,
        recordControls(image).some((wire) => wire.origin === 'generated'),
      ),
    [image],
  );
  const [inspecting, setInspecting] = useState(false);
  const contextual = resultMenuItems(studio, image, sources, () =>
    setComparing(true),
  );
  const editImage = contextual.find((item) => item.id === 'reference');
  const items = [
    ...contextual.filter((item) => item.id !== 'reference'),
    ...(exchanges.length
      ? [
          {
            id: 'exchange',
            label: 'Request and response',
            icon: 'braces',
            hint: exchanges.every((item) => item.state === 'unavailable')
              ? 'Not saved'
              : undefined,
            onSelect: () => setInspecting(true),
          },
        ]
      : []),
    ...(studio.imageAnnotations
      ? imageAnnotationMenuItems({
          image,
          annotations,
          onResult: (text) => {
            if (activeAnnotation.current === annotationId)
              setAnnotationNotice({ identity: annotationId, text });
          },
        })
      : []),
  ];

  return (
    <div className="result">
      <div className="result-head">
        <h2>{image.title || 'Untitled'}</h2>
        <div className="result-actions">
          <button type="button" className="btn" onClick={() => onEdit(image)}>
            <Icon name="edit" size={18} />
            Reuse settings
          </button>
          {editImage ? (
            <Tip label={editImage.hint ?? 'Edit image'}>
              <button
                type="button"
                className="btn"
                aria-disabled={
                  editImage.disabled || editImage.busy || undefined
                }
                aria-busy={editImage.busy || undefined}
                onClick={() => {
                  if (!editImage.disabled && !editImage.busy)
                    editImage.onSelect();
                }}
              >
                <Icon name="plus" size={18} />
                Edit image
              </button>
            </Tip>
          ) : null}
          <FullImageView
            image={image}
            watermark={
              studio.watermark.visible &&
              studio.watermark.settings &&
              !isBakedWatermark(image)
                ? { settings: studio.watermark.settings }
                : null
            }
          />
          {downloads ? (
            <ResultDownload
              image={image}
              watermark={studio.watermark}
              name={fileName(image)}
            />
          ) : null}
          {items.length ? <ResultMenu ref={menu} items={items} /> : null}
        </div>
      </div>
      {inspecting ? (
        <ExchangeDialog
          exchanges={exchanges}
          title="Controls request and response"
          onClose={() => {
            setInspecting(false);
            requestAnimationFrame(() => menu.current?.focus());
          }}
        />
      ) : null}
      {annotationNotice?.identity === annotationId ? (
        <p className="meta-line" role="status">
          {annotationNotice.text !== 'Saved in this browser.' ? (
            <WarningDetails warning={annotationNotice.text} />
          ) : null}
          {annotationNotice.text}
        </p>
      ) : null}
      {comparing ? (
        <ImageComparison
          image={image}
          sources={sources}
          urls={studio.urls}
          restoreFocus={focusStage}
          onClose={() => {
            setComparing(false);
            menu.current?.focus();
          }}
        />
      ) : null}
      <p className="meta-line">
        <span className="badge" data-kind={image.provider}>
          {image.provider === 'mock' ? 'Mock' : image.provider}
        </span>
        {variationBadge(image) ? (
          <span className="badge">{variationBadge(image)}</span>
        ) : null}
        {imported ? <span className="badge">Imported · not saved</span> : null}
        {local && !imported ? (
          <span className="badge">Private · this browser</span>
        ) : null}
        <span>{formatSaved(image)}</span>
      </p>
      {storage && storage.state !== STORAGE_STATE.SAVING ? (
        <p className="meta-line" role="status" data-storage={storage.state}>
          <span>
            {storage.state !== STORAGE_STATE.STORED ? (
              <WarningDetails warning={storageLabel(storage)} />
            ) : null}
            {storageLabel(storage)}
          </span>
          {storage.retryable ? (
            <button
              type="button"
              className="btn"
              onClick={() => studio.retryStorage(image)}
            >
              <Icon name="refresh" size={18} />
              Retry storing
            </button>
          ) : null}
        </p>
      ) : null}
      {edited.length ? (
        <ol className="summary edit-sources" aria-label="Edited from">
          {edited.map((ref, index) => (
            <li key={`${ref.id}-${index}`}>
              <span>{index === 0 ? 'Base' : `Reference ${index + 1}`}</span>{' '}
              {ref.description || ref.filename || ref.id}
            </li>
          ))}
        </ol>
      ) : null}
      {summary.length ? (
        <ul className="summary" aria-label="Selected options">
          {summary.map((s) => (
            <li key={s.key} data-kept={s.kept || undefined}>
              <span>{s.label}</span> {s.value}
              {s.kept ? <em className="summary-kept"> · kept</em> : null}
            </li>
          ))}
        </ul>
      ) : null}
      <Disclosure title="Prompts">
        <h3 className="mini">Original</h3>
        <p className="prose">{image.original_prompt ?? image.prompt}</p>
        <h3 className="mini">Final</h3>
        <pre className="final-prompt">{image.final_prompt}</pre>
        {creationRequest ? (
          <>
            <h3 className="mini">Prompt creation request</h3>
            <pre className="final-prompt">
              {typeof creationRequest === 'string'
                ? creationRequest
                : JSON.stringify(creationRequest, null, 2)}
            </pre>
          </>
        ) : null}
      </Disclosure>
      <Disclosure title="Details">
        <Facts image={image} />
      </Disclosure>
      <Disclosure title="Image Metadata">
        <JsonTree value={image} />
      </Disclosure>
    </div>
  );
}

/** Status of a selected provisional item the live job alert does not cover. */
function PendingNote({ studio, item }) {
  if (!item || studio.job?.id === item.client_pending.jobId) return null;
  const { phase, error } = item.client_pending;
  if (phase !== PHASE.failed)
    return (
      <p className="control-status" role="status">
        This image is still being created.
      </p>
    );
  return (
    <div className="alert" role="alert">
      <span>
        <ErrorDetails
          error={item.client_pending}
          diagnostic={jobDiagnostic({
            jobId: item.client_pending.jobId,
            record: item.client_pending,
            reason: error,
          })}
        />
        {error || 'Generation failed.'}
      </span>
      <button
        type="button"
        className="btn"
        onClick={() => studio.removeImage(item)}
      >
        Dismiss
      </button>
    </div>
  );
}

/**
 * What the stage is showing. While an image is being made nothing earlier is
 * shown (its saved record and history are untouched); the pills describe the
 * request being made. After a failure the prior result is shown again. A
 * shown result is described from its own record only, so draft changes never
 * relabel it; anything else is the requested size (`requested: true`).
 */
export function stageView(studio) {
  const { current, job, draft, discovery, generating } = studio;
  const supported = discovery.models.data?.supported_dimensions;
  const waiting = current?.client_pending ? current : null;
  const held =
    Boolean(generating) && Boolean(job) && job.phase !== PHASE.failed;
  const pendingNow = waiting && waiting.client_pending.phase !== PHASE.failed;
  const loading = held || Boolean(pendingNow);
  const shown = loading
    ? null
    : waiting
      ? waiting.client_pending.previous
      : (current ?? null);
  if (shown) {
    const size = describeImage(shown).size;
    return {
      loading,
      waiting,
      shown,
      size,
      aspect: recordAspect(shown, size, supported),
      modeLabel: recordModeLabel(shown),
      requested: false,
    };
  }
  const framing = requestFraming(
    draft,
    studio.references?.refs,
    discovery.models.data,
  );
  let { aspect } = framing;
  let size = parseDimensions(framing.dimensions);
  let modeLabel = draftModeLabel(draft);
  if (held && generating) {
    aspect = generating.aspect;
    size = parseDimensions(generating.dimensions);
    modeLabel = draftModeLabel(generating);
  } else if (pendingNow) {
    const requested = describeImage(waiting).requestedSize;
    size = requested ?? size;
    modeLabel = recordModeLabel(waiting);
    if (requested)
      aspect = nearestAspect(requested.width, requested.height, supported);
  }
  return {
    loading,
    waiting,
    shown: null,
    size,
    aspect,
    modeLabel,
    requested: true,
  };
}

export default function Viewer({ studio, onEdit }) {
  const { job, draft } = studio;
  const active = isActive(job);
  const { loading, waiting, shown, size, aspect, modeLabel, requested } =
    stageView(studio);
  const ratio = size
    ? `${size.width} / ${size.height}`
    : (aspect ?? draft.aspect).replace(':', ' / ');
  // A group keeps making images after its first is shown: its progress and
  // previews then stay with its own results instead of covering that image.
  const jobOverlay = active && (!job.group || loading);
  const importProgress = studio.importState?.progress;
  const importing = studio.importState?.phase === 'analyzing' && importProgress;
  const importedJob =
    jobOverlay &&
    importProgress?.step === 'generation' &&
    job.snapshot?.body?.dynamic_controls_metadata?.import_source?.binding
      ?.request_id === importProgress.requestId;
  const pipeline = importing
    ? importProgress
    : importedJob
      ? importProgress
      : null;
  const overlay = jobOverlay || Boolean(importing);
  const preview = jobOverlay && job.preview?.image_url ? job.preview : null;
  // The rotating lines are decoration for a wait the person is looking at: they
  // end with the preview, the result or a failure.
  const phrases = loading && active && !preview;
  const label = aspectName(aspect);
  const card = useRef(null);
  // Where focus goes when a comparison is removed while it held focus and its
  // More opener is gone with the result: the stage itself, which stays.
  const focusStage = useCallback(() => card.current?.focus(), []);

  return (
    <section
      ref={card}
      className="stage-card"
      id="result"
      aria-label="Result"
      tabIndex={-1}
    >
      <div className="stage-pills">
        <span className="pill">
          {label ? `${label} · ${modeLabel}` : modeLabel}
        </span>
        {size ? (
          <span className="pill mono">
            {requested ? <span className="pill-role">Requested</span> : null}
            {size.width}×{size.height}
          </span>
        ) : null}
      </div>
      <JobAlert studio={studio} />
      <PendingNote studio={studio} item={waiting} />
      <div
        className="stage"
        style={{ aspectRatio: ratio }}
        data-busy={jobOverlay}
        data-loading={loading}
      >
        {shown ? (
          <SavedImg
            key={describeImage(shown).key}
            image={shown}
            className="stage-img"
            loading="eager"
            variant="original"
            watermark={
              studio.watermark.visible &&
              studio.watermark.settings &&
              !isBakedWatermark(shown)
                ? { settings: studio.watermark.settings }
                : null
            }
          />
        ) : (
          <div className="stage-empty">
            {phrases ? (
              <GenerationPhrase />
            ) : loading ? (
              job?.phase === PHASE.lost ? (
                <span>Waiting for the job status</span>
              ) : null
            ) : (
              <>
                <span className="stage-ratio">{aspect ?? draft.aspect}</span>
                <span>
                  {studio.stageWaiting ? 'Loading image…' : 'No image yet'}
                </span>
              </>
            )}
          </div>
        )}
        {preview ? (
          <img
            className="stage-preview"
            src={preview.image_url}
            alt="Preview"
          />
        ) : null}
        {overlay ? <Progress job={job} imported={pipeline} /> : null}
      </div>
      <Variations studio={studio} />
      {shown ? (
        <Result
          key={describeImage(shown).key}
          studio={studio}
          image={shown}
          onEdit={onEdit}
          focusStage={focusStage}
        />
      ) : null}
    </section>
  );
}
