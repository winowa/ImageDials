import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { DEFAULT_CLIENT_POLICY } from './clientPolicy.js';
import { createLibrarySync, fallbackFor, timingFrom } from './librarySync.js';
import { FakeEventSource } from './testSupport.js';

const { transport } = DEFAULT_CLIENT_POLICY;
const timing = timingFrom(transport);
const pointer = new EventTarget();

let refresh;
let syncs;
const start = (extra = {}) => {
  const sync = createLibrarySync({
    refresh,
    timing,
    EventSourceImpl: FakeEventSource,
    pointerTarget: pointer,
    ...extra,
  });
  syncs.push(sync);
  return sync;
};
const sources = () => FakeEventSource.all;
const tick = (ms) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers();
  FakeEventSource.reset();
  refresh = vi.fn();
  syncs = [];
});
afterEach(() => {
  syncs.forEach((sync) => sync.close());
  vi.useRealTimers();
});

test('opening the actual canonical stream refreshes once so nothing before it is missed', () => {
  start();
  expect(sources()[0].url).toBe('/api/images/library/events');
  expect(refresh).not.toHaveBeenCalled();
  sources()[0].open();
  expect(refresh).toHaveBeenCalledTimes(1);
});

test('a burst of changes becomes one refresh after the debounce', async () => {
  start();
  sources()[0].open();
  refresh.mockClear();
  for (let i = 0; i < 4; i += 1) {
    sources()[0].emit('changed', { action: 'saved' });
    await tick(transport.libraryChangeDebounceMs - 50);
  }
  expect(refresh).not.toHaveBeenCalled();
  await tick(60);
  expect(refresh).toHaveBeenCalledTimes(1);
});

test('reconnects with exponential backoff capped at the maximum and refreshes on every open', async () => {
  start();
  const delays = [];
  for (let i = 0; i < 8; i += 1) {
    const before = sources().length;
    sources()[before - 1].fail();
    let waited = 0;
    while (sources().length === before) {
      await tick(500);
      waited += 500;
    }
    delays.push(waited);
  }
  expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  refresh.mockClear();
  sources().at(-1).open();
  expect(refresh).toHaveBeenCalledTimes(1);
  // A successful open restarts the backoff at its initial delay.
  sources().at(-1).fail();
  await tick(1000);
  expect(sources().length).toBe(10);
});

test('failed streams are closed and never accumulate', async () => {
  start();
  for (let i = 0; i < 3; i += 1) {
    sources().at(-1).fail();
    await tick(30000);
  }
  const live = sources().filter((s) => !s.closed);
  expect(live).toHaveLength(1);
});

test('fallback polling runs only while disconnected and only at the visible screen interval', async () => {
  const sync = start();
  sync.setPolling(transport.galleryPollIntervalMs);
  sources()[0].open();
  refresh.mockClear();
  await tick(60000);
  expect(refresh).not.toHaveBeenCalled();
  sources()[0].fail();
  await tick(transport.galleryPollIntervalMs * 2);
  expect(refresh).toHaveBeenCalledTimes(2);
  sync.setPolling(null);
  refresh.mockClear();
  await tick(60000);
  expect(refresh).not.toHaveBeenCalled();
});

test('repeated reconnect failures do not postpone the fallback poll', async () => {
  const sync = start();
  sync.setPolling(transport.libraryPollIntervalMs);
  // Failures at 0, 1, 3, 7 s (backoff 1, 2, 4) would reset a restarted timer.
  sources()[0].fail();
  await tick(1000);
  sources().at(-1).fail();
  await tick(2000);
  sources().at(-1).fail();
  await tick(4000);
  sources().at(-1).fail();
  await tick(transport.libraryPollIntervalMs - 7000);
  expect(refresh).toHaveBeenCalledTimes(1);
});

test('fallback intervals are 5 seconds for the gallery, 10 for the library, none for the generator', () => {
  expect(fallbackFor('/gallery', transport)).toEqual({
    pollMs: 5000,
    pauseOnPointer: false,
  });
  expect(fallbackFor('/print', transport)).toEqual({
    pollMs: 10000,
    pauseOnPointer: true,
  });
  expect(fallbackFor('/', transport).pollMs).toBeNull();
});

test('without EventSource the screen polls at its interval', async () => {
  const sync = start({ EventSourceImpl: null });
  sync.setPolling(5000);
  await tick(15000);
  expect(refresh).toHaveBeenCalledTimes(3);
});

test('refreshes wait while the pointer moves, then run once when it is idle', async () => {
  const sync = start();
  sync.setPolling(null, true);
  sources()[0].open();
  refresh.mockClear();
  pointer.dispatchEvent(new Event('pointermove'));
  sources()[0].emit('changed', {});
  sources()[0].emit('changed', {});
  await tick(transport.libraryChangeDebounceMs + 10);
  expect(refresh).not.toHaveBeenCalled();
  // Continued movement keeps extending the pause.
  await tick(2000);
  pointer.dispatchEvent(new Event('pointermove'));
  await tick(2000);
  expect(refresh).not.toHaveBeenCalled();
  await tick(transport.libraryPointerIdleMs - 1900);
  expect(refresh).toHaveBeenCalledTimes(1);
});

test('pointer movement does not delay screens that do not pause', async () => {
  const sync = start();
  sync.setPolling(null, false);
  sources()[0].open();
  refresh.mockClear();
  pointer.dispatchEvent(new Event('pointermove'));
  sources()[0].emit('changed', {});
  await tick(transport.libraryChangeDebounceMs + 10);
  expect(refresh).toHaveBeenCalledTimes(1);
});

test('close removes the stream, every timer and the pointer listener', async () => {
  const sync = start();
  sync.setPolling(5000, true);
  sources()[0].fail();
  sources()[0].emit('changed', {});
  sync.close();
  refresh.mockClear();
  await tick(120000);
  pointer.dispatchEvent(new Event('pointermove'));
  await tick(5000);
  expect(refresh).not.toHaveBeenCalled();
  expect(sources().every((s) => s.closed)).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
