import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { createCacheStore } from './cacheStore.js';
import { DEFAULT_CLIENT_POLICY } from './clientPolicy.js';
import { memoryDb } from './cacheTestSupport.js';
import {
  CONTENT_STORAGE_KEY,
  contentBody,
  loadContent,
  sameContent,
  saveContent,
  useLocalWatermark,
} from './localWatermark.js';
import { fixtures, installApi, respond } from './testSupport.js';

const { browserSettings } = fixtures;
const VALIDATE = 'POST /api/browser-settings/watermark/validate';
const DEFAULTS = 'GET /api/browser-settings/defaults';
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1z"/></svg>';

const normalized = (body) => ({
  ...browserSettings.local_watermark,
  ...body,
  fingerprint: `fp-${JSON.stringify(body)}`,
});

let api;
let db;
let store;
beforeEach(() => {
  localStorage.clear();
  db = memoryDb();
  store = createCacheStore(db, DEFAULT_CLIENT_POLICY.cache);
  api = installApi({ [VALIDATE]: (body) => normalized(body) });
});
afterEach(() => vi.unstubAllGlobals());

const mount = (options = {}) =>
  renderHook(() => useLocalWatermark({ store, ready: true, ...options }));

test('with no stored choice the server defaults apply, and nothing is stored', async () => {
  const { result } = mount();
  await waitFor(() => expect(result.current.phase).toBe('ready'));
  expect(result.current.settings).toEqual(browserSettings.defaults.watermark);
  expect(result.current.custom).toBe(false);
  expect(localStorage.getItem(CONTENT_STORAGE_KEY)).toBeNull();
  expect(api.called(VALIDATE)).toHaveLength(0);
});

test('saving validates through the browser route, keeps only the content and never writes the shared settings', async () => {
  const { result } = mount();
  await waitFor(() => expect(result.current.phase).toBe('ready'));
  let outcome;
  await act(async () => {
    outcome = await result.current.save({ type: 'text', text: 'Mine' });
  });
  expect(outcome).toEqual({ persisted: true });
  expect(result.current.custom).toBe(true);
  expect(result.current.settings.text).toBe('Mine');
  // Only the choice is stored: no fingerprint, limits or rendering policy.
  expect(JSON.parse(localStorage.getItem(CONTENT_STORAGE_KEY))).toEqual({
    v: 1,
    type: 'text',
    text: 'Mine',
  });
  expect(api.calls.some((c) => c.key.startsWith('PUT'))).toBe(false);
  expect(api.calls.some((c) => c.key.includes('/api/watermark/settings'))).toBe(
    false,
  );
});

test('a rejected value is not kept and the previous choice stays', async () => {
  const { result } = mount();
  await waitFor(() => expect(result.current.phase).toBe('ready'));
  api.routes[VALIDATE] = () => respond(400, { detail: 'Too many lines' });
  await act(async () => {
    await expect(
      result.current.save({ type: 'text', text: 'a\nb\nc\nd\ne' }),
    ).rejects.toThrow('Too many lines');
  });
  expect(result.current.custom).toBe(false);
  expect(localStorage.getItem(CONTENT_STORAGE_KEY)).toBeNull();
});

test('reset removes the choice and uses freshly fetched defaults', async () => {
  const { result } = mount();
  await waitFor(() => expect(result.current.phase).toBe('ready'));
  await act(async () => {
    await result.current.save({ type: 'text', text: 'Mine' });
  });
  const changed = {
    ...browserSettings.defaults,
    watermark: { ...browserSettings.defaults.watermark, text: 'New default' },
  };
  api.routes[DEFAULTS] = () => changed;
  await act(async () => {
    await result.current.reset();
  });
  expect(result.current.custom).toBe(false);
  expect(result.current.settings.text).toBe('New default');
  expect(localStorage.getItem(CONTENT_STORAGE_KEY)).toBeNull();
});

test('SVG markup lives in the cache database, not LocalStorage, and survives a reload', async () => {
  const first = mount();
  await waitFor(() => expect(first.result.current.phase).toBe('ready'));
  await act(async () => {
    await first.result.current.save({
      type: 'svg',
      svg_markup: SVG,
      svg_recolor: false,
    });
  });
  expect(localStorage.getItem(CONTENT_STORAGE_KEY)).not.toContain('<svg');
  expect(db.data.get('settings').get('watermark-svg')).toBe(SVG);
  first.unmount();

  const second = mount();
  await waitFor(() => expect(second.result.current.phase).toBe('ready'));
  expect(second.result.current.override).toEqual({
    type: 'svg',
    svg_markup: SVG,
    svg_recolor: false,
  });
  expect(second.result.current.custom).toBe(true);
});

test('two browsers keep independent choices; the server text is untouched', async () => {
  const other = { db: memoryDb(), storage: new Map() };
  const otherStore = createCacheStore(other.db, DEFAULT_CLIENT_POLICY.cache);
  const a = mount();
  await waitFor(() => expect(a.result.current.phase).toBe('ready'));
  await act(async () => {
    await a.result.current.save({ type: 'text', text: 'Browser A' });
  });
  // A second browser has its own LocalStorage and database.
  const saved = localStorage.getItem(CONTENT_STORAGE_KEY);
  localStorage.clear();
  const b = renderHook(() =>
    useLocalWatermark({ store: otherStore, ready: true }),
  );
  await waitFor(() => expect(b.result.current.phase).toBe('ready'));
  expect(b.result.current.custom).toBe(false);
  expect(b.result.current.settings.text).toBe(
    browserSettings.defaults.watermark.text,
  );
  localStorage.setItem(CONTENT_STORAGE_KEY, saved);
  expect(a.result.current.settings.text).toBe('Browser A');
});

test('stored content the server now rejects is reported and the defaults apply', async () => {
  localStorage.setItem(
    CONTENT_STORAGE_KEY,
    JSON.stringify({ v: 1, type: 'text', text: 'Old' }),
  );
  api.routes[VALIDATE] = () => respond(400, { detail: 'No longer valid' });
  const { result } = mount();
  await waitFor(() => expect(result.current.phase).toBe('ready'));
  expect(result.current.invalid).toBe('No longer valid');
  expect(result.current.settings).toEqual(browserSettings.defaults.watermark);
  // The stored choice is kept for the person to fix, not silently deleted.
  expect(localStorage.getItem(CONTENT_STORAGE_KEY)).not.toBeNull();
});

test('refresh revalidates the stored choice against the current policy and shares one exchange', async () => {
  localStorage.setItem(
    CONTENT_STORAGE_KEY,
    JSON.stringify({ v: 1, type: 'text', text: 'Mine' }),
  );
  const { result } = mount();
  await waitFor(() => expect(result.current.phase).toBe('ready'));
  const before = api.called(VALIDATE).length;
  const policy = {
    ...browserSettings.local_watermark,
    rendering: {
      ...browserSettings.local_watermark.rendering,
      sizeFraction: 0.3,
    },
  };
  api.routes[VALIDATE] = (body) => ({ ...policy, ...body, fingerprint: 'fp2' });
  const [one, two] = await Promise.all([
    result.current.refresh(),
    result.current.refresh(),
  ]);
  expect(api.called(VALIDATE)).toHaveLength(before + 1);
  expect(one).toBe(two);
  expect(one.rendering.sizeFraction).toBe(0.3);
  await waitFor(() =>
    expect(result.current.settings.rendering.sizeFraction).toBe(0.3),
  );
});

test('denied storage keeps the choice for this page and says it was not stored', async () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('full', 'QuotaExceededError');
  });
  const { result } = mount();
  await waitFor(() => expect(result.current.phase).toBe('ready'));
  let outcome;
  await act(async () => {
    outcome = await result.current.save({ type: 'text', text: 'Page only' });
  });
  expect(outcome).toEqual({ persisted: false });
  expect(result.current.settings.text).toBe('Page only');
  expect(result.current.persisted).toBe(false);
  vi.restoreAllMocks();
});

test('an SVG that cannot be stored is not left half-saved', async () => {
  const noDb = createCacheStore(null, DEFAULT_CLIENT_POLICY.cache);
  const outcome = await saveContent(
    { type: 'svg', svg_markup: SVG, svg_recolor: true },
    { settings: noDb.local },
  );
  // Memory-only: this page keeps it, a reload does not.
  expect(outcome.persisted).toBe(false);
  expect(localStorage.getItem(CONTENT_STORAGE_KEY)).toBeNull();
});

test('corrupt, future-version or oversized stored entries are ignored', async () => {
  for (const entry of [
    'not json',
    JSON.stringify({ v: 2, type: 'text', text: 'x' }),
    JSON.stringify({ v: 1, type: 'text', text: 'x'.repeat(5000) }),
    JSON.stringify({ v: 1, type: 'svg' }),
  ]) {
    localStorage.setItem(CONTENT_STORAGE_KEY, entry);
    expect((await loadContent({ settings: store.local })).body).toBeNull();
  }
});

test('content comparison ignores the server-added fields', () => {
  expect(
    sameContent(
      { type: 'text', text: 'a', fingerprint: 'x' },
      { type: 'text', text: 'a', limits: {} },
    ),
  ).toBe(true);
  expect(contentBody({ type: 'svg', svg_markup: SVG })).toEqual({
    type: 'svg',
    svg_markup: SVG,
    svg_recolor: true,
  });
});
