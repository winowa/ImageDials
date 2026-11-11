import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import App from '../../src/app/App.jsx';
import { DEFAULT_CLIENT_POLICY } from '../../src/data/api/clientPolicy.js';
import { createCacheStore } from '../../src/data/storage/cacheStore.js';
import { imageBlob, memoryDb } from '../helpers/cacheTestSupport.js';
import {
  completeStatus,
  FakeEventSource,
  fixtures,
  installApi,
} from '../helpers/testSupport.js';

const cacheHarness = vi.hoisted(() => ({ store: null, ready: true }));
vi.mock('../../src/data/storage/useCacheStore.js', () => ({
  useCacheStore: () => cacheHarness,
}));

const jobPolicy = { pollIntervalMs: 1, maxConsecutivePollFailures: 3 };
let nextUrl;

beforeEach(async () => {
  localStorage.clear();
  localStorage.setItem('imagedials-gallery-effect', '"fade"');
  localStorage.setItem('imagedials-gallery-playing', 'true');
  window.history.replaceState(null, '', '/gallery');
  FakeEventSource.reset();
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'Date',
    ],
  });
  nextUrl = 0;
  URL.createObjectURL = vi.fn(() => `blob:legacy-${++nextUrl}`);
  URL.revokeObjectURL = vi.fn();
  const db = memoryDb();
  cacheHarness.store = createCacheStore(db, DEFAULT_CLIENT_POLICY.cache);
  cacheHarness.ready = true;
  const source = completeStatus().result;
  for (const [index, id] of ['legacy-a', 'legacy-b', 'legacy-c'].entries()) {
    const record = {
      ...source,
      id,
      image_id: id,
      title: `Image ${id}`,
      visibility: 'private',
      storage_id: 'legacy-private',
      filename: `${id}.png`,
      dimensions: { width: 1152, height: 768 },
      sha256: undefined,
    };
    await cacheHarness.store.admitPrivate({
      record,
      origin: 'generated',
      addedAt: index + 1,
      full: imageBlob(20, 'image/png'),
      thumbnail: imageBlob(10, 'image/png'),
    });
  }
  installApi({
    'GET /api/app-capabilities': () => fixtures.m1.capabilities_private,
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const flush = () =>
  act(async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  });
const loadLayer = (alt) => {
  const image = [...document.querySelectorAll('.gallery-stage img')].find(
    (item) => item.alt === alt,
  );
  expect(image).toBeTruthy();
  Object.defineProperties(image, {
    complete: { value: true, configurable: true },
    naturalWidth: { value: 1152, configurable: true },
  });
  fireEvent.load(image);
  return image;
};

test('private legacy Gallery re-arms the retained A layer after an interrupted A to B to A return', async () => {
  vi.useRealTimers();
  render(<App jobPolicy={jobPolicy} />);
  await screen.findByRole('region', { name: 'Gallery controls' });
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'Date',
    ],
  });
  await flush();
  const selected = document.querySelector('.strip [aria-current="true"]');
  const imageA = selected.getAttribute('aria-label');

  const retainedA = loadLayer(imageA);
  await flush();
  fireEvent.click(screen.getByRole('button', { name: 'Next image' }));
  const imageB = document.querySelector(
    '.strip [aria-current="true"]',
  ).ariaLabel;
  await flush();
  loadLayer(imageB);
  await flush();
  expect(document.querySelector('.gallery-stage').dataset.effects).toBe('fade');

  fireEvent.click(screen.getByRole('button', { name: 'Previous image' }));
  await flush();
  expect(document.querySelector('.strip [aria-current="true"]').ariaLabel).toBe(
    imageA,
  );
  const returnedA = [...document.querySelectorAll('.gallery-stage img')].find(
    (item) => item.alt === imageA,
  );
  expect(returnedA).toBe(retainedA);
  await act(() => vi.advanceTimersByTimeAsync(600));
  await flush();
  expect(document.querySelector('.strip [aria-current="true"]').ariaLabel).toBe(
    imageA,
  );

  await act(() => vi.advanceTimersByTimeAsync(5000));
  await flush();
  expect(
    document.querySelector('.strip [aria-current="true"]').ariaLabel,
  ).not.toBe(imageA);
});
