import { expect, test } from 'vitest';

import {
  ANIMATED_EFFECT_IDS,
  DEFAULT_EFFECT,
  DEFAULT_EFFECTS,
  effectChosen,
  effectsFromLegacy,
  effectsLabel,
  legacyEffectsFallback,
  LEGACY_EFFECT_STORAGE_KEY,
  resolveTransition,
  toggleEffect,
  validEffects,
  EFFECT_IDS,
  EFFECT_MAX_MS,
  EFFECT_MIN_MS,
  effectMoves,
  GALLERY_EFFECTS,
  INSTANT_EFFECT,
  resolveEffect,
  validEffect,
} from './galleryEffects.js';

test('there are ten distinct effects with intentional durations', () => {
  expect(EFFECT_IDS).toEqual([
    'instant',
    'reveal',
    'fade',
    'zoom',
    'slide',
    'focus',
    'iris',
    'wipe',
    'flip',
    'glitch',
  ]);
  expect(new Set(EFFECT_IDS).size).toBe(10);
  expect(new Set(GALLERY_EFFECTS.map((e) => e.label)).size).toBe(10);
  for (const effect of GALLERY_EFFECTS) {
    if (effect.id === INSTANT_EFFECT) {
      expect(effect.durationMs).toBe(0);
      expect(effect.animated).toBe(false);
    } else {
      expect(effect.animated).toBe(true);
      expect(effect.durationMs).toBeGreaterThanOrEqual(EFFECT_MIN_MS);
      expect(effect.durationMs).toBeLessThanOrEqual(EFFECT_MAX_MS);
    }
  }
});

test('only a known stored effect is kept', () => {
  expect(validEffect('wipe')).toBe('wipe');
  for (const bad of [null, undefined, 3, {}, [], '', 'WIPE', 'spin'])
    expect(validEffect(bad)).toBe(DEFAULT_EFFECT);
  expect(validEffect('nope', 'fade')).toBe('fade');
});

test('reduced motion resolves every effect to the instant swap', () => {
  for (const id of EFFECT_IDS) {
    expect(resolveEffect(id, true).id).toBe(INSTANT_EFFECT);
    expect(effectMoves(id, true)).toBe(false);
    expect(resolveEffect(id, false).id).toBe(id);
  }
  expect(resolveEffect('unknown', false).id).toBe(DEFAULT_EFFECT);
  expect(effectMoves('instant', false)).toBe(false);
  expect(effectMoves('flip', false)).toBe(true);
});

test('a stored list keeps known animations in canonical order and keeps Instant', () => {
  expect(validEffects(['zoom', 'fade', 'zoom', 'spin', 3])).toEqual([
    'fade',
    'zoom',
  ]);
  expect(validEffects([])).toEqual([]);
  expect(validEffects(['instant'])).toEqual([]);
  expect(validEffects(['instant', 'wipe'])).toEqual(['wipe']);
  for (const bad of [null, undefined, 3, {}, ['spin'], [7], 'spin'])
    expect(validEffects(bad)).toBe(DEFAULT_EFFECTS);
  // An older single id is understood as well.
  expect(validEffects('glitch')).toEqual(['glitch']);
  expect(validEffects('instant')).toEqual([]);
});

test('the older single preference seeds the list without being removed', () => {
  const storage = (raw) => ({
    getItem: (key) => (key === LEGACY_EFFECT_STORAGE_KEY ? raw : null),
  });
  expect(legacyEffectsFallback(storage('"flip"'))).toEqual(['flip']);
  expect(legacyEffectsFallback(storage('"instant"'))).toEqual([]);
  for (const raw of [null, 'not json', '"spin"', '7'])
    expect(legacyEffectsFallback(storage(raw))).toBe(DEFAULT_EFFECTS);
  const throwing = {
    getItem() {
      throw new Error('blocked');
    },
  };
  expect(legacyEffectsFallback(throwing)).toBe(DEFAULT_EFFECTS);
  expect(effectsFromLegacy('nope')).toBeNull();
});

test('Instant is exclusive, animations combine, and the last one unchecked is Instant', () => {
  expect(toggleEffect(['fade', 'zoom'], 'instant')).toEqual([]);
  expect(toggleEffect([], 'instant')).toEqual([]);
  expect(toggleEffect([], 'wipe')).toEqual(['wipe']);
  expect(toggleEffect(['wipe'], 'fade')).toEqual(['fade', 'wipe']);
  expect(toggleEffect(['fade', 'wipe'], 'fade')).toEqual(['wipe']);
  expect(toggleEffect(['wipe'], 'wipe')).toEqual([]);
  expect(toggleEffect(['wipe'], 'unknown')).toEqual([]);
  expect(effectChosen([], 'instant')).toBe(true);
  expect(effectChosen(['fade'], 'instant')).toBe(false);
  expect(effectChosen(['fade'], 'fade')).toBe(true);
  expect(effectsLabel([])).toBe('Instant');
  expect(effectsLabel(['fade', 'iris'])).toBe('Fade + Iris');
});

test('a transition runs every chosen effect at once for the longest duration', () => {
  const all = resolveTransition(ANIMATED_EFFECT_IDS, false);
  expect(all.ids).toEqual(ANIMATED_EFFECT_IDS);
  expect(all.durationMs).toBe(EFFECT_MAX_MS);
  expect(all.animated).toBe(true);
  expect(resolveTransition(['iris', 'fade'], false)).toEqual({
    id: 'fade iris',
    ids: ['fade', 'iris'],
    durationMs: 800,
    animated: true,
  });
  for (const ids of [[], ['fade', 'zoom']])
    expect(resolveTransition(ids, ids.length === 0 ? false : true)).toEqual({
      id: INSTANT_EFFECT,
      ids: [],
      durationMs: 0,
      animated: false,
    });
});
