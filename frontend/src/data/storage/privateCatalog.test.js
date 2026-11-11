import { expect, test } from 'vitest';
import { STORE } from './cacheDb.js';
import { createCacheStore } from './cacheStore.js';
import { memoryDb } from '../../../tests/helpers/cacheTestSupport.js';
import { createPrivateCatalog } from './privateCatalog.js';

const row = (key, addedAt, payload = '') => ({
  key,
  addedAt,
  origin: 'generated',
  record: { id: key, payload },
  watermark: null,
  hasFull: true,
  hasThumbnail: false,
  hasPrepared: false,
});

function scriptedStore(initial) {
  let rows = [...initial];
  let seq = 1;
  let pause;
  const store = {
    async privateCount() {
      return { count: rows.length, seq };
    },
    async readPrivatePage({ anchor = null, direction = 'older', limit = 40 }) {
      const source = [...rows].sort(
        (a, b) => b.addedAt - a.addedAt || b.key.localeCompare(a.key),
      );
      let start = 0;
      if (anchor) {
        const index = source.findIndex(
          (candidate) =>
            candidate.addedAt === anchor.addedAt &&
            candidate.key === anchor.key,
        );
        if (index >= 0) start = index + (direction === 'older' ? 1 : -limit);
        else
          start = source.findIndex(
            (candidate) =>
              candidate.addedAt < anchor.addedAt ||
              (candidate.addedAt === anchor.addedAt &&
                candidate.key < anchor.key),
          );
        start = Math.max(0, start);
      }
      let result = source.slice(start, start + limit);
      if (direction === 'newer') result = result.reverse();
      const responseSeq = seq;
      const gate = pause;
      pause = null;
      if (gate) await gate;
      const last = result.at(-1);
      return {
        rows: result,
        next:
          last &&
          source.some(
            (candidate) =>
              candidate.addedAt < last.addedAt ||
              (candidate.addedAt === last.addedAt && candidate.key < last.key),
          )
            ? { addedAt: last.addedAt, key: last.key }
            : null,
        previous: null,
        seq: responseSeq,
      };
    },
    async readPrivateAround(identity, { before = 1, after = 1 } = {}) {
      const ordered = [...rows].sort(
        (a, b) => b.addedAt - a.addedAt || b.key.localeCompare(a.key),
      );
      const index = ordered.findIndex(
        (candidate) =>
          candidate.key === identity.key &&
          candidate.addedAt === identity.addedAt,
      );
      return index < 0
        ? { missing: true, rows: [], seq }
        : {
            missing: false,
            rows: ordered.slice(Math.max(0, index - before), index + after + 1),
            seq,
          };
    },
    async readPrivateDetail(key) {
      return rows.find((candidate) => candidate.key === key) ?? null;
    },
    async scanPrivateSlice() {
      return { rows: [], seq, done: true };
    },
    setRows(next) {
      rows = [...next];
      seq++;
    },
    setSequence(next) {
      seq = next;
    },
    hold() {
      pause = new Promise((resolve) => {
        store.release = resolve;
      });
    },
    release() {
      pause = null;
      store.release?.();
    },
  };
  return store;
}

function actualStore(records) {
  const db = memoryDb();
  db.data.set(STORE.PRIVATE, new Map());
  db.data.set(STORE.PRIVATE_MEDIA, new Map());
  db.data.set(STORE.META, new Map());
  for (const { key, addedAt, payload = '' } of records)
    db.data.get(STORE.PRIVATE).set(key, {
      record: { id: key, payload },
      origin: 'generated',
      addedAt,
    });
  return createCacheStore(db, {
    privateRecordLimit: 1,
    privateMaxBytes: 1,
    sharedRecordLimit: 1,
    sharedVariantLimit: 1,
    sharedVariantMaxBytes: 1,
  });
}

test('independent bounded surfaces traverse tied keys without claiming completeness', async () => {
  const rows = Array.from({ length: 9 }, (_, index) =>
    row(`k${index}`, Math.floor(index / 3)),
  );
  const store = scriptedStore(rows);
  const catalog = createPrivateCatalog(store, {
    create: { rows: 2, bytes: 4096 },
    library: { rows: 3, bytes: 4096 },
  });
  const seen = [];
  let result = await catalog.first('create');
  while (result.accepted) {
    seen.push(...result.state.rows.map((item) => item.key));
    if (!result.state.next) break;
    result = await catalog.older('create');
  }
  expect(seen).toHaveLength(9);
  expect(new Set(seen).size).toBe(9);
  expect(catalog.snapshot('create').complete).toBe(false);
  expect(catalog.snapshot('create').rows.length).toBeLessThanOrEqual(2);
  expect(catalog.snapshot('library').rows).toEqual([]);
  expect(catalog.snapshot('create').bytes).toBeLessThanOrEqual(4096);
});

test('latest request wins, older sequence is discarded, and absent window rows are not deletions', async () => {
  const store = scriptedStore([row('a', 1), row('b', 2)]);
  const catalog = createPrivateCatalog(store, {
    create: { rows: 1, bytes: 4096 },
  });
  await catalog.first('create');
  store.hold();
  const delayed = catalog.first('create');
  store.setRows([row('new', 3), row('b', 2)]);
  await catalog.first('create');
  store.release();
  const stale = await delayed;
  expect(stale.stale).toBe(true);
  expect(catalog.snapshot('create').rows.map((item) => item.key)).toEqual([
    'new',
  ]);
  expect(await catalog.lookup('b')).toMatchObject({ key: 'b' });
  expect(await catalog.confirm({ key: 'b', addedAt: 2 })).toMatchObject({
    key: 'b',
  });
  expect(await catalog.confirm({ key: 'b', addedAt: 1 })).toBeNull();
  expect((await catalog.count()).count).toBe(2);
});

test('shared sequence knowledge rejects a pending read made stale by another surface or count', async () => {
  const store = scriptedStore([row('a', 1)]);
  const catalog = createPrivateCatalog(store, {
    create: { rows: 1, bytes: 4096 },
    library: { rows: 1, bytes: 4096 },
  });
  store.hold();
  const oldCreateRead = catalog.first('create');
  store.setSequence(2);
  await catalog.first('library');
  store.release();
  expect((await oldCreateRead).stale).toBe(true);

  store.hold();
  const oldLibraryRead = catalog.first('library');
  store.setSequence(3);
  await catalog.count();
  store.release();
  expect((await oldLibraryRead).stale).toBe(true);
});

test('exact around lookup and named pin ledger preserve incarnation and refuse overflow', async () => {
  const store = scriptedStore([row('visible', 1), row('off-window', 2)]);
  const catalog = createPrivateCatalog(store, {
    create: { rows: 1, bytes: 4096 },
    pins: { entries: 1, bytes: 4096 },
  });
  await catalog.first('create');
  const exact = await catalog.around(
    'create',
    { key: 'off-window', addedAt: 2 },
    { before: 0, after: 0 },
  );
  expect(exact.state.rows.map((item) => item.key)).toEqual(['off-window']);
  expect(
    (await catalog.pin({ key: 'off-window', addedAt: 2 }, 'selected')).accepted,
  ).toBe(true);
  expect(
    await catalog.pin({ key: 'visible', addedAt: 1 }, 'draft-base'),
  ).toMatchObject({ accepted: false, reason: 'pin-limit', count: 1 });
  expect(
    catalog.pin({ key: 'off-window', addedAt: 2 }, 'draft-base').accepted,
  ).toBe(true);
  expect(catalog.pinSnapshot()).toMatchObject([
    {
      identity: { key: 'off-window', addedAt: 2 },
      roles: ['selected', 'draft-base'],
    },
  ]);
  expect(catalog.unpin({ key: 'off-window', addedAt: 2 }, 'selected')).toBe(
    true,
  );
  expect(catalog.pinSnapshot()[0].roles).toEqual(['draft-base']);
  expect(() =>
    catalog.pin({ key: 'off-window', addedAt: 2 }, 'arbitrary'),
  ).toThrow(TypeError);
  expect(catalog.unpin({ key: 'off-window', addedAt: 2 })).toBe(true);
  expect(catalog.pinSnapshot()).toEqual([]);
  store.setRows([row('off-window', 3)]);
  expect(await catalog.confirm({ key: 'off-window', addedAt: 2 })).toBeNull();
  store.setRows([]);
  expect(await catalog.confirm({ key: 'off-window', addedAt: 3 })).toBeNull();
});

test('retained byte bound admits one explicit oversized record only', async () => {
  const store = scriptedStore([
    row('large', 2, 'x'.repeat(800)),
    row('next', 1),
  ]);
  const catalog = createPrivateCatalog(store, {
    library: { rows: 10, bytes: 128 },
  });
  const result = await catalog.first('library');
  expect(result.state.rows).toHaveLength(1);
  expect(result.state.rows[0].key).toBe('large');
  expect(result.state.oversized).toBe(true);
  expect(result.state.bytes).toBeGreaterThan(128);
});

test('watermark action pins survive selection release and role bytes are restored on release', () => {
  const identity = { key: 'prepared-source', addedAt: 1 };
  const store = scriptedStore([]);
  const catalog = createPrivateCatalog(store);
  const selected = catalog.pin(identity, 'selected');
  const action = catalog.pin(identity, 'watermark-action');
  expect(action.accepted).toBe(true);
  expect(action.bytes).toBeGreaterThan(selected.bytes);
  expect(catalog.unpin(identity, 'selected')).toBe(true);
  expect(catalog.pinSnapshot()[0].roles).toEqual(['watermark-action']);
  expect(catalog.unpin(identity, 'watermark-action')).toBe(true);
  expect(catalog.pin(identity, 'selected').bytes).toBe(selected.bytes);

  const tight = createPrivateCatalog(store, {
    pins: { entries: 1, bytes: selected.bytes },
  });
  expect(tight.pin(identity, 'selected').accepted).toBe(true);
  expect(tight.pin(identity, 'watermark-action')).toMatchObject({
    accepted: false,
    reason: 'pin-limit',
    bytes: selected.bytes,
  });
  expect(tight.pinSnapshot()[0].roles).toEqual(['selected']);
});

test('actual cache store navigates forward and backward with bounded byte cursors', async () => {
  const records = Array.from({ length: 11 }, (_, index) => ({
    key: `k${String(index).padStart(2, '0')}`,
    addedAt: Math.floor(index / 2),
  }));
  const catalog = createPrivateCatalog(actualStore(records), {
    library: { rows: 4, bytes: 270 },
  });
  const pages = [];
  let current = await catalog.first('library');
  while (current.accepted) {
    pages.push(current.state.rows.map((item) => item.key));
    if (!current.state.next) break;
    current = await catalog.older('library');
  }
  expect(pages.flat()).toHaveLength(records.length);
  expect(new Set(pages.flat()).size).toBe(records.length);
  expect(pages.every((page) => page.length > 0)).toBe(true);

  const reverse = [];
  while (catalog.snapshot('library').previous) {
    current = await catalog.newer('library');
    reverse.push(current.state.rows.map((item) => item.key));
  }
  expect(reverse).toEqual(pages.slice(0, -1).reverse());
});

test('actual around window remains contiguous and exposes only genuine edge cursors', async () => {
  const records = [
    { key: 'newest', addedAt: 5 },
    { key: 'blocker', addedAt: 4, payload: 'x'.repeat(1400) },
    { key: 'selected', addedAt: 3 },
    { key: 'older', addedAt: 2 },
    { key: 'oldest', addedAt: 1 },
  ];
  const catalog = createPrivateCatalog(actualStore(records), {
    library: { rows: 4, bytes: 500 },
  });
  const around = await catalog.around(
    'library',
    { key: 'selected', addedAt: 3 },
    { before: 2, after: 1 },
  );
  expect(around.state.rows.map((item) => item.key)).toEqual([
    'selected',
    'older',
  ]);
  expect(around.state.previous).toEqual({ key: 'selected', addedAt: 3 });
  expect(around.state.next).toEqual({ key: 'older', addedAt: 2 });
  const newest = await catalog.around(
    'library',
    { key: 'oldest', addedAt: 1 },
    { before: 0, after: 0 },
  );
  expect(newest.state.next).toBeNull();
  expect(newest.state.previous).toEqual({ key: 'oldest', addedAt: 1 });
  const page = await catalog.newer('library');
  expect(page.state.rows.map((item) => item.key)).toEqual([
    'selected',
    'older',
  ]);
  const newestEdge = await catalog.around(
    'library',
    { key: 'newest', addedAt: 5 },
    { before: 0, after: 0 },
  );
  expect(newestEdge.state.previous).toBeNull();
  expect(newestEdge.state.next).toEqual({ key: 'newest', addedAt: 5 });
  const missing = await catalog.around(
    'library',
    { key: 'gone', addedAt: 99 },
    { before: 0, after: 0 },
  );
  expect(missing.state.missing).toBe(true);
  expect(missing.state.rows).toEqual([]);
});

test('a tighter repository byte window resumes at its last retained row', async () => {
  const store = scriptedStore(
    Array.from({ length: 8 }, (_, index) => row(`p${index}`, index)),
  );
  const catalog = createPrivateCatalog(store, {
    library: { rows: 4, bytes: 280 },
  });
  const seen = [];
  let result = await catalog.first('library');
  while (result.accepted) {
    seen.push(...result.state.rows.map((item) => item.key));
    if (!result.state.next) break;
    result = await catalog.older('library');
  }
  expect(seen).toHaveLength(8);
  expect(new Set(seen).size).toBe(8);
});

test('read failures remain visible and removed anchors remain exclusive', async () => {
  const store = actualStore([
    { key: 'new', addedAt: 2 },
    { key: 'old', addedAt: 1 },
  ]);
  const catalog = createPrivateCatalog(store, {
    library: { rows: 1, bytes: 4096 },
  });
  await catalog.first('library');
  const oldAnchor = catalog.snapshot('library').next;
  await store.removePrivate('new', 2);
  const old = await catalog.older('library');
  expect(old.state.rows.map((item) => item.key)).toEqual(['old']);
  expect(old.state.next).toBeNull();
  expect(oldAnchor).toEqual({ key: 'new', addedAt: 2 });

  const failing = createPrivateCatalog({
    privateCount: async () => ({ count: 0, seq: 0 }),
    readPrivatePage: async () => {
      throw new Error('read failed');
    },
    readPrivateAround: async () => ({ missing: true, rows: [], seq: 0 }),
    readPrivateDetail: async () => null,
    scanPrivateSlice: async () => ({ rows: [], seq: 0 }),
  });
  const result = await failing.first('library');
  expect(result.accepted).toBe(false);
  expect(result.error.message).toBe('read failed');
  expect(failing.snapshot('library').error.message).toBe('read failed');
});
