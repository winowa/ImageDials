import { expect, test, vi } from 'vitest';
import { STORE } from './cacheDb.js';
import {
  memoryDb,
  imageBlob,
  quotaError,
} from '../../../tests/helpers/cacheTestSupport.js';
import {
  createDraftReferenceStore,
  planDraftSnapshot,
} from './draftReferenceStore.js';

const hash = (n) => String(n).padStart(64, '0');
const reference = (n, size = 32) => ({
  id: `file:${n}`,
  name: `${n}.png`,
  sha256: hash(n),
  blob: imageBlob(size),
  description: `Description ${n}`,
  prepared: true,
  dimensions: { width: 10, height: 20 },
});

test('attached and parked exact files, source lineage and originals survive store recreation', async () => {
  const db = memoryDb();
  const a = reference(1),
    b = reference(2);
  a.source = {
    sha256: hash(3),
    width: 20,
    height: 40,
    max_normalized_bytes: 6400000,
  };
  a.original = { blob: imageBlob(64) };
  const parked = {
    refs: [{ id: b.id, sha256: b.sha256 }],
    sources: new Map([[b.id, b]]),
  };
  expect(
    (await createDraftReferenceStore(db).save({ attached: [a], parked }, 0))
      .persisted,
  ).toBe(true);
  const saved = await createDraftReferenceStore(db).load();
  expect(saved.attached[0]).toMatchObject({
    name: a.name,
    sha256: a.sha256,
    source: a.source,
    prepared: true,
    description: a.description,
    dimensions: a.dimensions,
  });
  expect(await saved.attached[0].blob.arrayBuffer()).toEqual(
    await a.blob.arrayBuffer(),
  );
  expect(await saved.attached[0].original.blob.arrayBuffer()).toEqual(
    await a.original.blob.arrayBuffer(),
  );
  expect(saved.parked[0]).toMatchObject({
    name: b.name,
    sha256: b.sha256,
    description: b.description,
  });
  expect(saved.parked[0].blob).toBe(b.blob);
});

test('budget keeps model copies ahead of originals, deduplicates and reports omissions', async () => {
  const a = reference(1),
    b = reference(2);
  a.source = { sha256: hash(3), width: 20, height: 40 };
  a.original = { blob: imageBlob(80) };
  const plan = planDraftSnapshot(
    { attached: [a, b], parked: { refs: [b] } },
    64,
  );
  expect(plan.bytes).toBe(64);
  expect(plan.omitted).toBe(0);
  expect(plan.originalsOmitted).toBe(1);
  const store = createDraftReferenceStore(memoryDb(), { maxBytes: 32 });
  expect(await store.save({ attached: [a, b] }, 0)).toMatchObject({
    persisted: true,
    omitted: 1,
    originalsOmitted: 1,
  });
  expect((await store.load()).attached.map((row) => Boolean(row.blob))).toEqual(
    [true, false],
  );
});

test('clear advances epoch and rejects delayed writes without touching explicitly kept files', async () => {
  const db = memoryDb(),
    store = createDraftReferenceStore(db);
  await db.run([STORE.REFERENCE_MEDIA], 'readwrite', (access) =>
    access.put(STORE.REFERENCE_MEDIA, 'kept', imageBlob()),
  );
  await store.save({ attached: [reference(1)] }, 0);
  const old = await store.load();
  expect(await store.clear()).toMatchObject({ cleared: true, epoch: 1 });
  expect(
    await store.save({ attached: [reference(2)] }, old.epoch),
  ).toMatchObject({ persisted: false, reason: 'changed' });
  expect((await createDraftReferenceStore(db).load()).attached).toEqual([]);
  expect(db.data.get(STORE.REFERENCE_MEDIA).has('kept')).toBe(true);
});

test('quota commits current manifest with honest missing slots instead of reviving older order', async () => {
  const db = memoryDb(),
    store = createDraftReferenceStore(db);
  await store.save({ attached: [reference(1), reference(2)] }, 0);
  db.failNext(quotaError());
  expect(
    await store.save({ attached: [reference(2), reference(3)] }, 0),
  ).toMatchObject({
    persisted: true,
    fallback: true,
    omitted: 1,
    reason: 'quota',
  });
  const saved = await store.load();
  expect(saved.attached.map((row) => row.id)).toEqual(['file:2', 'file:3']);
  expect(saved.attached.map((row) => Boolean(row.blob))).toEqual([true, false]);
});

test('unavailable storage and failed reads/writes are explicit', async () => {
  const absent = createDraftReferenceStore(null);
  expect(await absent.save({ attached: [] }, 0)).toEqual({
    persisted: false,
    reason: 'no-storage',
  });
  expect(await absent.clear()).toEqual({
    cleared: false,
    reason: 'no-storage',
  });
  const db = memoryDb(),
    store = createDraftReferenceStore(db);
  db.failNext(new Error('denied'));
  expect(await store.save({ attached: [reference(1)] }, 0)).toMatchObject({
    persisted: false,
    reason: 'failed',
  });
});

test('missing original metadata stays visible across later saves and refreshes', async () => {
  const store = createDraftReferenceStore(memoryDb(), { maxBytes: 32 });
  const a = reference(1);
  a.source = { sha256: hash(2), width: 20, height: 40 };
  a.original = { blob: imageBlob(80) };
  await store.save({ attached: [a] }, 0);
  const loaded = await store.load();
  expect(loaded.attached[0].original.blob).toBeNull();
  expect(await store.save({ attached: loaded.attached }, 0)).toMatchObject({
    persisted: true,
    originalsOmitted: 1,
  });
  expect((await store.load()).attached[0].original).toMatchObject({
    sha256: hash(2),
    bytes: 80,
    blob: null,
  });
});

test('pending files without WebCrypto persist exact bytes without claiming a hash', async () => {
  vi.stubGlobal('crypto', undefined);
  try {
    const store = createDraftReferenceStore(memoryDb());
    const pending = { ...reference(1), sha256: null, prepared: false };
    await store.save({ attached: [pending] }, 0);
    const saved = await store.load();
    expect(saved.attached[0].blob).toBe(pending.blob);
    expect(saved.attached[0].prepared).toBe(false);
    expect(saved.attached[0].sha256).toBeNull();
    expect(saved.attached[0].mediaId).toBe(`pending:${pending.id}`);
  } finally {
    vi.unstubAllGlobals();
  }
});
