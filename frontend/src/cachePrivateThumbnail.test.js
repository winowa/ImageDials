import { expect, test, vi } from 'vitest';

import { STORE } from './cacheDb.js';
import { createCacheStore } from './cacheStore.js';
import {
  imageBlob,
  memoryChannels,
  memoryDb,
  quotaError,
} from './cacheTestSupport.js';

const limits = {
  sharedRecordLimit: 10,
  sharedVariantLimit: 10,
  sharedVariantMaxBytes: 1000,
  privateRecordLimit: 10,
  privateMaxBytes: 100,
};

async function setup() {
  const db = memoryDb();
  const openChannel = memoryChannels();
  const store = createCacheStore(db, limits, { openChannel });
  const other = createCacheStore(db, limits, { openChannel });
  const original = imageBlob(20);
  const record = { id: 'image', extension: [false, 0, null] };
  await store.admitPrivate({
    record,
    origin: 'imported',
    addedAt: 1,
    full: original,
  });
  return { db, store, other, original, record };
}

test('thumbnail recovery keeps original and wire bytes, accounts replacement, and broadcasts only committed changes', async () => {
  const { store, other, db, original, record } = await setup();
  const changed = vi.fn();
  const unsubscribe = other.onPrivateChange(changed);
  const seq = (await store.privateCount()).seq;
  expect(
    await store.savePrivateThumbnail('image', { addedAt: 1 }, imageBlob(12)),
  ).toEqual({ persisted: true });
  expect(await store.privateUsage()).toMatchObject({ bytes: 32 });
  expect((await store.privateCount()).seq).toBe(seq + 1);
  expect(changed).toHaveBeenCalledTimes(1);
  expect(
    await store.savePrivateThumbnail('image', { addedAt: 1 }, imageBlob(8)),
  ).toEqual({ persisted: true });
  expect(await store.privateUsage()).toMatchObject({ bytes: 28 });
  expect(await store.readPrivateMedia('image', { addedAt: 1 }, 'full')).toBe(
    original,
  );
  expect(db.data.get(STORE.PRIVATE).get('image').record).toBe(record);
  expect(changed).toHaveBeenCalledTimes(2);
  unsubscribe();
});

test('a decode finishing after same-key removal and reimport cannot change the replacement', async () => {
  const { store, other } = await setup();
  await other.removePrivate('image', 1, { requireIncarnation: true });
  const replacement = imageBlob(25);
  await other.admitPrivate({
    record: { id: 'image' },
    origin: 'imported',
    addedAt: 2,
    full: replacement,
  });
  const seq = (await store.privateCount()).seq;
  expect(
    await store.savePrivateThumbnail('image', { addedAt: 1 }, imageBlob(5)),
  ).toMatchObject({ persisted: false });
  expect((await store.privateCount()).seq).toBe(seq);
  expect(
    await store.readPrivateMedia('image', { addedAt: 2 }, 'thumbnail'),
  ).toBeNull();
  expect(await store.readPrivateMedia('image', { addedAt: 2 }, 'full')).toBe(
    replacement,
  );
});

test('missing original, missing record and denied storage refuse derived writes without admission', async () => {
  const { store, db } = await setup();
  db.data.get(STORE.PRIVATE_MEDIA).delete('image|full');
  const seq = (await store.privateCount()).seq;
  expect(
    await store.savePrivateThumbnail('image', { addedAt: 1 }, imageBlob(5)),
  ).toEqual({ persisted: false, reason: 'original-missing' });
  expect(
    await store.savePrivateThumbnail('absent', { addedAt: 1 }, imageBlob(5)),
  ).toEqual({ persisted: false, reason: 'not-listed' });
  expect((await store.privateCount()).seq).toBe(seq);
  expect(db.data.get(STORE.PRIVATE_MEDIA).has('image|thumbnail')).toBe(false);
  expect(
    await createCacheStore(null, limits).savePrivateThumbnail(
      'image',
      { addedAt: 1 },
      imageBlob(5),
    ),
  ).toEqual({ persisted: false, reason: 'no-storage' });
});

test('lowered byte budget refuses recovery without evicting originals or existing derivatives', async () => {
  const { store, db, original } = await setup();
  await store.savePrivateThumbnail('image', { addedAt: 1 }, imageBlob(10));
  const before = db.data.get(STORE.PRIVATE_MEDIA).get('image|thumbnail');
  store.setLimits({ ...limits, privateMaxBytes: 30 });
  const seq = (await store.privateCount()).seq;
  expect(
    await store.savePrivateThumbnail('image', { addedAt: 1 }, imageBlob(11)),
  ).toEqual({ persisted: false, reason: 'oversize' });
  expect(db.data.get(STORE.PRIVATE_MEDIA).get('image|thumbnail')).toBe(before);
  expect(await store.readPrivateMedia('image', { addedAt: 1 }, 'full')).toBe(
    original,
  );
  expect((await store.privateCount()).seq).toBe(seq);
  expect(await store.privateUsage()).toMatchObject({ bytes: 30 });
});

test('commit quota failures roll back thumbnail, byte counter and sequence without broadcasting', async () => {
  const { store, other, db, original } = await setup();
  const seq = (await store.privateCount()).seq;
  const changed = vi.fn();
  const unsubscribe = other.onPrivateChange(changed);
  const privateWrite = (stores) => stores.includes(STORE.PRIVATE);
  db.failNext(quotaError(), privateWrite);
  db.failNext(quotaError(), privateWrite);
  expect(
    await store.savePrivateThumbnail('image', { addedAt: 1 }, imageBlob(5)),
  ).toEqual({ persisted: false, reason: 'quota' });
  expect(
    await store.readPrivateMedia('image', { addedAt: 1 }, 'thumbnail'),
  ).toBeNull();
  expect(await store.readPrivateMedia('image', { addedAt: 1 }, 'full')).toBe(
    original,
  );
  expect(await store.privateUsage()).toMatchObject({ bytes: 20 });
  expect((await store.privateCount()).seq).toBe(seq);
  expect(changed).not.toHaveBeenCalled();
  unsubscribe();
});
