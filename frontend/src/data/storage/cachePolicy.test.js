import { expect, test } from 'vitest';

import {
  listingForStorage,
  ADMISSION_REFUSAL,
  planPrivateAdmission,
  planLibraryDetailEviction,
  planVolatileSlot,
  VOLATILE_REFUSAL,
  planVariantEviction,
  reconcileDeletions,
  scopeKeyOf,
  selectSource,
  SOURCE,
} from './cachePolicy.js';

const limits = { sharedVariantLimit: 3, sharedVariantMaxBytes: 100 };
const entry = (id, bytes, lastUsedAt) => ({ id, bytes, lastUsedAt });

test('capabilities alone choose the source', () => {
  const slot = (status, data = null) => ({ status, data });
  expect(selectSource(slot('loading'))).toBe(SOURCE.PENDING);
  expect(selectSource(slot('loading', { shared_library: {} }))).toBe(
    SOURCE.PENDING,
  );
  expect(selectSource(slot('error'))).toBe(SOURCE.UNAVAILABLE);
  expect(selectSource(slot('ready', {}))).toBe(SOURCE.SHARED);
  expect(
    selectSource(slot('ready', { shared_library: { enabled: true } })),
  ).toBe(SOURCE.SHARED);
  expect(
    selectSource(slot('ready', { shared_library: { enabled: false } })),
  ).toBe(SOURCE.PRIVATE);
  expect(
    selectSource(slot('ready', { history_source: 'browser-private' })),
  ).toBe(SOURCE.PRIVATE);
});

test('the scope key ignores gallery order and tells scopes apart', () => {
  const caps = (gallery, active = 'a') => ({
    shared_library: { store: 'local' },
    events: { active_event_name: active, gallery_event_names: gallery },
  });
  expect(scopeKeyOf(caps(['x', 'y']))).toBe(scopeKeyOf(caps(['y', 'x'])));
  expect(scopeKeyOf(caps(['x']))).not.toBe(scopeKeyOf(caps(['x', 'y'])));
  expect(scopeKeyOf(caps(['x'], 'b'))).not.toBe(scopeKeyOf(caps(['x'])));
  expect(scopeKeyOf(null)).toBeNull();
});

test('a variant that fits evicts nothing, exactly at both limits', () => {
  const entries = [entry('a', 40, 1), entry('b', 40, 2)];
  expect(planVariantEviction(entries, { id: 'c', bytes: 20 }, limits)).toEqual({
    store: true,
    evict: [],
    reason: null,
  });
});

test('one over the count limit evicts the least recently used', () => {
  const entries = [entry('a', 1, 3), entry('b', 1, 1), entry('c', 1, 2)];
  expect(planVariantEviction(entries, { id: 'd', bytes: 1 }, limits)).toEqual({
    store: true,
    evict: ['b'],
    reason: null,
  });
});

test('one byte over the byte budget evicts until it fits', () => {
  const entries = [entry('a', 50, 1), entry('b', 50, 2)];
  const plan = planVariantEviction(entries, { id: 'c', bytes: 1 }, limits);
  expect(plan.evict).toEqual(['a']);
});

test('ties in recency are broken by id so the plan is deterministic', () => {
  const entries = [entry('b', 1, 5), entry('a', 1, 5), entry('c', 1, 5)];
  const plan = planVariantEviction(entries, { id: 'd', bytes: 1 }, limits);
  expect(plan.evict).toEqual(['a']);
});

test('pinned variants are never evicted; when only pinned remain nothing is stored', () => {
  const entries = [entry('a', 1, 1), entry('b', 1, 2), entry('c', 1, 3)];
  expect(
    planVariantEviction(entries, { id: 'd', bytes: 1 }, limits, new Set(['a']))
      .evict,
  ).toEqual(['b']);
  expect(
    planVariantEviction(
      entries,
      { id: 'd', bytes: 1 },
      limits,
      new Set(['a', 'b', 'c']),
    ),
  ).toEqual({ store: false, evict: [], reason: 'pinned' });
});

test('an oversized variant is refused and evicts nothing', () => {
  const entries = [entry('a', 1, 1)];
  expect(planVariantEviction(entries, { id: 'b', bytes: 101 }, limits)).toEqual(
    { store: false, evict: [], reason: 'oversize' },
  );
  // Exactly the whole budget is allowed (it displaces what is there).
  expect(
    planVariantEviction(entries, { id: 'b', bytes: 100 }, limits).evict,
  ).toEqual(['a']);
});

test('replacing a stored variant does not count it twice', () => {
  const entries = [entry('a', 1, 1), entry('b', 1, 2), entry('c', 1, 3)];
  expect(
    planVariantEviction(entries, { id: 'a', bytes: 1 }, limits).evict,
  ).toEqual([]);
});

test('a trim without an incoming variant brings the cache within the limits', () => {
  const entries = [entry('a', 1, 1), entry('b', 1, 2), entry('c', 1, 3)];
  const plan = planVariantEviction(entries, null, {
    sharedVariantLimit: 1,
    sharedVariantMaxBytes: 100,
  });
  expect(plan.evict).toEqual(['a', 'b']);
});

test('only a listing that fits whole is complete and may keep its ETag', () => {
  const images = [1, 2, 3].map((id) => ({ id }));
  expect(listingForStorage(images, 3)).toEqual({ images, complete: true });
  expect(listingForStorage(images, 2)).toEqual({
    images: images.slice(0, 2),
    complete: false,
  });
  expect(listingForStorage([], 3)).toEqual({ images: [], complete: true });
});

test('a read that began before a delete drops the image; a later read settles it', () => {
  const images = [{ id: 'a' }, { id: 'b' }];
  const tombstones = new Map([['a', 5]]);
  expect(reconcileDeletions(images, tombstones, 4)).toEqual({
    images: [{ id: 'b' }],
    settled: [],
  });
  expect(reconcileDeletions(images, tombstones, 5)).toEqual({
    images,
    settled: ['a'],
  });
});

// --- Private admission and the volatile pool --------------------------------

const privateLimits = { privateRecordLimit: 3, privateMaxBytes: 100 };

test('a record or byte that fits the limits exactly is admitted', () => {
  expect(
    planPrivateAdmission(
      { count: 2, bytes: 50 },
      { newRecord: true, bytes: 50 },
      privateLimits,
    ),
  ).toEqual({ admit: true });
});

test('one record over, or one byte over, is refused with its reason', () => {
  expect(
    planPrivateAdmission(
      { count: 3, bytes: 0 },
      { newRecord: true, bytes: 0 },
      privateLimits,
    ),
  ).toEqual({ admit: false, reason: ADMISSION_REFUSAL.RECORD_LIMIT });
  expect(
    planPrivateAdmission(
      { count: 1, bytes: 100 },
      { newRecord: true, bytes: 1 },
      privateLimits,
    ),
  ).toEqual({ admit: false, reason: ADMISSION_REFUSAL.BYTE_LIMIT });
});

test('bytes for an existing row never count a new record; a limit of zero admits nothing', () => {
  expect(
    planPrivateAdmission(
      { count: 3, bytes: 10 },
      { newRecord: false, bytes: 10 },
      privateLimits,
    ),
  ).toEqual({ admit: true });
  expect(
    planPrivateAdmission(
      { count: 0, bytes: 0 },
      { newRecord: true, bytes: 0 },
      { ...privateLimits, privateRecordLimit: 0 },
    ),
  ).toEqual({ admit: false, reason: ADMISSION_REFUSAL.RECORD_LIMIT });
});

test('stored entries above lowered limits are never evicted, only new admission is refused', () => {
  const lowered = { privateRecordLimit: 1, privateMaxBytes: 10 };
  const plan = planPrivateAdmission(
    { count: 5, bytes: 500 },
    { newRecord: true, bytes: 1 },
    lowered,
  );
  expect(plan.admit).toBe(false);
  expect(Object.keys(plan)).toEqual(['admit', 'reason']);
});

const pool = { privateVolatileRecordLimit: 2, privateVolatileMaxBytes: 100 };

test('the volatile pool grants a slot and holds bytes only while both budgets fit', () => {
  expect(planVolatileSlot({ slots: 1, bytes: 60 }, 40, pool)).toEqual({
    slot: true,
    hold: true,
  });
  // The slot is granted but the bytes are not held: a server link only.
  expect(planVolatileSlot({ slots: 1, bytes: 60 }, 41, pool)).toEqual({
    slot: true,
    hold: false,
  });
  expect(planVolatileSlot({ slots: 0, bytes: 0 }, null, pool)).toEqual({
    slot: true,
    hold: false,
  });
});

test('a full pool refuses every further slot', () => {
  expect(planVolatileSlot({ slots: 2, bytes: 0 }, 1, pool)).toEqual({
    slot: false,
    reason: VOLATILE_REFUSAL.NO_SLOT,
  });
  expect(
    planVolatileSlot({ slots: 0, bytes: 0 }, 1, {
      ...pool,
      privateVolatileRecordLimit: 0,
    }).slot,
  ).toBe(false);
});

test('selected-detail LRU enforces count and byte bounds without evicting pins', () => {
  const details = [entry('a', 60, 1), entry('b', 40, 2)];
  const detailLimits = {
    libraryDetailLimit: 2,
    libraryDetailMaxBytes: 100,
  };
  expect(
    planLibraryDetailEviction(
      details,
      { id: 'c', bytes: 40 },
      detailLimits,
      new Set(['a']),
    ),
  ).toEqual({ store: true, evict: ['b'], reason: null });
  expect(
    planLibraryDetailEviction(
      details,
      { id: 'c', bytes: 40 },
      detailLimits,
      new Set(['a', 'b']),
    ),
  ).toEqual({ store: false, evict: [], reason: 'pinned' });
});
