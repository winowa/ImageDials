import { expect, test } from 'vitest';

import {
  isNearAnchor,
  normalizePrompt,
  promptSimilarity,
} from './promptAnchor.js';
import { promptKey } from './submission.js';

test('normalization applies Unicode form, case, edge and repeated whitespace', () => {
  expect(normalizePrompt('  A  Red\n\tFOX ')).toBe('a red fox');
  expect(normalizePrompt('Café')).toBe(normalizePrompt('Café'));
  expect(normalizePrompt(null)).toBe('');
});

test.each([
  ['identical text', 'a red fox', 'a red fox', 1],
  ['case and whitespace only', 'A  red FOX ', ' a red fox', 1],
  ['composed versus combining accent', 'café table', 'café table', 1],
  ['one accent replaced by a letter', 'café', 'cafe', 0.75],
  ['CJK counts characters (4 of 5 kept)', '红色的狐狸', '红色的狐', 0.8],
  [
    'an emoji is one character',
    'fox \u{1f98a}\u{1f98a}',
    'fox \u{1f98a}',
    5 / 6,
  ],
  ['both empty', '  ', '', 1],
  ['nothing shared', 'abcd', 'wxyz', 0],
])('similarity: %s', (_name, a, b, expected) => {
  expect(promptSimilarity(a, b)).toBeCloseTo(expected, 10);
  expect(promptSimilarity(b, a)).toBeCloseTo(expected, 10);
});

test('the longer text is the denominator', () => {
  expect(promptSimilarity('abc', 'abcdefghij')).toBeCloseTo(0.3, 10);
});

test('exactly the minimum ratio starts a new prompt; just above keeps it', () => {
  const anchor = promptKey('abcdefghij', 'image');
  // 2 of 10 edited: similarity 0.8, which is not strictly above 0.8.
  expect(isNearAnchor(anchor, 'abcdefghXY', 'image', 0.8)).toBe(false);
  expect(isNearAnchor(anchor, 'abcdefghiX', 'image', 0.8)).toBe(true);
  // Half of the longer text edited: reset at 0.5.
  expect(isNearAnchor(anchor, 'abcdeXXXXX', 'image', 0.5)).toBe(false);
  expect(isNearAnchor(anchor, 'abcdefXXXX', 'image', 0.5)).toBe(true);
});

test('distance 499 keeps and 500 resets for 999 and 1000 code points', () => {
  for (const length of [999, 1000]) {
    const anchor = promptKey('a'.repeat(length), 'image');
    const edited = (count) => 'b'.repeat(count) + 'a'.repeat(length - count);
    expect(isNearAnchor(anchor, edited(499), 'image', 0.5)).toBe(true);
    expect(isNearAnchor(anchor, edited(500), 'image', 0.5)).toBe(false);
  }
});

test('identical normalized text stays at ratio 1, other edits reset', () => {
  const anchor = promptKey('A  Red Fox', 'image');
  expect(isNearAnchor(anchor, ' a red\tfox ', 'image', 1)).toBe(true);
  expect(isNearAnchor(anchor, 'a red fo', 'image', 1)).toBe(false);
  expect(isNearAnchor(anchor, 'a red fox', 'asset-image', 1)).toBe(false);
});

test('Unicode boundaries count code points, not UTF-16 units', () => {
  const anchor = promptKey('\u{1f98a}\u{1f98a}\u{1f98a}\u{1f98a}', 'image');
  expect(isNearAnchor(anchor, '\u{1f98a}\u{1f98a}xx', 'image', 0.5)).toBe(
    false,
  );
  expect(
    isNearAnchor(anchor, '\u{1f98a}\u{1f98a}\u{1f98a}x', 'image', 0.5),
  ).toBe(true);
});

test('a 4000 code point prompt is measured quickly', () => {
  const long = 'abcdefghij'.repeat(400);
  const anchor = promptKey(long, 'image');
  const edited = long.slice(0, 1000) + 'z'.repeat(1900) + long.slice(2900);
  const started = performance.now();
  expect(isNearAnchor(anchor, edited, 'image', 0.5)).toBe(true);
  expect(performance.now() - started).toBeLessThan(2000);
});

test('edits are always measured from the original anchor, not the last edit', () => {
  const anchor = promptKey('a quiet harbour at dawn', 'image');
  // Each step differs from the previous one by only a few characters...
  const steps = [
    'a quiet harbour at dusk',
    'a quiet harbor at dusk',
    'a calm harbor at dusk',
    'a calm lake at dusk',
    'a calm lake at noon',
  ];
  const near = steps.map((text) => isNearAnchor(anchor, text, 'image', 0.7));
  // ...but the drift accumulates against the anchor.
  expect(near[0]).toBe(true);
  expect(near.at(-1)).toBe(false);
});

test('a different mode or a malformed anchor never matches', () => {
  expect(isNearAnchor(promptKey('x', 'image'), 'x', 'asset-image', 0.7)).toBe(
    false,
  );
  expect(isNearAnchor(null, 'x', 'image', 0.7)).toBe(false);
  expect(isNearAnchor('no separator', 'x', 'image', 0.7)).toBe(false);
});
