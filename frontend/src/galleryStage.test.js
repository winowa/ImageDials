import { expect, test } from 'vitest';

import { resolveEffect } from './galleryEffects.js';
import {
  createStage,
  isTransitioning,
  LAYER_ROLE,
  readyStage,
  retargetStage,
  settleStage,
  stageLayers,
  visibleEntry,
} from './galleryStage.js';

const entry = (key) => ({ key, record: { key } });
const FADE = resolveEffect('fade', false);
const INSTANT = resolveEffect('fade', true);
const roles = (state) =>
  stageLayers(state).map(({ entry: e, role }) => `${e.key}:${role}`);

/** A stage that has settled on `key`. */
const settledOn = (key) =>
  readyStage(retargetStage(createStage(), entry(key)), key, FADE);

test('the first picture appears without an effect once it has loaded', () => {
  let state = retargetStage(createStage(), entry('a'));
  expect(roles(state)).toEqual(['a:loading']);
  expect(visibleEntry(state)).toBeNull();
  state = readyStage(state, 'a', FADE);
  expect(roles(state)).toEqual(['a:shown']);
  expect(isTransitioning(state)).toBe(false);
});

test('the old picture stays until the replacement is ready', () => {
  let state = retargetStage(settledOn('a'), entry('b'));
  expect(roles(state)).toEqual(['b:loading', 'a:shown']);
  expect(visibleEntry(state).key).toBe('a');
  state = readyStage(state, 'b', FADE);
  expect(roles(state)).toEqual(['b:entering', 'a:exiting']);
  expect(visibleEntry(state).key).toBe('b');
  expect(state.effect).toBe(FADE);
  state = settleStage(state);
  expect(roles(state)).toEqual(['b:shown']);
});

test('a late load of an abandoned replacement changes nothing', () => {
  let state = retargetStage(settledOn('a'), entry('b'));
  state = retargetStage(state, entry('c'));
  expect(roles(state)).toEqual(['c:loading', 'a:shown']);
  expect(readyStage(state, 'b', FADE)).toBe(state);
  // Going back to the shown picture drops the replacement.
  expect(roles(retargetStage(state, entry('a')))).toEqual(['a:shown']);
});

test('a new target settles a running effect at once', () => {
  let state = readyStage(retargetStage(settledOn('a'), entry('b')), 'b', FADE);
  state = retargetStage(state, entry('c'));
  expect(roles(state)).toEqual(['c:loading', 'b:shown']);
  expect(isTransitioning(state)).toBe(false);
  expect(state.outgoing).toBeNull();
});

test('re-rendering the target mid-effect does not end the effect', () => {
  const b = entry('b');
  const running = readyStage(retargetStage(settledOn('a'), b), 'b', FADE);
  expect(retargetStage(running, b)).toBe(running);
  const refreshed = retargetStage(running, {
    key: 'b',
    record: { key: 'b', title: 'new' },
  });
  expect(isTransitioning(refreshed)).toBe(true);
  expect(refreshed.incoming.record.title).toBe('new');
});

test('a ready load during an effect, or an instant effect, swaps without layers', () => {
  const loading = retargetStage(settledOn('a'), entry('b'));
  expect(roles(readyStage(loading, 'b', INSTANT))).toEqual(['b:shown']);
  const running = readyStage(loading, 'b', FADE);
  expect(readyStage(running, 'b', FADE)).toBe(running);
});

test('nothing to show clears every layer', () => {
  const running = readyStage(
    retargetStage(settledOn('a'), entry('b')),
    'b',
    FADE,
  );
  expect(stageLayers(retargetStage(running, null))).toEqual([]);
});

test('a refreshed record of the shown picture is adopted without a transition', () => {
  const state = settledOn('a');
  const next = retargetStage(state, { key: 'a', record: { key: 'a', x: 1 } });
  expect(roles(next)).toEqual(['a:shown']);
  expect(next.shown.record.x).toBe(1);
  expect(LAYER_ROLE.SHOWN).toBe('shown');
});
