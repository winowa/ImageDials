import { expect, test } from 'vitest';

import { createCacheStore } from './cacheStore.js';
import {
  imageBlob,
  memoryDb,
  quotaError,
} from '../../../tests/helpers/cacheTestSupport.js';
import { planPreparedEviction } from './localWatermarkStore.js';

const limits = {
  sharedRecordLimit: 10,
  sharedVariantLimit: 2,
  sharedVariantMaxBytes: 100,
  privateRecordLimit: 5,
  privateMaxBytes: 1000,
};
const state = (key) => ({ analysis: { print_watermark_key: key } });

test('eviction removes the least recently used copies and never fits an oversized one', () => {
  const entries = [
    { id: 'a', bytes: 40, lastUsedAt: 3 },
    { id: 'b', bytes: 40, lastUsedAt: 1 },
  ];
  expect(planPreparedEviction(entries, { id: 'c', bytes: 40 }, limits)).toEqual(
    {
      fits: true,
      evict: ['b'],
    },
  );
  expect(
    planPreparedEviction(entries, { id: 'c', bytes: 101 }, limits).fits,
  ).toBe(false);
  // Replacing an existing key does not count it twice.
  expect(
    planPreparedEviction(entries, { id: 'a', bytes: 50 }, limits).evict,
  ).toEqual([]);
});

test('prepared copies are bounded, rebuildable and read one row at a time', async () => {
  const db = memoryDb();
  const { local } = createCacheStore(db, limits);
  for (const key of ['a', 'b', 'c'])
    await local.writePrepared(key, { state: state(key), blob: imageBlob(30) });
  expect([...db.data.get('sharedPrepared').keys()].sort()).toEqual(['b', 'c']);
  expect((await local.readPrepared('c')).state).toEqual(state('c'));
  expect(await local.readPrepared('a')).toBeNull();
});

test('a quota failure refuses the write and prunes nothing else', async () => {
  const db = memoryDb();
  const { local } = createCacheStore(db, limits);
  await local.writePrepared('a', { state: state('a'), blob: imageBlob(30) });
  db.failNext(quotaError(), (names) => names.includes('sharedPrepared'));
  expect(
    await local.writePrepared('b', { state: state('b'), blob: imageBlob(30) }),
  ).toEqual({ persisted: false, reason: 'quota' });
  expect([...db.data.get('sharedPrepared').keys()]).toEqual(['a']);
});

test('without a database copies stay in this tab within the same bounds', async () => {
  const { local } = createCacheStore(null, limits);
  expect(
    await local.writePrepared('a', { state: state('a'), blob: imageBlob(30) }),
  ).toEqual({ persisted: true, memory: true });
  expect(
    (
      await local.writePrepared('big', {
        state: state('b'),
        blob: imageBlob(500),
      })
    ).reason,
  ).toBe('oversize');
  await local.deletePrepared('a');
  expect(await local.readPrepared('a')).toBeNull();
});
