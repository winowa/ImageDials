/**
 * The Gallery's image-change effects as data and pure rules.
 *
 * Every animated effect is a CSS animation pair (incoming and outgoing layer).
 * The viewer chooses a set of them, and every chosen effect runs at once on
 * the same image change: each has its own nested ring element (see
 * `TransitionRings`), so transforms, opacity, filters and clips compose rather
 * than replace one another. The durations here are the single source for the
 * CSS (through `--fx-ms`) and for the timer that removes the outgoing layer.
 *
 * A choice is stored as a list of animated ids; the empty list is Instant,
 * which is exclusive: choosing it clears every animation, and choosing an
 * animation clears it.
 */

/** Effect used when nothing valid is stored. */
export const DEFAULT_EFFECT = 'reveal';

/** The effect that swaps at once; also what reduced motion resolves to. */
export const INSTANT_EFFECT = 'instant';

/** Longest and shortest intentional animated effect, in milliseconds. */
export const EFFECT_MIN_MS = 360;
export const EFFECT_MAX_MS = 900;

/**
 * @typedef {object} GalleryEffect
 * @property {string} id stored value and `data-effect`
 * @property {string} label
 * @property {number} durationMs 0 for the instant swap
 * @property {boolean} animated false when nothing moves
 */

/** @type {readonly GalleryEffect[]} */
export const GALLERY_EFFECTS = Object.freeze(
  [
    { id: 'instant', label: 'Instant', durationMs: 0 },
    { id: 'reveal', label: 'Reveal', durationMs: 420 },
    { id: 'fade', label: 'Fade', durationMs: 600 },
    { id: 'zoom', label: 'Zoom', durationMs: 700 },
    { id: 'slide', label: 'Slide', durationMs: 560 },
    { id: 'focus', label: 'Focus', durationMs: 760 },
    { id: 'iris', label: 'Iris', durationMs: 800 },
    { id: 'wipe', label: 'Wipe', durationMs: 640 },
    { id: 'flip', label: 'Flip', durationMs: 900 },
    { id: 'glitch', label: 'Glitch', durationMs: 480 },
  ].map((effect) =>
    Object.freeze({ ...effect, animated: effect.durationMs > 0 }),
  ),
);

export const EFFECT_IDS = Object.freeze(GALLERY_EFFECTS.map((e) => e.id));

const BY_ID = new Map(GALLERY_EFFECTS.map((e) => [e.id, e]));

/** The effect for a stored id, or null. */
export const effectById = (id) => BY_ID.get(id) ?? null;

/** Preference sanitiser: any value that is not a known id falls back. */
export const validEffect = (stored, fallback = DEFAULT_EFFECT) =>
  typeof stored === 'string' && BY_ID.has(stored) ? stored : fallback;

/**
 * The effect that actually runs. Reduced motion turns every moving effect
 * into the instant swap; the stored choice itself is never rewritten.
 * @param {string} id
 * @param {boolean} reducedMotion
 */
export function resolveEffect(id, reducedMotion) {
  if (reducedMotion) return BY_ID.get(INSTANT_EFFECT);
  return BY_ID.get(id) ?? BY_ID.get(DEFAULT_EFFECT);
}

/** Whether the viewer sees a moving effect for `id` (previews use this too). */
export const effectMoves = (id, reducedMotion) =>
  resolveEffect(id, reducedMotion).animated;

// --- Multiple simultaneous effects --------------------------------------------------

/** Choice used when nothing valid is stored. */
export const DEFAULT_EFFECTS = Object.freeze([DEFAULT_EFFECT]);

/** The effects that move, in their canonical (and nesting) order. */
export const ANIMATED_EFFECT_IDS = Object.freeze(
  GALLERY_EFFECTS.filter((e) => e.animated).map((e) => e.id),
);

/** Storage key of the single-effect preference this list replaces. */
export const LEGACY_EFFECT_STORAGE_KEY = 'imagedials-gallery-effect';

const canonical = (ids) => ANIMATED_EFFECT_IDS.filter((id) => ids.includes(id));

/** The choice that a single stored effect id meant, or null. */
export function effectsFromLegacy(stored) {
  if (stored === INSTANT_EFFECT) return [];
  return typeof stored === 'string' && BY_ID.has(stored) ? [stored] : null;
}

/**
 * Preference sanitiser for the list of chosen effects. Unknown ids are dropped
 * and the order is canonical; an explicit Instant (the empty list, or a list
 * holding only `instant`) is kept; anything else unusable falls back.
 */
export function validEffects(stored, fallback = DEFAULT_EFFECTS) {
  if (typeof stored === 'string') return effectsFromLegacy(stored) ?? fallback;
  if (!Array.isArray(stored)) return fallback;
  const strings = stored.filter((id) => typeof id === 'string');
  const kept = canonical(strings);
  if (kept.length) return kept;
  const instant =
    strings.length > 0 && strings.every((id) => id === INSTANT_EFFECT);
  return stored.length === 0 || instant ? [] : fallback;
}

/**
 * The default for a viewer with no stored list: their old single choice when
 * one was saved, else Reveal. Only read, never removed, so an older build
 * opened afterwards still finds it.
 */
export function legacyEffectsFallback(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(LEGACY_EFFECT_STORAGE_KEY);
    if (raw == null) return DEFAULT_EFFECTS;
    return effectsFromLegacy(JSON.parse(raw)) ?? DEFAULT_EFFECTS;
  } catch {
    return DEFAULT_EFFECTS;
  }
}

/**
 * The choice after pressing `id`. Instant clears every animation (and stays
 * chosen when pressed again); an animation toggles and clears Instant.
 * Unchecking the last animation leaves Instant chosen.
 */
export function toggleEffect(ids, id) {
  if (id === INSTANT_EFFECT || !ANIMATED_EFFECT_IDS.includes(id)) return [];
  return canonical(
    ids.includes(id) ? ids.filter((other) => other !== id) : [...ids, id],
  );
}

/** Whether `id` is chosen in the list (Instant is the empty list). */
export const effectChosen = (ids, id) =>
  id === INSTANT_EFFECT ? ids.length === 0 : ids.includes(id);

/** Short name of a choice, e.g. "Instant" or "Fade + Zoom". */
export const effectsLabel = (ids) =>
  ids.length
    ? ids.map((id) => BY_ID.get(id).label).join(' + ')
    : BY_ID.get(INSTANT_EFFECT).label;

/**
 * @typedef {object} GalleryTransition
 * @property {string} id the chosen ids joined by spaces, or `instant`
 * @property {string[]} ids the animated effects that run together
 * @property {number} durationMs the longest of them; 0 for Instant
 * @property {boolean} animated false when nothing moves
 */

/**
 * The transition that actually runs for a choice: every chosen effect starts
 * together, each with its own duration, and the change ends with the longest.
 * Reduced motion resolves to Instant without rewriting the stored choice.
 * @param {string[]} ids
 * @param {boolean} reducedMotion
 * @returns {GalleryTransition}
 */
export function resolveTransition(ids, reducedMotion) {
  const run = reducedMotion ? [] : canonical(ids ?? []);
  return {
    id: run.length ? run.join(' ') : INSTANT_EFFECT,
    ids: run,
    durationMs: Math.max(0, ...run.map((id) => BY_ID.get(id).durationMs)),
    animated: run.length > 0,
  };
}
