import { expect, test, vi } from 'vitest';

import { STORE } from './cacheDb.js';
import { createCacheStore } from './cacheStore.js';
import { WRITE_SKIPPED } from './cacheKernel.js';
import {
  imageBlob,
  memoryChannels,
  memoryDb,
  quotaError,
} from '../../../tests/helpers/cacheTestSupport.js';

const limits = {
  sharedRecordLimit: 10,
  sharedVariantLimit: 10,
  sharedVariantMaxBytes: 1000,
  privateRecordLimit: 3,
  privateMaxBytes: 100,
};
const analysis = (key) => ({
  print_watermark: { position: { corner: 'top-left' } },
  print_watermark_key: key,
  source_sha256: 'a'.repeat(64),
  dimensions: { width: 4, height: 3 },
});
const state = (key, addedAt = 1) => ({
  addedAt,
  analysis: analysis(key),
  settings: { fingerprint: 'f', rendering: { v: 1 } },
  prepared: null,
});
const prepared = (base, bytes) => ({
  ...base,
  prepared: {
    key: base.analysis.print_watermark_key,
    fingerprint: 'f',
    width: 4,
    height: 3,
    bytes,
    createdAt: 1,
  },
});

async function seeded(id = 'a', addedAt = 1, bytes = 20) {
  const db = memoryDb();
  const store = createCacheStore(db, limits);
  await store.admitPrivate({
    record: { id, title: id },
    origin: 'imported',
    addedAt,
    full: imageBlob(bytes),
  });
  return { db, store };
}

test('analysis and the one prepared PNG persist beside the unchanged wire record and reload', async () => {
  const { db, store } = await seeded();
  const base = state('k1');
  expect(await store.savePrivateWatermark('a', { addedAt: 1 }, base)).toEqual({
    persisted: true,
  });
  const png = imageBlob(30);
  expect(
    await store.savePrivatePrepared(
      'a',
      { addedAt: 1 },
      prepared(base, 30),
      png,
    ),
  ).toEqual({ persisted: true });

  const [row] = await createCacheStore(db, limits).loadPrivate();
  expect(row.record).toEqual({ id: 'a', title: 'a' });
  expect(row.watermark.analysis.print_watermark_key).toBe('k1');
  expect(row.watermark.prepared.bytes).toBe(30);
  expect(row.preparedBytes).toBe(30);
  expect(await store.readPrivateMedia('a', { addedAt: 1 }, 'watermarked')).toBe(
    png,
  );
});

test('a new analysis removes the stale prepared PNG with it', async () => {
  const { store } = await seeded();
  const base = state('k1');
  await store.savePrivateWatermark('a', { addedAt: 1 }, base);
  await store.savePrivatePrepared(
    'a',
    { addedAt: 1 },
    prepared(base, 30),
    imageBlob(30),
  );
  await store.savePrivateWatermark('a', { addedAt: 1 }, state('k2'));
  const [row] = await store.loadPrivate();
  expect(row.watermark.analysis.print_watermark_key).toBe('k2');
  expect(row.watermark.prepared).toBeNull();
  expect(row.preparedBytes).toBe(0);
});

test('a PNG made from an older analysis is refused as changed', async () => {
  const { store } = await seeded();
  const old = state('k1');
  await store.savePrivateWatermark('a', { addedAt: 1 }, state('k2'));
  expect(
    await store.savePrivatePrepared(
      'a',
      { addedAt: 1 },
      prepared(old, 10),
      imageBlob(10),
    ),
  ).toEqual({ persisted: false, reason: WRITE_SKIPPED.CHANGED });
});

test('writes for a removed, replaced or never-added entry are refused', async () => {
  const { db, store } = await seeded('a', 5);
  await store.removePrivate('a', 5);
  for (const write of [
    () => store.savePrivateWatermark('a', { addedAt: 5 }, state('k', 5)),
    () =>
      store.savePrivatePrepared(
        'a',
        { addedAt: 5 },
        prepared(state('k', 5), 5),
        imageBlob(5),
      ),
  ])
    expect(await write()).toMatchObject({ persisted: false });
  expect(await store.loadPrivate()).toEqual([]);

  // A different add of the same key is not the one the write was made for.
  const second = createCacheStore(db, limits);
  await second.admitPrivate({
    record: { id: 'a' },
    origin: 'imported',
    addedAt: 9,
  });
  expect(
    await second.savePrivateWatermark('a', { addedAt: 7 }, state('k', 7)),
  ).toMatchObject({ persisted: false, reason: WRITE_SKIPPED.NOT_LISTED });
  expect(
    await second.savePrivateWatermark('a', { addedAt: 12 }, state('k', 12)),
  ).toMatchObject({ persisted: false, reason: WRITE_SKIPPED.NOT_LISTED });
});

test('the prepared PNG counts toward the budget and never prunes other copies', async () => {
  const { store } = await seeded('a', 1, 40);
  await store.admitPrivate({
    record: { id: 'b' },
    origin: 'imported',
    addedAt: 2,
    full: imageBlob(40),
  });
  const base = state('k1', 2);
  await store.savePrivateWatermark('b', { addedAt: 2 }, base);
  // 80 stored; 30 more fits exactly under 100? 110 > 100: refused.
  expect(
    await store.savePrivatePrepared(
      'b',
      { addedAt: 2 },
      prepared(base, 30),
      imageBlob(30),
    ),
  ).toEqual({ persisted: false, reason: WRITE_SKIPPED.OVERSIZE });
  expect((await store.loadPrivate()).map((r) => r.record.id)).toEqual([
    'b',
    'a',
  ]);
  // 20 fits (100 total) and is counted by a later full re-attach.
  expect(
    await store.savePrivatePrepared(
      'b',
      { addedAt: 2 },
      prepared(base, 20),
      imageBlob(20),
    ),
  ).toEqual({ persisted: true });
  // Five more bytes do not fit (105 > 100): the rebuildable PNG is given up,
  // never the other original.
  expect(
    await store.admitPrivate({
      record: { id: 'b' },
      origin: 'imported',
      addedAt: 2,
      full: imageBlob(45),
    }),
  ).toMatchObject({ persisted: true, preparedReleased: ['b'] });
  const rows = await store.loadPrivate();
  expect(rows.map((r) => r.record.id)).toEqual(['b', 'a']);
  expect(rows[0].preparedBytes).toBe(0);
  expect(rows[0].watermark.prepared).toBeNull();
  expect(rows[0].full.size).toBe(45);
  expect(rows[1].full.size).toBe(40);
});

test('a PNG larger than the whole budget is refused up front', async () => {
  const { store } = await seeded();
  const base = state('k1');
  await store.savePrivateWatermark('a', { addedAt: 1 }, base);
  expect(
    await store.savePrivatePrepared(
      'a',
      { addedAt: 1 },
      prepared(base, 101),
      imageBlob(101),
    ),
  ).toEqual({ persisted: false, reason: WRITE_SKIPPED.OVERSIZE });
});

test('removal drops every kind of media, derivatives included', async () => {
  const { db, store } = await seeded('a', 1, 10);
  const base = state('k1');
  await store.savePrivateWatermark('a', { addedAt: 1 }, base);
  await store.savePrivatePrepared(
    'a',
    { addedAt: 1 },
    prepared(base, 10),
    imageBlob(10),
  );
  expect(db.data.get(STORE.META).get('privateBytes')).toBe(20);
  for (const [id, at] of [
    ['b', 2],
    ['c', 3],
  ])
    await store.admitPrivate({
      record: { id },
      origin: 'imported',
      addedAt: at,
    });
  await store.removePrivate('a', 1);
  expect([...db.data.get(STORE.PRIVATE_MEDIA).keys()]).toEqual([]);
  expect(db.data.get(STORE.META).get('privateBytes')).toBe(0);

  await store.removePrivate('b', 2);
  expect([...db.data.get(STORE.PRIVATE).keys()]).toEqual(['c']);
});

test('a quota failure while writing the PNG keeps the analysis and earlier copies', async () => {
  const { db, store } = await seeded();
  const base = state('k1');
  await store.savePrivateWatermark('a', { addedAt: 1 }, base);
  db.failNext(quotaError(), (names) => names.includes(STORE.PRIVATE_MEDIA));
  db.failNext(quotaError(), (names) => names.includes(STORE.PRIVATE_MEDIA));
  expect(
    await store.savePrivatePrepared(
      'a',
      { addedAt: 1 },
      prepared(base, 10),
      imageBlob(10),
    ),
  ).toMatchObject({ persisted: false, reason: WRITE_SKIPPED.QUOTA });
  const [row] = await store.loadPrivate();
  expect(row.full.size).toBe(20);
  expect(row.watermark.analysis.print_watermark_key).toBe('k1');
  expect(row.watermark.prepared).toBeNull();
});

test('without a database nothing persists and says so', async () => {
  const store = createCacheStore(null, limits);
  expect(
    await store.savePrivateWatermark('a', { addedAt: 1 }, state('k')),
  ).toEqual({ persisted: false, reason: WRITE_SKIPPED.NO_STORAGE });
  expect(await store.readPrivateMedia('a', { addedAt: 1 }, 'full')).toBeNull();
});

test('analysis and prepared commits notify other tabs, aborted writes do not', async () => {
  const { db } = await seeded();
  const channels = memoryChannels();
  const writer = createCacheStore(db, limits, { openChannel: channels });
  const reader = createCacheStore(db, limits, { openChannel: channels });
  const changed = vi.fn();
  const stop = reader.onPrivateChange(changed);
  try {
    const base = state('notified');
    expect(
      await writer.savePrivateWatermark('a', { addedAt: 1 }, base),
    ).toEqual({ persisted: true });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(
      await writer.savePrivatePrepared(
        'a',
        { addedAt: 1 },
        prepared(base, 10),
        imageBlob(10),
      ),
    ).toEqual({ persisted: true });
    expect(changed).toHaveBeenCalledTimes(2);
    db.failNext(new Error('injected commit abort'));
    expect(
      await writer.savePrivateWatermark('a', { addedAt: 1 }, state('aborted')),
    ).toMatchObject({ persisted: false });
    expect(changed).toHaveBeenCalledTimes(2);
  } finally {
    stop();
  }
});
