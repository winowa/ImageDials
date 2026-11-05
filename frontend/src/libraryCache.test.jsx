import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { SOURCE } from './cachePolicy.js';
import { deferred, quotaError, scriptedStore } from './cacheTestSupport.js';
import { imageKey } from './imageRecord.js';
import { useLibrary } from './library.js';
import {
  fakeLibrary,
  FakeEventSource,
  fixtures,
  installApi,
  libraryRecord,
  networkFailure,
  respond,
} from './testSupport.js';

const { m2 } = fixtures;
const LIST = 'GET /api/images/library';
const DELETE = 'DELETE /api/images/library';
const SCOPE = '{"scope":"a"}';

beforeEach(() => {
  FakeEventSource.reset();
  vi.stubGlobal('EventSource', FakeEventSource);
});
afterEach(() => vi.unstubAllGlobals());

const ids = (hook) => hook.result.current.images.items.map((i) => i.id);
const syncOptions = {
  enabled: true,
  timing: {
    reconnectInitialMs: 1000,
    reconnectMaxMs: 30000,
    changeDebounceMs: 150,
    pointerIdleMs: 2500,
  },
  pollMs: null,
  pauseOnPointer: false,
};
const open = (store, extra = {}) =>
  renderHook(
    (props) =>
      useLibrary({ source: SOURCE.SHARED, scopeKey: SCOPE, store, ...props }),
    { initialProps: extra },
  );

test('a pending source makes no library, stream or cache request', async () => {
  const api = installApi();
  const store = scriptedStore();
  const hook = open(store, { source: SOURCE.PENDING, sync: syncOptions });
  await act(() => hook.result.current.reload());
  expect(api.called(LIST)).toHaveLength(0);
  expect(store.hydrate).not.toHaveBeenCalled();
  expect(store.beginRead).not.toHaveBeenCalled();
  expect(FakeEventSource.all).toHaveLength(0);
  expect(hook.result.current.images.status).toBe('loading');
});

test('a private source makes no shared request; images stay in memory', async () => {
  const api = installApi();
  const store = scriptedStore();
  const hook = open(store, { source: SOURCE.PRIVATE, sync: syncOptions });
  await act(() => hook.result.current.reload());
  expect(hook.result.current.images).toMatchObject({
    status: 'ready',
    items: [],
  });
  const mine = libraryRecord({ id: 'mine' });
  act(() => hook.result.current.insert(mine));
  expect(ids(hook)).toEqual(['mine']);
  let failure;
  await act(async () => {
    failure = await hook.result.current.remove(mine);
  });
  expect(failure).toBeNull();
  expect(ids(hook)).toEqual([]);
  expect(api.calls.filter((c) => c.key.includes('/api/images'))).toEqual([]);
  expect(store.hydrate).not.toHaveBeenCalled();
  expect(store.purgeShared).not.toHaveBeenCalled();
  expect(FakeEventSource.all).toHaveLength(0);
});

test('an unavailable source never reads the library; reload retries capabilities', async () => {
  const api = installApi();
  const refreshCapabilities = vi.fn();
  const hook = open(scriptedStore(), {
    source: SOURCE.UNAVAILABLE,
    refreshCapabilities,
  });
  await waitFor(() => expect(hook.result.current.images.status).toBe('error'));
  await act(() => hook.result.current.reload());
  expect(refreshCapabilities).toHaveBeenCalledTimes(1);
  expect(api.called(LIST)).toHaveLength(0);
});

test('the last resolved source holds while capabilities reload', async () => {
  const library = fakeLibrary([libraryRecord({ id: 'a' })]);
  const api = installApi(library.routes);
  const store = scriptedStore();
  const hook = open(store, { sync: syncOptions });
  await waitFor(() => expect(ids(hook)).toEqual(['a']));
  const reads = api.called(LIST).length;
  hook.rerender({ source: SOURCE.PENDING, sync: syncOptions });
  expect(hook.result.current.source).toBe(SOURCE.SHARED);
  expect(ids(hook)).toEqual(['a']);
  expect(FakeEventSource.all.every((s) => !s.closed)).toBe(true);
  expect(api.called(LIST)).toHaveLength(reads);
  expect(store.hydrate).toHaveBeenCalledTimes(1);
});

test('stored images show before the server answers, and the stored ETag is sent', async () => {
  const stored = [libraryRecord({ id: 'cached' })];
  const server = deferred();
  const store = scriptedStore({
    hydrate: vi.fn(async () => ({
      items: stored,
      etag: '"stored"',
      watermarkSettings: null,
    })),
  });
  const api = installApi({ [LIST]: () => server.promise });
  const hook = open(store);
  await waitFor(() => expect(ids(hook)).toEqual(['cached']));
  expect(hook.result.current.images.status).toBe('loading');
  await waitFor(() => expect(api.called(LIST)).toHaveLength(1));
  expect(api.called(LIST)[0].headers['If-None-Match']).toBe('"stored"');
  server.resolve(respond(304, null, { ETag: '"stored"' }));
  await waitFor(() => expect(hook.result.current.images.status).toBe('ready'));
  expect(ids(hook)).toEqual(['cached']);
  expect(store.commitListing).not.toHaveBeenCalled();
});

test('a 200 with images, even none, is authoritative and stored', async () => {
  const library = fakeLibrary([libraryRecord({ id: 'gone' })]);
  const store = scriptedStore({
    hydrate: vi.fn(async () => ({
      items: library.records,
      etag: null,
      watermarkSettings: null,
    })),
  });
  installApi(library.routes);
  const hook = open(store);
  await waitFor(() => expect(hook.result.current.images.status).toBe('ready'));
  library.records = [];
  await act(() => hook.result.current.reload());
  expect(ids(hook)).toEqual([]);
  expect(store.commitListing).toHaveBeenLastCalledWith(
    SCOPE,
    { seq: 0, epoch: 0 },
    expect.objectContaining({ images: [] }),
  );
});

test('an unreadable 200 keeps the images and the stored copy', async () => {
  const library = fakeLibrary([libraryRecord({ id: 'a' })]);
  let mode = 'ok';
  installApi({
    [LIST]: (...args) =>
      mode === 'ok'
        ? library.routes[LIST](...args)
        : respond(200, mode === 'no-images' ? { count: 0 } : '[1,2]'),
  });
  const store = scriptedStore();
  const hook = open(store);
  await waitFor(() => expect(hook.result.current.images.status).toBe('ready'));
  const commits = store.commitListing.mock.calls.length;
  for (mode of ['no-images', 'array']) {
    await act(() => hook.result.current.reload());
    expect(hook.result.current.images.status).toBe('error');
    expect(ids(hook)).toEqual(['a']);
  }
  expect(store.commitListing).toHaveBeenCalledTimes(commits);
});

test('a network failure keeps images and stores nothing', async () => {
  const library = fakeLibrary([libraryRecord({ id: 'a' })]);
  let fail = false;
  installApi({
    [LIST]: (...args) =>
      fail ? networkFailure() : library.routes[LIST](...args),
  });
  const store = scriptedStore();
  const hook = open(store);
  await waitFor(() => expect(ids(hook)).toEqual(['a']));
  fail = true;
  await act(() => hook.result.current.reload());
  expect(hook.result.current.images.status).toBe('error');
  expect(ids(hook)).toEqual(['a']);
  expect(store.commitListing).toHaveBeenCalledTimes(1);
});

test('a 403 is reported, stops automatic reads and asks capabilities once', async () => {
  vi.useFakeTimers();
  try {
    let forbid = false;
    const library = fakeLibrary([libraryRecord({ id: 'a' })]);
    const api = installApi({
      [LIST]: (...args) =>
        forbid ? respond(403, { detail: 'no' }) : library.routes[LIST](...args),
    });
    const refreshCapabilities = vi.fn();
    const hook = open(scriptedStore(), {
      sync: { ...syncOptions, pollMs: 1000 },
      refreshCapabilities,
    });
    await act(() => vi.advanceTimersByTimeAsync(50));
    expect(ids(hook)).toEqual(['a']);
    forbid = true;
    await act(() => hook.result.current.reload());
    expect(hook.result.current.images.status).toBe('error');
    expect(hook.result.current.images.error).toMatch(/refused/);
    expect(ids(hook)).toEqual(['a']);
    expect(refreshCapabilities).toHaveBeenCalledTimes(1);
    const reads = api.called(LIST).length;
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(api.called(LIST)).toHaveLength(reads);
    expect(refreshCapabilities).toHaveBeenCalledTimes(1);
    expect(hook.result.current.source).toBe(SOURCE.SHARED);
  } finally {
    vi.useRealTimers();
  }
});

test('a read that raced a mutation shows the filtered list and reads once more', async () => {
  const library = fakeLibrary([libraryRecord({ id: 'a' })]);
  const api = installApi(library.routes);
  let first = true;
  const store = scriptedStore({
    commitListing: vi.fn(async (_s, _t, { images }) => {
      const stale = first;
      first = false;
      return { images, persisted: !stale, stale };
    }),
  });
  const hook = open(store);
  await waitFor(() => expect(api.called(LIST)).toHaveLength(2));
  await waitFor(() => expect(hook.result.current.images.status).toBe('ready'));
  // The raced read's ETag is not trusted: the follow-up read is unconditional.
  expect(api.called(LIST)[1].headers['If-None-Match']).toBeUndefined();
});

test('delete goes to the server first; a failure changes nothing', async () => {
  const record = libraryRecord();
  const library = fakeLibrary([record]);
  installApi({
    ...library.routes,
    [DELETE]: () => respond(502, m2.errors.storage),
  });
  const store = scriptedStore();
  const hook = open(store);
  await waitFor(() => expect(ids(hook)).toHaveLength(1));
  let failure;
  await act(async () => {
    failure = await hook.result.current.remove(record);
  });
  expect(failure).toBe(m2.errors.storage.detail);
  expect(ids(hook)).toEqual([record.id]);
  expect(store.purgeShared).not.toHaveBeenCalled();
});

test('a 404 delete means already gone: remove from view and purge the copy', async () => {
  const record = libraryRecord();
  const library = fakeLibrary([record]);
  installApi({
    ...library.routes,
    [DELETE]: () => respond(404, m2.errors.missing),
  });
  const store = scriptedStore();
  const hook = open(store);
  await waitFor(() => expect(ids(hook)).toHaveLength(1));
  let failure;
  await act(async () => {
    failure = await hook.result.current.remove(record);
  });
  expect(failure).toBeNull();
  expect(ids(hook)).toEqual([]);
  expect(store.purgeShared).toHaveBeenCalledWith(imageKey(record));
});

test('a failed local cleanup after a real delete is a warning, not a failure', async () => {
  const record = libraryRecord();
  const library = fakeLibrary([record]);
  installApi(library.routes);
  const store = scriptedStore({
    purgeShared: vi.fn(async () => {
      throw quotaError();
    }),
  });
  const hook = open(store);
  await waitFor(() => expect(ids(hook)).toHaveLength(1));
  let failure;
  await act(async () => {
    failure = await hook.result.current.remove(record);
  });
  expect(failure).toBeNull();
  expect(library.deleted).toHaveLength(1);
  expect(ids(hook)).toEqual([]);
  expect(hook.result.current.images.cacheWarning).toMatch(
    /could not be cleared/,
  );
});

test('a read held across a delete cannot bring the image back or be stored', async () => {
  const record = libraryRecord();
  const library = fakeLibrary([record]);
  const hold = deferred();
  let stale = false;
  installApi({
    ...library.routes,
    [LIST]: (...args) => {
      if (!stale) return library.routes[LIST](...args);
      const snapshot = library.body();
      return hold.promise.then(() => respond(200, snapshot, { ETag: '"old"' }));
    },
  });
  const store = scriptedStore();
  const hook = open(store);
  await waitFor(() => expect(ids(hook)).toHaveLength(1));
  const commits = store.commitListing.mock.calls.length;
  stale = true;
  let reading;
  act(() => {
    reading = hook.result.current.reload();
  });
  await waitFor(() => expect(store.beginRead).toHaveBeenCalledTimes(2));
  await act(async () => {
    await hook.result.current.remove(record);
  });
  await act(async () => {
    hold.resolve();
    await reading;
  });
  expect(ids(hook)).toEqual([]);
  expect(store.commitListing).toHaveBeenCalledTimes(commits);
});

test('a read held across an insert is ignored; the insert persists only via a server read', async () => {
  const library = fakeLibrary([libraryRecord({ id: 'a' })]);
  const hold = deferred();
  let slow = false;
  installApi({
    ...library.routes,
    [LIST]: (...args) => {
      if (!slow) return library.routes[LIST](...args);
      const snapshot = library.body();
      return hold.promise.then(() => respond(200, snapshot, { ETag: '"old"' }));
    },
  });
  const store = scriptedStore();
  const hook = open(store);
  await waitFor(() => expect(ids(hook)).toEqual(['a']));
  const commits = store.commitListing.mock.calls.length;
  slow = true;
  let reading;
  act(() => {
    reading = hook.result.current.reload();
  });
  await waitFor(() => expect(store.beginRead).toHaveBeenCalledTimes(2));
  act(() => hook.result.current.insert(libraryRecord({ id: 'b' })));
  expect(ids(hook)).toEqual(['b', 'a']);
  expect(store.noteMutation).toHaveBeenCalledTimes(1);
  await act(async () => {
    hold.resolve();
    await reading;
  });
  expect(ids(hook)).toEqual(['b', 'a']);
  expect(store.commitListing).toHaveBeenCalledTimes(commits);
});
