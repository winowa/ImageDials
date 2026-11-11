import { act, renderHook, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { expect, test, vi } from 'vitest';

import { createCacheStore } from './cacheStore.js';
import { PRIVATE_TOMBSTONE_LIMIT } from './cachePrivate.js';
import { DEFAULT_CLIENT_POLICY } from '../api/clientPolicy.js';
import {
  deferred,
  imageBlob,
  memoryChannels,
  memoryDb,
  quotaError,
  scriptedStore,
} from '../../../tests/helpers/cacheTestSupport.js';
import { createUrlLedger } from '../media/objectUrls.js';
import {
  poolFullMessage,
  storageLabel,
  STORAGE_STATE,
  usePrivateHistory,
} from './privateHistory.js';

const limits = {
  ...DEFAULT_CLIENT_POLICY.cache,
  sharedRecordLimit: 10,
  sharedVariantLimit: 10,
  sharedVariantMaxBytes: 1000,
  privateRecordLimit: 3,
  privateMaxBytes: 100,
};
const result = (id, extra = {}) => ({
  id,
  image_id: id,
  storage_id: 'local-0',
  filename: `${id}.png`,
  visibility: 'private',
  image_url: `/api/images/${id}/content`,
  safe: false,
  count: 0,
  unknown_future_field: { keep: [false, 0, null] },
  created_at: 1,
  ...extra,
});

/** A URL API that records which object URLs are live. */
function urlLog() {
  let next = 0;
  const log = { live: new Set(), revoked: [] };
  const api = {
    createObjectURL: () => {
      next += 1;
      log.live.add(`blob:t-${next}`);
      return `blob:t-${next}`;
    },
    revokeObjectURL: (url) => {
      log.live.delete(url);
      log.revoked.push(url);
    },
  };
  return { api, log };
}

function setup({ store, wrapper, ...overrides } = {}) {
  const db = memoryDb();
  const real = store ?? createCacheStore(db, limits);
  const { api, log } = urlLog();
  const urls = createUrlLedger(api);
  const original = imageBlob(20);
  const options = {
    store: real,
    urls,
    limits,
    enabled: true,
    fetchBlob: vi.fn(async () => original),
    thumbnail: vi.fn(async () => imageBlob(4, 'image/jpeg')),
    digest: vi.fn(async () => null),
    ...overrides,
  };
  const hook = renderHook(
    (props) => usePrivateHistory({ ...options, ...props }),
    {
      wrapper,
    },
  );
  return { hook, db, store: real, urls, log, original, options };
}
const ids = (hook) => hook.result.current.items.map((item) => item.id);
const settled = (hook, id) =>
  hook.result.current.items.find((item) => item.id === id)?.local_storage
    ?.state;

test('a result shows at once from its server URL, then its original and thumbnail are stored', async () => {
  const { hook, store, original, options } = setup();
  await waitFor(() => expect(hook.result.current.status).toBe('ready'));
  const wire = result('a');
  let view;
  act(() => {
    view = hook.result.current.add(wire, { origin: 'generated' });
  });
  expect(view.image_url).toBe('/api/images/a/content');
  expect(view.local_origin).toBe('generated');
  expect(ids(hook)).toEqual(['a']);

  await waitFor(() => expect(settled(hook, 'a')).toBe(STORAGE_STATE.STORED));
  expect(options.fetchBlob).toHaveBeenCalledWith('/api/images/a/content');
  const [stored] = await store.loadPrivate();
  expect(stored.full).toBe(original); // verbatim, never re-encoded
  expect(stored.thumbnail.type).toBe('image/jpeg');
  // The persisted snapshot is the wire record: falsy and unknown fields intact,
  // no client markers, no blob URL.
  expect(stored.record).toEqual(wire);
  expect(JSON.stringify(stored.record)).not.toContain('blob:');
  expect(stored.record).not.toHaveProperty('local_origin');
});

test('after a reload the stored bytes are shown from object URLs, each shown image once', async () => {
  const first = setup();
  await waitFor(() => expect(first.hook.result.current.status).toBe('ready'));
  act(() => {
    first.hook.result.current.add(result('gen'), { origin: 'generated' });
  });
  await waitFor(() => expect(settled(first.hook, 'gen')).toBe('stored'));
  first.hook.unmount();

  const file = imageBlob(9);
  const second = setup({ store: createCacheStore(first.db, limits) });
  await waitFor(() => expect(second.hook.result.current.status).toBe('ready'));
  act(() => {
    second.hook.result.current.add(
      { id: 'imp', title: 'Imported', safe: false, count: 0, image_url: '' },
      { origin: 'imported', blob: file, url: second.urls.acquire(file) },
    );
  });
  await waitFor(() => expect(settled(second.hook, 'imp')).toBe('stored'));
  second.hook.unmount();

  const third = setup({ store: createCacheStore(first.db, limits) });
  await waitFor(() => expect(ids(third.hook)).toEqual(['imp', 'gen']));
  const [imported, generated] = third.hook.result.current.items;
  expect(imported.image_url).toMatch(/^blob:/);
  expect(imported.storage_type).toBe('browser-upload');
  expect(imported.safe).toBe(false);
  expect(imported.count).toBe(0);
  expect(generated.image_url).toMatch(/^blob:/);
  expect(generated.local_thumbnail_url).toMatch(/^blob:/);
  expect(third.options.fetchBlob).not.toHaveBeenCalled();
});

test('a fetch failure keeps the record and its URL, says so, and a retry stores it', async () => {
  const fetchBlob = vi
    .fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue(imageBlob(20));
  const { hook, store } = setup({ fetchBlob });
  await waitFor(() => expect(hook.result.current.status).toBe('ready'));
  act(() => {
    hook.result.current.add(result('a'), { origin: 'generated' });
  });
  await waitFor(() => expect(settled(hook, 'a')).toBe('not-stored'));
  const [view] = hook.result.current.items;
  expect(view.image_url).toBe('/api/images/a/content');
  expect(view.local_storage).toMatchObject({
    reason: 'fetch',
    retryable: true,
  });
  // The original could not be fetched, so nothing is held: the link only.
  expect(view.local_storage.held).toBe(false);
  expect(storageLabel(view.local_storage)).toMatch(/Only the server link/);
  expect(hook.result.current.notice).toMatch(/server link/);
  expect((await store.loadPrivate())[0].full).toBeNull();

  act(() => hook.result.current.retry(view));
  await waitFor(() => expect(settled(hook, 'a')).toBe('stored'));
  expect((await store.loadPrivate())[0].full.size).toBe(20);
  expect(hook.result.current.notice).toBeNull();
});

test('a checksum mismatch is not stored; without crypto.subtle nothing is claimed verified', async () => {
  const mismatch = setup({ digest: vi.fn(async () => 'beef') });
  await waitFor(() =>
    expect(mismatch.hook.result.current.status).toBe('ready'),
  );
  act(() => {
    mismatch.hook.result.current.add(result('a', { sha256: 'ABCD' }), {
      origin: 'generated',
    });
  });
  await waitFor(() => expect(settled(mismatch.hook, 'a')).toBe('not-stored'));
  expect(mismatch.hook.result.current.items[0].local_storage).toMatchObject({
    reason: 'checksum',
    retryable: false,
  });
  expect((await mismatch.store.loadPrivate())[0].full).toBeNull();

  const plain = setup({ digest: vi.fn(async () => null) });
  await waitFor(() => expect(plain.hook.result.current.status).toBe('ready'));
  act(() => {
    plain.hook.result.current.add(result('b', { sha256: 'ABCD' }), {
      origin: 'generated',
    });
  });
  await waitFor(() => expect(settled(plain.hook, 'b')).toBe('stored'));
});

test('removing during capture cannot be undone by the late bytes', async () => {
  const body = deferred();
  const fetchBlob = vi.fn(() => body.promise);
  const { hook, store, options } = setup({ fetchBlob });
  await waitFor(() => expect(hook.result.current.status).toBe('ready'));
  let view;
  act(() => {
    view = hook.result.current.add(result('a'), { origin: 'generated' });
  });
  await waitFor(() => expect(fetchBlob).toHaveBeenCalled());
  let failure;
  await act(async () => {
    failure = await hook.result.current.remove(view);
  });
  expect(failure).toBeNull();
  expect(ids(hook)).toEqual([]);
  await act(async () => body.resolve(imageBlob(20)));
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(await store.loadPrivate()).toEqual([]);
  expect(ids(hook)).toEqual([]);
  expect(options.thumbnail).not.toHaveBeenCalled();
});

test('a removal the database cannot confirm keeps the entry and reports the error', async () => {
  const { hook, db, store } = setup();
  await waitFor(() => expect(hook.result.current.status).toBe('ready'));
  act(() => {
    hook.result.current.add(result('a'), { origin: 'generated' });
  });
  await waitFor(() => expect(settled(hook, 'a')).toBe('stored'));
  db.failNext(new Error('storage is locked'));
  let failure;
  await act(async () => {
    failure = await hook.result.current.remove(hook.result.current.items[0]);
  });
  expect(failure).toBe('storage is locked');
  expect(ids(hook)).toEqual(['a']);
  expect(await store.loadPrivate()).toHaveLength(1);
});

test('quota: the record stays in memory, is not claimed saved, and nothing older is erased', async () => {
  const { hook, db, store } = setup();
  await waitFor(() => expect(hook.result.current.status).toBe('ready'));
  act(() => {
    hook.result.current.add(result('old'), { origin: 'generated' });
  });
  await waitFor(() => expect(settled(hook, 'old')).toBe('stored'));
  const mediaWrite = (names) => names.includes('privateMedia');
  // The recovery row and the original each fail twice (write, then the retry).
  for (let i = 0; i < 4; i += 1) db.failNext(quotaError(), mediaWrite);
  act(() => {
    hook.result.current.add(result('new'), { origin: 'generated' });
  });
  await waitFor(() => expect(settled(hook, 'new')).toBe('not-stored'));
  expect(
    hook.result.current.items.find((i) => i.id === 'new').local_storage,
  ).toMatchObject({ reason: 'quota', retryable: true });
  expect(ids(hook)).toEqual(['new', 'old']);
  // Neither the failed add nor its retry erased the earlier private copy.
  expect(
    (await store.loadPrivate()).map((row) => row.full?.size ?? null),
  ).toEqual([20]);
});

const importNow = (hook, urls, id, bytes = 5, extra = {}) => {
  const file = imageBlob(bytes);
  const url = urls.acquire(file);
  let view;
  act(() => {
    view = hook.result.current.add(
      { id, title: id, ...extra },
      { origin: 'imported', blob: file, url },
    );
  });
  urls.release(url); // the import preview lets go; the history holds its own
  return { file, url, view };
};
const stateOf = (hook, id) =>
  hook.result.current.items.find((item) => item.id === id)?.local_storage;

test('over the record limit nothing older is removed; the new import is held, labelled, and stored once room appears', async () => {
  const { hook, urls, log, store } = setup();
  await waitFor(() => expect(hook.result.current.status).toBe('ready'));
  const made = [];
  for (const id of ['a', 'b', 'c']) {
    made.push(importNow(hook, urls, id));
    await waitFor(() => expect(settled(hook, id)).toBe('stored'));
  }
  const over = importNow(hook, urls, 'd', 7);
  await waitFor(() => expect(settled(hook, 'd')).toBe('not-stored'));
  expect(ids(hook)).toEqual(['d', 'c', 'b', 'a']);
  expect(stateOf(hook, 'd')).toMatchObject({
    reason: 'record-limit',
    retryable: true,
    held: true,
  });
  expect(storageLabel(stateOf(hook, 'd'))).toMatch(/held in this tab only/i);
  expect(hook.result.current.notice).toMatch(/lost when this tab closes/);
  // Every older original is still stored, byte for byte, and nothing is revoked.
  const rows = await store.loadPrivate();
  expect(rows.map((row) => row.record.id)).toEqual(['c', 'b', 'a']);
  expect(rows.map((row) => row.full)).toEqual(
    made.map((m) => m.file).reverse(),
  );
  expect(log.revoked).toEqual([]);

  // A confirmed removal frees room and the held import is stored without a click.
  await act(async () => {
    await hook.result.current.remove(hook.result.current.items[3]);
  });
  await waitFor(() => expect(settled(hook, 'd')).toBe('stored'));
  expect((await store.readPrivate(over.view.id)).full).toBe(over.file);
  expect(hook.result.current.notice).toBeNull();
});

test('a held import older than compacted removals stays held and is truthfully not stored', async () => {
  const { hook, urls, db, store } = setup();
  await waitFor(() => expect(hook.result.current.status).toBe('ready'));
  for (const id of ['a', 'b', 'c']) {
    importNow(hook, urls, id);
    await waitFor(() => expect(settled(hook, id)).toBe('stored'));
  }
  const over = importNow(hook, urls, 'd', 7);
  await waitFor(() => expect(settled(hook, 'd')).toBe('not-stored'));
  // Another tab confirms more removals than tombstones are kept, all newer
  // than the held import, so the removal fence passes it.
  const otherTab = createCacheStore(db, limits);
  const newer = Date.now() + 60_000;
  for (let n = 0; n <= PRIVATE_TOMBSTONE_LIMIT + 1; n += 1)
    expect(await otherTab.removePrivate(`gone-${n}`, newer + n)).toEqual({
      removed: true,
    });

  await act(async () => {
    await hook.result.current.remove(hook.result.current.items[3]);
  });
  await waitFor(() =>
    expect(stateOf(hook, 'd')).toMatchObject({ reason: 'removal-fenced' }),
  );
  expect(stateOf(hook, 'd')).toMatchObject({
    state: 'not-stored',
    retryable: false,
    held: true,
  });
  expect(storageLabel(stateOf(hook, 'd'))).toMatch(/held in this tab only/i);
  // Never retimed into a new add, and the held bytes are still the import's.
  expect(await store.readPrivate(over.view.id)).toBeNull();
  expect(
    hook.result.current.items.find((item) => item.id === 'd').image_url,
  ).toBe(over.url);
});

test('a held original blocks unload only until it is no longer held', async () => {
  const refusing = setup({
    store: createCacheStore(memoryDb(), { ...limits, privateRecordLimit: 0 }),
  });
  const unloadBlocked = () => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };
  await waitFor(() =>
    expect(refusing.hook.result.current.status).toBe('ready'),
  );
  expect(unloadBlocked()).toBe(false);
  importNow(refusing.hook, refusing.urls, 'x');
  await waitFor(() => expect(settled(refusing.hook, 'x')).toBe('not-stored'));
  expect(unloadBlocked()).toBe(true);
  await act(async () => {
    await refusing.hook.result.current.remove(
      refusing.hook.result.current.items[0],
    );
  });
  expect(unloadBlocked()).toBe(false);
});

test('a stored original releases its held file and no longer blocks unload', async () => {
  const { hook, urls } = setup();
  await waitFor(() => expect(hook.result.current.status).toBe('ready'));
  importNow(hook, urls, 'a');
  await waitFor(() => expect(settled(hook, 'a')).toBe('stored'));
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
  expect(hook.result.current.unsavedCount).toBe(0);
});

test('an unsaved image that only has a server link never claims to hold a copy and does not guard unload', async () => {
  // The store is full and the 20-byte original exceeds the 10-byte pool.
  const tight = {
    ...limits,
    privateVolatileMaxBytes: 10,
    privateRecordLimit: 0,
  };
  const { hook } = setup({
    store: createCacheStore(memoryDb(), tight),
    limits: tight,
  });
  await waitFor(() => expect(hook.result.current.status).toBe('ready'));
  act(() => {
    hook.result.current.add(result('a'), { origin: 'generated' });
  });
  await waitFor(() => expect(settled(hook, 'a')).toBe('not-stored'));
  const storage = stateOf(hook, 'a');
  expect(storage).toMatchObject({ reason: 'record-limit', held: false });
  expect(storageLabel(storage)).toMatch(/Only the server link remains/);
  expect(storageLabel(storage)).not.toMatch(/copy is held/);
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
  // It still takes a slot of the pool.
  expect(hook.result.current.unsavedCount).toBe(1);
});

test('the pool refuses new work when no slot is free, an import without changing anything', async () => {
  const small = {
    ...limits,
    privateRecordLimit: 0,
    privateVolatileRecordLimit: 2,
  };
  const { hook, urls, log } = setup({
    store: createCacheStore(memoryDb(), small),
    limits: small,
  });
  await waitFor(() => expect(hook.result.current.status).toBe('ready'));
  expect(hook.result.current.admissionBlock('generating')).toBeNull();
  importNow(hook, urls, 'a');
  importNow(hook, urls, 'b');
  await waitFor(() => expect(settled(hook, 'b')).toBe('not-stored'));
  await waitFor(() => expect(settled(hook, 'a')).toBe('not-stored'));
  expect(hook.result.current.admissionBlock('generating')).toBe(
    poolFullMessage(2, 'generating'),
  );
  expect(hook.result.current.admissionBlock('importing', 5)).toBe(
    poolFullMessage(2, 'importing'),
  );
  // A third import is refused outright: nothing listed, no URL retained.
  const file = imageBlob(5);
  const url = urls.acquire(file);
  let view = 'unset';
  act(() => {
    view = hook.result.current.add(
      { id: 'c', title: 'c' },
      { origin: 'imported', blob: file, url },
    );
  });
  expect(view).toBeNull();
  expect(ids(hook)).toEqual(['b', 'a']);
  urls.release(url);
  expect(log.live.has(url)).toBe(false);
  expect(hook.result.current.oldestUnsaved()).toBe('a');
});

test('an unexpected result with a full pool is kept as a link and displaces no held original', async () => {
  const small = {
    ...limits,
    privateRecordLimit: 0,
    privateVolatileRecordLimit: 1,
  };
  const { hook, urls } = setup({
    store: createCacheStore(memoryDb(), small),
    limits: small,
  });
  await waitFor(() => expect(hook.result.current.status).toBe('ready'));
  const held = importNow(hook, urls, 'held');
  await waitFor(() => expect(settled(hook, 'held')).toBe('not-stored'));
  act(() => {
    hook.result.current.add(result('late'), { origin: 'generated' });
  });
  await waitFor(() => expect(settled(hook, 'late')).toBe('not-stored'));
  expect(stateOf(hook, 'late').held).toBe(false);
  expect(stateOf(hook, 'held').held).toBe(true);
  expect(held.view.id).toBe('held');
  expect(ids(hook)).toEqual(['late', 'held']);
});

test('without storage an import is held in the tab and a generated result is fetched and held; neither is called stored', async () => {
  const store = scriptedStore({ durable: false });
  const { hook, urls } = setup({ store });
  await waitFor(() => expect(hook.result.current.status).toBe('ready'));
  expect(hook.result.current.notice).toMatch(/until this tab closes/);
  importNow(hook, urls, 'imp');
  expect(stateOf(hook, 'imp')).toEqual({
    state: STORAGE_STATE.MEMORY,
    held: true,
  });
  act(() => {
    hook.result.current.add(result('gen'), { origin: 'generated' });
  });
  await waitFor(() => expect(stateOf(hook, 'gen').state).toBe('memory'));
  expect(stateOf(hook, 'gen').held).toBe(true);
  expect(storageLabel(stateOf(hook, 'gen'))).toMatch(/Held in this tab only/);
  expect(store.hydrate).not.toHaveBeenCalled();
});

test('without storage a result whose bytes cannot be fetched says only the link remains', async () => {
  const store = scriptedStore({ durable: false });
  const { hook } = setup({
    store,
    fetchBlob: vi.fn(async () => {
      throw new Error('offline');
    }),
  });
  await waitFor(() => expect(hook.result.current.status).toBe('ready'));
  act(() => {
    hook.result.current.add(result('gen'), { origin: 'generated' });
  });
  await waitFor(() => expect(stateOf(hook, 'gen').held).toBe(false));
  expect(storageLabel(stateOf(hook, 'gen'))).toMatch(/Only the server link/);
  expect(stateOf(hook, 'gen').state).toBe('memory');
});

test('a failed import write is retried from the held file and stores it', async () => {
  const { hook, urls, db, store } = setup();
  await waitFor(() => expect(hook.result.current.status).toBe('ready'));
  db.failNext(new Error('disk said no'), (names) =>
    names.includes('privateMedia'),
  );
  const made = importNow(hook, urls, 'a', 9);
  await waitFor(() => expect(settled(hook, 'a')).toBe('not-stored'));
  expect(stateOf(hook, 'a')).toMatchObject({ reason: 'failed', held: true });
  expect(await store.loadPrivate()).toEqual([]);
  act(() => hook.result.current.retry(made.view));
  await waitFor(() => expect(settled(hook, 'a')).toBe('stored'));
  expect((await store.readPrivate('a')).full).toBe(made.file);
});

test('a retry re-admits a row that never reached storage and then attaches the bytes', async () => {
  const { hook, db, store } = setup();
  await waitFor(() => expect(hook.result.current.status).toBe('ready'));
  // Both the metadata row and the first media write fail.
  db.failNext(new Error('first'));
  db.failNext(new Error('second'));
  act(() => {
    hook.result.current.add(result('a'), { origin: 'generated' });
  });
  await waitFor(() => expect(settled(hook, 'a')).toBe('not-stored'));
  expect(await store.loadPrivate()).toEqual([]);
  expect(stateOf(hook, 'a').held).toBe(true);
  act(() => hook.result.current.retry(hook.result.current.items[0]));
  await waitFor(() => expect(settled(hook, 'a')).toBe('stored'));
  expect((await store.loadPrivate())[0].full.size).toBe(20);
});

test('a duplicate stored by another tab is adopted, never overwritten', async () => {
  const db = memoryDb();
  const other = createCacheStore(db, limits);
  const theirs = imageBlob(33);
  await other.admitPrivate({
    record: result('a'),
    origin: 'generated',
    addedAt: 5,
    full: theirs,
  });
  const { hook, store } = setup({ store: createCacheStore(db, limits) });
  await waitFor(() => expect(hook.result.current.status).toBe('ready'));
  // Added before this tab's own read could have seen the other tab's row.
  expect(ids(hook)).toEqual(['a']);
  const rows = await store.loadPrivate();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ addedAt: 5 });
  expect(rows[0].full).toBe(theirs);
});

test('a same-key add racing a stored row adopts its addedAt and attaches our bytes to it', async () => {
  const db = memoryDb();
  const other = createCacheStore(db, limits);
  await other.admitPrivate({
    record: result('a'),
    origin: 'generated',
    addedAt: 5,
  });
  const mine = createCacheStore(db, limits);
  const { hook, store } = setup({ store: mine, enabled: false });
  act(() => {
    hook.result.current.add(result('a'), { origin: 'generated' });
  });
  await waitFor(() => expect(settled(hook, 'a')).toBe('stored'));
  const [row] = await store.loadPrivate();
  expect(row.addedAt).toBe(5);
  expect(row.full.size).toBe(20);
});

test('another tab removing a stored image drops it here; a held image is never dropped by a read', async () => {
  const db = memoryDb();
  const openChannel = memoryChannels();
  const tabA = createCacheStore(db, limits, { openChannel });
  const tabB = createCacheStore(db, limits, { openChannel });
  const { hook, urls } = setup({ store: tabA });
  await waitFor(() => expect(hook.result.current.status).toBe('ready'));
  importNow(hook, urls, 'kept');
  await waitFor(() => expect(settled(hook, 'kept')).toBe('stored'));
  const [row] = await tabA.loadPrivate();
  await act(async () => {
    await tabB.removePrivate('kept', row.addedAt);
  });
  await waitFor(() => expect(ids(hook)).toEqual([]));
  // Another tab storing something new shows up here too.
  await act(async () => {
    await tabB.admitPrivate({
      record: { id: 'theirs', title: 'theirs' },
      origin: 'imported',
      addedAt: 99,
      full: imageBlob(4),
    });
  });
  await waitFor(() => expect(ids(hook)).toEqual(['theirs']));
});

test('a read cannot drop an entry that was stored after the read began', async () => {
  const db = memoryDb();
  const openChannel = memoryChannels();
  const tabA = createCacheStore(db, limits, { openChannel });
  const tabB = createCacheStore(db, limits, { openChannel });
  const gate = deferred();
  const slowRead = vi.spyOn(tabA, 'loadPrivate');
  const { hook, urls } = setup({ store: tabA });
  await waitFor(() => expect(hook.result.current.status).toBe('ready'));
  // The next read hangs until released: it will not contain what we store now.
  slowRead.mockImplementationOnce(async () => {
    await gate.promise;
    return [];
  });
  await act(async () => {
    await tabB.admitPrivate({
      record: { id: 'x', title: 'x' },
      origin: 'imported',
      addedAt: 3,
      full: imageBlob(2),
    });
  });
  importNow(hook, urls, 'fresh');
  await waitFor(() => expect(settled(hook, 'fresh')).toBe('stored'));
  await act(async () => gate.resolve());
  await waitFor(() => expect(slowRead).toHaveBeenCalled());
  expect(ids(hook)).toContain('fresh');
});

test('held entries are stored oldest first and promotion stops at the first refusal', async () => {
  const two = { ...limits, privateRecordLimit: 2 };
  const { hook, urls, store } = setup({
    store: createCacheStore(memoryDb(), two),
    limits: two,
  });
  await waitFor(() => expect(hook.result.current.status).toBe('ready'));
  for (const id of ['a', 'b']) {
    importNow(hook, urls, id);
    await waitFor(() => expect(settled(hook, id)).toBe('stored'));
  }
  for (const id of ['c', 'd']) {
    importNow(hook, urls, id);
    await waitFor(() => expect(settled(hook, id)).toBe('not-stored'));
  }
  await act(async () => {
    await hook.result.current.remove(
      hook.result.current.items.find((item) => item.id === 'a'),
    );
  });
  await waitFor(() => expect(settled(hook, 'c')).toBe('stored'));
  await waitFor(() => expect(settled(hook, 'd')).toBe('not-stored'));
  expect((await store.loadPrivate()).map((row) => row.record.id)).toEqual([
    'c',
    'b',
  ]);
});

test('lowered limits list every stored image and refuse only new admission', async () => {
  const db = memoryDb();
  const wide = createCacheStore(db, { ...limits, privateRecordLimit: 10 });
  for (const [id, at] of [
    ['a', 1],
    ['b', 2],
    ['c', 3],
    ['d', 4],
    ['e', 5],
  ])
    await wide.admitPrivate({
      record: { id, title: id },
      origin: 'imported',
      addedAt: at,
      full: imageBlob(10),
    });
  // The hook runs with privateRecordLimit 3 and 100 bytes against 5 rows.
  const { hook, urls } = setup({ store: createCacheStore(db, limits) });
  await waitFor(() => expect(ids(hook)).toEqual(['e', 'd', 'c', 'b', 'a']));
  importNow(hook, urls, 'new');
  await waitFor(() => expect(settled(hook, 'new')).toBe('not-stored'));
  expect(ids(hook)).toEqual(['new', 'e', 'd', 'c', 'b', 'a']);
  expect((await wide.loadPrivate()).map((row) => row.record.id)).toEqual([
    'e',
    'd',
    'c',
    'b',
    'a',
  ]);
});

test('object URLs survive React StrictMode and are revoked only after the last owner leaves', async () => {
  const first = setup();
  await waitFor(() => expect(first.hook.result.current.status).toBe('ready'));
  act(() => {
    first.hook.result.current.add(result('a'), { origin: 'generated' });
  });
  await waitFor(() => expect(settled(first.hook, 'a')).toBe('stored'));
  first.hook.unmount();

  const second = setup({
    store: createCacheStore(first.db, limits),
    wrapper: StrictMode,
  });
  await waitFor(() => expect(ids(second.hook)).toEqual(['a']));
  const shown = second.hook.result.current.items[0];
  expect(second.log.live.has(shown.image_url)).toBe(true);
  expect(second.log.live.has(shown.local_thumbnail_url)).toBe(true);

  let failure;
  await act(async () => {
    failure = await second.hook.result.current.remove(shown);
  });
  expect(failure).toBeNull();
  await waitFor(() => expect(second.log.live.size).toBe(0));
  expect(second.log.revoked).toEqual(
    expect.arrayContaining([shown.image_url, shown.local_thumbnail_url]),
  );
});

test('a generated entry stored without bytes is fetched once on the next load', async () => {
  const first = setup({
    fetchBlob: vi.fn(async () => {
      throw new Error('down');
    }),
  });
  await waitFor(() => expect(first.hook.result.current.status).toBe('ready'));
  act(() => {
    first.hook.result.current.add(result('a'), { origin: 'generated' });
  });
  await waitFor(() => expect(settled(first.hook, 'a')).toBe('not-stored'));
  first.hook.unmount();

  const second = setup({ store: createCacheStore(first.db, limits) });
  await waitFor(() => expect(settled(second.hook, 'a')).toBe('stored'));
  expect(second.options.fetchBlob).toHaveBeenCalledTimes(1);
});
