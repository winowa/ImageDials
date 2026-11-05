/**
 * Pure decisions for the watermark state of one private image.
 *
 * The state lives beside the immutable wire record, never inside it:
 *
 *   {
 *     addedAt,                 which add of the entry this state belongs to
 *     analysis: {print_watermark, print_watermark_key, source_sha256, dimensions},
 *     settings: {fingerprint, rendering},   content + policy the analysis used
 *     prepared: null | {pipeline, key, fingerprint, width, height, bytes, createdAt}
 *   }
 *
 * `analysis.print_watermark_key` is opaque: it is only ever compared for
 * equality and sent back, never computed here.
 */

import { analysisMatchesPolicy } from './watermarkGeometry.js';

/** Stable JSON text of a value, so object key order never matters. */
export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

/** Current shared content and rendering policy, reduced to what decides currency. */
export const settingsSnapshot = (settings) => ({
  fingerprint: settings?.fingerprint ?? null,
  rendering: settings?.rendering ?? null,
});

/** True when two settings documents describe the same content and policy. */
export const sameSettings = (a, b) =>
  Boolean(a?.fingerprint) &&
  a.fingerprint === b?.fingerprint &&
  stableJson(a.rendering ?? null) === stableJson(b.rendering ?? null);

/** The state a transient analysis response establishes (no prepared file yet). */
export function stateFromAnalysis(response, addedAt) {
  return {
    addedAt,
    analysis: {
      print_watermark: response.print_watermark,
      print_watermark_key: response.print_watermark_key,
      source_sha256: response.source_sha256,
      dimensions: response.dimensions,
    },
    settings: settingsSnapshot(response.watermark_settings),
    prepared: null,
  };
}

/** True when a response carries everything the private branch relies on. */
export const isUsableAnalysis = (response) =>
  Boolean(
    response?.storage === 'transient' &&
    response.print_watermark?.position?.corner &&
    analysisMatchesPolicy(
      response.print_watermark,
      response.watermark_settings?.rendering,
    ) &&
    response.print_watermark_key &&
    response.watermark_settings?.fingerprint &&
    response.dimensions?.width > 0 &&
    response.dimensions?.height > 0,
  );

/**
 * Is the stored analysis valid for the settings the server has now, this add
 * of the entry, and the source it was made from?
 * @param {object|null} state
 * @param {object} settings current server settings
 * @param {{addedAt: number, sourceSha?: string|null}} entry
 */
export function analysisCurrent(state, settings, { addedAt, sourceSha }) {
  if (!state?.analysis?.print_watermark_key) return false;
  if (state.addedAt !== addedAt) return false;
  if (!sameSettings(state.settings, settings)) return false;
  if (
    !analysisMatchesPolicy(state.analysis.print_watermark, settings?.rendering)
  )
    return false;
  const analyzed = state.analysis.source_sha256;
  return !sourceSha || !analyzed || sourceSha.toLowerCase() === analyzed;
}

/**
 * Version of the prepared-file pipeline. Raise it whenever the bytes of a
 * prepared PNG change meaning. Version 1 is: draw the watermark, then add the
 * ImageDials metadata through the metadata endpoint. Older records have no
 * `pipeline` (their PNG was the raw canvas output without metadata) and are
 * never reused.
 */
export const PREPARED_PIPELINE = 'embed-metadata-v1';

/** True when a prepared record was made by the current pipeline. */
export const preparedPipelineCurrent = (prepared) =>
  prepared?.pipeline === PREPARED_PIPELINE;

/** Is the recorded prepared file made for exactly this analysis and these settings? */
export function preparedCurrent(state, settings) {
  const prepared = state?.prepared;
  return Boolean(
    prepared &&
    preparedPipelineCurrent(prepared) &&
    prepared.key === state.analysis?.print_watermark_key &&
    prepared.fingerprint === settings?.fingerprint &&
    prepared.width === state.analysis.dimensions?.width &&
    prepared.height === state.analysis.dimensions?.height,
  );
}

/** The state after a prepared PNG was made for it. */
export const withPrepared = (state, blob, size, now = Date.now()) => ({
  ...state,
  prepared: {
    pipeline: PREPARED_PIPELINE,
    key: state.analysis.print_watermark_key,
    fingerprint: state.settings.fingerprint,
    width: size.width,
    height: size.height,
    bytes: blob.size,
    createdAt: now,
  },
});

export const preparedBytes = (state) => state?.prepared?.bytes ?? 0;
