/**
 * Lossless retention when generated controls are refreshed (UX07).
 *
 * `planRetention` is pure. It never mutates its inputs and never installs
 * anything: it returns either the complete next entry list or an explicit
 * refusal, and the caller publishes the list (or leaves every piece of state
 * untouched on refusal).
 *
 * Rules, from the endorsed R1-R7 and L1/L2 policies:
 * - Match by stable key within the generated group. Kind is a compatibility
 *   check, never permission for a second key. No renames, no `#2` suffixes.
 * - An entry the person decided (manual) or whose origin is unknown (legacy)
 *   is preserved: with no incoming match it is kept; with a lossless match it
 *   takes the incoming position and keeps its exact value, order, option
 *   objects, custom options, unknown fields, state and provenance; with a
 *   conflicting or lossy match the OLD entry wins unchanged and the incoming
 *   entry is omitted. Untouched automatic entries follow the existing
 *   replacement (`mergeGenerated`). Incoming defaults are never applied to
 *   an edit and never become manual.
 * - Incoming entries come first in provider relevance order, then retained
 *   entries in their previous order; Standard (base) entries stay first.
 * - A retained entry gets an immutable entry-only marker (never on the wire).
 *   A later lossless match removes the marker but keeps the origin class.
 * - The whole candidate (base, generated, retained, disabled, legacy) must fit
 *   the effective limit, or the whole refresh is refused (no truncation).
 */
import {
  cloneJson,
  effectiveControlLimit,
  createEntry,
  GROUP,
  isChoiceKind,
  isKnownKind,
  isMultiChoice,
  isSingleChoice,
  KIND,
  selectedOptionKeys,
  validateWire,
} from './controls.js';
import { hasRetentionClaim } from './controlIntent.js';
import { PROVENANCE_FIELD } from './selectionProvenance.js';

export const REFUSAL = Object.freeze({
  capacity: 'capacity',
  identity: 'identity',
});

const isObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Structural JSON equality that ignores object key order. */
export function sameJson(a, b) {
  if (a === b) return true;
  if (Array.isArray(a))
    return (
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, i) => sameJson(item, b[i]))
    );
  if (!isObject(a) || !isObject(b)) return false;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && sameJson(a[key], b[key]))
  );
}

/** The identity part of a generated key, before the `generated:` prefix. */
export const ownIdentity = (wire) =>
  typeof wire.id === 'string' && wire.id
    ? wire.id
    : `${wire.kind}:${wire.label}`;

/**
 * Why the incoming list cannot be installed under stable identities, or null.
 * Repeated identities and identities that collide with a Standard control are
 * rejected here, before `createEntry` could silently suffix them.
 */
export function incomingIdentityProblem(incomingWires, baseEntries) {
  const taken = new Set(baseEntries.map(({ wire }) => ownIdentity(wire)));
  for (const wire of incomingWires) {
    const own = ownIdentity(wire);
    if (taken.has(own))
      return `The control "${wire.label}" repeats an existing identity.`;
    taken.add(own);
  }
  return null;
}

/**
 * The wire an incoming entry and a preserved entry would share, or null when
 * keeping both meanings is not possible without changing the preserved
 * selection. Exact value (order, null, empty, zero, false), complete option
 * objects, custom options, unknown fields and provenance come from the
 * preserved entry; the incoming entry contributes position and its own
 * descriptive fields. Unknown kinds are never merged.
 */
export function losslessWire(previous, incoming) {
  const old = previous.wire;
  const fresh = incoming.wire;
  const { kind } = old;
  if (kind !== fresh.kind || !isKnownKind(kind)) return null;
  // Unknown fields belong to the preserved wire. Conflicting opaque fields
  // cannot be attributed to a newer response without changing their meaning.
  const understood = new Set([
    'id',
    'kind',
    'label',
    'description',
    'value',
    'options',
    'min',
    'max',
    'step',
    'minLabel',
    'maxLabel',
    'selection_provenance',
  ]);
  for (const key of Object.keys(old)) {
    if (
      !understood.has(key) &&
      Object.hasOwn(fresh, key) &&
      !sameJson(old[key], fresh[key])
    )
      return null;
  }
  const merged = { ...old, ...fresh, value: old.value };
  delete merged[PROVENANCE_FIELD];
  if (Object.hasOwn(old, PROVENANCE_FIELD))
    merged[PROVENANCE_FIELD] = cloneJson(old[PROVENANCE_FIELD]);

  if (isChoiceKind(kind)) {
    const oldOptions = old.options;
    const freshOptions = fresh.options;
    if (
      (oldOptions !== undefined && !isObject(oldOptions)) ||
      (freshOptions !== undefined && !isObject(freshOptions))
    )
      return null;
    if (isMultiChoice(kind)) {
      if (
        !Array.isArray(old.value) ||
        old.value.some((v) => typeof v !== 'string')
      )
        return null;
    } else if (
      isSingleChoice(kind) &&
      old.value !== null &&
      typeof old.value !== 'string'
    )
      return null;
    const options = { ...oldOptions, ...freshOptions };
    for (const key of previous.custom ?? []) {
      const own = oldOptions?.[key];
      if (own === undefined) continue;
      if (Object.hasOwn(options, key)) {
        if (!sameJson(options[key], own)) return null;
      } else options[key] = cloneJson(own);
    }
    for (const key of selectedOptionKeys(old)) {
      if (
        !Object.hasOwn(freshOptions ?? {}, key) &&
        !(previous.custom ?? []).includes(key)
      )
        return null;
      if (!Object.hasOwn(options, key)) return null;
      if (
        oldOptions &&
        Object.hasOwn(oldOptions, key) &&
        !sameJson(oldOptions[key], options[key])
      )
        return null;
    }
    if (freshOptions !== undefined || Object.keys(options).length)
      merged.options = options;
    return merged;
  }
  if (kind === KIND.text) return typeof old.value === 'string' ? merged : null;
  if (kind === KIND.binary)
    return typeof old.value === 'boolean' ? merged : null;
  // Slider: the exact value must stay valid under the incoming bounds.
  return validateWire(merged) === null ? merged : null;
}

const markRetained = (entry, origin) =>
  entry.retained ? entry : { ...entry, retained: Object.freeze({ ...origin }) };

/**
 * Plan the generated list after a refresh.
 * @param {object[]} previous every current entry (base and generated)
 * @param {object[]} incomingWires validated wires, in provider relevance order
 * @param {{limit: number, origin?: {anchor?: string, refs?: string}}} options
 *   `limit` is the effective total limit; `origin` names the set an entry is
 *   first retained from, when it is known (never invented).
 * @returns {{ok: true, entries: object[], retained: string[], dropped: string[]}
 *   | {ok: false, refused: 'capacity', count: number, limit: number}
 *   | {ok: false, refused: 'identity', message: string}}
 */
export function planRetention(previous, incomingWires, { limit, origin = {} }) {
  const base = previous.filter((entry) => entry.group !== GROUP.generated);
  const before = previous.filter((entry) => entry.group === GROUP.generated);
  const problem = incomingIdentityProblem(incomingWires, base);
  if (problem)
    return { ok: false, refused: REFUSAL.identity, message: problem };

  const byKey = new Map(before.map((entry) => [entry.key, entry]));
  const used = new Set(base.map((entry) => entry.key));
  const matched = new Set();
  const retained = [];
  const accepted = incomingWires.map((wire) => {
    const fresh = createEntry(wire, GROUP.generated, used);
    const old = byKey.get(fresh.key);
    if (!old) return fresh;
    matched.add(old.key);
    if (!hasRetentionClaim(old)) return fresh;
    const wireOut = losslessWire(old, fresh);
    if (!wireOut) {
      // The old entry wins; the incoming one is omitted, never renamed.
      retained.push(old.key);
      return null;
    }
    const { retained: _marker, ...rest } = old;
    return { ...rest, wire: wireOut, initial: cloneJson(fresh.initial) };
  });

  const kept = [];
  const dropped = [];
  for (const entry of before) {
    if (matched.has(entry.key) && !retained.includes(entry.key)) continue;
    if (hasRetentionClaim(entry)) {
      kept.push(markRetained(entry, origin));
      if (!retained.includes(entry.key)) retained.push(entry.key);
    } else dropped.push(entry.key);
  }

  const entries = [...base, ...accepted.filter(Boolean), ...kept];
  limit = effectiveControlLimit(limit);
  if (entries.length > limit)
    return {
      ok: false,
      refused: REFUSAL.capacity,
      count: entries.length,
      limit,
    };
  return {
    ok: true,
    entries,
    retained: entries
      .filter((entry) => entry.retained)
      .map((entry) => entry.key),
    dropped,
  };
}

/** The visible notice for a refused refresh (capacity). */
export const capacityMessage = (count, limit) =>
  `Too many controls to refresh options (${count} of ${limit}). Remove controls, then Refresh.`;

/** Message when a draft already over the limit is submitted. */
export const overLimitMessage = (count, limit) =>
  `Too many controls to generate (${count} of ${limit}). Remove controls, then try again.`;
