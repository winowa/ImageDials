import { expect, test } from 'vitest';

import {
  describeValue,
  fixedCategories,
  mergeCategories,
  resetCategory,
  validateCategories,
} from './categories.js';

const generated = (extra = {}) => ({
  id: 'mood',
  label: 'Mood',
  description: '',
  type: 'single',
  origin: 'generated',
  options: [
    { id: 'calm', label: 'Calm' },
    { id: 'tense', label: 'Tense' },
  ],
  value: null,
  ...extra,
});

test('validates every control type and normalizes values', () => {
  const result = validateCategories([
    generated({ value: 'bogus' }),
    generated({ id: 'tags', type: 'multi', value: ['calm', 'nope'] }),
    generated({ id: 'pick', type: 'select', value: 'tense' }),
    {
      id: 'zoom',
      label: 'Zoom',
      type: 'range',
      min: 1,
      max: 5,
      step: 1,
      value: 99,
    },
  ]);
  expect(result.map((c) => c.value)).toEqual([null, ['calm'], 'tense', 5]);
});

test('rejects malformed provider output', () => {
  expect(() => validateCategories(null)).toThrow();
  expect(() =>
    validateCategories([{ id: 'a', label: 'A', type: 'x' }]),
  ).toThrow();
  expect(() =>
    validateCategories([
      { id: 'a', label: 'A', type: 'range', min: 3, max: 1 },
    ]),
  ).toThrow();
  expect(() => validateCategories([generated(), generated()])).toThrow();
});

test('merge keeps valid selections and custom options when options expand', () => {
  const prev = [
    generated({
      value: 'custom:wild',
      options: [
        { id: 'calm', label: 'Calm' },
        { id: 'custom:wild', label: 'Wild' },
      ],
    }),
  ];
  const next = validateCategories([
    generated({
      options: [
        { id: 'calm', label: 'Calm' },
        { id: 'tense', label: 'Tense' },
        { id: 'eerie', label: 'Eerie' },
      ],
    }),
  ]);
  const [merged] = mergeCategories(prev, next);
  expect(merged.value).toBe('custom:wild');
  expect(merged.options.map((o) => o.id)).toEqual([
    'calm',
    'tense',
    'eerie',
    'custom:wild',
  ]);
});

test('merge keeps local fixed controls the provider omitted', () => {
  const prev = fixedCategories('image');
  const merged = mergeCategories(prev, validateCategories([generated()]));
  expect(merged.map((c) => c.id)).toEqual([
    'mood',
    'style',
    'color',
    'lighting',
    'composition',
  ]);
});

test('describes selections by label', () => {
  const [c] = validateCategories([generated({ value: 'tense' })]);
  expect(describeValue(c)).toBe('Tense');
  expect(describeValue({ ...c, value: null })).toBeNull();
});

const optionless = (type, extra = {}) => ({
  id: type,
  label: type,
  type,
  ...extra,
});

test('validates radio, checkbox, text and binary and preserves falsy values', () => {
  const result = validateCategories([
    generated({ id: 'r', type: 'radio', value: 'calm' }),
    generated({ id: 'c', type: 'checkbox', value: ['calm', 'nope'] }),
    optionless('text', { value: 'hi', placeholder: 'Say' }),
    optionless('binary', {
      value: false,
      true_label: 'On',
      false_label: 'Off',
    }),
    optionless('binary', { id: 'b2', value: 'yes' }),
    { id: 'zero', label: 'Z', type: 'range', min: 0, max: 5, value: 0 },
  ]);
  expect(result.map((c) => c.value)).toEqual([
    'calm',
    ['calm'],
    'hi',
    false,
    false,
    0,
  ]);
  expect(result[2].placeholder).toBe('Say');
  expect(describeValue(result[3])).toBe('Off');
  expect(describeValue({ ...result[3], value: true })).toBe('On');
  expect(describeValue(result[4])).toBe('No');
  expect(describeValue(result[5])).toBe('0');
  expect(describeValue({ ...result[2], value: '' })).toBeNull();
  expect(describeValue(result[1])).toBe('Calm');
  expect(() =>
    validateCategories([generated({ type: 'radio', options: null })]),
  ).toThrow();
});

test('merge and reset preserve false, empty and zero', () => {
  const next = validateCategories([
    optionless('binary', { value: true }),
    optionless('text', { id: 't', value: 'x' }),
    { id: 'zero', label: 'Z', type: 'range', min: 0, max: 5, value: 3 },
  ]);
  const prev = [
    { ...next[0], value: false },
    { ...next[1], value: '' },
    { ...next[2], value: 0 },
  ];
  expect(mergeCategories(prev, next).map((c) => c.value)).toEqual([
    false,
    '',
    0,
  ]);
  expect(resetCategory({ ...next[0], value: true }).value).toBe(false);
  expect(resetCategory({ ...next[1], value: 'x' }).value).toBe('');
  expect(resetCategory({ ...next[2], value: 4 }).value).toBe(0);
  expect(
    resetCategory(generated({ type: 'checkbox', value: ['calm'] })).value,
  ).toEqual([]);
});
