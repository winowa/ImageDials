/**
 * Random starting values for the standard controls of a new prompt episode.
 * Pure: every function takes the random source, so tests inject their own.
 * Only `value` changes; options, custom options, ids and unknown fields stay.
 */
import {
  GROUP,
  KIND,
  isMultiChoice,
  isSingleChoice,
  optionEntries,
  setValue,
  sliderBounds,
} from './controls.js';

/** Chance the Style control picks Photography (independent of the prompt-match threshold). */
export const PHOTOGRAPHY_PROBABILITY = 0.7;
/** Chance a binary control is switched on. */
export const SELECTED_PROBABILITY = 0.5;
/** Conditional chances for each next choice; the zero caps the draw at six. */
export const MULTI_CONTINUATION_PROBABILITIES = Object.freeze([
  0.5, 0.4, 0.3, 0.2, 0.1, 0,
]);

const isPhotography = (option) =>
  [option.key, option.label].some(
    (text) => String(text).trim().toLowerCase() === 'photography',
  );
const isStyle = (wire) =>
  [wire.id, wire.label].some(
    (text) =>
      String(text ?? '')
        .trim()
        .toLowerCase() === 'style',
  );

const pick = (items, random) =>
  items[Math.min(items.length - 1, Math.floor(random() * items.length))];

/** One initial choice, then a continuation decision before each distinct pick. */
export function sampleMultiOptions(options, random = Math.random, firstKey) {
  if (!options.length) return [];
  const selected = [firstKey ?? pick(options, random).key];
  const remaining = options.filter((option) => option.key !== selected[0]);
  for (const chance of MULTI_CONTINUATION_PROBABILITIES) {
    if (!remaining.length || chance === 0 || random() >= chance) break;
    const next = pick(remaining, random);
    selected.push(next.key);
    remaining.splice(remaining.indexOf(next), 1);
  }
  return selected;
}

function singleChoice(wire, random) {
  const options = optionEntries(wire);
  if (!options.length) return null;
  if (isStyle(wire)) {
    const photography = options.find(isPhotography);
    if (photography) {
      const others = options.filter((o) => o !== photography);
      return !others.length || random() < PHOTOGRAPHY_PROBABILITY
        ? photography.key
        : pick(others, random).key;
    }
  }
  return pick(options, random).key;
}

/** The entry with a freshly sampled value; kinds without a safe sample are unchanged. */
export function randomizeEntry(entry, random = Math.random) {
  const { wire } = entry;
  const multi = isMultiChoice(wire.kind);
  if (isSingleChoice(wire.kind)) {
    const key = singleChoice(wire, random);
    return key === null ? entry : setValue(entry, key);
  }
  if (multi) {
    const options = optionEntries(wire);
    if (!options.length) return entry;
    const selected = sampleMultiOptions(
      options,
      random,
      singleChoice(wire, random),
    );
    return setValue(entry, selected);
  }
  if (wire.kind === KIND.slider) {
    const { min, max, step } = sliderBounds(wire);
    if (![min, max, step].every(Number.isFinite) || step <= 0 || max < min)
      return entry;
    const steps = Math.floor((max - min) / step);
    const value =
      min + step * Math.min(steps, Math.floor(random() * (steps + 1)));
    return setValue(entry, Number(value.toFixed(10)));
  }
  if (wire.kind === KIND.binary && typeof wire.value === 'boolean')
    return setValue(entry, random() < SELECTED_PROBABILITY);
  // Manual text belongs to the previous prompt: a new one starts empty.
  if (wire.kind === KIND.text) return setValue(entry, '');
  // Unknown kinds have no meaningful random value: they stay fixed.
  return entry;
}

/** Randomize the standard (base) entries only; generated ones are never touched. */
export const randomizeStandard = (entries, random = Math.random) =>
  entries.map((entry) =>
    entry.group === GROUP.base ? randomizeEntry(entry, random) : entry,
  );
