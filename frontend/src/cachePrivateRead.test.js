import { expect, test } from 'vitest';
import vectors from '../../fixtures/browser/private-read-pages.json';
import { STORE, CACHE_DB_VERSION } from './cacheDb.js';
import {
  createCacheStore,
  PRIVATE_PAGE_METADATA_MAX_BYTES,
} from './cacheStore.js';
import { memoryDb } from './cacheTestSupport.js';

const limits = {
  sharedRecordLimit: 1,
  sharedVariantLimit: 1,
  sharedVariantMaxBytes: 1,
  privateRecordLimit: 1,
  privateMaxBytes: 1,
};
const setup = () => {
  const db = memoryDb();
  db.data.set(STORE.PRIVATE, new Map());
  db.data.set(STORE.PRIVATE_MEDIA, new Map());
  db.data.set(STORE.META, new Map());
  for (const {
    record,
    origin,
    addedAt,
    hasFull,
    hasThumbnail,
    hasPrepared,
  } of vectors.records) {
    db.data.get(STORE.PRIVATE)?.set(record.id, { record, origin, addedAt });
    if (hasFull || hasThumbnail || hasPrepared) {
      let media = db.data.get(STORE.PRIVATE_MEDIA);
      if (!media) db.data.set(STORE.PRIVATE_MEDIA, (media = new Map()));
      if (hasFull)
        media.set(`${record.id}|full`, { blob: new Blob(['x']), bytes: 1 });
      if (hasThumbnail)
        media.set(`${record.id}|thumbnail`, {
          blob: new Blob(['x']),
          bytes: 1,
        });
      if (hasPrepared)
        media.set(`${record.id}|watermarked`, {
          blob: new Blob(['x']),
          bytes: 1,
        });
    }
  }
  return { db, store: createCacheStore(db, limits) };
};

test('durability follows a database closed by an incompatible writer upgrade', () => {
  const db = memoryDb();
  db.open = true;
  const store = createCacheStore(db, limits);
  expect(store.durable).toBe(true);
  expect(store.local.durable).toBe(true);
  db.open = false;
  expect(store.durable).toBe(false);
  expect(store.local.durable).toBe(false);
  expect(createCacheStore(null, limits).durable).toBe(false);
});

test('fixture private keyset pages, exact detail/around, and lowered admission limits', async () => {
  const { store } = setup();
  expect((await store.privateCount()).count).toBe(vectors.expected.count);
  expect(
    (await store.readPrivatePage({ limit: vectors.page_size })).rows.map(
      (row) => row.key,
    ),
  ).toEqual(vectors.expected.older_pages[0]);
  const page2 = await store.readPrivatePage({
    anchor: { addedAt: 20, key: 'gamma' },
    direction: 'older',
    limit: 3,
  });
  expect(page2.rows.map((row) => row.key)).toEqual(
    vectors.expected.older_pages[1],
  );
  const page3 = await store.readPrivatePage({
    anchor: page2.next,
    direction: 'older',
    limit: 3,
  });
  expect(page3.rows.map((row) => row.key)).toEqual(
    vectors.expected.older_pages[2],
  );
  expect(
    [
      ...(await store.readPrivatePage({ limit: 3 })).rows,
      ...page2.rows,
      ...page3.rows,
    ].map((row) => row.key),
  ).toEqual(vectors.expected.newest_first_keys);
  const around = await store.readPrivateAround(
    { key: 'beta', addedAt: 20 },
    { before: 1, after: 1 },
  );
  expect(around.rows.map((row) => row.key)).toEqual(
    vectors.expected.around_beta_one_each,
  );
  const detail = await store.readPrivateDetail('oldest');
  expect(detail.record.extension).toEqual({
    enabled: false,
    count: 0,
    note: null,
  });
  expect(detail.hasPrepared).toBe(false);
  expect(CACHE_DB_VERSION).toBeGreaterThan(7);
});

test('deleted-anchor traversal is exclusive and metadata slice admits one oversized row', async () => {
  const { db, store } = setup();
  const afterDeleted = await store.readPrivatePage({
    anchor: { addedAt: 20, key: 'gamma' },
    direction: 'older',
    limit: 3,
  });
  expect(afterDeleted.rows.map((row) => row.key)).toEqual(
    vectors.expected.after_deleted_gamma_anchor,
  );
  db.data.get(STORE.PRIVATE).delete('gamma');
  const afterRemoval = await store.readPrivatePage({
    anchor: { addedAt: 20, key: 'gamma' },
    direction: 'older',
    limit: 3,
  });
  expect(afterRemoval.rows.map((row) => row.key)).toEqual(
    vectors.expected.after_deleted_gamma_anchor,
  );
  db.data.get(STORE.PRIVATE).set('arrival', {
    record: { id: 'arrival' },
    origin: 'generated',
    addedAt: 25,
  });
  const afterArrival = await store.readPrivatePage({
    anchor: { addedAt: 20, key: 'gamma' },
    direction: 'older',
    limit: 3,
  });
  expect(afterArrival.rows.map((row) => row.key)).toEqual(
    vectors.expected.after_newer_arrival_existing_gamma_anchor,
  );
  const slice = await store.scanPrivateSlice({ maxRows: 1, maxBytes: 1 });
  expect(slice.rows).toHaveLength(1);
  expect(slice.oversized).toBe(true);
  expect(slice.cursor).toMatchObject({ key: 'delta', addedAt: 30 });
});

test('read limits and cursors reject invalid inputs and missing identities are explicit', async () => {
  const { store } = setup();
  await expect(store.readPrivatePage({ limit: 0 })).rejects.toThrow(RangeError);
  await expect(store.readPrivatePage({ limit: 97 })).rejects.toThrow(
    RangeError,
  );
  await expect(
    store.readPrivatePage({ direction: 'sideways' }),
  ).rejects.toThrow(TypeError);
  await expect(
    store.readPrivatePage({ anchor: { addedAt: 1 } }),
  ).rejects.toThrow(TypeError);
  expect(await store.readPrivateDetail('missing')).toBeNull();
  expect(
    await store.readPrivateAround({ key: 'missing', addedAt: 1 }),
  ).toMatchObject({ missing: true, rows: [] });
});

test('private sequence advances with committed metadata writes and rolls back on abort', async () => {
  const { db, store } = setup();
  expect((await store.privateCount()).seq).toBe(0);
  await store.savePrivateWatermark(
    'beta',
    { addedAt: 20 },
    { analysis: { key: 'proof' }, prepared: null },
  );
  expect((await store.privateCount()).seq).toBe(1);
  db.failNext(new Error('abort proof'), (names) =>
    names.includes(STORE.PRIVATE),
  );
  expect(
    await store.savePrivateWatermark(
      'beta',
      { addedAt: 20 },
      { analysis: { key: 'aborted' }, prepared: null },
    ),
  ).toMatchObject({ persisted: false });
  expect((await store.privateCount()).seq).toBe(1);
});

test('default scan works and zero-sized around sides include no neighbors', async () => {
  const { store } = setup();
  const slice = await store.scanPrivateSlice();
  expect(slice.rows.map((row) => row.key)).toEqual(
    vectors.expected.newest_first_keys,
  );
  expect(slice.done).toBe(true);
  for (const [before, after, expected] of [
    [0, 0, ['beta']],
    [0, 1, ['beta', 'alpha']],
    [1, 0, ['epsilon', 'beta']],
  ]) {
    const around = await store.readPrivateAround(
      { key: 'beta', addedAt: 20 },
      { before, after },
    );
    expect(around.rows.map((row) => row.key)).toEqual(expected);
  }
});

test('metadata scans reject malformed anchors and unbounded byte requests', async () => {
  const { store } = setup();
  for (const anchor of [
    false,
    {},
    { key: '', addedAt: 1 },
    { key: 'x', addedAt: Infinity },
  ]) {
    await expect(store.scanPrivateSlice({ anchor })).rejects.toThrow(TypeError);
    await expect(store.readPrivatePage({ anchor })).rejects.toThrow(TypeError);
  }
  for (const maxBytes of [
    0,
    1.5,
    Infinity,
    PRIVATE_PAGE_METADATA_MAX_BYTES + 1,
  ])
    await expect(store.scanPrivateSlice({ maxBytes })).rejects.toThrow(
      RangeError,
    );
});

test('large metadata pages stop reading at the byte boundary and remain traversable in both directions', async () => {
  const { db, store } = setup();
  const entries = db.data.get(STORE.PRIVATE);
  entries.clear();
  for (let i = 0; i < 12; i++)
    entries.set(`large-${i}`, {
      record: { id: `large-${i}`, extension: 'x'.repeat(600 * 1024) },
      origin: 'generated',
      addedAt: i,
    });
  const run = db.run.bind(db);
  let visited = 0;
  let mediaReads = 0;
  db.run = (names, mode, work) =>
    run(names, mode, (access) =>
      work({
        ...access,
        get: (name, key) => {
          if (name === STORE.PRIVATE_MEDIA) mediaReads++;
          return access.get(name, key);
        },
        scanKeyset: (name, index, anchor, direction, visit) =>
          access.scanKeyset(name, index, anchor, direction, (row, key) => {
            visited++;
            return visit(row, key);
          }),
      }),
    );
  const first = await store.readPrivatePage();
  expect(first.rows.map((row) => row.key)).toEqual(['large-11']);
  expect(first.oversized).toBe(false);
  expect(visited).toBeLessThanOrEqual(4);
  const second = await store.readPrivatePage({ anchor: first.next });
  expect(second.rows.map((row) => row.key)).toEqual(['large-10']);
  const back = await store.readPrivatePage({
    anchor: second.previous,
    direction: 'newer',
  });
  expect(back.rows.map((row) => row.key)).toEqual(['large-11']);
  const around = await store.readPrivateAround(
    { key: 'large-6', addedAt: 6 },
    { before: 4, after: 4 },
  );
  expect(around.rows.map((row) => row.key)).toEqual(['large-6']);
  expect(mediaReads).toBe(0);
  entries.get('large-11').record.extension = 'x'.repeat(
    PRIVATE_PAGE_METADATA_MAX_BYTES,
  );
  const oversized = await store.readPrivatePage();
  expect(oversized.rows).toHaveLength(1);
  expect(oversized.oversized).toBe(true);
  expect(oversized.next).toEqual({ key: 'large-11', addedAt: 11 });
});
