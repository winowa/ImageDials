import { Blob as ByteBlob } from 'node:buffer';
import { createHash } from 'node:crypto';
import { expect, test, vi } from 'vitest';

import { STORE } from './cacheDb.js';
import { createCacheStore } from './cacheStore.js';
import {
  deferred,
  memoryDb,
  quotaError,
} from '../../../tests/helpers/cacheTestSupport.js';
import { DEFAULT_CLIENT_POLICY } from '../api/clientPolicy.js';
import {
  createReferenceAssetsStore,
  REFERENCE_ASSET_STATE_KEY,
} from './referenceAssets.js';

const hash = (n) => n.toString(16).padStart(64, '0');
const file = (n = 1, size = 8) => ({
  sha256: hash(n),
  blob: new Blob([new Uint8Array(size).fill(n)], { type: 'image/png' }),
  name: `reference-${n}.png`,
  description: `Description ${n}`,
  dimensions: { width: 4, height: 2 },
});
const setup = (options = {}) => {
  const db = memoryDb();
  const store = createReferenceAssetsStore(db, {
    getLimits: () => ({ referenceRecordLimit: 2, referenceMaxBytes: 16 }),
    digest: async () => null,
    openChannel: () => null,
    ...options,
  });
  return { db, store };
};
const keep = async (store, candidate = file()) =>
  store.keep(await store.beginKeep(), candidate);

test('stored reference bytes and allowlisted metadata survive a new store owner', async () => {
  const { db, store } = setup();
  const candidate = {
    ...file(),
    url: 'blob:transient-only',
    providerHeader: 'not-persisted',
    record: { unknown: false },
  };
  expect(await keep(store, candidate)).toMatchObject({ persisted: true });
  const reloaded = createReferenceAssetsStore(db);
  const read = await reloaded.read(candidate.sha256);
  expect(read.blob).toBe(candidate.blob);
  expect(read).toMatchObject({
    sha256: candidate.sha256,
    name: candidate.name,
    description: candidate.description,
    dimensions: candidate.dimensions,
    bytes: 8,
  });
  expect(read).not.toHaveProperty('url');
  expect(read).not.toHaveProperty('record');
  expect(read).not.toHaveProperty('providerHeader');
});

test('listing metadata never reads or scans the media store', async () => {
  const { db, store } = setup();
  await keep(store);
  const run = vi.spyOn(db, 'run');
  const listing = await store.list();
  expect(listing.items).toHaveLength(1);
  expect(listing.items[0]).not.toHaveProperty('blob');
  expect(listing.usage).toMatchObject({ count: 1, bytes: 8, maxBytes: 16 });
  expect(run).toHaveBeenCalledOnce();
  expect(run.mock.calls[0][0]).not.toContain(STORE.REFERENCE_MEDIA);
});

test('exact count and byte budgets fit and the next write evicts nothing', async () => {
  const { db, store } = setup();
  const first = file(1);
  await keep(store, first);
  expect(await keep(store, file(2))).toMatchObject({ persisted: true });
  expect(await keep(store, file(3))).toEqual({
    persisted: false,
    reason: 'record-limit',
  });
  expect((await store.read(first.sha256)).blob).toBe(first.blob);
  expect(db.data.get(STORE.REFERENCE_MEDIA).size).toBe(2);
});

test('oversize writes fail without deleting an existing original', async () => {
  const { store } = setup();
  await keep(store);
  expect(await keep(store, file(2, 17))).toEqual({
    persisted: false,
    reason: 'byte-limit',
  });
  expect((await store.list()).usage.bytes).toBe(8);
});

test('lowered limits keep every old reference readable and refuse new admission', async () => {
  let limits = { referenceRecordLimit: 2, referenceMaxBytes: 16 };
  const { store } = setup({ getLimits: () => limits });
  await keep(store, file(1));
  await keep(store, file(2));
  limits = { referenceRecordLimit: 1, referenceMaxBytes: 4 };
  expect((await store.list()).items).toHaveLength(2);
  expect((await store.read(hash(2))).blob.size).toBe(8);
  expect(await keep(store, file(3))).toMatchObject({ persisted: false });
  expect(await keep(store, file(1))).toMatchObject({
    persisted: true,
    duplicate: true,
  });
});

test('duplicate hashes adopt the original instead of replacing metadata or bytes', async () => {
  const { store } = setup();
  const first = file();
  const original = await keep(store, first);
  const second = await keep(store, { ...file(), name: 'other-name.png' });
  expect(second).toMatchObject({ persisted: true, duplicate: true });
  expect(second.entry).toEqual(original.entry);
  expect((await store.read(first.sha256)).blob).toBe(first.blob);
  expect((await store.list()).usage.count).toBe(1);
});

test('a duplicate can repair missing bytes without changing its identity', async () => {
  const { db, store } = setup();
  const saved = await keep(store);
  db.data.get(STORE.REFERENCE_MEDIA).delete(hash(1));
  await expect(store.read(hash(1))).rejects.toThrow('bytes are missing');
  const repaired = await keep(store);
  expect(repaired).toMatchObject({ persisted: true, duplicate: true });
  expect(repaired.entry.revision).toBe(saved.entry.revision);
  expect((await store.read(hash(1))).blob.size).toBe(8);
});

test('two owners racing for the last slot admit exactly one', async () => {
  const { db, store } = setup({
    getLimits: () => ({ referenceRecordLimit: 1, referenceMaxBytes: 16 }),
  });
  const other = createReferenceAssetsStore(db, {
    getLimits: () => ({ referenceRecordLimit: 1, referenceMaxBytes: 16 }),
    digest: async () => null,
  });
  const tickets = await Promise.all([store.beginKeep(), other.beginKeep()]);
  const results = await Promise.all([
    store.keep(tickets[0], file(1)),
    other.keep(tickets[1], file(2)),
  ]);
  expect(results.filter((r) => r.persisted)).toHaveLength(1);
  expect((await store.list()).usage).toMatchObject({ count: 1, bytes: 8 });
});

test('a removal fences a late keep even when its checksum finishes afterward', async () => {
  const gate = deferred();
  let delay = false;
  const { db, store } = setup({
    digest: () => (delay ? gate.promise : Promise.resolve(null)),
  });
  const saved = await keep(store);
  delay = true;
  const pending = store.keep(await store.beginKeep(), file(2));
  const other = createReferenceAssetsStore(db);
  expect(
    await other.remove(hash(1), { revision: saved.entry.revision }),
  ).toMatchObject({ removed: true });
  gate.resolve(null);
  expect(await pending).toEqual({ persisted: false, reason: 'changed' });
  expect((await other.list()).items).toEqual([]);
});

test('an old remove cannot delete a newly retained incarnation', async () => {
  const { store } = setup();
  const first = await keep(store);
  await store.remove(hash(1), { revision: first.entry.revision });
  const next = await keep(store);
  expect(next.entry.revision).not.toBe(first.entry.revision);
  expect(
    await store.remove(hash(1), { revision: first.entry.revision }),
  ).toEqual({ removed: false, reason: 'changed' });
  expect((await store.read(hash(1))).revision).toBe(next.entry.revision);
});

test('quota aborts the complete write and preserves previous rows and usage', async () => {
  const { db, store } = setup();
  await keep(store);
  const before = await store.list();
  const ticket = await store.beginKeep();
  db.failNext(quotaError());
  expect(await store.keep(ticket, file(2))).toEqual({
    persisted: false,
    reason: 'quota',
  });
  expect(await store.list()).toEqual(before);
  expect(await store.read(hash(2))).toBeNull();
  expect(db.data.get(STORE.REFERENCE_MEDIA).size).toBe(1);
});

test('failed removal rolls back the original, counter and late-write fence', async () => {
  const { db, store } = setup();
  const original = await keep(store);
  const ticket = await store.beginKeep();
  db.failNext(quotaError());
  expect(
    await store.remove(hash(1), { revision: original.entry.revision }),
  ).toMatchObject({ removed: false, reason: 'quota' });
  expect(await store.keep(ticket, file(2))).toMatchObject({ persisted: true });
  expect((await store.list()).usage).toMatchObject({ count: 2, bytes: 16 });
});

test('checksum mismatch and invalid inputs write nothing', async () => {
  const { store } = setup({ digest: async () => hash(99) });
  expect(await keep(store)).toEqual({
    persisted: false,
    reason: 'checksum-mismatch',
  });
  expect(await keep(store, { ...file(), sha256: 'not-a-hash' })).toMatchObject({
    reason: 'invalid',
  });
  expect(await keep(store, { ...file(), blob: new Blob(['x']) })).toMatchObject(
    { reason: 'invalid' },
  );
  expect((await store.list()).items).toEqual([]);
});

test('denied storage uses no second memory owner and honestly reports not stored', async () => {
  const store = createReferenceAssetsStore(null);
  expect(await store.beginKeep()).toBeNull();
  expect(await store.keep(null, file())).toEqual({
    persisted: false,
    reason: 'no-storage',
  });
  expect(await store.list()).toMatchObject({ durable: false, items: [] });
  expect(await store.read(hash(1))).toBeNull();
});

test('removal churn has bounded metadata and never touches private originals', async () => {
  const { db, store } = setup();
  const original = new Blob(['private original']);
  db.data.set(STORE.PRIVATE_MEDIA, new Map([['protected|full', original]]));
  const pending = await store.beginKeep();
  for (let n = 1; n <= 205; n++) {
    const saved = await keep(store, file(n));
    await store.remove(hash(n), { revision: saved.entry.revision });
  }
  expect(await store.keep(pending, file(999))).toMatchObject({
    reason: 'changed',
  });
  expect(db.data.get(STORE.META).size).toBe(1);
  expect(db.data.get(STORE.META).get(REFERENCE_ASSET_STATE_KEY).count).toBe(0);
  expect(db.data.get(STORE.PRIVATE_MEDIA).get('protected|full')).toBe(original);
});

test('cache owner exposes the reference store with current published limits', async () => {
  const db = memoryDb();
  const cache = createCacheStore(db, {
    ...DEFAULT_CLIENT_POLICY.cache,
    referenceRecordLimit: 2,
  });
  const blob = new ByteBlob(['x'], { type: 'image/png' });
  const sha256 = createHash('sha256').update('x').digest('hex');
  expect(
    await keep(cache.referenceAssets, { ...file(), sha256, blob }),
  ).toMatchObject({ persisted: true });
  cache.setLimits({ ...DEFAULT_CLIENT_POLICY.cache, referenceRecordLimit: 1 });
  expect(
    await keep(cache.referenceAssets, {
      ...file(2),
      sha256: createHash('sha256').update('y').digest('hex'),
      blob: new ByteBlob(['y'], { type: 'image/png' }),
    }),
  ).toMatchObject({ persisted: false, reason: 'record-limit' });
});

test('subscriptions notify on own commit and close the channel on unsubscribe', async () => {
  const channel = { postMessage: vi.fn(), close: vi.fn() };
  const { store } = setup({ openChannel: () => channel });
  const listener = vi.fn();
  const unsubscribe = store.subscribe(listener);
  await keep(store);
  expect(listener).toHaveBeenCalledOnce();
  expect(channel.postMessage).toHaveBeenCalledWith({ type: 'changed' });
  channel.onmessage({ data: { type: 'changed' } });
  expect(listener).toHaveBeenCalledTimes(2);
  unsubscribe();
  expect(channel.close).toHaveBeenCalledOnce();
});

test('a failing subscriber cannot turn a committed keep into a storage failure', async () => {
  const { store } = setup();
  const unsubscribe = store.subscribe(() => {
    throw new Error('observer failure');
  });
  expect(await keep(store)).toMatchObject({ persisted: true });
  expect((await store.list()).items).toHaveLength(1);
  unsubscribe();
});

test('a writer without local subscribers still broadcasts and closes its sender', async () => {
  const channel = { postMessage: vi.fn(), close: vi.fn() };
  const { store } = setup({ openChannel: () => channel });
  await keep(store);
  expect(channel.postMessage).toHaveBeenCalledWith({ type: 'changed' });
  expect(channel.close).toHaveBeenCalledOnce();
});
