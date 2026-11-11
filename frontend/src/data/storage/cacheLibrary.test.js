import { expect, test } from 'vitest';

import { STORE } from './cacheDb.js';
import { createCacheStore } from './cacheStore.js';
import { memoryDb } from '../../../tests/helpers/cacheTestSupport.js';

const limits = {
  sharedRecordLimit: 3,
  sharedVariantLimit: 4,
  sharedVariantMaxBytes: 4000,
  sharedDetailRecordLimit: 2,
  sharedDetailMaxBytes: 4000,
  sharedPageManifestLimit: 64,
  sharedPageMaxBytes: 8 * 1024 * 1024,
};

const summary = (id) => ({
  id,
  storage_id: 'shared',
  filename: `${id}.png`,
  title: `Image ${id}`,
  extension: { enabled: false, number: 0 },
});

const record = (id) => ({
  ...summary(id),
  visibility: 'shared',
  width: 20,
  height: 10,
  dimensions: { width: 20, height: 10 },
  prompt: `Prompt ${id}`,
  selected_controls: [],
});

const page = (id, position, revision = 3) => ({
  listing_kind: 'summary-page',
  count: 1,
  total: 10,
  orientation_counts: { landscape: 10, portrait: 0, square: 0, unknown: 0 },
  images: [summary(id)],
  position,
  revision,
  next_cursor: `next-${id}`,
  previous_cursor: `previous-${id}`,
  etag: `etag-${id}`,
});

test('page manifests persist only the bounded summaries and match their binding', async () => {
  const db = memoryDb();
  const store = createCacheStore(db, limits, { openChannel: () => null });
  const window = {
    binding: {
      q: 'blue',
      orientation: null,
      eventName: 'show',
      order: 'newest',
      limit: 24,
    },
    pages: [page('one', 0), page('two', 24), page('three', 48)],
    activeIndex: 1,
    revision: 3,
    complete: false,
  };
  expect(await store.persistLibraryWindow('scope', window)).toMatchObject({
    persisted: true,
    stale: false,
  });
  expect(db.data.get(STORE.LIBRARY_SUMMARIES)).toHaveProperty('size', 3);
  expect(db.data.get(STORE.LIBRARY_DETAILS)?.size ?? 0).toBe(0);

  const hydrated = await store.hydrateLibraryWindow('scope', window.binding);
  expect(hydrated).toMatchObject({
    activeIndex: 1,
    revision: 3,
    complete: false,
  });
  expect(hydrated.pages.map((entry) => entry.images[0].id)).toEqual([
    'one',
    'two',
    'three',
  ]);
  expect(hydrated.pages[0].images[0].extension).toEqual({
    enabled: false,
    number: 0,
  });
  expect(await store.hydrateLibraryWindow('other-scope', window.binding)).toBe(
    null,
  );
  expect(
    await store.hydrateLibraryWindow('scope', {
      ...window.binding,
      q: 'red',
    }),
  ).toBeNull();
});

test('oversized page windows do not evict the previously cached window', async () => {
  const db = memoryDb();
  const store = createCacheStore(
    db,
    { ...limits, sharedPageMaxBytes: 1024 },
    { openChannel: () => null },
  );
  const binding = {
    q: '',
    orientation: null,
    eventName: null,
    order: 'newest',
    limit: 24,
  };
  const original = {
    binding,
    pages: [page('kept', 0)],
    activeIndex: 0,
    revision: 3,
  };
  expect((await store.persistLibraryWindow('scope', original)).persisted).toBe(
    true,
  );
  const oversized = {
    ...original,
    pages: [page('too-large', 0)],
  };
  oversized.pages[0].images[0].filename = 'x'.repeat(2048);
  expect(await store.persistLibraryWindow('scope', oversized)).toMatchObject({
    persisted: false,
    reason: 'oversize',
  });
  expect(
    (await store.hydrateLibraryWindow('scope', binding)).pages[0].images[0].id,
  ).toBe('kept');
});

test('summary identities authorize variant writes without populating legacy records', async () => {
  const db = memoryDb();
  const store = createCacheStore(db, limits, { openChannel: () => null });
  const image = { ...summary('listed'), sha256: 'source-hash' };
  const window = {
    binding: {
      q: '',
      orientation: null,
      eventName: null,
      order: 'newest',
      limit: 24,
    },
    pages: [{ ...page('listed', 0), images: [image] }],
    activeIndex: 0,
    revision: 3,
  };
  await store.persistLibraryWindow('scope', window);
  expect(
    await store.putVariant(image, 'thumbnail', new Blob(['thumb'])),
  ).toMatchObject({ persisted: true });
  expect(db.data.get(STORE.RECORDS)?.size ?? 0).toBe(0);
  const detail = record('detail-only');
  await store.putLibraryDetail(detail, 'detail-etag');
  expect(
    await store.putVariant(detail, 'original', new Blob(['original'])),
  ).toMatchObject({ persisted: true });
  expect(
    await store.putVariant(
      { ...image, sha256: 'stale' },
      'original',
      new Blob(['x']),
    ),
  ).toMatchObject({
    persisted: false,
    reason: 'changed',
  });
});

test('v5 raw page summaries upgrade in place so cached media remains eligible', async () => {
  const db = memoryDb();
  const store = createCacheStore(db, limits, { openChannel: () => null });
  const image = { ...summary('legacy'), sha256: 'legacy-hash' };
  const key = '0|0|shared/legacy.png';
  db.data.set(
    STORE.LIBRARY_PAGES,
    new Map([
      [
        'active-library-window',
        {
          scopeKey: 'scope',
          binding: {
            q: '',
            orientation: null,
            eventName: null,
            order: 'newest',
            limit: 24,
          },
          pages: [{ page: page('legacy', 0), summaryKeys: [key] }],
          activeIndex: 0,
          revision: 3,
        },
      ],
    ]),
  );
  db.data.set(STORE.LIBRARY_SUMMARIES, new Map([[key, image]]));
  const hydrated = await store.hydrateLibraryWindow('scope', {
    q: '',
    orientation: null,
    eventName: null,
    order: 'newest',
    limit: 24,
  });
  expect(hydrated.pages[0].images[0]).toEqual(image);
  expect(db.data.get(STORE.LIBRARY_SUMMARIES).get(key)).toMatchObject({
    identity: 'shared/legacy.png',
    summary: image,
  });
  expect(
    await store.putVariant(image, 'thumbnail', new Blob(['thumbnail'])),
  ).toMatchObject({
    persisted: true,
  });
});

test('summary count ceiling refuses a window before replacing the active cache', async () => {
  const db = memoryDb();
  const store = createCacheStore(
    db,
    { ...limits, sharedRecordLimit: 1 },
    { openChannel: () => null },
  );
  const binding = {
    q: '',
    orientation: null,
    eventName: null,
    order: 'newest',
    limit: 24,
  };
  const one = {
    binding,
    pages: [page('kept', 0)],
    activeIndex: 0,
    revision: 3,
  };
  await store.persistLibraryWindow('scope', one);
  const two = {
    ...one,
    pages: [
      { ...page('too-many', 0), images: [summary('one'), summary('two')] },
    ],
  };
  expect(await store.persistLibraryWindow('scope', two)).toMatchObject({
    persisted: false,
    reason: 'oversize',
  });
  expect(
    (await store.hydrateLibraryWindow('scope', binding)).pages[0].images[0].id,
  ).toBe('kept');
});

test('page manifest limit bounds cached page entries below the three-page maximum', async () => {
  const db = memoryDb();
  const store = createCacheStore(
    db,
    { ...limits, sharedPageManifestLimit: 1 },
    { openChannel: () => null },
  );
  const binding = {
    q: '',
    orientation: null,
    eventName: null,
    order: 'newest',
    limit: 24,
  };
  const current = {
    binding,
    pages: [page('kept', 0)],
    activeIndex: 0,
    revision: 3,
  };
  await store.persistLibraryWindow('scope', current);
  const tooMany = { ...current, pages: [page('a', 0), page('b', 24)] };
  expect(await store.persistLibraryWindow('scope', tooMany)).toMatchObject({
    persisted: false,
    reason: 'oversize',
  });
  expect(
    (await store.hydrateLibraryWindow('scope', binding)).pages[0].images[0].id,
  ).toBe('kept');
});

test('full details use an independent bounded LRU and delete removes exact detail', async () => {
  const db = memoryDb();
  const store = createCacheStore(db, limits, { openChannel: () => null });
  const a = record('a');
  const b = record('b');
  const c = record('c');
  expect((await store.putLibraryDetail(a, 'a-etag')).persisted).toBe(true);
  expect((await store.putLibraryDetail(b, 'b-etag')).persisted).toBe(true);
  expect(await store.getLibraryDetail(a)).toMatchObject({
    record: a,
    etag: 'a-etag',
  });
  expect((await store.putLibraryDetail(c, 'c-etag')).persisted).toBe(true);
  expect(await store.getLibraryDetail(b)).toBeNull();
  expect(await store.getLibraryDetail(a)).toMatchObject({ record: a });
  expect(await store.getLibraryDetail(c)).toMatchObject({ record: c });
  expect(db.data.get(STORE.META).get('libraryDetailCount')).toBe(2);
  expect(db.data.get(STORE.META).get('libraryDetailBytes')).toBeGreaterThan(0);

  const ticket = await store.beginRead();
  await store.commitListing('scope', ticket, { images: [a, c], etag: 'all' });
  await store.purgeShared('shared/a.png');
  expect(await store.getLibraryDetail(a)).toBeNull();
  expect(await store.getLibraryDetail(c)).toMatchObject({ record: c });
  expect(db.data.get(STORE.LIBRARY_PAGES)?.size ?? 0).toBe(0);
});

test('an oversized single detail refuses caching without evicting another detail', async () => {
  const db = memoryDb();
  const store = createCacheStore(
    db,
    {
      ...limits,
      sharedDetailRecordLimit: 4,
      sharedDetailMaxBytes: 128,
    },
    { openChannel: () => null },
  );
  const small = { id: 'small', selected_controls: [] };
  const large = {
    id: 'large',
    selected_controls: [],
    extension: 'x'.repeat(200),
  };
  expect((await store.putLibraryDetail(small, 'small-etag')).persisted).toBe(
    true,
  );
  expect(await store.putLibraryDetail(large, 'large-etag')).toMatchObject({
    persisted: false,
    reason: 'oversize',
  });
  expect(await store.getLibraryDetail(small)).toMatchObject({ record: small });
  expect(await store.getLibraryDetail(large)).toBeNull();
});

test('a page read begun before a confirmed deletion cannot persist summaries', async () => {
  const db = memoryDb();
  const store = createCacheStore(db, limits, { openChannel: () => null });
  const ticket = await store.beginRead();
  await store.purgeShared('shared/gone.png');
  const persisted = await store.persistLibraryWindow(
    'scope',
    {
      binding: {
        q: '',
        orientation: null,
        eventName: null,
        order: 'newest',
        limit: 24,
      },
      pages: [page('gone', 0)],
      activeIndex: 0,
      revision: 3,
    },
    ticket,
  );
  expect(persisted).toMatchObject({ persisted: false, stale: true });
  expect(db.data.get(STORE.LIBRARY_PAGES)?.size ?? 0).toBe(0);
  expect(db.data.get(STORE.LIBRARY_SUMMARIES)?.size ?? 0).toBe(0);
});

test('a full variant cache evicts only the oldest unpinned rows it needs', async () => {
  const db = memoryDb();
  const store = createCacheStore(db, limits, { openChannel: () => null });
  await store.persistLibraryWindow(
    'scope',
    {
      binding: { q: '' },
      pages: [page('a', 0)],
      activeIndex: 0,
      revision: 3,
    },
    null,
  );
  const blob = new Blob(['x'.repeat(100)]);
  const target = summary('a');
  const seeded = new Map(
    ['one', 'two', 'three', 'four'].map((id, index) => [
      `${id}|thumbnail`,
      { key: id, blob, bytes: 100, sourceSha: null, lastUsedAt: index + 1 },
    ]),
  );
  const variants = db.data.get(STORE.VARIANTS) ?? new Map();
  for (const [id, row] of seeded) variants.set(id, row);
  db.data.set(STORE.VARIANTS, variants);
  db.data.set(
    STORE.META,
    new Map([...(db.data.get(STORE.META) ?? []), ['variantBytes', 400]]),
  );
  const result = await store.putVariant(target, 'thumbnail', blob, {
    pinned: new Set(['one|thumbnail']),
  });
  expect(result).toEqual({ persisted: true });
  const kept = [...db.data.get(STORE.VARIANTS).keys()];
  expect(kept).toHaveLength(4);
  expect(kept).toContain('one|thumbnail');
  expect(kept).not.toContain('two|thumbnail');
  expect(kept).toContain('three|thumbnail');
  expect(db.data.get(STORE.META).get('variantBytes')).toBe(400);
});

test('every variant pinned refuses the write and removes nothing', async () => {
  const db = memoryDb();
  const store = createCacheStore(
    db,
    { ...limits, sharedVariantLimit: 1 },
    {
      openChannel: () => null,
    },
  );
  await store.persistLibraryWindow(
    'scope',
    {
      binding: { q: '' },
      pages: [page('a', 0)],
      activeIndex: 0,
      revision: 3,
    },
    null,
  );
  const blob = new Blob(['x']);
  const variants = new Map([
    [
      'one|thumbnail',
      { key: 'one', blob, bytes: 1, sourceSha: null, lastUsedAt: 1 },
    ],
  ]);
  db.data.set(STORE.VARIANTS, variants);
  const result = await store.putVariant(summary('a'), 'thumbnail', blob, {
    pinned: new Set(['one|thumbnail']),
  });
  expect(result).toEqual({ persisted: false, reason: 'pinned' });
  expect([...db.data.get(STORE.VARIANTS).keys()]).toEqual(['one|thumbnail']);
});

test('a window whose cleanup failed locally does not hydrate the deleted image', async () => {
  const db = memoryDb();
  const store = createCacheStore(db, limits, { openChannel: () => null });
  const window = {
    binding: { q: '' },
    pages: [page('a', 0)],
    activeIndex: 0,
    revision: 3,
  };
  await store.persistLibraryWindow('scope', window, null);
  expect(
    await store.hydrateLibraryWindow('scope', window.binding),
  ).not.toBeNull();
  const key = [...db.data.get(STORE.LIBRARY_SUMMARIES).values()][0].identity;
  db.failNext(new Error('cleanup failed'));
  await expect(store.purgeShared(key)).rejects.toThrow('cleanup failed');
  // The rows survived the aborted transaction; the in-tab tombstone still wins.
  expect(db.data.get(STORE.LIBRARY_SUMMARIES).size).toBe(1);
  expect(await store.hydrateLibraryWindow('scope', window.binding)).toBeNull();
});

test('removing a detail with absent counters rebuilds them rather than assuming zero', async () => {
  const db = memoryDb();
  const store = createCacheStore(db, limits, { openChannel: () => null });
  await store.putLibraryDetail(record('a'), 'etag-a');
  await store.putLibraryDetail(record('b'), 'etag-b');
  const meta = db.data.get(STORE.META);
  meta.delete('libraryDetailCount');
  meta.delete('libraryDetailBytes');
  const before = [...db.data.get(STORE.LIBRARY_DETAILS).values()];
  const [keyA] = [...db.data.get(STORE.LIBRARY_DETAILS).keys()];
  await store.purgeShared(keyA);
  expect(meta.get('libraryDetailCount')).toBe(1);
  expect(meta.get('libraryDetailBytes')).toBe(before[1].bytes);
});
