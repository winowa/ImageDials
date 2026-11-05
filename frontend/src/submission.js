/**
 * Pure rules for turning a draft into a generation request. Kept free of React
 * so the identity, validation and sizing rules are testable on their own.
 */
import { GENERATION_MODE } from './api.js';
import { cloneJson, GROUP, isEnabled, validateEntries } from './controls.js';
import {
  referenceDescriptors,
  serializeEditEntries,
  serializeTextEntries,
} from './references.js';
import { readRegionCapability } from './regionSelection.js';

/** Display order: portrait, landscape, square. */
export const ASPECTS = ['2:3', '3:2', '1:1'];
export const DEFAULT_ASPECT = '3:2';
export const ASPECT_LABEL = {
  '3:2': 'Landscape',
  '2:3': 'Portrait',
  '1:1': 'Square',
};
export const MODES = ['image', 'asset-image'];

/** Controls are tied to the idea they were generated for and to the mode. */
export const promptKey = (prompt, mode) =>
  `${mode}\u0000${prompt.normalize('NFC').trim()}`;

/** Base controls first, then generated ones, as the wire contract appends them. */
export const orderEntries = (entries) => [
  ...entries.filter((e) => e.group === GROUP.base),
  ...entries.filter((e) => e.group !== GROUP.base),
];

/** `1152x768` to `{ width, height }`, or null when malformed. */
export function parseDimensions(text) {
  const match = /^([1-9]\d{0,4})x([1-9]\d{0,4})$/.exec(text ?? '');
  return match ? { width: Number(match[1]), height: Number(match[2]) } : null;
}

/** Server-provided sizes for each aspect; no local fallback is invented. */
export function dimensionsFor(models, aspect) {
  const text = models?.supported_dimensions?.[aspect];
  return parseDimensions(text) ? text : null;
}

/** The supported aspect whose shape is closest to the given pixel size. */
export function nearestAspect(width, height, supported) {
  if (!(width > 0 && height > 0)) return DEFAULT_ASPECT;
  const ratio = width / height;
  const candidates = ASPECTS.flatMap((aspect) => {
    const size = parseDimensions(supported?.[aspect]);
    return size ? [{ aspect, ratio: size.width / size.height }] : [];
  });
  if (!candidates.length) {
    if (ratio > 1.1) return '3:2';
    return ratio < 0.9 ? '2:3' : '1:1';
  }
  const distance = (c) => Math.abs(Math.log(c.ratio / ratio));
  return candidates.reduce((best, c) =>
    distance(c) < distance(best) ? c : best,
  ).aspect;
}

/**
 * Why a text request cannot leave controls to the model, or null. A server
 * without optional controls would use their values anyway, so nothing is
 * sent until they are turned back on.
 */
export function disabledControlBlock(entries, { textFlags = true } = {}) {
  if (textFlags) return null;
  const off = entries.find((entry) => !isEnabled(entry));
  return off
    ? `This server uses every control. Turn ${off.wire.label} back on to generate.`
    : null;
}

/**
 * Build the canonical request. Returns `{ error }` when the draft cannot be
 * submitted; the caller shows it and keeps every selection. Generated-control
 * metadata is sent only while the draft is `dynamicCurrent` (by default: its
 * exact prompt); the caller decides nearness to the original anchor.
 * `textFlags` says whether the server honours controls left to the model.
 */
export function buildSubmission({
  draft,
  entries,
  dynamic,
  additionalMetadata = [],
  dimensions,
  references = [],
  regionEdit = null,
  regionCapability = null,
  textFlags = true,
  dynamicCurrent = dynamic.status === 'ready' &&
    dynamic.anchor === promptKey(draft.prompt, draft.mode),
}) {
  const mustHaveTerms = draft.mustHaveTerms;
  if (
    mustHaveTerms !== undefined &&
    (!Array.isArray(mustHaveTerms) ||
      !mustHaveTerms.every((term) => typeof term === 'string'))
  )
    return { error: 'Must-have terms must be an array of strings.' };

  const ordered = orderEntries(entries);
  const editing = references.length > 0;
  // An edit may preserve the source with no controls at all.
  if (!ordered.length && !editing)
    return {
      error:
        'No controls are available. Reload the standard controls, then try again.',
    };
  if (!editing) {
    const unsupported = disabledControlBlock(ordered, { textFlags });
    if (unsupported) return { error: unsupported };
  }
  // A control left to the model is sent as it is, unused and unvalidated.
  const [problem] = validateEntries(
    editing ? ordered : ordered.filter(isEnabled),
  );
  if (problem) return { error: `${problem.label} ${problem.message}.` };
  const body = {
    prompt: draft.prompt.trim(),
    controls: editing
      ? serializeEditEntries(ordered)
      : serializeTextEntries(ordered),
    dimensions,
    dynamic_controls_metadata: dynamicCurrent
      ? (dynamic.metadata ?? null)
      : null,
    generation_mode: GENERATION_MODE[draft.mode],
  };
  // Omitted while empty so earlier request identities are unchanged.
  if (dynamicCurrent && additionalMetadata.length)
    body.additional_controls_metadata = cloneJson(additionalMetadata);
  if (mustHaveTerms?.length) body.must_have_terms = cloneJson(mustHaveTerms);
  // Descriptors bind each description to the original bytes' hash, in order.
  if (editing) body.reference_images = referenceDescriptors(references);
  if (regionEdit) {
    if (!editing)
      return {
        error: 'Add the original base reference or clear the region selection.',
      };
    const capability = readRegionCapability(regionCapability);
    if (!capability.ok)
      return {
        error: `${capability.reason} Clear the region selection to continue.`,
      };
    const base = references[0];
    const width = base?.dimensions?.width;
    const height = base?.dimensions?.height;
    if (
      !base?.sha256 ||
      base.sha256 !== regionEdit.source_sha256 ||
      width !== regionEdit.width ||
      height !== regionEdit.height
    )
      return {
        error:
          'The region selection belongs to a different base image. Clear it or select the original base again.',
      };
    body.region_edit = cloneJson(regionEdit);
  }
  return { body, fingerprint: JSON.stringify(body) };
}

export const SIZES_UNAVAILABLE = 'Image sizes are unavailable.';

/** Why submission is currently impossible, or null. */
export function submitBlockReason({ discovery, draft }) {
  const { health, models } = discovery;
  if (
    health.data?.inference_enabled === false ||
    models.data?.inference_enabled === false
  )
    return 'Inference is disabled on the server.';
  if (models.status === 'loading') return 'Loading image sizes…';
  if (models.status === 'error' || !dimensionsFor(models.data, draft.aspect))
    return SIZES_UNAVAILABLE;
  if (models.data?.routing?.image?.configured === false)
    return 'No image provider is configured.';
  return null;
}

/** A completed job's record, shaped like a library record. */
export function libraryRecordFromResult(result) {
  return {
    ...result,
    // Library records keep original wire controls in `selected_controls`.
    selected_controls:
      result.original_selected_controls ?? result.selected_controls,
  };
}
