import { preserveError } from '../../shared/diagnostics/diagnostics.js';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { api } from '../../data/api/api.js';
import { usePreference } from '../../shared/browser/preferences.js';
import {
  isBakedWatermark,
  isLocalOnly,
} from '../../data/records/imageRecord.js';
import { createLocalPrepareService } from './localPrepare.js';
import { decodeImage, renderPrepared } from './watermarkRenderer.js';
import { hasPlacement } from './watermarkGeometry.js';

/** How often bounded batch status is checked while the shared Library is open. */
export const BACKFILL_POLL_MS = 2000;

/** The statuses of a bulk analysis batch that have not finished. */
export const BACKFILL_ACTIVE = new Set(['queued', 'running']);

/** The batch a 200/202 POST response describes, in status-route shape. */
export function batchFromAccepted(accepted) {
  const queued = accepted?.queued_count ?? null;
  return {
    id: accepted?.analysis_batch_id ?? null,
    status: 'queued',
    phase: accepted?.phase ?? 'analysis',
    force: accepted?.force === true,
    candidate_count: accepted?.candidate_count ?? queued,
    queued_count: queued,
    count_pending: accepted?.count_pending === true,
    completed_count: 0,
    failed_count: 0,
    omitted_error_count: 0,
    error: null,
    completion_scope: 'analysis',
  };
}

/**
 * The batch to show. A fresh status read or local accept outranks a library
 * snapshot, unless that snapshot names a different batch that is still active
 * and has not been contradicted by a later status read.
 */
export function currentBatch(tracked, seed, ignoredSeedId) {
  const usable = seed && seed.id !== ignoredSeedId ? seed : null;
  if (!usable) return tracked;
  if (!tracked || usable.id === tracked.id) return tracked ?? usable;
  return BACKFILL_ACTIVE.has(usable.status) &&
    !BACKFILL_ACTIVE.has(tracked.status)
    ? usable
    : tracked;
}

/**
 * Follow one analysis batch through the bounded status route. Polling runs only
 * while the batch is active; a 304, a failed or malformed read keeps the last
 * progress. Superseded or unmounted polls are aborted and a stale batch's
 * response is ignored. The library is reloaded once when the batch ends. While
 * idle, one conditional read per `check` value finds batches other tabs start:
 * a page's 304 or a cursor page carries no batch information.
 */
function useBackfillProgress({ seed, reload, observing, check }) {
  const [tracked, setTracked] = useState(null);
  const [error, setError] = useState(null);
  const [errorDetail, setErrorDetail] = useState(null);
  const [ignoredSeedId, setIgnoredSeedId] = useState(null);
  const etag = useRef(null);
  const requestEpoch = useRef(0);
  useLayoutEffect(() => {
    requestEpoch.current += 1;
  }, [observing]);
  const reloadRef = useRef(reload);
  const seedRef = useRef(seed);
  /** The id of the last status response; a 304 repeats it. */
  const freshId = useRef(null);
  useEffect(() => {
    reloadRef.current = reload;
    seedRef.current = seed;
  });

  const current = currentBatch(tracked, seed, ignoredSeedId);
  const active = BACKFILL_ACTIVE.has(current?.status);
  const id = current?.id ?? null;

  const accept = useCallback(
    (accepted) => {
      requestEpoch.current += 1;
      setIgnoredSeedId(seed?.id ?? null);
      etag.current = null;
      freshId.current = null;
      setError(null);
      setTracked(batchFromAccepted(accepted));
    },
    [seed?.id],
  );

  /** Apply one status response; returns the batch it says is current. */
  const applyStatus = useCallback((result) => {
    setError(null);
    if (!result.notModified) {
      if (result.etag) etag.current = result.etag;
      freshId.current = result.backfill?.id ?? null;
      setTracked(result.backfill);
    }
    // This read is newer than any library snapshot naming another batch.
    const snapshot = seedRef.current?.id ?? null;
    if (snapshot !== null && snapshot !== freshId.current)
      setIgnoredSeedId(snapshot);
  }, []);

  useEffect(() => {
    if (active || !observing || check === null) return undefined;
    const controller = new AbortController();
    const epoch = ++requestEpoch.current;
    api
      .watermarkBackfillStatus({
        etag: etag.current,
        signal: controller.signal,
      })
      .then((result) => {
        if (!controller.signal.aborted && epoch === requestEpoch.current)
          applyStatus(result);
      })
      .catch(() => {
        // Only an active batch reports progress failures.
      });
    return () => controller.abort();
  }, [active, observing, check, applyStatus]);

  useEffect(() => {
    if (!active || !observing) return undefined;
    const controller = new AbortController();
    const epoch = ++requestEpoch.current;
    let timer = null;
    const poll = async () => {
      let ended = false;
      try {
        const result = await api.watermarkBackfillStatus({
          etag: etag.current,
          signal: controller.signal,
        });
        if (controller.signal.aborted || epoch !== requestEpoch.current) return;
        applyStatus(result);
        ended =
          !result.notModified && !BACKFILL_ACTIVE.has(result.backfill?.status);
      } catch (failure) {
        if (
          controller.signal.aborted ||
          epoch !== requestEpoch.current ||
          failure?.name === 'AbortError'
        )
          return;
        setError(failure.message || 'Analysis progress is unavailable.');
        setErrorDetail(preserveError(failure));
      }
      if (ended) reloadRef.current?.();
      else timer = setTimeout(poll, BACKFILL_POLL_MS);
    };
    timer = setTimeout(poll, BACKFILL_POLL_MS);
    return () => {
      requestEpoch.current += 1;
      controller.abort();
      clearTimeout(timer);
    };
  }, [active, id, observing, applyStatus]);

  return useMemo(
    () => ({ current, error, errorDetail, accept }),
    [current, error, errorDetail, accept],
  );
}

/** Decode the original and draw its source-size prepared PNG. */
async function renderSource({ source, settings, placement }) {
  const bitmap = await decodeImage(source);
  try {
    return await renderPrepared({
      source: bitmap,
      settings,
      limits: settings.limits,
      placement,
      policy: settings.rendering,
    });
  } finally {
    bitmap.close?.();
  }
}

/** Counts shown beside the toolbar; analysis and prepared files are separate. */
export function watermarkCounts(images, policy) {
  return {
    total: images.length,
    analyzed: images.filter((image) => hasPlacement(image, policy)).length,
    prepared: images.filter(
      (image) => image.print_ready_url || image.has_prepared_record === true,
    ).length,
  };
}

/**
 * Watermark state and actions. ONE owner serves every original:
 *
 * - the CONTENT is this browser's own (`local`, see `localWatermark.js`): a
 *   stored choice or the server defaults. Nothing here writes the shared
 *   settings, and a change in one browser cannot reach another;
 * - browser-only images (private results, imports) are prepared through the
 *   private history host; shared-library originals through the shared host.
 *   Both run the same local prepare service, so preview, Download and Print
 *   agree, and no local content is ever uploaded to shared storage;
 * - the shared library's analysis and backfill stay content-independent.
 *
 * @param {object} options
 * @param {{watermarkBackfill: object|null}} options.images
 * @param {Function} options.reload
 * @param {Function} options.replace
 * @param {object} options.local `useLocalWatermark()`
 * @param {object|null} options.capabilities the capabilities document
 * @param {object|null} options.localHost the private history's watermark host
 * @param {object|null} options.sharedHost the shared originals' host
 * @param {boolean} options.observeSharedBatch whether the shared Library is
 *   currently visible
 * @param {*} [options.batchCheck] a change repeats the idle batch status read
 */
export function useWatermark({
  images,
  reload,
  replace,
  local,
  capabilities = null,
  localHost = null,
  sharedHost = null,
  observeSharedBatch = false,
  batchCheck = null,
}) {
  const [visible, setVisible] = usePreference(
    'watermark-visible',
    true,
    (stored) => stored !== false,
  );
  const transientEnabled =
    capabilities?.watermark?.transient_analysis_enabled === true;
  const maxBytes = capabilities?.uploads?.watermark_analysis_max_bytes ?? null;
  const { refresh } = local;

  const serviceFor = useCallback(
    (host) =>
      host
        ? createLocalPrepareService({
            api,
            host,
            render: renderSource,
            readSettings: refresh,
            limits: () => ({ maxBytes }),
          })
        : null,
    [maxBytes, refresh],
  );
  const privateService = useMemo(
    () => serviceFor(localHost),
    [localHost, serviceFor],
  );
  const sharedService = useMemo(
    () => serviceFor(sharedHost),
    [serviceFor, sharedHost],
  );
  const serviceOf = (record) =>
    isLocalOnly(record) ? privateService : sharedService;

  /** Prepared PNGs and local analysis are available (private or shared). */
  const localAvailable = Boolean(privateService) && transientEnabled;
  const preparable = Boolean(sharedService) && transientEnabled;

  /**
   * Analyze (or, with `force`, regenerate the analysis of) one image. Shared
   * images use the library's content-independent analysis.
   */
  const analyze = useCallback(
    async (record, { force = false, signal, publish = true } = {}) => {
      if (isLocalOnly(record))
        return privateService.analyze(record, { force, signal });
      const response = await api.analyzeWatermark(
        { storage_id: record.storage_id, filename: record.filename, force },
        { signal },
      );
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (publish) await replace(response.image);
      return response;
    },
    [privateService, replace],
  );

  const prepare = useCallback(
    (record, options) => serviceOf(record).prepare(record, options),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [privateService, sharedService],
  );

  const asyncPreparation =
    capabilities?.watermark?.backfill?.async_preparation_enabled === true;
  const batch = useBackfillProgress({
    seed: images.watermarkBackfill,
    reload,
    observing: observeSharedBatch,
    check: batchCheck,
  });
  const acceptBatch = batch.accept;

  /**
   * Queue analysis for the library. One POST, never retried; the async form is
   * used only when the server publishes it. Progress then comes from the
   * bounded status route, not from library reads.
   */
  const queueAnalysis = useCallback(
    async (options) => {
      const accepted = await api.queueWatermarkBackfill({
        ...options,
        asyncPreparation,
      });
      acceptBatch(accepted);
      return accepted;
    },
    [asyncPreparation, acceptBatch],
  );

  /** Original bytes of an image kept only in this browser, or null. */
  const readLocalOriginal = useCallback(
    async (record, { signal } = {}) => {
      const handle = localHost?.handleFor(record);
      return handle ? localHost.readOriginal(handle, { signal }) : null;
    },
    [localHost],
  );

  /** What is kept for a shared image: `{analyzed, prepared}`. */
  const inspect = useCallback(
    (record) => sharedHost?.inspect(record) ?? Promise.resolve(null),
    [sharedHost],
  );

  return {
    readLocalOriginal,
    settings: local.settings,
    local,
    backfill: batch.current,
    backfillError: batch.error,
    backfillErrorDetail: batch.errorDetail,
    visible,
    setVisible,
    /** Keep new content for this browser; rejects with the server's reason. */
    saveSettings: local.save,
    /** Remove this browser's content; the server defaults apply again. */
    resetSettings: local.reset,
    analyze,
    prepare,
    inspect,
    queueAnalysis,
    isBaked: isBakedWatermark,
    /** Images kept only in this browser can be analyzed and prepared. */
    localAvailable,
    /** Any image, shared or private, can be prepared with local content. */
    preparable,
  };
}
