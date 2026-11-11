import { beforeEach, expect, test } from 'vitest';

import shared from '../../../../shared/generation-phrases.json';
import {
  createPhraseBag,
  PHRASE_INTERVAL_MS,
  PHRASES,
  resetSharedPhraseBag,
  sharedPhraseBag,
} from './generationPhrases.js';

const draw = (bag, count) => Array.from({ length: count }, () => bag.next());

/** A deterministic generator so a test controls the shuffle. */
const sequence = (values) => {
  let i = 0;
  return () => values[i++ % values.length];
};

beforeEach(() => resetSharedPhraseBag());

test('the shared document supplies 48 distinct lines at 4 seconds', () => {
  expect(PHRASE_INTERVAL_MS).toBe(4000);
  expect(PHRASES).toHaveLength(48);
  expect(new Set(PHRASES).size).toBe(48);
  expect(Math.max(...PHRASES.map((p) => p.length))).toBeLessThanOrEqual(43);
  expect(shared.phrases).toHaveLength(48);
});

test('a cycle shows every line exactly once before any repeats', () => {
  const bag = createPhraseBag();
  const first = draw(bag, 48);
  expect(new Set(first).size).toBe(48);
  expect(new Set(draw(bag, 48)).size).toBe(48);
});

test('a new cycle never starts with the line that ended the last', () => {
  // Random 0 keeps the shuffle in a fixed order that would repeat the boundary.
  const bag = createPhraseBag(['a', 'b', 'c'], () => 0);
  const seen = draw(bag, 3);
  for (let cycle = 0; cycle < 50; cycle += 1) {
    const next = draw(bag, 3);
    expect(next[0]).not.toBe(seen[seen.length - 1]);
    expect(new Set(next).size).toBe(3);
    seen.push(...next);
  }
  for (let i = 1; i < seen.length; i += 1)
    expect(seen[i]).not.toBe(seen[i - 1]);
});

test('the real random source never repeats a line back to back', () => {
  const bag = createPhraseBag();
  const lines = draw(bag, 48 * 20);
  for (let i = 1; i < lines.length; i += 1)
    expect(lines[i]).not.toBe(lines[i - 1]);
});

test('blank, repeated and non-text entries are ignored', () => {
  const bag = createPhraseBag(['x', ' x ', '', null, 4, 'y'], sequence([0.2]));
  expect(bag.size).toBe(2);
  expect(new Set(draw(bag, 2))).toEqual(new Set(['x', 'y']));
});

test('a one-line or empty bag still answers', () => {
  expect(draw(createPhraseBag(['only']), 3)).toEqual(['only', 'only', 'only']);
  expect(createPhraseBag([]).next()).toBe('');
});

test('the shared bag is one object, so variety continues across generations', () => {
  const first = draw(sharedPhraseBag(), 10);
  const second = draw(sharedPhraseBag(), 10);
  expect(sharedPhraseBag()).toBe(sharedPhraseBag());
  expect(new Set([...first, ...second]).size).toBe(20);
});
