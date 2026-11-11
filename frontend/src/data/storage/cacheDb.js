/**
 * The only module that touches `indexedDB`. It opens the one cache database
 * and runs transactions that settle exactly when the browser says they have:
 * resolved on `oncomplete`, rejected on `onabort` with `transaction.error`
 * (a quota failure at commit exists only there, never on a request).
 *
 * Every failure to obtain a database (no IndexedDB, denied storage,
 * `VersionError`, blocked or slow open) yields `null`, and callers carry on
 * with in-memory state.
 */
export const CACHE_DB_NAME = 'imagedials-cache';
/**
 * v1: shared library cache. v2 adds the private browser history stores. v3
 * adds the browser-local settings and the rebuildable prepared watermark copies.
 * v4 adds the `addedAt` index of the private history and fences earlier
 * writers. v5 adds separate bounded Library summary, page-manifest and detail
 * stores, fencing v4 writers before they can continue list-wide commits. v6
 * indexes summary identity so bounded Library media can be cached without
 * copying full detail into the legacy shared-record store. v7 creates nothing:
 * it fences v6 writers, which pruned private tombstones without the removal
 * fence and admitted below it, so they cannot revive a removed private image.
 * v8 adds a private mutation sequence and fences writers that do not maintain it.
 * v9 fences writers that can remove a replacement after confirming an older add.
 * v10 adds explicitly retained reference metadata and original bytes.
 * Upgrades only create what is missing; existing rows are never rewritten or
 * cleared.
 */
export const CACHE_DB_VERSION = 10;
export const OPEN_TIMEOUT_MS = 4000;

/** Object stores. Keys are out-of-line; values are described in cacheStore.js. */
export const STORE = Object.freeze({
  /** Explicitly retained reference originals; never disposable cache entries. */
  REFERENCE_ASSETS: 'referenceAssets',
  REFERENCE_MEDIA: 'referenceMedia',
  RECORDS: 'records',
  LISTINGS: 'listings',
  VARIANTS: 'variants',
  TOMBSTONES: 'tombstones',
  META: 'meta',
  /** Private generated and imported images: imageKey -> {record, origin, addedAt}. */
  PRIVATE: 'private',
  /** Private bytes: `key|kind` -> {key, blob, bytes}. */
  PRIVATE_MEDIA: 'privateMedia',
  /** Removed private images: imageKey -> {addedAt}. Separate from shared tombstones. */
  PRIVATE_TOMBSTONES: 'privateTombstones',
  /** Browser-local settings too large for LocalStorage: name -> value. */
  SETTINGS: 'settings',
  /** Rebuildable prepared watermark PNGs of shared originals: imageKey -> row. */
  SHARED_PREPARED: 'sharedPrepared',
  /** Bounded summary rows referenced only by the active page manifest. */
  LIBRARY_SUMMARIES: 'librarySummaries',
  /** One bounded three-page manifest for the active Library surface. */
  LIBRARY_PAGES: 'libraryPages',
  /** Exact full shared records in a small independent LRU. */
  LIBRARY_DETAILS: 'libraryDetails',
});
/** Index over `variants.lastUsedAt`, oldest first. */
export const VARIANT_USE_INDEX = 'lastUsedAt';
/** Index over `private.addedAt`, oldest first. */
export const PRIVATE_ADDED_INDEX = 'addedAt';
export const LIBRARY_DETAIL_USE_INDEX = 'lastUsedAt';
export const LIBRARY_SUMMARY_IDENTITY_INDEX = 'identity';

const requestResult = (request) =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

/** Promise-returning access to the stores of one live transaction. */
function accessTo(transaction) {
  const store = (name) => transaction.objectStore(name);
  return {
    get: (name, key) => requestResult(store(name).get(key)),
    getIndex: (name, index, key) =>
      requestResult(store(name).index(index).get(key)),
    put: (name, key, value) => requestResult(store(name).put(value, key)),
    delete: (name, key) => requestResult(store(name).delete(key)),
    count: (name) => requestResult(store(name).count()),
    has: (name, key) =>
      requestResult(store(name).getKey(key)).then(
        (value) => value !== undefined,
      ),
    scanKeyset: (name, index, anchor, direction, visit) =>
      new Promise((resolve, reject) => {
        const source = store(name).index(index);
        const forward = direction === 'next';
        const range = anchor
          ? forward
            ? IDBKeyRange.lowerBound(anchor.addedAt)
            : IDBKeyRange.upperBound(anchor.addedAt)
          : null;
        const request = source.openCursor(range, direction);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) {
            resolve();
            return;
          }
          if (anchor) {
            const keyOrder =
              cursor.key < anchor.addedAt
                ? -1
                : cursor.key > anchor.addedAt
                  ? 1
                  : 0;
            const primaryOrder =
              cursor.primaryKey < anchor.key
                ? -1
                : cursor.primaryKey > anchor.key
                  ? 1
                  : 0;
            const order = keyOrder || primaryOrder;
            if ((forward && order <= 0) || (!forward && order >= 0)) {
              const ahead = forward ? order < 0 : order > 0;
              if (ahead && cursor.key === anchor.addedAt)
                cursor.continuePrimaryKey(anchor.addedAt, anchor.key);
              else cursor.continue();
              return;
            }
          }
          Promise.resolve(visit(cursor.value, cursor.primaryKey)).then(
            (keepGoing) => {
              if (keepGoing === false) resolve();
              else cursor.continue();
            },
            reject,
          );
        };
      }),
    /**
     * Visit rows in key order, or in `index` order, until `visit` returns
     * false. `visit(value, primaryKey)`.
     */
    scan: (name, index, visit, { direction = 'next', range = null } = {}) =>
      new Promise((resolve, reject) => {
        const source = index ? store(name).index(index) : store(name);
        const request = source.openCursor(range, direction);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor || visit(cursor.value, cursor.primaryKey) === false)
            resolve();
          else cursor.continue();
        };
      }),
  };
}

function wrap(db) {
  let open = true;
  db.onversionchange = () => {
    open = false;
    db.close();
  };
  db.onclose = () => {
    open = false;
  };
  return {
    get open() {
      return open;
    },
    close() {
      open = false;
      db.close();
    },
    /**
     * Run `work(access)` inside one transaction over `storeNames`. `work` may
     * await only `access` calls (never a fetch, decode or digest). A thrown
     * error aborts the transaction, so nothing partial is ever committed.
     * @returns the value `work` returned, once the transaction has committed
     */
    run(storeNames, mode, work) {
      return new Promise((resolve, reject) => {
        let transaction;
        try {
          transaction = db.transaction(storeNames, mode);
        } catch (error) {
          reject(error);
          return;
        }
        let result;
        let failure = null;
        transaction.oncomplete = () => resolve(result);
        transaction.onabort = () =>
          reject(
            transaction.error ??
              failure ??
              new DOMException('The transaction was aborted.', 'AbortError'),
          );
        Promise.resolve()
          .then(() => work(accessTo(transaction)))
          .then(
            (value) => {
              result = value;
            },
            (error) => {
              failure = error;
              try {
                transaction.abort();
              } catch {
                // Already finished or aborted by the browser.
              }
            },
          );
      });
    },
  };
}

/**
 * Bring the database to the current schema. Only stores and indexes that are
 * missing are created, so rows of an earlier version (shared records, listings
 * and variants) survive an upgrade untouched.
 */
export function upgradeSchema(db, transaction) {
  const ensureStore = (name) =>
    db.objectStoreNames.contains(name)
      ? transaction.objectStore(name)
      : db.createObjectStore(name);
  for (const name of Object.values(STORE)) {
    const store = ensureStore(name);
    if (
      name === STORE.VARIANTS &&
      !store.indexNames.contains(VARIANT_USE_INDEX)
    )
      store.createIndex(VARIANT_USE_INDEX, VARIANT_USE_INDEX);
    if (
      name === STORE.PRIVATE &&
      !store.indexNames.contains(PRIVATE_ADDED_INDEX)
    )
      store.createIndex(PRIVATE_ADDED_INDEX, PRIVATE_ADDED_INDEX);
    if (
      name === STORE.LIBRARY_DETAILS &&
      !store.indexNames.contains(LIBRARY_DETAIL_USE_INDEX)
    )
      store.createIndex(LIBRARY_DETAIL_USE_INDEX, LIBRARY_DETAIL_USE_INDEX);
    if (
      name === STORE.LIBRARY_SUMMARIES &&
      !store.indexNames.contains(LIBRARY_SUMMARY_IDENTITY_INDEX)
    )
      store.createIndex(LIBRARY_SUMMARY_IDENTITY_INDEX, 'identity');
  }
}

/**
 * @param {{factory?: IDBFactory|null, name?: string, openTimeoutMs?: number}} [options]
 * @returns {Promise<ReturnType<typeof wrap>|null>} null when storage is unusable
 */
export function openCacheDb({
  factory = globalThis.indexedDB,
  name = CACHE_DB_NAME,
  openTimeoutMs = OPEN_TIMEOUT_MS,
} = {}) {
  if (!factory) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (db) => {
      if (settled) {
        // A late success after we gave up must not keep the database open.
        db?.close();
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(db ? wrap(db) : null);
    };
    let request;
    try {
      request = factory.open(name, CACHE_DB_VERSION);
    } catch {
      finish(null);
      return;
    }
    timer = setTimeout(() => finish(null), openTimeoutMs);
    request.onupgradeneeded = () =>
      upgradeSchema(request.result, request.transaction);
    request.onsuccess = () => finish(request.result);
    request.onerror = () => finish(null);
    request.onblocked = () => finish(null);
  });
}
