import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import libraryPages from '../../fixtures/api/library-pages.json';
import { SOURCE } from './cachePolicy.js';
import { useLibrary } from './library.js';
import { scriptedStore } from './cacheTestSupport.js';
import { FakeEventSource } from './testSupport.js';

const json = (body, status = 200, etag = null) =>
  new Response(status === 304 ? null : JSON.stringify(body), {
    status,
    headers: etag ? { ETag: etag } : undefined,
  });

afterEach(() => vi.unstubAllGlobals());

test('paged repository uses only summary pages and exact detail endpoint', async () => {
  const page = libraryPages.first.response;
  const detail = libraryPages.detail;
  const calls = [];
  vi.stubGlobal('fetch', async (url, init = {}) => {
    calls.push({ url, init });
    if (url.startsWith('/api/images/library/page?'))
      return json(page, 200, libraryPages.first.etag);
    if (url.startsWith('/api/images/library/record/'))
      return json(detail, 200, 'detail-etag');
    throw new Error(`unexpected route ${url}`);
  });
  const store = scriptedStore();
  const { result } = renderHook(() =>
    useLibrary({
      source: SOURCE.SHARED,
      scopeKey: 'shared-scope',
      store,
      paged: true,
    }),
  );

  await act(async () => {
    await result.current.loadLibraryWindow({
      direction: 'first',
      binding: { limit: 2 },
    });
  });
  expect(calls.map(({ url }) => url)).toEqual([
    '/api/images/library/page?limit=2',
  ]);
  expect(result.current.libraryWindow.pages[0].images).toEqual(page.images);
  expect(result.current.images.items).toEqual([]);
  expect(store.persistLibraryWindow).toHaveBeenCalledTimes(1);

  let selected;
  await act(async () => {
    selected = await result.current.loadLibraryRecord(page.images[0]);
  });
  expect(calls[1].url).toBe(`/api/images/library/record/${page.images[0].id}`);
  expect(selected).toEqual(detail);
  expect(store.putLibraryDetail).toHaveBeenCalledWith(
    detail,
    'detail-etag',
    expect.objectContaining({ pinned: expect.any(Set) }),
  );
  expect(calls.some(({ url }) => url === '/api/images/library')).toBe(false);
});

test('304 retains cached window; a failed page request retains visible summaries', async () => {
  const cachedWindow = {
    binding: {
      q: '',
      orientation: null,
      eventName: null,
      order: 'newest',
      limit: 2,
    },
    pages: [
      {
        ...libraryPages.first.response,
        etag: libraryPages.first.etag,
        requestParams: { limit: 2 },
      },
    ],
    activeIndex: 0,
    revision: libraryPages.first.response.revision,
    complete: false,
  };
  const store = scriptedStore({
    hydrateLibraryWindow: vi.fn(async () => cachedWindow),
  });
  let calls = 0;
  vi.stubGlobal('fetch', async () => {
    calls += 1;
    if (calls === 1) return json(null, 304, libraryPages.first.etag);
    return json({ detail: 'temporarily unavailable' }, 503);
  });
  const { result } = renderHook(() =>
    useLibrary({
      source: SOURCE.SHARED,
      scopeKey: 'shared-scope',
      store,
      paged: true,
    }),
  );
  await act(async () => {
    await result.current.loadLibraryWindow({
      direction: 'first',
      binding: { limit: 2 },
    });
  });
  expect(result.current.libraryWindow.pages[0].images).toEqual(
    libraryPages.first.response.images,
  );
  expect(result.current.libraryWindow.error).toBeNull();

  await act(async () => {
    await result.current.loadLibraryWindow({ direction: 'refresh' });
  });
  expect(result.current.libraryWindow.pages[0].images).toEqual(
    libraryPages.first.response.images,
  );
  expect(result.current.libraryWindow.error.message).toBe(
    'temporarily unavailable',
  );
  expect(result.current.images.items).toEqual([]);
});

test('cursor projection conflict clears the old window and restarts from the head once', async () => {
  const calls = [];
  vi.stubGlobal('fetch', async (url) => {
    calls.push(url);
    if (calls.length === 2)
      return json(libraryPages.projection_changed.response, 409);
    const fresh = {
      ...libraryPages.first.response,
      revision: calls.length > 2 ? 4 : libraryPages.first.response.revision,
      position: 0,
    };
    return json(fresh, 200, `etag-${calls.length}`);
  });
  const store = scriptedStore();
  const { result } = renderHook(() =>
    useLibrary({
      source: SOURCE.SHARED,
      scopeKey: 'shared-scope',
      store,
      paged: true,
    }),
  );
  await act(async () => {
    await result.current.loadLibraryWindow({
      direction: 'first',
      binding: { limit: 2 },
    });
  });
  await act(async () => {
    await result.current.loadLibraryWindow({ direction: 'forward' });
  });
  await waitFor(() => expect(calls).toHaveLength(3));
  expect(calls[1]).toContain('cursor=');
  expect(calls[2]).toBe('/api/images/library/page?limit=2');
  expect(result.current.libraryWindow.revision).toBe(4);
  expect(store.clearLibraryWindow).toHaveBeenCalledTimes(1);
  expect(calls.some((url) => url === '/api/images/library')).toBe(false);
});

const hookFor = (store, extra = {}) =>
  renderHook(() =>
    useLibrary({
      source: SOURCE.SHARED,
      scopeKey: 'shared-scope',
      store,
      paged: true,
      ...extra,
    }),
  );
const loadFirst = (result) =>
  act(async () => {
    await result.current.loadLibraryWindow({
      direction: 'first',
      binding: { limit: 2 },
    });
  });

test('a stale persist repeats the requested navigation, not a refresh', async () => {
  const calls = [];
  vi.stubGlobal('fetch', async (url) => {
    calls.push(url);
    return json(
      { ...libraryPages.first.response, position: calls.length },
      200,
      `etag-${calls.length}`,
    );
  });
  const store = scriptedStore({
    persistLibraryWindow: vi
      .fn()
      .mockResolvedValueOnce({ persisted: true, stale: false })
      .mockResolvedValueOnce({ persisted: false, stale: true })
      .mockResolvedValue({ persisted: true, stale: false }),
  });
  const { result } = hookFor(store);
  await loadFirst(result);
  await act(async () => {
    await result.current.loadLibraryWindow({ direction: 'forward' });
  });
  await waitFor(() => expect(calls).toHaveLength(3));
  expect(calls[2]).toBe(calls[1]);
  expect(calls[2]).toContain('cursor=');
  await waitFor(() => expect(result.current.libraryWindow.pending).toBeNull());
  expect(result.current.libraryWindow.pages).toHaveLength(2);
});

test('an empty range after deletions follows its cursor and is never persisted', async () => {
  const first = libraryPages.first.response;
  const empty = {
    ...first,
    images: [],
    count: 0,
    total: 5,
    position: null,
    next_cursor: null,
    previous_cursor: 'back',
    revision: first.revision + 1,
  };
  const rows = { ...first, position: null, previous_cursor: null };
  const calls = [];
  const responses = [first, empty, { ...rows, revision: empty.revision }];
  vi.stubGlobal('fetch', async (url) => {
    calls.push(url);
    return json(responses.shift(), 200, `etag-${calls.length}`);
  });
  const store = scriptedStore();
  const { result } = hookFor(store);
  await loadFirst(result);
  await act(async () => {
    await result.current.loadLibraryWindow({ direction: 'forward' });
  });
  await waitFor(() => expect(calls).toHaveLength(3));
  expect(calls[2]).toContain('cursor=back');
  await waitFor(() =>
    expect(result.current.libraryWindow.pages[0].images).toEqual(rows.images),
  );
  expect(result.current.libraryWindow.pages).toHaveLength(1);
  for (const [, window] of store.persistLibraryWindow.mock.calls)
    expect(window.pages.every((entry) => entry.count > 0)).toBe(true);
});

test('a confirmed delete leaves the window and restore record even if revalidation fails', async () => {
  const page = libraryPages.first.response;
  const target = page.images[0];
  vi.stubGlobal('fetch', async (url, init = {}) => {
    if (init.method === 'DELETE' || init.method === 'POST')
      return json({ deleted: true });
    if (url.startsWith('/api/images/library/page?'))
      return fetchOnce.shift() ?? json({ detail: 'offline' }, 503);
    throw new Error(`unexpected route ${url}`);
  });
  const fetchOnce = [json(page, 200, 'etag-1')];
  const store = scriptedStore();
  const { result } = hookFor(store);
  await loadFirst(result);
  act(() =>
    result.current.rememberRecordForRestore({
      ...target,
      selected_controls: [],
    }),
  );
  expect(result.current.restoreRecord).not.toBeNull();
  await act(async () => {
    await result.current.remove(target);
  });
  expect(store.purgeShared).toHaveBeenCalledTimes(1);
  const shown = result.current.libraryWindow.pages[0].images;
  expect(shown.some((image) => image.id === target.id)).toBe(false);
  expect(result.current.restoreRecord).toBeNull();
  expect(result.current.libraryWindow.error).not.toBeNull();
});

test('a paged 403 stops the event stream; a successful retry starts it again', async () => {
  FakeEventSource.reset();
  vi.stubGlobal('EventSource', FakeEventSource);
  const replies = [
    json({ detail: 'refused' }, 403),
    json(libraryPages.first.response, 200, 'etag-ok'),
  ];
  vi.stubGlobal('fetch', async () => replies.shift());
  const refreshCapabilities = vi.fn();
  const { result } = hookFor(scriptedStore(), {
    refreshCapabilities,
    sync: {
      enabled: true,
      timing: { changeDebounceMs: 1, reconnectInitialMs: 1, reconnectMaxMs: 1 },
    },
  });
  expect(FakeEventSource.all).toHaveLength(1);
  await loadFirst(result);
  expect(refreshCapabilities).toHaveBeenCalledTimes(1);
  expect(FakeEventSource.all[0].closed).toBe(true);
  await act(async () => {
    await result.current.reload();
  });
  expect(result.current.libraryWindow.error).toBeNull();
  await waitFor(() => expect(FakeEventSource.all).toHaveLength(2));
  expect(FakeEventSource.all[1].closed).toBe(false);
});

test('a page saved for nobody says so; the next saved page clears only that warning', async () => {
  vi.stubGlobal('fetch', async () =>
    json(libraryPages.first.response, 200, 'etag'),
  );
  const store = scriptedStore({
    persistLibraryWindow: vi
      .fn()
      .mockResolvedValueOnce({
        persisted: false,
        reason: 'oversize',
        stale: false,
      })
      .mockResolvedValue({ persisted: true, stale: false }),
  });
  const { result } = hookFor(store);
  await loadFirst(result);
  expect(result.current.images.cacheWarning).toMatch(/unavailable offline/);
  await loadFirst(result);
  expect(result.current.images.cacheWarning).toBeNull();
});

test('an explicit null batch envelope replaces a stale batch; a cursor page keeps it', async () => {
  const batch = { id: 'old', status: 'running' };
  const replies = [
    { ...libraryPages.first.response, watermark_backfill: batch },
    (() => {
      const { watermark_backfill: _omitted, ...page } =
        libraryPages.first.response;
      return page;
    })(),
    { ...libraryPages.first.response, watermark_backfill: null },
  ];
  vi.stubGlobal('fetch', async () => json(replies.shift(), 200));
  const { result } = hookFor(scriptedStore());
  await loadFirst(result);
  expect(result.current.images.watermarkBackfill).toEqual(batch);
  await loadFirst(result);
  expect(result.current.images.watermarkBackfill).toEqual(batch);
  await loadFirst(result);
  expect(result.current.images.watermarkBackfill).toBeNull();
});

test('an incomplete stored detail is neither revalidated into use nor offline-restored', async () => {
  const summary = libraryPages.first.response.images[0];
  const detail = libraryPages.detail;
  const incomplete = { ...summary, display_prompt: 'only a summary' };
  const store = scriptedStore({
    getLibraryDetail: vi.fn(async () => ({
      record: incomplete,
      etag: 'stale-etag',
    })),
  });
  const seen = [];
  let online = true;
  vi.stubGlobal('fetch', async (url, init = {}) => {
    seen.push(init.headers?.['If-None-Match'] ?? null);
    if (!online) throw new TypeError('Failed to fetch');
    return json(detail, 200, 'fresh-etag');
  });
  const { result } = renderHook(() =>
    useLibrary({
      source: SOURCE.SHARED,
      scopeKey: 'shared-scope',
      store,
      paged: true,
    }),
  );
  let record;
  await act(async () => {
    record = await result.current.loadLibraryRecord(summary);
  });
  expect(record).toEqual(detail);
  expect(seen).toEqual([null]);
  online = false;
  await expect(result.current.loadLibraryRecord(summary)).rejects.toThrow();
});
