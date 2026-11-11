import { vi } from 'vitest';

/** A promise that a test settles by hand, to hold a step mid-flight. */
export function deferred() {
  const handle = {};
  handle.promise = new Promise((resolve, reject) => {
    handle.resolve = resolve;
    handle.reject = reject;
  });
  return handle;
}

/**
 * A scripted `cacheStore` double. It scripts the store INTERFACE (not
 * IndexedDB), so component and hook races can be driven step by step; the real
 * transactions are proven in Chromium (frontend/proof). Override any method.
 */
export function scriptedStore(overrides = {}) {
  return {
    durable: true,
    setLimits: vi.fn(),
    hydrate: vi.fn(async () => null),
    hydrateLibraryWindow: vi.fn(async () => null),
    persistLibraryWindow: vi.fn(async () => ({ persisted: true })),
    clearLibraryWindow: vi.fn(async () => ({ persisted: true })),
    getLibraryDetail: vi.fn(async () => null),
    putLibraryDetail: vi.fn(async () => ({ persisted: true })),
    beginRead: vi.fn(async () => ({ seq: 0, epoch: 0 })),
    commitListing: vi.fn(async (_scope, _ticket, { images }) => ({
      images,
      persisted: true,
      stale: false,
    })),
    noteMutation: vi.fn(async () => ({ persisted: true })),
    putRecord: vi.fn(async () => ({ persisted: true })),
    purgeShared: vi.fn(async () => ({ cleared: true })),
    getVariant: vi.fn(async () => null),
    putVariant: vi.fn(async () => ({ persisted: true })),
    dropVariant: vi.fn(async () => {}),
    loadPrivate: vi.fn(async () => []),
    readPrivate: vi.fn(async () => null),
    admitPrivate: vi.fn(async () => ({ persisted: true, duplicate: false })),
    removePrivate: vi.fn(async () => ({ removed: true })),
    onPrivateChange: vi.fn(() => () => {}),
    touch: vi.fn(),
    ...overrides,
  };
}

export const quotaError = () => new DOMException('full', 'QuotaExceededError');

/**
 * A transactional in-memory stand-in for `cacheDb`'s database: the same
 * `run(stores, mode, work)` contract (all-or-nothing, rejects with the error
 * `work` threw) over Maps. It exists so the REAL `createCacheStore` logic is
 * unit-tested; native IndexedDB behavior is proven in Chromium (frontend/proof).
 * `failNext(error, {when})` makes the next matching write transaction abort
 * after `work` ran, as a quota failure does at commit.
 */
export function memoryDb() {
  const data = new Map();
  const table = (name) => {
    if (!data.has(name)) data.set(name, new Map());
    return data.get(name);
  };
  const failures = [];
  // Overlapping readwrite transactions run one after another, as in IndexedDB.
  let writing = Promise.resolve();
  const db = {
    open: true,
    data,
    close() {},
    failNext(error, when = () => true) {
      failures.push({ error, when });
    },
    run(storeNames, mode, work) {
      if (mode !== 'readwrite') return runNow(storeNames, mode, work);
      const turn = writing.then(() => runNow(storeNames, mode, work));
      writing = turn.catch(() => {});
      return turn;
    },
  };
  async function runNow(storeNames, mode, work) {
    const names = [...storeNames];
    const before = new Map(names.map((name) => [name, new Map(table(name))]));
    const access = {
      get: async (name, key) => table(name).get(key),
      getIndex: async (name, index, key) =>
        [...table(name).values()].find((value) => value[index] === key),
      put: async (name, key, value) => void table(name).set(key, value),
      delete: async (name, key) => void table(name).delete(key),
      count: async (name) => table(name).size,
      has: async (name, key) => table(name).has(key),
      scanKeyset: async (name, _index, anchor, direction, visit) => {
        const rows = [...table(name)].sort(
          ([ak, a], [bk, b]) =>
            a.addedAt - b.addedAt || (ak < bk ? -1 : ak > bk ? 1 : 0),
        );
        if (direction === 'prev') rows.reverse();
        for (const [key, row] of rows) {
          const c = { addedAt: row.addedAt, key };
          if (anchor) {
            const cmp =
              c.addedAt - anchor.addedAt ||
              (key < anchor.key ? -1 : key > anchor.key ? 1 : 0);
            if (
              (direction === 'next' && cmp <= 0) ||
              (direction === 'prev' && cmp >= 0)
            )
              continue;
          }
          if ((await visit(row, key)) === false) break;
        }
      },
      scan: async (name, index, visit) => {
        const rows = [...table(name)];
        if (index) rows.sort(([, a], [, b]) => a[index] - b[index]);
        else rows.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        for (const [key, value] of rows) if (visit(value, key) === false) break;
      },
    };
    try {
      const result = await work(access);
      const at = failures.findIndex(
        (f) => mode === 'readwrite' && f.when(names),
      );
      if (at >= 0) throw failures.splice(at, 1)[0].error;
      return result;
    } catch (error) {
      for (const [name, rows] of before) data.set(name, rows);
      throw error;
    }
  }
  return db;
}

/** A blob of `bytes` bytes with an image type. */
export const imageBlob = (bytes = 8, type = 'image/png') =>
  new Blob([new Uint8Array(bytes)], { type });

/**
 * Tab-to-tab channels over one in-process bus, for `createCacheStore`'s
 * `openChannel` option: a message reaches every OTHER open channel, as with a
 * real BroadcastChannel. Every tab's store calls its own `openChannel`.
 */
export function memoryChannels() {
  const open = new Set();
  return () => {
    const channel = {
      onmessage: null,
      postMessage(data) {
        for (const other of open)
          if (other !== channel) other.onmessage?.({ data });
      },
      close() {
        open.delete(channel);
      },
    };
    open.add(channel);
    return channel;
  };
}
