import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { imageKey } from './imageRecord.js';
import { useLibrary } from './library.js';
import {
  fakeLibrary,
  fixtures,
  installApi,
  libraryRecord,
  networkFailure,
  respond,
} from './testSupport.js';

const { m2 } = fixtures;
const LIST = 'GET /api/images/library';
const DELETE = 'DELETE /api/images/library';

afterEach(() => vi.unstubAllGlobals());

const ids = (hook) => hook.result.current.images.items.map((i) => i.id);

test('loads the canonical list newest first, keeping every wire field', async () => {
  const records = [libraryRecord({ id: 'new' }), libraryRecord({ id: 'old' })];
  installApi(fakeLibrary(records).routes);
  const hook = renderHook(() => useLibrary());
  expect(hook.result.current.images.status).toBe('loading');
  await waitFor(() => expect(hook.result.current.images.status).toBe('ready'));
  expect(ids(hook)).toEqual(['new', 'old']);
  expect(hook.result.current.images.items[0]).toEqual(records[0]);
  expect(hook.result.current.images.watermarkSettings).toEqual(
    m2.library.watermark_settings,
  );
});

test('a repeat read sends the last ETag and a 304 keeps the displayed images', async () => {
  const library = fakeLibrary([libraryRecord()]);
  const api = installApi(library.routes);
  const hook = renderHook(() => useLibrary());
  await waitFor(() => expect(hook.result.current.images.status).toBe('ready'));
  const shown = hook.result.current.images.items;
  await act(() => hook.result.current.reload());
  const [first, second] = api.called(LIST);
  expect(first.headers['If-None-Match']).toBeUndefined();
  expect(second.headers['If-None-Match']).toBe(library.etag());
  // The very same list objects stay on screen.
  expect(hook.result.current.images.items).toBe(shown);
  expect(hook.result.current.images.status).toBe('ready');
});

test('a changed library replaces the list on the next read', async () => {
  const library = fakeLibrary([libraryRecord({ id: 'a' })]);
  installApi(library.routes);
  const hook = renderHook(() => useLibrary());
  await waitFor(() => expect(ids(hook)).toEqual(['a']));
  library.records = [libraryRecord({ id: 'b' }), ...library.records];
  await act(() => hook.result.current.reload());
  expect(ids(hook)).toEqual(['b', 'a']);
});

test('a failed refresh keeps the displayed images and reports the error', async () => {
  const library = fakeLibrary([libraryRecord()]);
  let fail = false;
  installApi({
    [LIST]: (...args) =>
      fail ? respond(502, m2.errors.storage) : library.routes[LIST](...args),
  });
  const hook = renderHook(() => useLibrary());
  await waitFor(() => expect(hook.result.current.images.status).toBe('ready'));
  fail = true;
  await act(() => hook.result.current.reload());
  expect(hook.result.current.images).toMatchObject({
    status: 'error',
    error: m2.errors.storage.detail,
  });
  expect(ids(hook)).toEqual(['fixture-image-1']);
  // Recovering clears the error.
  fail = false;
  await act(() => hook.result.current.reload());
  expect(hook.result.current.images).toMatchObject({
    status: 'ready',
    error: null,
  });
});

test('a first read that cannot connect is an error with nothing to show', async () => {
  installApi({ [LIST]: networkFailure });
  const hook = renderHook(() => useLibrary());
  await waitFor(() => expect(hook.result.current.images.status).toBe('error'));
  expect(hook.result.current.images.items).toEqual([]);
  expect(hook.result.current.images.error).toBe('The API is unreachable.');
});

test('delete removes exactly that identity and sends it to the server', async () => {
  const keep = libraryRecord({ id: 'keep' });
  const gone = libraryRecord({ id: 'gone' });
  // Same id and title, different storage: a different image.
  const lookalike = libraryRecord({ id: 'gone', storage_id: 'local-1' });
  const library = fakeLibrary([keep, gone, lookalike]);
  installApi(library.routes);
  const hook = renderHook(() => useLibrary());
  await waitFor(() => expect(ids(hook)).toHaveLength(3));
  let failure;
  await act(async () => {
    failure = await hook.result.current.remove(gone);
  });
  expect(failure).toBeNull();
  expect(library.deleted).toEqual([
    { storage_id: 'local-0', filename: 'gone.png' },
  ]);
  expect(hook.result.current.images.items.map(imageKey)).toEqual([
    'local-0/keep.png',
    'local-1/gone.png',
  ]);
});

test('a failed delete leaves the library untouched and returns the reason', async () => {
  const record = libraryRecord();
  const library = fakeLibrary([record]);
  installApi({
    ...library.routes,
    [DELETE]: () => respond(502, m2.errors.storage),
  });
  const hook = renderHook(() => useLibrary());
  await waitFor(() => expect(ids(hook)).toHaveLength(1));
  let failure;
  await act(async () => {
    failure = await hook.result.current.remove(record);
  });
  expect(failure).toBe(m2.errors.storage.detail);
  expect(ids(hook)).toEqual([record.id]);
});

test('a read started before a delete cannot bring the image back', async () => {
  const record = libraryRecord();
  const library = fakeLibrary([record]);
  let release;
  let stale = false;
  installApi({
    ...library.routes,
    [LIST]: (...args) => {
      if (!stale) return library.routes[LIST](...args);
      const snapshot = library.body();
      return new Promise((resolve) => {
        release = () => resolve(respond(200, snapshot, { ETag: '"old"' }));
      });
    },
  });
  const hook = renderHook(() => useLibrary());
  await waitFor(() => expect(ids(hook)).toHaveLength(1));
  stale = true;
  let reading;
  act(() => {
    reading = hook.result.current.reload();
  });
  await act(async () => {
    await hook.result.current.remove(record);
  });
  await act(async () => {
    release?.();
    await reading;
  });
  expect(ids(hook)).toEqual([]);
});

test('inserting a saved record shows it at once and forgets the old ETag', async () => {
  const library = fakeLibrary([libraryRecord({ id: 'a' })]);
  const api = installApi(library.routes);
  const hook = renderHook(() => useLibrary());
  await waitFor(() => expect(ids(hook)).toEqual(['a']));
  const saved = libraryRecord({ id: 'b' });
  act(() => hook.result.current.insert(saved));
  expect(ids(hook)).toEqual(['b', 'a']);
  library.records = [saved, ...library.records];
  await act(() => hook.result.current.reload());
  // The post-insert read is unconditional, so it cannot 304 over a new record.
  expect(api.called(LIST).at(-1).headers['If-None-Match']).toBeUndefined();
  expect(ids(hook)).toEqual(['b', 'a']);
});
