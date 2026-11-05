/**
 * What size a request asks for and how the stage labels it. Pure and free of
 * React. An edit's framing follows its base image, so its request uses the
 * configured size nearest the base's shape; the draft's own aspect choice is
 * a preference kept for text and asset requests and is never rewritten here.
 */
import { baseDimensions, recordReferences } from './references.js';
import { ASPECT_LABEL, dimensionsFor, nearestAspect } from './submission.js';

/** The aspect a request from this draft uses. */
export function requestAspect(draft, refs, models) {
  const base = draft?.edit ? baseDimensions(refs ?? []) : null;
  return base
    ? nearestAspect(base.width, base.height, models?.supported_dimensions)
    : draft.aspect;
}

/** `{ aspect, dimensions }` for a request; dimensions as `WxH` text or null. */
export function requestFraming(draft, refs, models) {
  const aspect = requestAspect(draft, refs, models);
  return { aspect, dimensions: dimensionsFor(models, aspect) };
}

/** Display name of a draft's mode. */
export const draftModeLabel = (draft) =>
  draft?.edit
    ? 'Edit'
    : draft?.mode === 'asset-image'
      ? 'Asset image'
      : 'Image';

/** Display name of a saved result's mode, from the result alone. */
export const recordModeLabel = (record) =>
  recordReferences(record).length || record?.generation_type === 'image-edit'
    ? 'Edit'
    : record?.generation_mode === 'trellis' || record?.mode === 'asset-image'
      ? 'Asset image'
      : 'Image';

/**
 * A saved result's aspect comes from its actual pixels when available, then
 * its stored request aspect. Never the current draft's choice.
 */
export function recordAspect(record, size, supported) {
  if (size) return nearestAspect(size.width, size.height, supported);
  return ASPECT_LABEL[record?.aspect] ? record.aspect : null;
}

export const aspectName = (aspect) => ASPECT_LABEL[aspect] ?? aspect ?? '';
