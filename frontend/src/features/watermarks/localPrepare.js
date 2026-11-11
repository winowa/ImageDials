/**
 * The local prepare service: the current watermark analysis and prepared PNG
 * of one original, made in this browser from THIS browser's watermark content.
 * It serves browser-only images (private results, imports) and shared-library
 * originals alike through a host; the host owns where state and bytes live.
 * It never calls the shared-library analysis, prepared-file, delete or
 * backfill routes, never uploads local content to shared storage and never
 * invents a storage identity.
 *
 *  1. Read the CURRENT local settings (content + rendering policy).
 *  2. Reuse the stored analysis when it was made for those settings, this add
 *     of the entry and this source; otherwise send the ORIGINAL bytes with the
 *     local settings to the transient analyzer (the API reuses its pixel
 *     analysis, so a content change is cheap) and keep the answer.
 *  3. Reuse the stored prepared PNG when it was made for that analysis and
 *     those settings; otherwise draw it with the shared renderer and add the
 *     ImageDials metadata through the metadata endpoint. The RETURNED PNG is
 *     the prepared file: it is what is stored, downloaded and printed.
 *  4. Read the settings again. If they changed during the render, or the
 *     metadata endpoint says the key is stale (409), refresh the analysis and
 *     render ONCE more; a second change is the answer.
 *  5. Store the PNG through the host unless the entry was removed meanwhile.
 *
 * Concurrent requests for one entry, stored key and mode share one run.
 * Original bytes are only ever read, and never fetched again after embedding.
 */
import {
  analysisCurrent,
  isUsableAnalysis,
  preparedCurrent,
  sameSettings,
  stateFromAnalysis,
  stableJson,
  withPrepared,
} from './privateWatermark.js';
import {
  isBakedWatermark,
  isLocalOnly,
} from '../../data/records/imageRecord.js';
import { PrepareError } from './prepareError.js';
import { createRunRegistry } from '../../shared/browser/runRegistry.js';
import { placementOf } from './watermarkGeometry.js';

/** One refresh-and-render retry when the settings change mid-render. */
const SETTINGS_RETRY_LIMIT = 1;
const HTTP_STALE = 409;
const MIB = 1024 * 1024;

const sourceAnalysisOf = (record) =>
  !record || isLocalOnly(record)
    ? null
    : stableJson([
        record.print_watermark_key,
        record.print_watermark?.position,
        record.print_watermark?.presentation,
        record.print_watermark?.provenance?.generator_version,
      ]);

const aborted = (error) => error?.name === 'AbortError';

const stageError = (stage, prefix) => (error) => {
  if (aborted(error) || error instanceof PrepareError) throw error;
  throw new PrepareError(`${prefix} ${error.message}`.trim(), stage, error);
};

const REMOVED = () =>
  new PrepareError('The image was removed from this browser.', 'removed');

/**
 * @param {object} deps
 * @param {{analyzeWatermarkImage: Function, embedWatermarkMetadata: Function}} deps.api
 * @param {object} deps.host where state and bytes live (see the two hosts)
 * @param {(signal?: AbortSignal) => Promise<object>} deps.readSettings this
 *   browser's effective settings, revalidated against the server
 * @param {Function} deps.render `({source, settings, placement}) => {blob, width, height}`
 * @param {() => {maxBytes?: number|null}} [deps.limits] analyzer upload limits
 */
export function createLocalPrepareService({
  api,
  host,
  readSettings: readCurrentSettings,
  render,
  limits = () => ({}),
}) {
  const runs = createRunRegistry();
  /** Newest run per entry: an older run never overwrites a newer one's state. */
  const newest = new Map();

  const entryId = (handle) => `${handle.key}@${handle.addedAt}`;

  const readSettings = (signal) =>
    readCurrentSettings(signal).catch(
      stageError('settings', 'Watermark settings could not be read.'),
    );

  /** A content/policy change shares the same retry budget at every async stage. */
  const readChangedSettings = async (expected, attempt, signal) => {
    const current = await readSettings(signal);
    if (sameSettings(current, expected)) return null;
    if (attempt >= SETTINGS_RETRY_LIMIT)
      throw new PrepareError(
        'The watermark settings changed again while preparing.',
        'settings',
      );
    return current;
  };

  const loadOriginal = async (handle, signal) => {
    let original;
    try {
      original = await host.readOriginal(handle, { signal });
    } catch (error) {
      if (aborted(error) || error instanceof PrepareError) throw error;
      throw new PrepareError(
        `The original could not be read. ${error.message}`,
        'source',
        error,
      );
    }
    if (!original)
      throw new PrepareError(
        'The original bytes of this image are not stored in this browser.',
        'source',
      );
    const maxBytes = limits().maxBytes;
    if (maxBytes && original.size > maxBytes)
      throw new PrepareError(
        `The original is ${(original.size / MIB).toFixed(1)} MiB; the analyzer accepts up to ${(maxBytes / MIB).toFixed(0)} MiB.`,
        'source',
      );
    return original;
  };

  /** Analyze the original and keep the answer beside the entry. */
  const analyze = async (
    handle,
    original,
    settings,
    force,
    signal,
    ticket,
    previous,
  ) => {
    const response = await api
      .analyzeWatermarkImage(original, {
        force,
        signal,
        watermarkSettings: settings,
        previousAnalysis: previous,
      })
      .catch(stageError('analysis', 'The image could not be analyzed.'));
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const sourceSha = host.current(handle)?.wire.sha256;
    if (
      sourceSha &&
      response?.source_sha256?.toLowerCase() !== sourceSha.toLowerCase()
    )
      throw new PrepareError(
        'The analyzed bytes do not match the saved original.',
        'source',
      );
    if (!isUsableAnalysis(response))
      throw new PrepareError(
        'The analysis response was not usable.',
        'analysis',
      );
    const state = {
      ...stateFromAnalysis(response, handle.addedAt),
      sourceAnalysis: sourceAnalysisOf(host.current(handle)?.wire),
    };
    const saved = await persist(ticket, handle, () =>
      host.saveAnalysis(handle, state),
    );
    return { state, settings: response.watermark_settings, saved };
  };

  /** Run a host write unless the entry was removed or a newer run owns it. */
  const persist = async (ticket, handle, write) => {
    if (!host.isListed(handle)) throw REMOVED();
    if (newest.get(entryId(handle)) !== ticket) return null;
    const result = await write();
    if (result?.listed === false) throw REMOVED();
    return result;
  };

  const run = async (handle, mode, force, signal, ticket) => {
    const wantsPng = mode === 'prepare';
    let settings = await readSettings(signal);
    let forceNow = force;
    let regenerateNow = force;
    let original = null;
    for (let attempt = 0; ; attempt += 1) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (!host.isListed(handle)) throw REMOVED();
      await host.load?.(handle);
      const current = host.current(handle);
      if (!current) throw REMOVED();
      let state = current.watermark;
      let drawWith = settings;
      let saved = null;
      const sharedAnalysis = isLocalOnly(current.wire)
        ? null
        : current.wire.print_watermark;
      const sharedChanged = Boolean(
        sharedAnalysis &&
        state &&
        sourceAnalysisOf(current.wire) !== state.sourceAnalysis,
      );
      const reusable =
        !sharedChanged &&
        !forceNow &&
        analysisCurrent(state, settings, {
          addedAt: handle.addedAt,
          sourceSha: current.wire.sha256,
        });
      if (reusable && wantsPng && preparedCurrent(state, settings)) {
        const stored = await host.readPrepared(handle).catch(() => null);
        if (stored && stored.size === state.prepared.bytes)
          return {
            blob: stored,
            size: state.analysis.dimensions,
            reused: true,
            persistence: host.persistenceOf(handle),
            analysis: state,
          };
      }
      if (!reusable) {
        original ??= await loadOriginal(handle, signal);
        ({
          state,
          settings: drawWith,
          saved,
        } = await analyze(
          handle,
          original,
          settings,
          forceNow,
          signal,
          ticket,
          forceNow && !regenerateNow
            ? undefined
            : sharedChanged
              ? sharedAnalysis
              : (state?.analysis?.print_watermark ?? sharedAnalysis),
        ));
        forceNow = false;
        regenerateNow = false;
      }
      if (!wantsPng)
        return { reused: reusable, analysis: state, persistence: saved };

      original ??= await loadOriginal(handle, signal);
      let rendered;
      try {
        rendered = await render({
          source: original,
          settings: drawWith,
          placement: placementOf(
            state.analysis.print_watermark,
            drawWith.rendering,
          ),
        });
      } catch (error) {
        if (aborted(error)) throw error;
        throw new PrepareError(error.message, 'render', error);
      }
      // The decoded source, not an old record, is the truth about its size.
      const { width, height } = state.analysis.dimensions;
      if (rendered.width !== width || rendered.height !== height)
        throw new PrepareError(
          `The rendered image is ${rendered.width}×${rendered.height}, but the analyzed original is ${width}×${height}.`,
          'render',
        );
      const after = await readChangedSettings(state.settings, attempt, signal);
      if (after) {
        settings = after;
        continue;
      }
      let embedded;
      try {
        embedded = await api.embedWatermarkMetadata(
          rendered.blob,
          {
            source_image: current.wire,
            source_sha256: state.analysis.source_sha256,
            print_watermark: state.analysis.print_watermark,
            watermark_settings: drawWith,
            watermark_key: state.analysis.print_watermark_key,
            dimensions: { width, height },
          },
          { signal },
        );
      } catch (error) {
        if (aborted(error)) throw error;
        if (error?.status === HTTP_STALE && attempt < SETTINGS_RETRY_LIMIT) {
          // The key no longer matches: ask the analyzer again under the
          // server's current policy and render once more.
          settings = await readSettings(signal);
          forceNow = true;
          regenerateNow = false;
          continue;
        }
        throw new PrepareError(
          error?.status === HTTP_STALE
            ? `The watermark settings changed again while preparing. ${error.message}`
            : `The image details could not be added. ${error.message}`,
          'embed',
          error,
        );
      }
      if (!embedded?.size)
        throw new PrepareError(
          'The image details response was empty.',
          'embed',
        );
      // Embedding is asynchronous too: a new local choice must not publish
      // the already-rendered PNG after it has become stale.
      const afterEmbedding = await readChangedSettings(
        state.settings,
        attempt,
        signal,
      );
      if (afterEmbedding) {
        settings = afterEmbedding;
        continue;
      }
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const next = withPrepared(state, embedded, { width, height });
      const outcome = await persist(ticket, handle, () =>
        host.savePrepared(handle, next, embedded),
      );
      return {
        blob: embedded,
        size: { width, height },
        reused: false,
        persistence: outcome ?? { state: 'not-stored', reason: 'superseded' },
        analysis: next,
      };
    }
  };

  const start = (record, mode, { force = false, signal } = {}) => {
    // A baked copy already carries its watermark; drawing again would double it.
    if (isBakedWatermark(record))
      return Promise.reject(
        new PrepareError(
          'This image already has the watermark built in.',
          'baked',
        ),
      );
    const handle = host.handleFor(record);
    if (!handle) return Promise.reject(REMOVED());
    const id = `${entryId(handle)}|${handle.watermark?.analysis?.print_watermark_key ?? 'unanalyzed'}|${mode}${force ? '|force' : ''}`;
    return runs.join(
      id,
      async (runSignal) => {
        const release = host.retain?.(handle);
        const ticket = Symbol('run');
        newest.set(entryId(handle), ticket);
        try {
          const result = await run(handle, mode, force, runSignal, ticket);
          // A removed entry is never reported as done.
          if (!host.isListed(handle)) throw REMOVED();
          return result;
        } finally {
          release?.();
          if (newest.get(entryId(handle)) === ticket)
            newest.delete(entryId(handle));
        }
      },
      signal,
    );
  };

  return {
    /** The current prepared PNG: `{blob, size, reused, persistence, analysis}`. */
    prepare: (record, options) => start(record, 'prepare', options),
    /** Analysis only; `force` regenerates it. */
    analyze: (record, options) => start(record, 'analyze', options),
    get pending() {
      return runs.pending;
    },
  };
}
