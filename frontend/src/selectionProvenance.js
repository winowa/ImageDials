/**
 * The per-control `selection_provenance` wire record (backend contract v1).
 *
 * It is an optional property of ONE wire control. The server validates a
 * version-1 record strictly (400 on a malformed one), stores it unchanged and
 * never forwards it to prompt composition. This module only ever builds
 * records of the exact documented shape, and never invents a source for
 * state it cannot vouch for: an absent record stays absent.
 *
 *   { version: 1,
 *     source: 'suggested' | 'explicit' | 'fallback-random',
 *     anchor?: [A-Za-z0-9._:-]{1,64},
 *     effect?: 'value' | 'model-decides' }   // effect: source 'suggested' only
 */

export const PROVENANCE_FIELD = 'selection_provenance';
export const PROVENANCE_VERSION = 1;
export const SOURCE = Object.freeze({
  suggested: 'suggested',
  explicit: 'explicit',
  fallback: 'fallback-random',
});
export const EFFECT = Object.freeze({
  value: 'value',
  modelDecides: 'model-decides',
});

const SOURCES = new Set(Object.values(SOURCE));
const EFFECTS = new Set(Object.values(EFFECT));
const ANCHOR = /^[A-Za-z0-9._:-]{1,64}$/;

const isObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** A well-formed anchor (the dynamic response's `suggestion_anchor`). */
export const validAnchor = (anchor) =>
  typeof anchor === 'string' && ANCHOR.test(anchor);

/**
 * Why `record` is not a valid record, or null. Mirrors the server: a
 * non-object or versionless record is invalid, a malformed version 1 is
 * invalid, and any other positive integer version is valid but opaque.
 */
export function provenanceProblem(record) {
  if (!isObject(record)) return 'is not an object';
  const { version } = record;
  if (!Number.isInteger(version) || version < 1)
    return 'needs a positive integer version';
  if (version !== PROVENANCE_VERSION) return null;
  if (!SOURCES.has(record.source)) return 'has an unsupported source';
  if (record.anchor !== undefined && !validAnchor(record.anchor))
    return 'has an invalid anchor';
  if (
    record.effect !== undefined &&
    (!EFFECTS.has(record.effect) || record.source !== SOURCE.suggested)
  )
    return 'has an invalid effect';
  return null;
}

/** A valid record of the version this client understands. */
export const isKnownProvenance = (record) =>
  isObject(record) &&
  record.version === PROVENANCE_VERSION &&
  provenanceProblem(record) === null;

/** The record on a wire control, or null when absent. */
export const provenanceOf = (wire) =>
  isObject(wire) && isObject(wire[PROVENANCE_FIELD])
    ? wire[PROVENANCE_FIELD]
    : null;

/** A known record on the wire, or null (absent, malformed or future). */
export const knownProvenanceOf = (wire) => {
  const record = provenanceOf(wire);
  return isKnownProvenance(record) ? record : null;
};

/** The wire with `record` set; the input is never mutated. */
export function withProvenance(wire, record) {
  const before = provenanceOf(wire);
  if (before?.version > PROVENANCE_VERSION)
    return { ...wire, [PROVENANCE_FIELD]: before };
  const {
    version: _version,
    source: _source,
    anchor: _anchor,
    effect: _effect,
    ...extra
  } = before ?? {};
  return { ...wire, [PROVENANCE_FIELD]: { ...extra, ...record } };
}

/** The wire without any record. */
export function withoutProvenance(wire) {
  if (!Object.hasOwn(wire, PROVENANCE_FIELD)) return wire;
  const { [PROVENANCE_FIELD]: _dropped, ...rest } = wire;
  return rest;
}

/** A model-suggested value (`value`) or a suggested "let the model decide". */
export const suggestedRecord = ({ anchor, effect = EFFECT.value } = {}) => ({
  version: PROVENANCE_VERSION,
  source: SOURCE.suggested,
  ...(validAnchor(anchor) ? { anchor } : {}),
  effect,
});

/** A value from the random fallback; it has no anchor. */
export const fallbackRecord = () => ({
  version: PROVENANCE_VERSION,
  source: SOURCE.fallback,
});

/**
 * The record after a person's own change. A known earlier record keeps its
 * extra keys and, when it overrode a suggestion or explicit choice, its
 * anchor; the effect is dropped (it is valid only on a suggestion). A record
 * of a future version is opaque and is returned unchanged, so nothing it
 * carries is lost; an absent or malformed one becomes the minimal record.
 */
export function explicitRecord(previous) {
  if (isObject(previous) && Number.isInteger(previous.version)) {
    if (previous.version > PROVENANCE_VERSION) return previous;
    if (isKnownProvenance(previous)) {
      const {
        version: _v,
        source,
        anchor,
        effect: _effect,
        ...extra
      } = previous;
      return {
        version: PROVENANCE_VERSION,
        source: SOURCE.explicit,
        ...(source !== SOURCE.fallback && validAnchor(anchor)
          ? { anchor }
          : {}),
        ...extra,
      };
    }
  }
  return { version: PROVENANCE_VERSION, source: SOURCE.explicit };
}

/** Whether a known record says the control was disabled by a suggested null. */
export const isSuggestedOff = (record) =>
  record?.source === SOURCE.suggested && record.effect === EFFECT.modelDecides;

/**
 * Origin class a saved wire proves, never more:
 * - `manual`: a known explicit record;
 * - `automatic`: a known suggested or fallback-random record;
 * - `legacy`: anything else (absent, malformed, future). Booleans such as
 *   `apply_to_edit` or `apply_to_generation` never decide this.
 */
export function originClassOf(wire) {
  const record = knownProvenanceOf(wire);
  if (!record) return 'legacy';
  return record.source === SOURCE.explicit ? 'manual' : 'automatic';
}
