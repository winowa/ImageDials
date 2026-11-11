/**
 * Who decided a generated or standard control's current state.
 *
 * Entry-only fields (never sent; they live in snapshots):
 * - `intentClass`: `'manual'` | `'automatic'` | `'legacy'`.
 *   - `manual`: a person's own change this session, or a saved record that
 *     carries a known `explicit` wire provenance.
 *   - `automatic`: client-created from a provider response, a suggestion or a
 *     random fallback, untouched since. Replaceable even when off or when its
 *     edit flag serializes as false.
 *   - `legacy`: restored from a saved record with no authoritative
 *     provenance. A boolean Apply/Keep flag or an off switch never proves a
 *     click, so such an entry is preserved like intent but never labelled as
 *     chosen by the person.
 *   A missing field reads as `manual` for `explicit: true` or custom options
 *   (older evidence) and `automatic` otherwise.
 * - `pending`: a Standard value waiting for its one episode settlement.
 * - `retained`: `{ anchor?, refs? }`, the set an entry was kept from when a
 *   refresh no longer offered it. Immutable; only a lossless match removes it.
 */
import {
  explicitRecord,
  isSuggestedOff,
  knownProvenanceOf,
  provenanceOf,
  SOURCE,
  withProvenance,
} from './selectionProvenance.js';

export const INTENT = Object.freeze({
  manual: 'manual',
  automatic: 'automatic',
  legacy: 'legacy',
});

export function intentClassOf(entry) {
  if (
    entry?.explicit === true ||
    entry?.custom?.length ||
    knownProvenanceOf(entry?.wire)?.source === SOURCE.explicit
  )
    return INTENT.manual;
  const own = entry?.intentClass;
  if (
    own === INTENT.manual ||
    own === INTENT.automatic ||
    own === INTENT.legacy
  )
    return own;
  return entry?.explicit === true || entry?.custom?.length
    ? INTENT.manual
    : INTENT.automatic;
}

/** Whether a refresh must preserve the entry (manual intent or legacy state). */
export const hasRetentionClaim = (entry) =>
  intentClassOf(entry) !== INTENT.automatic;

/** True only for state a person or a known explicit record established. */
export const isManualIntent = (entry) => intentClassOf(entry) === INTENT.manual;

/**
 * The entry after a person's own change: manual, no longer pending, and its
 * wire provenance explicit (earlier evidence is kept; see `explicitRecord`).
 * Pure; apply it inside the one synchronous entries owner.
 */
export function markIntent(entry) {
  const { pending: _pending, ...rest } = entry;
  const before = provenanceOf(entry.wire);
  const record = explicitRecord(before);
  return {
    ...rest,
    intentClass: INTENT.manual,
    wire:
      before && JSON.stringify(before) === JSON.stringify(record)
        ? entry.wire
        : withProvenance(entry.wire, record),
  };
}

/** The entry with its pending mark removed (no other change). */
export function clearPending(entry) {
  if (!entry.pending) return entry;
  const { pending: _pending, ...rest } = entry;
  return rest;
}

/** Whether a Standard entry is waiting for its episode settlement. */
export const isPending = (entry) => entry?.pending === true;

/**
 * One state per Standard control for a summary: `pending`, `manual`,
 * `suggested`, `suggested-off` (turned off by a suggested null), `disabled`
 * (turned off by a person or unknown origin), `fallback` or `unseeded`.
 */
export function standardStatus(entry) {
  if (isPending(entry)) return 'pending';
  const record = knownProvenanceOf(entry.wire);
  if (entry.enabled === false)
    return isSuggestedOff(record) ? 'suggested-off' : 'disabled';
  if (isManualIntent(entry)) return 'manual';
  if (!record) return 'unseeded';
  if (record.source === SOURCE.explicit) return 'manual';
  return record.source === SOURCE.suggested ? 'suggested' : 'fallback';
}

/** Counts of each `standardStatus` over the Standard (base) entries. */
export function standardSummary(entries) {
  const summary = {
    total: 0,
    pending: 0,
    manual: 0,
    suggested: 0,
    suggestedOff: 0,
    disabled: 0,
    fallback: 0,
    unseeded: 0,
  };
  for (const entry of entries) {
    if (entry.group !== 'base') continue;
    summary.total += 1;
    const status = standardStatus(entry);
    const key = status === 'suggested-off' ? 'suggestedOff' : status;
    summary[key] += 1;
  }
  return summary;
}
