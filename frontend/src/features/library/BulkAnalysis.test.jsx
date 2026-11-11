import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import batches from '../../../../fixtures/api/watermark-batches.json';
import { ENDPOINTS } from '../../data/api/api.js';
import { backfillText } from './Library.jsx';
import { BACKFILL_POLL_MS, useWatermark } from '../watermarks/watermark.js';

const asyncCapabilities = (enabled) => ({
  watermark: {
    transient_analysis_enabled: true,
    backfill: { async_preparation_enabled: enabled },
  },
});

const json = (status, body, headers = {}) =>
  new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers,
  });

let routes;
let calls;

beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
  routes = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path, init = {}) => {
      calls.push({
        path,
        method: init.method,
        headers: init.headers,
        body: init.body,
      });
      const next = routes.shift();
      if (!next) throw new Error(`unexpected request ${path}`);
      return next();
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function setup(capabilities, seed = null, observing = true) {
  const reload = vi.fn();
  const hook = renderHook(
    ({ images, observing: isObserving }) =>
      useWatermark({
        images,
        reload,
        replace: vi.fn(),
        local: { settings: null, refresh: vi.fn() },
        capabilities,
        observeSharedBatch: isObserving,
      }),
    { initialProps: { images: { watermarkBackfill: seed }, observing } },
  );
  return { ...hook, reload };
}

const tick = (ms = BACKFILL_POLL_MS) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

test('async capability posts once, shows an unknown count, then exact counts without library reads', async () => {
  routes.push(
    () => json(202, batches.async.response),
    () => json(200, batches.preparing.response, { ETag: '"a"' }),
    () => new Response(null, { status: 304, headers: { ETag: '"a"' } }),
    () => json(200, batches.async_complete.response, { ETag: '"b"' }),
  );
  const { result, reload } = setup(asyncCapabilities(true));
  await act(() => result.current.queueAnalysis({ force: false }));
  expect(calls[0].path).toBe(ENDPOINTS.watermarkBackfill);
  expect(JSON.parse(calls[0].body)).toEqual({
    force: false,
    async_preparation: true,
  });
  expect(result.current.backfill).toMatchObject({
    count_pending: true,
    queued_count: null,
  });
  expect(backfillText(result.current.backfill)).toBe(
    'Preparing analysis, up to 1 images',
  );

  await tick();
  expect(calls[1].path).toBe(ENDPOINTS.watermarkBackfillStatus);
  await tick();
  expect(calls[2].headers['If-None-Match']).toBe('"a"');
  expect(result.current.backfill.phase).toBe('preparing');
  await tick();
  expect(result.current.backfill.status).toBe('complete');
  expect(backfillText(result.current.backfill)).toBe(
    'Analysis finished for 1 images',
  );
  expect(reload).toHaveBeenCalledTimes(1);
  await tick(BACKFILL_POLL_MS * 3);
  expect(calls).toHaveLength(4);
  expect(calls.every((call) => !call.path.endsWith('/library'))).toBe(true);
});

test('without published support the legacy body is sent and no retry follows an error', async () => {
  routes.push(() => json(409, batches.busy.response));
  const { result } = setup(asyncCapabilities(false));
  await expect(
    act(() => result.current.queueAnalysis({ force: false })),
  ).rejects.toMatchObject({ status: 409 });
  expect(JSON.parse(calls[0].body)).toEqual({ force: false });
  await tick(BACKFILL_POLL_MS * 3);
  expect(calls).toHaveLength(1);
});

test('a failed status read keeps progress; a fresh global response adopts the current batch', async () => {
  routes.push(
    () => json(202, batches.async.response),
    () => json(500, { detail: 'status unavailable' }),
    () =>
      json(
        200,
        batches.async_complete.response.watermark_backfill && {
          watermark_backfill: {
            ...batches.async_complete.response.watermark_backfill,
            id: 'externally-started-batch',
            status: 'running',
          },
        },
      ),
    () =>
      json(200, {
        watermark_backfill: {
          ...batches.async_complete.response.watermark_backfill,
          id: 'externally-started-batch',
        },
      }),
  );
  const { result } = setup(asyncCapabilities(true));
  await act(() => result.current.queueAnalysis({}));
  await tick();
  expect(result.current.backfillError).toBe('status unavailable');
  expect(result.current.backfill.count_pending).toBe(true);
  await tick();
  expect(result.current.backfill.id).toBe('externally-started-batch');
  expect(result.current.backfill.status).toBe('running');
  await tick();
  expect(result.current.backfill.status).toBe('complete');
  expect(result.current.backfillError).toBeNull();
});

test('a malformed status response preserves the last valid progress', async () => {
  routes.push(
    () => json(202, batches.async.response),
    () => json(200, { watermark_backfill: [] }),
    () => json(200, batches.async_complete.response),
  );
  const { result } = setup(asyncCapabilities(true));
  await act(() => result.current.queueAnalysis({}));
  await tick();
  expect(result.current.backfillError).toBe(
    'The analysis status was unreadable.',
  );
  expect(result.current.backfill.count_pending).toBe(true);
  await tick();
  expect(result.current.backfill.status).toBe('complete');
  expect(result.current.backfillError).toBeNull();
});

test('a fresh global response adopts another active batch and uses its ETag', async () => {
  routes.push(
    () => json(202, batches.async.response),
    () => json(200, batches.preparing.response, { ETag: '"accepted"' }),
    () =>
      json(
        200,
        {
          watermark_backfill: {
            ...batches.preparing.response.watermark_backfill,
            id: 'other-batch',
          },
        },
        { ETag: '"other"' },
      ),
    () =>
      json(
        200,
        {
          watermark_backfill: {
            ...batches.async_complete.response.watermark_backfill,
            id: 'other-batch',
          },
        },
        { ETag: '"other-2"' },
      ),
  );
  const { result } = setup(asyncCapabilities(true));
  await act(() => result.current.queueAnalysis({}));
  await tick();
  await tick();
  expect(result.current.backfill.status).toBe('queued');
  await tick();
  expect(calls[3].headers['If-None-Match']).toBe('"other"');
  expect(result.current.backfill.status).toBe('complete');
});

test('a running batch seeded by the library is followed; failure keeps real diagnostics', async () => {
  routes.push(() => json(200, batches.failed.response));
  const seed = {
    ...batches.failed.response.watermark_backfill,
    status: 'running',
    count_pending: false,
  };
  const { result } = setup(asyncCapabilities(true), seed);
  await tick();
  expect(result.current.backfill.status).toBe('failed');
  expect(result.current.backfill.error_sample.error).toBe(
    'Image storage is unavailable',
  );
  expect(backfillText(result.current.backfill)).toBe(
    'Analysis stopped: 1 done, 1 failed',
  );
});

test('unmounting aborts polling', async () => {
  routes.push(
    () => json(202, batches.async.response),
    () => json(200, batches.preparing.response),
  );
  const { result, unmount } = setup(asyncCapabilities(true));
  await act(() => result.current.queueAnalysis({}));
  unmount();
  await tick(BACKFILL_POLL_MS * 3);
  expect(calls).toHaveLength(1);
});

test('polling is paused outside the shared Library and resumes on return', async () => {
  routes.push(
    () => json(202, batches.async.response),
    () => json(200, batches.preparing.response),
  );
  const { result, rerender } = setup(asyncCapabilities(true), null, false);
  await act(() => result.current.queueAnalysis({}));
  await tick(BACKFILL_POLL_MS * 2);
  expect(calls).toHaveLength(1);
  rerender({ images: { watermarkBackfill: null }, observing: true });
  await tick();
  expect(calls[1].path).toBe(ENDPOINTS.watermarkBackfillStatus);
});

test('an accepted batch B remains selected over stale seeded batch A', async () => {
  const seed = {
    ...batches.failed.response.watermark_backfill,
    status: 'running',
  };
  const accepted = {
    ...batches.async.response,
    analysis_batch_id: 'batch-b',
  };
  const responseB = {
    watermark_backfill: {
      ...batches.async_complete.response.watermark_backfill,
      id: 'batch-b',
    },
  };
  routes.push(
    () => json(202, accepted),
    () => json(200, responseB),
  );
  const { result } = setup(asyncCapabilities(true), seed);
  await act(() => result.current.queueAnalysis({}));
  expect(result.current.backfill.id).toBe('batch-b');
  await tick();
  expect(result.current.backfill.id).toBe('batch-b');
  expect(result.current.backfill.status).toBe('complete');
});

test('a new active seed wakes polling after the tracked batch ended', async () => {
  const first = batches.legacy_complete.response.watermark_backfill;
  const second = {
    ...batches.preparing.response.watermark_backfill,
    id: 'external-batch-b',
  };
  routes.push(() => json(200, { watermark_backfill: second }));
  const { result, rerender } = setup(asyncCapabilities(true), first, false);
  rerender({
    images: { watermarkBackfill: second },
    observing: true,
  });
  await tick();
  expect(calls[0].path).toBe(ENDPOINTS.watermarkBackfillStatus);
  expect(result.current.backfill.id).toBe('external-batch-b');
});

test('returning to the Library adopts the fresh global batch after supersession', async () => {
  const batchB = {
    ...batches.preparing.response.watermark_backfill,
    id: 'external-batch-b',
  };
  routes.push(
    () => json(202, batches.async.response),
    () => json(200, { watermark_backfill: batchB }),
    () =>
      json(200, {
        watermark_backfill: {
          ...batches.async_complete.response.watermark_backfill,
          id: 'external-batch-b',
        },
      }),
  );
  const { result, rerender } = setup(asyncCapabilities(true), null, true);
  await act(() => result.current.queueAnalysis({}));
  rerender({ images: { watermarkBackfill: null }, observing: false });
  await tick(BACKFILL_POLL_MS * 2);
  expect(calls).toHaveLength(1);
  rerender({ images: { watermarkBackfill: null }, observing: true });
  await tick();
  expect(result.current.backfill.id).toBe('external-batch-b');
  await tick();
  expect(result.current.backfill.status).toBe('complete');
});

test('a status request started before local accept cannot overwrite the accepted batch', async () => {
  let resolveStatus;
  const pendingStatus = new Promise((resolve) => {
    resolveStatus = resolve;
  });
  routes.push(
    () => json(202, batches.async.response),
    () => pendingStatus,
    () =>
      json(202, { ...batches.async.response, analysis_batch_id: 'batch-b' }),
    () =>
      json(200, {
        watermark_backfill: {
          ...batches.preparing.response.watermark_backfill,
          id: 'batch-b',
        },
      }),
  );
  const { result } = setup(asyncCapabilities(true));
  await act(() => result.current.queueAnalysis({}));
  await tick();
  await act(() => result.current.queueAnalysis({ force: true }));
  await act(async () => {
    resolveStatus(
      json(200, {
        watermark_backfill: {
          ...batches.async_complete.response.watermark_backfill,
          id: batches.async.response.analysis_batch_id,
        },
      }),
    );
    await Promise.resolve();
  });
  expect(result.current.backfill.id).toBe('batch-b');
  expect(result.current.backfill.status).toBe('queued');
  await tick();
  expect(result.current.backfill.id).toBe('batch-b');
});

const running = (id) => ({
  id,
  status: 'running',
  queued_count: 3,
  completed_count: 1,
});

test('a fresh report of no batch ends a stale library snapshot instead of polling forever', async () => {
  routes.push(
    () => json(200, { watermark_backfill: null }, { ETag: '"none"' }),
    () => {
      throw new Error('polled after the batch was gone');
    },
  );
  const { result, reload } = setup(null, running('stale'));
  expect(result.current.backfill.id).toBe('stale');
  await tick();
  expect(result.current.backfill).toBeNull();
  expect(reload).toHaveBeenCalledTimes(1);
  await tick(BACKFILL_POLL_MS * 3);
  expect(calls).toHaveLength(1);
});

test('a 304 keeps a finished batch authoritative over an older snapshot of another batch', async () => {
  const done = { id: 'done', status: 'complete', queued_count: 1 };
  routes.push(
    () => json(200, { watermark_backfill: done }, { ETag: '"done"' }),
    () => new Response(null, { status: 304, headers: { ETag: '"done"' } }),
  );
  const { result, rerender } = setup(null, running('done'));
  await tick();
  expect(result.current.backfill.status).toBe('complete');
  rerender({
    images: { watermarkBackfill: running('older') },
    observing: true,
  });
  expect(result.current.backfill.id).toBe('older');
  await tick();
  expect(result.current.backfill.id).toBe('done');
  await tick(BACKFILL_POLL_MS * 3);
  expect(calls).toHaveLength(2);
});

test('a library change makes one idle status read that follows a batch another tab started', async () => {
  routes.push(
    () => json(200, { watermark_backfill: null }, { ETag: '"none"' }),
    () => json(200, { watermark_backfill: running('other') }, { ETag: '"o"' }),
  );
  const hook = renderHook(
    ({ check }) =>
      useWatermark({
        images: { watermarkBackfill: null },
        reload: vi.fn(),
        replace: vi.fn(),
        local: { settings: null, refresh: vi.fn() },
        capabilities: null,
        observeSharedBatch: true,
        batchCheck: check,
      }),
    { initialProps: { check: 4 } },
  );
  await tick(1);
  expect(calls).toHaveLength(1);
  expect(hook.result.current.backfill).toBeNull();
  await tick(BACKFILL_POLL_MS * 2);
  expect(calls).toHaveLength(1);
  hook.rerender({ check: 5 });
  await tick(1);
  expect(calls).toHaveLength(2);
  expect(calls[1].headers['If-None-Match']).toBe('"none"');
  expect(hook.result.current.backfill.id).toBe('other');
});

test('a hidden Library makes no idle status read', async () => {
  const hook = renderHook(() =>
    useWatermark({
      images: { watermarkBackfill: null },
      reload: vi.fn(),
      replace: vi.fn(),
      local: { settings: null, refresh: vi.fn() },
      capabilities: null,
      observeSharedBatch: false,
      batchCheck: 4,
    }),
  );
  await tick(BACKFILL_POLL_MS * 2);
  expect(calls).toHaveLength(0);
  hook.unmount();
});
