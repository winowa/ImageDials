import { expect, test } from 'vitest';

import {
  cleanOverrides,
  FIELDS,
  KIND,
  validateValues,
  valuesFor,
  headerFor,
  loadOverrides,
  overridesFromValues,
  providerIdFor,
  saveOverrides,
  STORAGE_KEY,
  validateField,
} from './providerSettings.js';

const defaults = {
  providers: { LLM_MODEL_ENDPOINT_1: 'https://a.example.invalid/v1' },
  keys_configured: { LLM_MODEL_KEY_1: true },
};
const memory = () => {
  const data = new Map();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => data.set(k, v),
    removeItem: (k) => data.delete(k),
  };
};

test('endpoints must be plain http(s) addresses and values stay single-line', () => {
  expect(
    validateField('LLM_MODEL_ENDPOINT_1', 'https://h.example.invalid/v1'),
  ).toBeNull();
  for (const bad of [
    'h.example',
    'ftp://h.example',
    ['https://u:p', 'h.example'].join('@'),
    'https://h.example/?q=1',
    'https://h.example/#x',
  ])
    expect(validateField('LLM_MODEL_ENDPOINT_1', bad)).toBeTruthy();
  expect(validateField('LLM_MODEL_NAME', 'a\nb')).toBeTruthy();
  expect(validateField('LLM_MODEL_NAME', 'x'.repeat(1025))).toBeTruthy();
  expect(validateField('IMAGE_PROVIDER', 'comfyui')).toBeTruthy();
});

test('only allowlisted valid overrides survive loading, and corrupt storage is ignored', () => {
  expect(
    cleanOverrides({
      LLM_MODEL_NAME: ' m ',
      IMAGE_MODEL_NAME: 'x',
      LLM_MODEL_KEY_1: '',
    }),
  ).toEqual({ LLM_MODEL_NAME: 'm' });
  const storage = memory();
  storage.setItem(STORAGE_KEY, '{not json');
  expect(loadOverrides(storage)).toEqual({ overrides: {}, available: true });
  storage.setItem(
    STORAGE_KEY,
    JSON.stringify({ v: 2, overrides: { LLM_MODEL_NAME: 'm' } }),
  );
  expect(loadOverrides(storage).overrides).toEqual({});
  expect(loadOverrides(null)).toEqual({ overrides: {}, available: false });
  expect(saveOverrides({ LLM_MODEL_NAME: 'm' }, storage)).toBe(true);
  expect(loadOverrides(storage).overrides).toEqual({ LLM_MODEL_NAME: 'm' });
  saveOverrides({}, storage);
  expect(storage.getItem(STORAGE_KEY)).toBeNull();
  expect(saveOverrides({}, null)).toBe(false);
});

test('values equal to the server default are not overrides; keys always are', () => {
  expect(
    overridesFromValues(
      {
        LLM_MODEL_ENDPOINT_1: 'https://a.example.invalid/v1',
        LLM_MODEL_KEY_1: ' k ',
        LLM_MODEL_NAME: '',
      },
      defaults,
    ),
  ).toEqual({ LLM_MODEL_KEY_1: 'k' });
});

test('cache identity separates choices and never contains the key text', () => {
  expect(providerIdFor(null)).toBe('default');
  const a = providerIdFor(headerFor({ LLM_MODEL_KEY_1: 'secret-one' }));
  const b = providerIdFor(headerFor({ LLM_MODEL_KEY_1: 'secret-two' }));
  expect(a).not.toBe(b);
  expect(a).not.toContain('secret');
});

test('same-as keeps separate settings in storage but removes them from requests', () => {
  const stored = {
    IMAGE_EDIT_ROUTE: 'generation',
    IMAGE_EDIT_MODEL_ENDPOINT: 'https://edit.example.invalid',
    IMAGE_EDIT_MODEL_KEY: 'separate-edit-key',
    IMAGE_MODEL_ENDPOINT_1: 'https://generation.example.invalid',
    IMAGE_MODEL_KEY_1: 'generation-key',
  };
  const storage = memory();
  saveOverrides(stored, storage);
  expect(loadOverrides(storage).overrides).toEqual(stored);
  expect(JSON.parse(atob(headerFor(stored)))).toEqual({
    IMAGE_EDIT_ROUTE: 'generation',
    IMAGE_MODEL_ENDPOINT_1: stored.IMAGE_MODEL_ENDPOINT_1,
    IMAGE_MODEL_KEY_1: stored.IMAGE_MODEL_KEY_1,
  });
  const changed = { ...stored, IMAGE_MODEL_KEY_1: 'next-generation-key' };
  expect(JSON.parse(atob(headerFor(changed))).IMAGE_MODEL_KEY_1).toBe(
    'next-generation-key',
  );
  expect(
    JSON.parse(atob(headerFor({ ...stored, IMAGE_EDIT_ROUTE: 'separate' })))
      .IMAGE_EDIT_MODEL_KEY,
  ).toBe('separate-edit-key');
});

test('oversized provider drafts validate before encoding and oversized storage cannot crash requests', () => {
  const values = valuesFor({}, { editing: { route: 'generation' } });
  for (const field of FIELDS)
    values[field.name] =
      field.kind === KIND.endpoint
        ? 'https://provider.example.invalid/' + 'x'.repeat(900)
        : 'x'.repeat(1024);
  values.IMAGE_EDIT_ROUTE = 'separate';
  expect(validateValues(values).LLM_MODEL_NAME).toMatch(/request size limit/);
  expect(cleanOverrides(values)).toEqual({});
  const denied = {
    getItem() {
      throw Error('denied');
    },
  };
  expect(loadOverrides(denied)).toEqual({ overrides: {}, available: false });
});

test('same-as never stores an invalid hidden endpoint containing URL credentials', () => {
  const values = valuesFor({}, {});
  values.IMAGE_EDIT_MODEL_ENDPOINT = [
    'https://synthetic-user:synthetic-password',
    'fixture.invalid',
  ].join('@');
  expect(overridesFromValues(values, {})).toEqual({});
});
