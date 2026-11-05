/** Entry-only pending state and the one Standard settlement per text episode. */
import {
  GROUP,
  isMultiChoice,
  isSingleChoice,
  optionEntries,
  setValue,
  validateWire,
} from './controls.js';
import {
  clearPending,
  hasRetentionClaim,
  intentClassOf,
} from './controlIntent.js';
import {
  fallbackRecord,
  isSuggestedOff,
  knownProvenanceOf,
  suggestedRecord,
  withProvenance,
} from './selectionProvenance.js';
import { randomizeStandard, sampleMultiOptions } from './standardRandom.js';

/** Sample only newly admitted, untouched multi defaults, after retention/refusal. */
export function settleGenerated(
  entries,
  previous = [],
  { editing = false, random = Math.random } = {},
) {
  if (editing) return entries;
  const before = new Map(previous.map((entry) => [entry.key, entry]));
  return entries.map((entry) => {
    const provenance = knownProvenanceOf(entry.wire);
    if (
      entry.group !== GROUP.generated ||
      !isMultiChoice(entry.wire.kind) ||
      hasRetentionClaim(entry) ||
      entry.retained ||
      entry.enabled === false ||
      isSuggestedOff(provenance) ||
      (entry.wire.selection_provenance && !provenance)
    )
      return entry;
    const options = optionEntries(entry.wire);
    if (!options.length) return entry;
    const old = before.get(entry.key);
    // Metadata refreshes and compatible option expansion keep the one prior draw.
    const reuse =
      old &&
      !hasRetentionClaim(old) &&
      old.enabled !== false &&
      old.wire.kind === entry.wire.kind &&
      knownProvenanceOf(old.wire)?.source === 'fallback-random' &&
      Array.isArray(old.wire.value) &&
      old.wire.value.length > 0 &&
      old.wire.value.every((key) =>
        options.some((option) => option.key === key),
      );
    const value = reuse
      ? [...old.wire.value]
      : sampleMultiOptions(options, random);
    return {
      ...entry,
      initial: [...value],
      wire: withProvenance({ ...entry.wire, value }, fallbackRecord()),
    };
  });
}

export function pendingStandard(entries) {
  return entries.map((entry) => {
    if (entry.group !== GROUP.base) return entry;
    // Manual off persists; suggested off may be reconsidered next episode.
    if (
      entry.enabled === false &&
      !isSuggestedOff(knownProvenanceOf(entry.wire))
    )
      return clearPending(entry);
    return { ...entry, pending: true };
  });
}

function validSuggestion(entry, value, textFlags) {
  if (value === null) return textFlags;
  const { wire } = entry;
  if (isMultiChoice(wire.kind))
    return (
      Array.isArray(value) &&
      value.length <= 2 &&
      new Set(value).size === value.length &&
      value.every(
        (key) =>
          typeof key === 'string' && Object.hasOwn(wire.options ?? {}, key),
      )
    );
  if (isSingleChoice(wire.kind))
    return (
      typeof value === 'string' && Object.hasOwn(wire.options ?? {}, value)
    );
  return validateWire({ ...wire, value }) === null;
}

export function settleStandard(
  entries,
  { suggestions, anchor, textFlags = false } = {},
) {
  const usable =
    suggestions &&
    typeof suggestions === 'object' &&
    !Array.isArray(suggestions)
      ? suggestions
      : {};
  return entries.map((entry) => {
    if (entry.group !== GROUP.base || !entry.pending) return entry;
    const next = clearPending(entry);
    const id = entry.wire.id;
    const value = usable[id];
    if (Object.hasOwn(usable, id) && validSuggestion(entry, value, textFlags)) {
      const changed = value === null ? next : setValue(next, value);
      return {
        ...changed,
        intentClass: 'automatic',
        explicit: false,
        applyToEdit: undefined,
        enabled: value !== null,
        wire: withProvenance(
          changed.wire,
          suggestedRecord({
            anchor,
            effect: value === null ? 'model-decides' : 'value',
          }),
        ),
      };
    }
    // Delegate to the existing algorithm, including its complete multi distribution.
    const [sampled] = randomizeStandard([next]);
    return {
      ...sampled,
      intentClass: 'automatic',
      explicit: false,
      applyToEdit: undefined,
      enabled: true,
      wire: withProvenance(sampled.wire, fallbackRecord()),
    };
  });
}

/** Automatic provider defaults have durable provenance, never Apply intent. */
export function automaticGenerated(wires, anchor) {
  return wires.map((wire) =>
    Object.hasOwn(wire, 'selection_provenance')
      ? wire
      : withProvenance(wire, suggestedRecord({ anchor })),
  );
}

export const unknownOrigin = (entry) => intentClassOf(entry) === 'legacy';
