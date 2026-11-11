import { expect, test } from 'vitest';

import { STORE, upgradeSchema } from './cacheDb.js';
import { createCacheStore } from './cacheStore.js';
import { WRITE_SKIPPED } from './cacheKernel.js';
import {
  imageBlob,
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
// A wire snapshot with falsy and unknown fields that must survive unchanged.
const wire = (id, extra = {}) => ({
  id,
  image_id: id,
  title: `Image ${id}`,
  safe: false,
  count: 0,
  note: null,
  unknown_future_field: { nested: [false, 0, null] },
  created_at: 1,
  ...extra,
});
const entry = (id, addedAt, origin = 'generated') => ({
  record: wire(id),
  origin,
  addedAt,
});
const open = (db = memoryDb()) => ({ db, store: createCacheStore(db, limits) });
const keys = (rows) => rows.map((row) => row.record.id);
/** A finished add: the row and, when given, its original in one admission. */
const admit = (store, row, full = null, thumbnail = null) =>
  store.admitPrivate({ ...row, full, thumbnail });
const counter = (db) => db.data.get(STORE.META)?.get('privateBytes');
const sumOfMedia = (db) =>
  [...(db.data.get(STORE.PRIVATE_MEDIA)?.values() ?? [])].reduce(
    (sum, row) => sum + row.bytes,
    0,
  );

const analysisState = () => ({
  analysis: { print_watermark_key: 'k1', dimensions: { width: 1, height: 1 } },
  prepared: null,
});
const preparedState = () => ({ ...analysisState(), prepared: { pipeline: 1 } });

test('private entries reload newest first by local addedAt with their bytes and untouched wire fields', async () => {
  const { db, store } = open();
  await admit(store, entry('a', 10));
  const full = imageBlob(12);
  expect(
    await admit(
      store,
      { ...entry('b', 20, 'imported'), record: wire('b', { created_at: 0 }) },
      full,
      imageBlob(3),
    ),
  ).toMatchObject({ persisted: true, duplicate: false });

  const reloaded = await createCacheStore(db, limits).loadPrivate();
  expect(keys(reloaded)).toEqual(['b', 'a']);
  expect(reloaded[0].full).toBe(full);
  expect(reloaded[0].thumbnail.size).toBe(3);
  expect(reloaded[1].full).toBeNull();
  expect(reloaded[1].record).toEqual(wire('a'));
  expect(reloaded[1].record.safe).toBe(false);
  expect(reloaded[1].record.count).toBe(0);
});

test('admission above the record limit is refused and every older row and byte stays', async () => {
  const { db, store } = open();
  const originals = new Map();
  for (const [id, at] of [
    ['a', 1],
    ['b', 2],
    ['c', 3],
  ]) {
    originals.set(id, imageBlob(10));
    await admit(store, entry(id, at), originals.get(id));
  }
  const refused = await admit(store, entry('d', 4), imageBlob(10));
  expect(refused).toEqual({
    persisted: false,
    reason: WRITE_SKIPPED.RECORD_LIMIT,
  });
  const rows = await store.loadPrivate();
  expect(keys(rows)).toEqual(['c', 'b', 'a']);
  for (const row of rows) expect(row.full).toBe(originals.get(row.record.id));
  expect(db.data.get(STORE.PRIVATE_MEDIA).size).toBe(3);
  expect(counter(db)).toBe(30);
});

test('record limit boundaries: exactly at the limit fits, zero admits nothing', async () => {
  const { store } = open();
  for (const [id, at] of [
    ['a', 1],
    ['b', 2],
    ['c', 3],
  ])
    expect(await admit(store, entry(id, at))).toMatchObject({
      persisted: true,
    });
  expect(await admit(store, entry('d', 4))).toMatchObject({
    reason: WRITE_SKIPPED.RECORD_LIMIT,
  });
  const none = createCacheStore(memoryDb(), {
    ...limits,
    privateRecordLimit: 0,
  });
  expect(await admit(none, entry('a', 1))).toMatchObject({
    persisted: false,
    reason: WRITE_SKIPPED.RECORD_LIMIT,
  });
});

test('bytes: exactly at the budget fits, one over is refused and nothing older is erased', async () => {
  const { db, store } = open();
  const a = imageBlob(60);
  await admit(store, entry('a', 1), a);
  expect(await admit(store, entry('b', 2), imageBlob(40))).toMatchObject({
    persisted: true,
  });
  expect(counter(db)).toBe(100);
  const over = await admit(store, entry('c', 3), imageBlob(1));
  expect(over).toEqual({ persisted: false, reason: WRITE_SKIPPED.BYTE_LIMIT });
  // Alone larger than the whole budget is a final refusal.
  const huge = await admit(store, entry('d', 4), imageBlob(101));
  expect(huge).toMatchObject({
    persisted: false,
    reason: WRITE_SKIPPED.OVERSIZE,
  });
  const rows = await store.loadPrivate();
  expect(keys(rows)).toEqual(['b', 'a']);
  expect(rows[1].full).toBe(a);
  expect(counter(db)).toBe(sumOfMedia(db));
});

test('the byte counter is rebuilt once when absent, then maintained by every writer', async () => {
  const { db, store } = open();
  await admit(store, entry('a', 1), imageBlob(30), imageBlob(5));
  await admit(store, entry('b', 2), imageBlob(20));
  // A database from before the counter: media exist, the counter does not.
  db.data.get(STORE.META).delete('privateBytes');
  expect(await store.privateUsage()).toEqual({ count: 2, bytes: 55 });
  expect(counter(db)).toBe(55);
  await admit(store, entry('c', 3), imageBlob(10));
  expect(counter(db)).toBe(65);
  await store.removePrivate('a', 1);
  expect(counter(db)).toBe(30);
  expect(counter(db)).toBe(sumOfMedia(db));
});

test('a failed admission rolls back the row, the media and the counter', async () => {
  const { db, store } = open();
  await admit(store, entry('keep', 1), imageBlob(10));
  db.failNext(new Error('disk said no'), (names) =>
    names.includes(STORE.PRIVATE_MEDIA),
  );
  expect(await admit(store, entry('new', 2), imageBlob(10))).toMatchObject({
    persisted: false,
    reason: WRITE_SKIPPED.FAILED,
  });
  expect(keys(await store.loadPrivate())).toEqual(['keep']);
  expect(counter(db)).toBe(10);
  expect(sumOfMedia(db)).toBe(10);
});

test('a duplicate identity adopts the stored add and never overwrites it', async () => {
  const db = memoryDb();
  const tabA = createCacheStore(db, limits);
  const tabB = createCacheStore(db, limits);
  const first = imageBlob(10);
  await admit(tabA, entry('a', 5), first);
  const second = await admit(tabB, entry('a', 9, 'imported'), imageBlob(20));
  expect(second).toEqual({
    persisted: true,
    duplicate: true,
    addedAt: 5,
    origin: 'generated',
  });
  const [stored] = await tabA.loadPrivate();
  expect(stored).toMatchObject({ addedAt: 5, origin: 'generated' });
  expect(stored.full).toBe(first);
  expect(counter(db)).toBe(10);
  // Repeating the SAME add is idempotent and may attach its bytes.
  await admit(tabA, entry('b', 6));
  expect(await admit(tabA, entry('b', 6), imageBlob(7))).toMatchObject({
    persisted: true,
    duplicate: false,
  });
  expect((await tabA.readPrivate('b')).full.size).toBe(7);
  expect(counter(db)).toBe(17);
});

test('two tabs racing for the last slot: one is admitted, the other refused, nothing lost', async () => {
  const db = memoryDb();
  const tabA = createCacheStore(db, limits);
  const tabB = createCacheStore(db, limits);
  for (const [id, at] of [
    ['a', 1],
    ['b', 2],
  ])
    await admit(tabA, entry(id, at), imageBlob(5));
  const outcomes = await Promise.all([
    admit(tabA, entry('x', 10), imageBlob(5)),
    admit(tabB, entry('y', 11), imageBlob(5)),
  ]);
  expect(outcomes.filter((o) => o.persisted)).toHaveLength(1);
  expect(outcomes.find((o) => !o.persisted).reason).toBe(
    WRITE_SKIPPED.RECORD_LIMIT,
  );
  expect(await tabA.loadPrivate()).toHaveLength(3);
});

test('lowered limits keep every stored row readable and removable, and only refuse new admission', async () => {
  const db = memoryDb();
  const wide = createCacheStore(db, {
    ...limits,
    privateRecordLimit: 10,
    privateMaxBytes: 1000,
  });
  const blobs = [];
  for (const [id, at] of [
    ['a', 1],
    ['b', 2],
    ['c', 3],
    ['d', 4],
  ]) {
    blobs.push(imageBlob(40));
    await admit(wide, entry(id, at), blobs.at(-1));
  }
  const narrow = createCacheStore(db, limits); // 3 records, 100 bytes
  const rows = await narrow.loadPrivate();
  expect(keys(rows)).toEqual(['d', 'c', 'b', 'a']);
  expect(await admit(narrow, entry('e', 5), imageBlob(1))).toMatchObject({
    persisted: false,
    reason: WRITE_SKIPPED.RECORD_LIMIT,
  });
  expect(keys(await narrow.loadPrivate())).toEqual(['d', 'c', 'b', 'a']);
  expect(await narrow.removePrivate('a', 1)).toEqual({ removed: true });
  expect(await narrow.removePrivate('b', 2)).toEqual({ removed: true });
  expect(counter(db)).toBe(80);
  // Two rows leave a record free, but 80 + 21 bytes exceed the byte limit.
  expect(await admit(narrow, entry('f', 6), imageBlob(21))).toMatchObject({
    reason: WRITE_SKIPPED.BYTE_LIMIT,
  });
});

test('a byte refusal first releases the oldest prepared PNGs, and only if that makes room', async () => {
  const { db, store } = open();
  const a = imageBlob(30);
  await admit(store, entry('a', 1), a);
  await admit(store, entry('b', 2), imageBlob(30));
  // Prepared PNGs of both entries: 20 bytes each. Total 100.
  for (const [id, at] of [
    ['a', 1],
    ['b', 2],
  ]) {
    await store.savePrivateWatermark(id, { addedAt: at }, analysisState());
    await store.savePrivatePrepared(
      id,
      { addedAt: at },
      preparedState(),
      imageBlob(20),
    );
  }
  expect(counter(db)).toBe(100);
  // 41 bytes need 41 of the 40 prepared bytes: not enough, nothing is released.
  const refused = await admit(store, entry('c', 3), imageBlob(41));
  expect(refused).toMatchObject({ persisted: false, reason: 'byte-limit' });
  expect(db.data.get(STORE.PRIVATE_MEDIA).has('a|watermarked')).toBe(true);
  // 20 bytes need one prepared PNG: the oldest goes, originals stay.
  const admitted = await admit(store, entry('c', 3), imageBlob(20));
  expect(admitted).toMatchObject({
    persisted: true,
    preparedReleased: ['a'],
  });
  const rows = await store.loadPrivate();
  expect(rows.map((r) => r.preparedBytes)).toEqual([0, 20, 0]);
  expect(rows.find((r) => r.record.id === 'a').watermark.prepared).toBeNull();
  expect(rows.find((r) => r.record.id === 'a').full).toBe(a);
  expect(counter(db)).toBe(sumOfMedia(db));
});

test('a removed entry cannot be brought back by a late admission, but a newer add can', async () => {
  const { store } = open();
  await admit(store, entry('a', 5));
  expect(await store.removePrivate('a', 5)).toEqual({ removed: true });
  expect(await store.loadPrivate()).toEqual([]);
  expect(await admit(store, entry('a', 5), imageBlob(5))).toMatchObject({
    persisted: false,
    reason: WRITE_SKIPPED.DELETED,
  });
  // The same identity imported again later is a new add.
  expect(await admit(store, entry('a', 9, 'imported'))).toMatchObject({
    persisted: true,
  });
  expect(keys(await store.loadPrivate())).toEqual(['a']);
});

test('removal in another tab (stored tombstone) blocks a late admission from this tab', async () => {
  const db = memoryDb();
  const tabA = createCacheStore(db, limits);
  const tabB = createCacheStore(db, limits);
  await admit(tabA, entry('a', 5));
  await tabB.removePrivate('a', 5);
  expect(await admit(tabA, entry('a', 5), imageBlob(5))).toMatchObject({
    persisted: false,
    reason: WRITE_SKIPPED.DELETED,
  });
});

test('a failed durable removal keeps the entry and returns the error', async () => {
  const { db, store } = open();
  await admit(store, entry('a', 5), imageBlob(5));
  db.failNext(new Error('disk said no'));
  const outcome = await store.removePrivate('a', 5);
  expect(outcome.removed).toBe(false);
  expect(outcome.error.message).toBe('disk said no');
  expect(keys(await store.loadPrivate())).toEqual(['a']);
  expect(counter(db)).toBe(5);
  // The failed attempt left no in-tab tombstone behind.
  expect(await admit(store, entry('a', 5), imageBlob(5))).toMatchObject({
    persisted: true,
  });
});

test('quota: shared variants are evicted and the write retried once; prior private copies survive', async () => {
  const { db, store } = open();
  await admit(store, entry('keep', 1), imageBlob(30));
  db.data.set(
    STORE.VARIANTS,
    new Map([['s/x|thumbnail', { key: 's/x', bytes: 9, lastUsedAt: 1 }]]),
  );
  db.failNext(quotaError(), (names) => names.includes(STORE.PRIVATE_MEDIA));
  const result = await admit(store, entry('new', 2), imageBlob(30));
  expect(result).toMatchObject({ persisted: true });
  expect(db.data.get(STORE.VARIANTS).size).toBe(0);
  expect((await store.loadPrivate()).map((r) => r.full?.size)).toEqual([
    30, 30,
  ]);
});

test('quota twice gives up with the reason and never erases private history', async () => {
  const { db, store } = open();
  await admit(store, entry('keep', 1), imageBlob(30));
  const mediaWrite = (names) => names.includes(STORE.PRIVATE_MEDIA);
  db.failNext(quotaError(), mediaWrite);
  db.failNext(quotaError(), mediaWrite);
  const result = await admit(store, entry('new', 2), imageBlob(30));
  expect(result).toMatchObject({
    persisted: false,
    reason: WRITE_SKIPPED.QUOTA,
  });
  const rows = await store.loadPrivate();
  expect(keys(rows)).toEqual(['keep']);
  expect(rows[0].full.size).toBe(30);
  expect(counter(db)).toBe(30);
});

test('changes are announced to other tabs, and each tab hears only the others', async () => {
  const db = memoryDb();
  const channels = [];
  const openChannel = () => {
    const channel = {
      posted: [],
      onmessage: null,
      closed: false,
      postMessage(message) {
        this.posted.push(message);
        for (const other of channels)
          if (other !== this && !other.closed)
            other.onmessage?.({ data: message });
      },
      close() {
        this.closed = true;
      },
    };
    channels.push(channel);
    return channel;
  };
  const tabA = createCacheStore(db, limits, { openChannel });
  const tabB = createCacheStore(db, limits, { openChannel });
  const heardByB = [];
  const stop = tabB.onPrivateChange(() => heardByB.push('changed'));
  await admit(tabA, entry('a', 1), imageBlob(5));
  await tabA.removePrivate('a', 1);
  expect(heardByB).toEqual(['changed', 'changed']);
  stop();
  expect(channels[0].closed).toBe(true);
});

test('a failed removal is not announced', async () => {
  const { db, store } = open();
  const posted = [];
  const quiet = createCacheStore(db, limits, {
    openChannel: () => ({ postMessage: (m) => posted.push(m), close() {} }),
  });
  await admit(quiet, entry('a', 1), imageBlob(5));
  posted.length = 0;
  db.failNext(new Error('no'));
  await quiet.removePrivate('a', 1);
  expect(posted).toEqual([]);
  expect(store).toBeTruthy();
});

test('a store without a database reports it and still honors in-tab removal', async () => {
  const store = createCacheStore(null, limits);
  expect(await store.loadPrivate()).toEqual([]);
  expect(await admit(store, entry('a', 1))).toMatchObject({
    persisted: false,
    reason: WRITE_SKIPPED.NO_STORAGE,
  });
  await store.removePrivate('a', 1);
  expect(await admit(store, entry('a', 1))).toMatchObject({
    reason: WRITE_SKIPPED.DELETED,
  });
});

test('private and shared rows never share a store, so identical identities stay apart', async () => {
  const { db, store } = open();
  const shared = {
    id: 'same',
    storage_id: 's',
    filename: 'same.png',
    sha256: 'x',
  };
  const ticket = await store.beginRead();
  await store.commitListing('scope', ticket, { images: [shared], etag: '"e"' });
  await admit(store, {
    record: { ...shared },
    origin: 'imported',
    addedAt: 3,
  });
  await store.removePrivate('s/same.png', 3);
  expect(db.data.get(STORE.RECORDS).has('s/same.png')).toBe(true);
  expect(db.data.get(STORE.TOMBSTONES)?.size ?? 0).toBe(0);
  expect((await store.hydrate('scope')).items).toHaveLength(1);
});

test('upgrading creates only missing stores and indexes and keeps v1 rows', () => {
  const created = [];
  const indexes = [];
  const existing = new Set([
    STORE.RECORDS,
    STORE.LISTINGS,
    STORE.VARIANTS,
    STORE.TOMBSTONES,
    STORE.META,
  ]);
  const fakeStore = (name) => ({
    indexNames: {
      contains: (index) =>
        (name === STORE.VARIANTS && index === 'lastUsedAt') || false,
    },
    createIndex: (...args) => indexes.push(args),
  });
  const db = {
    objectStoreNames: { contains: (name) => existing.has(name) },
    createObjectStore: (name) => {
      created.push(name);
      return fakeStore(name);
    },
  };
  upgradeSchema(db, { objectStore: fakeStore });
  expect(created.sort()).toEqual(
    [
      STORE.PRIVATE,
      STORE.PRIVATE_MEDIA,
      STORE.PRIVATE_TOMBSTONES,
      STORE.REFERENCE_ASSETS,
      STORE.REFERENCE_MEDIA,
      STORE.SETTINGS,
      STORE.SHARED_PREPARED,
      STORE.LIBRARY_SUMMARIES,
      STORE.LIBRARY_PAGES,
      STORE.LIBRARY_DETAILS,
    ].sort(),
  );
  // Private, detail-LRU and summary-identity indexes are independent.
  expect(indexes).toEqual([
    ['addedAt', 'addedAt'],
    ['identity', 'identity'],
    ['lastUsedAt', 'lastUsedAt'],
  ]);
});
