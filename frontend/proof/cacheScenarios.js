/**
 * Browser scenarios for the shared-library cache. They import the real modules
 * (cacheDb.js, cacheStore.js) and run against NATIVE IndexedDB, so they must
 * run in a browser page (see docs on the F09 proof); they return plain JSON and
 * decide nothing about pass/fail beyond each scenario's own `pass` field.
 *
 * A runner opens a page on the dev server and calls, e.g.,
 *   page.evaluate(() => import('/proof/cacheScenarios.js').then((m) => m.lruOrder()))
 * Scenarios use databases of their own name, never the application's.
 */
import {
  CACHE_DB_VERSION,
  openCacheDb,
  STORE,
  upgradeSchema,
  VARIANT_USE_INDEX,
} from '../src/data/storage/cacheDb.js';
import { planVolatileSlot } from '../src/data/storage/cachePolicy.js';
import { createCacheStore } from '../src/data/storage/cacheStore.js';
import {
  PRIVATE_REMOVAL_FENCE_KEY,
  PRIVATE_SEQ_KEY,
  PRIVATE_TOMBSTONE_LIMIT,
  PRIVATE_TOMBSTONE_MAX_BYTES,
} from '../src/data/storage/cachePrivate.js';
import { DEFAULT_CLIENT_POLICY } from '../src/data/api/clientPolicy.js';

const MIB = 1024 * 1024;
const KIB = 1024;
const SCOPE = 'proof-scope';
const RECLAIM_WATCH_SECONDS = 20;
// The published defaults (shared/client-policy.json) with a wide shared cache.
const BIG_LIMITS = { ...DEFAULT_CLIENT_POLICY.cache };

const opened = new Map();

const wire = (id) => ({
  id,
  storage_id: 's',
  filename: `${id}.png`,
  sha256: `sha-${id}`,
});
const keyOf = (id) => `s/${id}.png`;
const idOf = (id, kind = 'thumbnail') => `${keyOf(id)}|${kind}`;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Random (incompressible) bytes, so the browser's quota accounting is real. */
function randomBlob(bytes) {
  const data = new Uint8Array(bytes);
  for (let at = 0; at < bytes; at += 65536)
    crypto.getRandomValues(data.subarray(at, Math.min(at + 65536, bytes)));
  return new Blob([data], { type: 'image/png' });
}

async function sha256(blob) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    await blob.arrayBuffer(),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function deleteDatabase(name) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error(`delete of ${name} is blocked`));
  });
}

/** Open (optionally from empty) a scenario database and its store. */
export async function openScenario({
  name,
  limits = BIG_LIMITS,
  reset = true,
  storeOptions,
}) {
  if (reset) {
    opened.get(name)?.db.close();
    await deleteDatabase(name);
  }
  const db = await openCacheDb({ name });
  if (!db) throw new Error('IndexedDB did not open');
  const store = createCacheStore(db, limits, storeOptions);
  opened.set(name, { db, store });
  return { name };
}

/** Native older-writer upgrade preserves private metadata and media without a rewrite. */
async function privateReadUpgrade(fromVersion) {
  const name = `o17-private-read-v${fromVersion}-upgrade`;
  await deleteDatabase(name);
  const blob = new Blob([new Uint8Array([7, 8, 9, 10])], { type: 'image/png' });
  const digestBefore = await sha256(blob);
  await new Promise((resolve, reject) => {
    const request = indexedDB.open(name, fromVersion);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const storeName of Object.values(STORE)) {
        const objectStore = db.createObjectStore(storeName);
        if (storeName === STORE.PRIVATE)
          objectStore.createIndex('addedAt', 'addedAt');
        if (storeName === STORE.VARIANTS)
          objectStore.createIndex('lastUsedAt', 'lastUsedAt');
        if (storeName === STORE.LIBRARY_DETAILS)
          objectStore.createIndex('lastUsedAt', 'lastUsedAt');
        if (storeName === STORE.LIBRARY_SUMMARIES)
          objectStore.createIndex('identity', 'identity');
      }
    };
    request.onsuccess = () => {
      const tx = request.result.transaction(
        [
          STORE.PRIVATE,
          STORE.PRIVATE_MEDIA,
          STORE.SETTINGS,
          STORE.SHARED_PREPARED,
        ],
        'readwrite',
      );
      tx.objectStore(STORE.PRIVATE).put(
        { record: wire('survivor'), origin: 'imported', addedAt: 5 },
        'survivor',
      );
      tx.objectStore(STORE.PRIVATE_MEDIA).put(
        { key: 'survivor', blob, bytes: blob.size, addedAt: 5 },
        'survivor|full',
      );
      tx.objectStore(STORE.SETTINGS).put({ untouched: true }, 'proof-setting');
      tx.objectStore(STORE.SHARED_PREPARED).put(
        { untouched: true, blob },
        'proof-prepared',
      );
      tx.oncomplete = () => {
        request.result.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
    request.onerror = () => reject(request.error);
  });
  const db = await openCacheDb({ name });
  if (!db) throw new Error('v7 database did not upgrade');
  const store = createCacheStore(db, BIG_LIMITS);
  const detail = await store.readPrivateDetail('survivor');
  const media = await store.readPrivateMedia(
    'survivor',
    { addedAt: 5 },
    'full',
  );
  const initialPrivateSeq = await db.run([STORE.META], 'readonly', (access) =>
    access.get(STORE.META, PRIVATE_SEQ_KEY),
  );
  const committedWrite = await store.savePrivateWatermark(
    'survivor',
    { addedAt: 5 },
    { analysis: { proof: 'committed' }, prepared: null },
  );
  const seqAfterCommit = (await store.privateCount()).seq;
  const originalRun = db.run;
  db.run = (stores, mode, work) =>
    originalRun.call(db, stores, mode, (access) => {
      const put = access.put;
      access.put = (storeName, key, value) => {
        if (storeName === STORE.META && key === PRIVATE_SEQ_KEY)
          throw new Error('native sequence rollback proof');
        return put(storeName, key, value);
      };
      return work(access);
    });
  const abortedWrite = await store.savePrivateWatermark(
    'survivor',
    { addedAt: 5 },
    { analysis: { proof: 'must-roll-back' }, prepared: null },
  );
  db.run = originalRun;
  const seqAfterRollback = (await store.privateCount()).seq;
  const detailAfterRollback = await store.readPrivateDetail('survivor');
  const state = await db.run(
    [STORE.SETTINGS, STORE.SHARED_PREPARED, STORE.META],
    'readonly',
    async (access) => ({
      setting: await access.get(STORE.SETTINGS, 'proof-setting'),
      prepared: await access.get(STORE.SHARED_PREPARED, 'proof-prepared'),
      privateSeq: await access.get(STORE.META, 'privateSeq'),
    }),
  );
  const oldWriter = await new Promise((resolve) => {
    const request = indexedDB.open(name, fromVersion);
    request.onsuccess = () => {
      request.result.close();
      resolve('opened');
    };
    request.onerror = () => resolve(request.error?.name ?? 'error');
  });
  const digestAfter = await sha256(media);
  db.close();
  await deleteDatabase(name);
  return {
    name: `privateReadV${fromVersion}Upgrade`,
    pass:
      CACHE_DB_VERSION === 10 &&
      detail?.addedAt === 5 &&
      state.setting?.untouched === true &&
      state.prepared?.untouched === true &&
      digestBefore === digestAfter &&
      oldWriter === 'VersionError' &&
      committedWrite.persisted === true &&
      seqAfterCommit === 1 &&
      abortedWrite.persisted === false &&
      seqAfterRollback === seqAfterCommit &&
      detailAfterRollback?.watermark?.analysis?.proof === 'committed',
    version: CACHE_DB_VERSION,
    oldWriter,
    digestBefore,
    digestAfter,
    privateSeqInitiallyAbsent: initialPrivateSeq === undefined,
    committedPrivateSeq: seqAfterCommit,
    abortedPrivateSeq: seqAfterRollback,
    abortedWriteReason: abortedWrite.reason,
  };
}

/** Native exclusive keyset pages through equal addedAt rows, deleted anchors and arrivals. */
export const privateReadV7Upgrade = () => privateReadUpgrade(7);
export const privateReadV8Upgrade = () => privateReadUpgrade(8);

export async function privateReadNativeTies() {
  const name = 'o17-private-read-native-ties';
  await deleteDatabase(name);
  const db = await openCacheDb({ name });
  if (!db) throw new Error('IndexedDB did not open');
  const entries = [
    ['oldest', 0],
    ['alpha', 20],
    ['beta', 20],
    ['epsilon', 20],
    ['gamma', 20],
    ['zeta', 20],
    ['delta', 30],
  ];
  await db.run(
    [STORE.PRIVATE, STORE.PRIVATE_MEDIA],
    'readwrite',
    async (access) => {
      for (const [key, addedAt] of entries)
        await access.put(STORE.PRIVATE, key, {
          record: { id: key, unknown: { zero: 0, no: false, nil: null } },
          origin: key === 'delta' ? 'imported' : 'generated',
          addedAt,
        });
      await access.put(STORE.PRIVATE_MEDIA, 'delta|full', {
        key: 'delta',
        blob: new Blob([new Uint8Array([1, 2, 3])]),
        bytes: 3,
        addedAt: 30,
      });
    },
  );
  const store = createCacheStore(db, BIG_LIMITS);
  const first = await store.readPrivatePage({ limit: 3 });
  const second = await store.readPrivatePage({
    anchor: first.next,
    direction: 'older',
    limit: 3,
  });
  const third = await store.readPrivatePage({
    anchor: second.next,
    direction: 'older',
    limit: 3,
  });
  const traversed = [...first.rows, ...second.rows, ...third.rows].map(
    (row) => row.key,
  );
  await db.run([STORE.PRIVATE], 'readwrite', (access) =>
    access.delete(STORE.PRIVATE, 'gamma'),
  );
  const afterDelete = await store.readPrivatePage({
    anchor: { addedAt: 20, key: 'gamma' },
    direction: 'older',
    limit: 3,
  });
  await db.run([STORE.PRIVATE], 'readwrite', (access) =>
    access.put(STORE.PRIVATE, 'arrival', {
      record: { id: 'arrival' },
      origin: 'generated',
      addedAt: 25,
    }),
  );
  const afterArrival = await store.readPrivatePage({
    anchor: { addedAt: 20, key: 'gamma' },
    direction: 'older',
    limit: 3,
  });
  const detail = await store.readPrivateDetail('delta');
  db.close();
  await deleteDatabase(name);
  return {
    name: 'privateReadNativeTies',
    pass:
      traversed.join(',') === 'delta,zeta,gamma,epsilon,beta,alpha,oldest' &&
      afterDelete.rows.map((row) => row.key).join(',') ===
        'epsilon,beta,alpha' &&
      afterArrival.rows.map((row) => row.key).join(',') ===
        'epsilon,beta,alpha' &&
      detail?.hasFull === true &&
      detail.record.unknown.no === false &&
      detail.record.unknown.zero === 0,
    traversed,
    afterDeletedAnchor: afterDelete.rows.map((row) => row.key),
    afterNewArrival: afterArrival.rows.map((row) => row.key),
    physicalFullExists: detail?.hasFull,
  };
}

/** Bounded keyset traversal over 10k owned metadata rows and three originals. */
export async function privateReadTenThousand() {
  const name = 'o17-private-read-10000';
  await deleteDatabase(name);
  const db = await openCacheDb({ name });
  if (!db) throw new Error('IndexedDB did not open');
  const mediaReads = { count: 0 };
  const metadataRowsVisited = { count: 0 };
  const run = db.run.bind(db);
  db.run = (stores, mode, work) =>
    run(stores, mode, (access) => {
      const get = access.get;
      const scanKeyset = access.scanKeyset;
      access.get = (storeName, key) => {
        if (storeName === STORE.PRIVATE_MEDIA) mediaReads.count += 1;
        return get(storeName, key);
      };
      access.scanKeyset = (...args) => {
        const visit = args[args.length - 1];
        args[args.length - 1] = (...visitArgs) => {
          metadataRowsVisited.count += 1;
          return visit(...visitArgs);
        };
        return scanKeyset(...args);
      };
      return work(access);
    });
  const originals = [];
  for (const n of [1, 5000, 9999]) {
    const key = `row-${String(n).padStart(5, '0')}`;
    const blob = new Blob([new Uint8Array([n & 255, (n >> 8) & 255, 42])], {
      type: 'image/png',
    });
    originals.push({ key, blob, digest: await sha256(blob) });
  }
  await db.run(
    [STORE.PRIVATE, STORE.PRIVATE_MEDIA],
    'readwrite',
    async (access) => {
      for (let n = 0; n < 10000; n += 1) {
        const key = `row-${String(n).padStart(5, '0')}`;
        await access.put(STORE.PRIVATE, key, {
          record: { id: key, extension: { flag: false, count: 0, nil: null } },
          origin: 'imported',
          addedAt: n,
        });
      }
      for (const original of originals)
        await access.put(STORE.PRIVATE_MEDIA, `${original.key}|full`, {
          key: original.key,
          addedAt: Number(original.key.slice(4)),
          blob: original.blob,
          bytes: original.blob.size,
        });
    },
  );
  const store = createCacheStore(db, BIG_LIMITS);
  const before = performance.now();
  const count = await store.privateCount();
  const first = await store.readPrivatePage({ limit: 40 });
  const middle = await store.readPrivateAround(
    { key: 'row-05000', addedAt: 5000 },
    { before: 2, after: 2 },
  );
  const last = await store.readPrivatePage({
    anchor: { key: 'row-00040', addedAt: 40 },
    direction: 'older',
    limit: 40,
  });
  const elapsedMs = performance.now() - before;
  const metadataMediaGetCalls = mediaReads.count;
  const hashesAfter = [];
  for (const original of originals) {
    const hydrated = await store.readPrivateMedia(
      original.key,
      { addedAt: Number(original.key.slice(4)) },
      'full',
    );
    hashesAfter.push({
      key: original.key,
      preserved: (await sha256(hydrated)) === original.digest,
    });
  }
  const report = {
    name: 'privateReadTenThousand',
    pass:
      count.count === 10000 &&
      first.rows.length === 40 &&
      middle.rows.length === 5 &&
      last.rows.length === 40 &&
      metadataMediaGetCalls === 0 &&
      hashesAfter.every((item) => item.preserved),
    count: count.count,
    firstKeys: [first.rows[0]?.key, first.rows.at(-1)?.key],
    middleKeys: middle.rows.map((row) => row.key),
    lastKeys: [last.rows[0]?.key, last.rows.at(-1)?.key],
    boundedRows: {
      first: first.rows.length,
      middle: middle.rows.length,
      last: last.rows.length,
    },
    metadataMediaGetCalls,
    metadataIndexRowsVisited: metadataRowsVisited.count,
    originalHashesPreserved: hashesAfter,
    elapsedMs,
    heapUsedBytes: performance.memory?.usedJSHeapSize ?? null,
    memoryMeasurement: performance.memory
      ? 'Chromium performance.memory snapshot'
      : 'unavailable',
  };
  db.close();
  await deleteDatabase(name);
  return report;
}

const scenario = (name) => {
  const found = opened.get(name);
  if (!found) throw new Error(`scenario database ${name} is not open`);
  return found;
};

/** Everything that is stored, for accounting checks. */
export async function inspect(name) {
  const { db } = scenario(name);
  return db.run(Object.values(STORE), 'readonly', async (access) => {
    const variants = [];
    await access.scan(STORE.VARIANTS, VARIANT_USE_INDEX, (row, id) => {
      variants.push({ id, bytes: row.bytes, lastUsedAt: row.lastUsedAt });
    });
    const records = [];
    await access.scan(STORE.RECORDS, null, (_row, key) => records.push(key));
    const tombstones = [];
    await access.scan(STORE.TOMBSTONES, null, (row, key) =>
      tombstones.push({ key, seq: row.seq }),
    );
    const listing = await access.get(STORE.LISTINGS, SCOPE);
    return {
      variantIds: variants.map((v) => v.id),
      variantBytesRows: variants.reduce((sum, v) => sum + v.bytes, 0),
      variantBytesMeta: (await access.get(STORE.META, 'variantBytes')) ?? 0,
      seq: (await access.get(STORE.META, 'seq')) ?? 0,
      records,
      tombstones,
      listing,
    };
  });
}

/** Persist a listing of `ids` through the real commit path. */
export async function seedListing({ name, ids, etag = '"e1"' }) {
  const { store } = scenario(name);
  const ticket = await store.beginRead();
  return store.commitListing(SCOPE, ticket, {
    images: ids.map(wire),
    etag,
    watermarkSettings: { seeded: true },
  });
}

const accounting = (state) => state.variantBytesRows === state.variantBytesMeta;

/** Least-recently-used order, pins, exact limits, oversize, truncated ETag. */
export async function lruOrder() {
  const name = 'f09-proof-lru';
  const limits = {
    sharedRecordLimit: 4,
    sharedVariantLimit: 3,
    sharedVariantMaxBytes: 1000,
  };
  await openScenario({ name, limits });
  const { store } = scenario(name);
  const steps = {};
  const seeded = await seedListing({ name, ids: ['r1', 'r2', 'r3', 'r4'] });
  steps.seeded = seeded.persisted;
  const blob = () => randomBlob(100);
  for (const id of ['r1', 'r2', 'r3']) {
    await store.putVariant(wire(id), 'thumbnail', blob());
    await pause(5);
  }
  steps.atLimit = (await inspect(name)).variantIds.sort();
  // r1 is used again, so r2 is now the oldest.
  store.touch(idOf('r1'));
  await store.flushTouches();
  await store.putVariant(wire('r4'), 'thumbnail', blob());
  steps.afterOneOver = (await inspect(name)).variantIds.sort();
  // r1 and r3 are on screen: the unpinned r4 goes, never the pinned ones.
  await pause(5);
  const pinned = new Set([idOf('r1'), idOf('r3')]);
  await store.putVariant(wire('r2'), 'thumbnail', blob(), { pinned });
  steps.pinnedKept = (await inspect(name)).variantIds.sort();
  const allPinned = new Set(steps.pinnedKept);
  const refused = await store.putVariant(wire('r4'), 'thumbnail', blob(), {
    pinned: allPinned,
  });
  steps.refusedWhenAllPinned = refused;
  const oversize = await store.putVariant(
    wire('r4'),
    'full',
    randomBlob(1001),
    { pinned },
  );
  steps.oversize = oversize;
  const afterOversize = await inspect(name);
  steps.oversizeEvictedNothing =
    afterOversize.variantIds.length === steps.pinnedKept.length;

  // A listing longer than the record limit is truncated and keeps no ETag.
  const ticket = await store.beginRead();
  await store.commitListing(SCOPE, ticket, {
    images: ['r1', 'r2', 'r3', 'r4', 'r5'].map(wire),
    etag: '"truncated"',
  });
  const truncated = await inspect(name);
  steps.truncated = {
    complete: truncated.listing.complete,
    etag: truncated.listing.etag,
    records: truncated.records.length,
  };
  const final = await inspect(name);
  steps.accounting = accounting(final);
  const pass =
    steps.seeded &&
    steps.atLimit.length === 3 &&
    !steps.afterOneOver.includes(idOf('r2')) &&
    steps.afterOneOver.includes(idOf('r1')) &&
    steps.afterOneOver.length === 3 &&
    !steps.pinnedKept.includes(idOf('r4')) &&
    steps.pinnedKept.includes(idOf('r1')) &&
    steps.pinnedKept.includes(idOf('r3')) &&
    steps.refusedWhenAllPinned.reason === 'pinned' &&
    steps.oversize.reason === 'oversize' &&
    steps.oversizeEvictedNothing &&
    steps.truncated.complete === false &&
    steps.truncated.etag === null &&
    steps.truncated.records === 4 &&
    steps.accounting;
  return { name: 'lruOrder', pass, steps };
}

/**
 * Run with the origin quota already overridden to a few MiB (the runner does
 * that with the DevTools protocol before this opens the database). The browser
 * reclaims deleted blob space lazily, so the retry right after the trim can
 * still fail; writes then back off and succeed once the space is back.
 */
export async function quotaFailure({ blobBytes = MIB, writes = 5 } = {}) {
  const name = 'f09-proof-quota';
  const backoffMs = 1500;
  await openScenario({ name, storeOptions: { quotaBackoffMs: backoffMs } });
  const { store } = scenario(name);
  const ids = Array.from({ length: writes + 2 }, (_, n) => `q${n}`);
  await seedListing({ name, ids });
  const results = [];
  const write = async (id) => {
    const result = await store.putVariant(
      wire(id),
      'thumbnail',
      randomBlob(blobBytes),
    );
    results.push({ id, ...result });
    await pause(5);
  };
  for (const id of ids.slice(0, writes)) await write(id);
  const afterFailure = await inspect(name);
  // Observation: how long the browser takes to give back deleted blob space.
  const usageCurve = [];
  for (let second = 0; second <= RECLAIM_WATCH_SECONDS; second += 1) {
    usageCurve.push((await navigator.storage.estimate()).usage);
    if (usageCurve.at(-1) <= blobBytes * 1.5) break;
    await pause(1000);
  }
  await write(ids[writes]);
  const final = await inspect(name);
  const firstQuota = results.findIndex((r) => r.reason === 'quota');
  const pass =
    results.slice(0, 3).every((r) => r.persisted) &&
    firstQuota >= 3 &&
    results
      .slice(firstQuota + 1, writes)
      .every((r) => r.reason === 'quota-backoff') &&
    afterFailure.variantIds.length >= 1 &&
    accounting(afterFailure) &&
    accounting(final);
  return {
    name: 'quotaFailure',
    pass,
    results,
    usageCurve,
    laterWrite: results.at(-1),
    afterFailure: afterFailure.variantIds,
    final: final.variantIds,
    accounting: {
      afterFailure: accounting(afterFailure),
      final: accounting(final),
    },
    estimate: await navigator.storage?.estimate?.(),
  };
}

/** Phase 1 of the reload scenario: store real bytes and report their digest. */
export async function reloadSeed() {
  const name = 'f09-proof-reload';
  await openScenario({ name });
  const { store } = scenario(name);
  await seedListing({ name, ids: ['p1', 'p2'], etag: '"persisted"' });
  const blob = randomBlob(300 * 1024);
  const result = await store.putVariant(wire('p1'), 'thumbnail', blob);
  return { persisted: result.persisted, digest: await sha256(blob) };
}

/** Phase 2, after a real page reload: the same bytes and listing come back. */
export async function reloadVerify({ digest }) {
  const name = 'f09-proof-reload';
  await openScenario({ name, reset: false });
  const { store } = scenario(name);
  const cached = await store.hydrate(SCOPE);
  const variant = await store.getVariant(wire('p1'), 'thumbnail');
  const changed = await store.getVariant(
    { ...wire('p1'), sha256: 'other-bytes' },
    'thumbnail',
  );
  const after = variant ? await sha256(variant.blob) : null;
  return {
    name: 'reloadByteIdentity',
    pass:
      after === digest &&
      cached?.etag === '"persisted"' &&
      cached.items.length === 2 &&
      cached.watermarkSettings?.seeded === true &&
      changed === null,
    sameBytes: after === digest,
    etag: cached?.etag,
    items: cached?.items.length,
    changedSourceIsMiss: changed === null,
  };
}

/** Tab A and B each call this to open the shared database; A seeds it. */
export async function tabOpen({ seed = false }) {
  const name = 'f09-proof-tabs';
  await openScenario({ name, reset: seed });
  if (seed) await seedListing({ name, ids: ['t1', 't2'] });
  return { opened: true };
}

/** Tab B takes a read ticket, as a library read does before its request. */
export async function tabBegin() {
  const { store } = scenario('f09-proof-tabs');
  const ticket = await store.beginRead();
  opened.get('f09-proof-tabs').ticket = ticket;
  return ticket;
}

/** Tab A deletes t1 (the server DELETE already succeeded). */
export async function tabDelete() {
  const { store } = scenario('f09-proof-tabs');
  return store.purgeShared(keyOf('t1'));
}

/** Tab B finishes a read that began before the delete, then fetches late. */
export async function tabStaleWrites() {
  const name = 'f09-proof-tabs';
  const { store, ticket } = scenario(name);
  const commit = await store.commitListing(SCOPE, ticket, {
    images: [wire('t1'), wire('t2')],
    etag: '"stale"',
  });
  const variant = await store.putVariant(
    wire('t1'),
    'thumbnail',
    randomBlob(1024),
  );
  const state = await inspect(name);
  const cached = await store.hydrate(SCOPE);
  const pass =
    commit.images.map((i) => i.id).join() === 't2' &&
    commit.stale === true &&
    commit.persisted === false &&
    variant.persisted === false &&
    ['deleted', 'not-listed'].includes(variant.reason) &&
    !state.records.includes(keyOf('t1')) &&
    !state.variantIds.some((id) => id.startsWith(keyOf('t1'))) &&
    cached.items.every((i) => i.id !== 't1') &&
    state.listing.etag === null &&
    state.tombstones.some((t) => t.key === keyOf('t1'));
  return {
    name: 'twoTabDelete',
    pass,
    commit: { ...commit, images: commit.images.map((i) => i.id) },
    variant,
    state,
  };
}

/** Storage that cannot be used yields null and a store without storage. */
export async function openFailures() {
  const never = { open: () => ({}) };
  const results = {
    securityError: await openCacheDb({
      factory: {
        open() {
          throw new DOMException('denied', 'SecurityError');
        },
      },
    }),
    blocked: await openCacheDb({
      factory: {
        open() {
          const request = {};
          setTimeout(() => request.onblocked?.(), 0);
          return request;
        },
      },
    }),
    timeout: await openCacheDb({ factory: never, openTimeoutMs: 50 }),
    versionError: await openCacheDb({
      factory: {
        open() {
          const request = {
            error: new DOMException('older', 'VersionError'),
          };
          setTimeout(() => request.onerror?.(), 0);
          return request;
        },
      },
    }),
    absent: await openCacheDb({ factory: null }),
  };
  const store = createCacheStore(null, BIG_LIMITS);
  const write = await store.putVariant(wire('x'), 'thumbnail', randomBlob(8));
  return {
    name: 'openFailures',
    pass:
      Object.values(results).every((db) => db === null) &&
      store.durable === false &&
      write.persisted === false &&
      (await store.hydrate(SCOPE)) === null,
    outcomes: Object.fromEntries(
      Object.entries(results).map(([k, v]) => [k, v === null ? 'null' : 'db']),
    ),
  };
}

// --- Private browser history (slice 2) ----------------------------------------

const wireRecord = (id, extra = {}) => ({
  id,
  title: `Image ${id}`,
  safe: false,
  count: 0,
  note: null,
  unknown_future_field: { nested: [false, 0, null] },
  created_at: 1,
  ...extra,
});
const privateEntry = (id, addedAt, origin = 'generated', extra = {}) => ({
  record: wireRecord(id, extra),
  origin,
  addedAt,
});
const keysOf = (rows) => rows.map((row) => row.record.id);

/** Raw version-1 database exactly as the first release created it. */
function createVersionOne(name, seed) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const store of ['records', 'listings', 'tombstones', 'meta'])
        db.createObjectStore(store);
      db.createObjectStore('variants').createIndex('lastUsedAt', 'lastUsedAt');
    };
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction(
        ['records', 'listings', 'variants', 'tombstones', 'meta'],
        'readwrite',
      );
      seed(transaction);
      transaction.oncomplete = () => {
        db.close();
        resolve();
      };
      transaction.onerror = () => reject(transaction.error);
    };
    request.onerror = () => reject(request.error);
  });
}

function describeDatabase(name) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onsuccess = () => {
      const db = request.result;
      const names = [...db.objectStoreNames].sort();
      const index = [
        ...db.transaction('variants').objectStore('variants').indexNames,
      ];
      db.close();
      resolve({ version: db.version, names, variantIndexes: index });
    };
    request.onerror = () => reject(request.error);
  });
}

/** A real v1 database upgrades to v2 keeping every shared row byte-identical. */
export async function privateMigration() {
  const name = 'f09-proof-migrate-v1';
  opened.get(name)?.db.close();
  await deleteDatabase(name);
  const blob = randomBlob(64 * KIB);
  const digest = await sha256(blob);
  const record = wire('m1');
  await createVersionOne(name, (transaction) => {
    transaction.objectStore('records').put(record, keyOf('m1'));
    transaction.objectStore('listings').put(
      {
        keys: [keyOf('m1')],
        etag: '"v1-etag"',
        complete: true,
        watermarkSettings: { seeded: true },
      },
      SCOPE,
    );
    transaction.objectStore('variants').put(
      {
        key: keyOf('m1'),
        blob,
        bytes: blob.size,
        sourceSha: record.sha256,
        lastUsedAt: 7,
      },
      idOf('m1'),
    );
    transaction.objectStore('tombstones').put({ seq: 2 }, keyOf('gone'));
    transaction.objectStore('meta').put(2, 'seq');
    transaction.objectStore('meta').put(blob.size, 'variantBytes');
  });
  const before = await describeDatabase(name);
  const { store, db } = await openScenario({
    name,
    reset: false,
  }).then(() => scenario(name));
  const cached = await store.hydrate(SCOPE);
  const variant = await store.getVariant(record, 'thumbnail');
  const state = await inspect(name);
  const upgraded = await describeDatabase(name);
  // The private stores work, in the same database, next to the shared rows.
  const added = await store.admitPrivate(privateEntry('m1', 3, 'imported'));
  const stillShared = await store.hydrate(SCOPE);
  const pass =
    before.version === 1 &&
    !before.names.includes('private') &&
    upgraded.version >= 2 &&
    ['private', 'privateMedia', 'privateTombstones'].every((n) =>
      upgraded.names.includes(n),
    ) &&
    upgraded.variantIndexes.includes('lastUsedAt') &&
    cached?.etag === '"v1-etag"' &&
    cached.items.length === 1 &&
    cached.watermarkSettings?.seeded === true &&
    variant !== null &&
    (await sha256(variant.blob)) === digest &&
    state.tombstones.some((t) => t.key === keyOf('gone')) &&
    state.seq === 2 &&
    state.variantBytesMeta === blob.size &&
    added.persisted === true &&
    stillShared.items.length === 1;
  return {
    name: 'privateMigrationV1ToV2',
    pass,
    before,
    upgraded,
    sharedRowsPreserved: { etag: cached?.etag, items: cached?.items.length },
    variantBytesIdentical: variant
      ? (await sha256(variant.blob)) === digest
      : false,
    tombstones: state.tombstones,
    added,
    dbOpen: db.open,
  };
}

/** Phase 1: store entries with falsy/unknown wire fields and random bytes. */
export async function privateReloadSeed() {
  const name = 'f09-proof-private-reload';
  await openScenario({ name });
  const { store } = scenario(name);
  const full = randomBlob(200 * KIB);
  const thumbnail = randomBlob(8 * KIB);
  await store.admitPrivate({
    ...privateEntry('r1', 10, 'generated'),
    full,
    thumbnail,
  });
  await store.admitPrivate({
    ...privateEntry('r2', 20, 'imported'),
    full: randomBlob(50 * KIB),
  });
  await store.admitPrivate(privateEntry('r3', 30, 'generated'));
  return {
    digests: { full: await sha256(full), thumbnail: await sha256(thumbnail) },
  };
}

/** Phase 2, after a real reload: bytes, order and wire fields come back unchanged. */
export async function privateReloadVerify({ digests }) {
  const name = 'f09-proof-private-reload';
  await openScenario({ name, reset: false });
  const { store } = scenario(name);
  const rows = await store.loadPrivate();
  const first = rows.find((row) => row.record.id === 'r1');
  const removed = await store.removePrivate('r2', 20);
  await openScenario({ name, reset: false });
  const afterRemove = keysOf(await scenario(name).store.loadPrivate());
  const pass =
    keysOf(rows).join() === 'r3,r2,r1' &&
    (await sha256(first.full)) === digests.full &&
    (await sha256(first.thumbnail)) === digests.thumbnail &&
    JSON.stringify(first.record) === JSON.stringify(wireRecord('r1')) &&
    first.record.safe === false &&
    first.record.count === 0 &&
    first.record.note === null &&
    rows.find((row) => row.record.id === 'r3').full === null &&
    removed.removed === true &&
    afterRemove.join() === 'r3,r1';
  return {
    name: 'privateReloadByteIdentity',
    pass,
    order: keysOf(rows),
    afterRemove,
  };
}

/** Quota: shared variants are freed first; private copies are never erased. */
export async function privateQuota({ blobBytes = MIB, writes = 6 } = {}) {
  const name = 'f09-proof-private-quota';
  await openScenario({ name });
  const { store } = scenario(name);
  await seedListing({ name, ids: ['v0', 'v1'] });
  const shared = [];
  for (const id of ['v0', 'v1'])
    shared.push(
      await store.putVariant(wire(id), 'thumbnail', randomBlob(blobBytes)),
    );
  const digests = new Map();
  const results = [];
  for (let n = 0; n < writes; n += 1) {
    const id = `p${n}`;
    const blob = randomBlob(blobBytes);
    const outcome = await store.admitPrivate({
      ...privateEntry(id, 100 + n),
      full: blob,
    });
    if (outcome.persisted) digests.set(id, await sha256(blob));
    results.push({ id, ...outcome });
    await pause(5);
  }
  const rows = await store.loadPrivate();
  const state = await inspect(name);
  const survivors = [];
  for (const row of rows)
    if (row.full && digests.has(row.record.id))
      survivors.push((await sha256(row.full)) === digests.get(row.record.id));
  const firstFailure = results.findIndex((r) => !r.persisted);
  const stored = results.filter((r) => r.persisted).map((r) => r.id);
  return {
    name: 'privateQuota',
    pass:
      shared.every((r) => r.persisted) &&
      results[0].persisted &&
      firstFailure > 0 &&
      results[firstFailure].reason === 'quota' &&
      survivors.length === stored.length &&
      survivors.every(Boolean) &&
      state.variantIds.length === 0 &&
      rows.length === stored.length,
    sharedBefore: shared.map((r) => r.persisted),
    results,
    sharedVariantsLeft: state.variantIds,
    storedIntact: survivors,
    recordsKept: rows.length,
  };
}

/** Tab A and B open one database; A seeds an entry with addedAt 5. */
export async function privateTabOpen({ seed = false }) {
  const name = 'f09-proof-private-tabs';
  await openScenario({ name, reset: seed });
  if (seed) await scenario(name).store.admitPrivate(privateEntry('t1', 5));
  return {
    opened: true,
    rows: keysOf(await scenario(name).store.loadPrivate()),
  };
}

/** Tab A removes the entry. */
export async function privateTabRemove() {
  return scenario('f09-proof-private-tabs').store.removePrivate('t1', 5);
}

/** Tab B, still holding the entry, writes late: nothing comes back. */
export async function privateTabLateWrites() {
  const { store } = scenario('f09-proof-private-tabs');
  const bytes = await store.admitPrivate({
    ...privateEntry('t1', 5),
    full: randomBlob(KIB),
  });
  const add = await store.admitPrivate(privateEntry('t1', 5));
  const later = await store.admitPrivate(privateEntry('t1', 9, 'imported'));
  const rows = keysOf(await store.loadPrivate());
  return {
    name: 'privateTwoTabRemove',
    pass:
      bytes.persisted === false &&
      bytes.reason === 'deleted' &&
      add.persisted === false &&
      add.reason === 'deleted' &&
      later.persisted === true &&
      rows.join() === 't1',
    bytes,
    add,
    later,
    rows,
  };
}

// --- O17: original-retention safety ------------------------------------------
// Every scenario uses a database of its own name and never the application's.

/** Accounting facts of the private stores: rows, media and the byte counter. */
export async function privateConsistency(name) {
  const { db } = scenario(name);
  return db.run(
    [STORE.PRIVATE, STORE.PRIVATE_MEDIA, STORE.META],
    'readonly',
    async (access) => {
      const rows = [];
      await access.scan(STORE.PRIVATE, null, (row, key) =>
        rows.push({ key, row }),
      );
      const media = [];
      await access.scan(STORE.PRIVATE_MEDIA, null, (row, id) =>
        media.push({ id, key: row.key, bytes: row.bytes }),
      );
      const keys = new Set(rows.map((r) => r.key));
      const withFull = new Set(
        media.filter((m) => m.id.endsWith('|full')).map((m) => m.key),
      );
      return {
        rows: rows.length,
        media: media.length,
        mediaBytes: media.reduce((sum, m) => sum + m.bytes, 0),
        counter: (await access.get(STORE.META, 'privateBytes')) ?? null,
        orphanMedia: media.filter((m) => !keys.has(m.key)).length,
        rowsWithoutFull: rows.filter((r) => !withFull.has(r.key)).length,
      };
    },
  );
}

const isConsistent = (c) => c.counter === c.mediaBytes && c.orphanMedia === 0;

/** Raw database exactly as the previous release (v3) created it. */
function createVersionThree(name, seed) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 3);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const store of [
        'records',
        'listings',
        'tombstones',
        'meta',
        'private',
        'privateMedia',
        'privateTombstones',
        'settings',
        'sharedPrepared',
      ])
        db.createObjectStore(store);
      db.createObjectStore('variants').createIndex('lastUsedAt', 'lastUsedAt');
    };
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction(
        ['private', 'privateMedia', 'meta'],
        'readwrite',
      );
      seed(transaction);
      transaction.oncomplete = () => {
        db.close();
        resolve();
      };
      transaction.onerror = () => reject(transaction.error);
    };
    request.onerror = () => reject(request.error);
  });
}

/** Raw v4 cache layout immediately before bounded Library stores were added. */
function createVersionFour(name, seed) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 4);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const store of [
        'records',
        'listings',
        'tombstones',
        'meta',
        'private',
        'privateMedia',
        'privateTombstones',
        'settings',
        'sharedPrepared',
      ]) {
        const objectStore = db.createObjectStore(store);
        if (store === 'private') objectStore.createIndex('addedAt', 'addedAt');
      }
      db.createObjectStore('variants').createIndex('lastUsedAt', 'lastUsedAt');
    };
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction(
        [
          'records',
          'variants',
          'private',
          'privateMedia',
          'settings',
          'sharedPrepared',
          'meta',
        ],
        'readwrite',
      );
      seed(transaction);
      transaction.oncomplete = () => {
        db.close();
        resolve();
      };
      transaction.onerror = () => reject(transaction.error);
    };
    request.onerror = () => reject(request.error);
  });
}

/** v4 to current adds Library indexes/stores without rewriting existing data. */
export async function boundedLibraryUpgradePreservesV4Bytes() {
  const name = 'o17-proof-v4-to-current';
  opened.get(name)?.db.close();
  await deleteDatabase(name);
  const shared = wire('shared');
  const privateRow = privateEntry('private', 11, 'imported');
  const blobs = {
    original: randomBlob(16 * KIB),
    thumbnail: randomBlob(2 * KIB),
    prepared: randomBlob(3 * KIB),
    sharedThumbnail: randomBlob(4 * KIB),
  };
  const settings = {
    watermark: { enabled: false, opacity: 0 },
    unknown: [0, false],
  };
  const expected = {
    original: await sha256(blobs.original),
    thumbnail: await sha256(blobs.thumbnail),
    prepared: await sha256(blobs.prepared),
    sharedThumbnail: await sha256(blobs.sharedThumbnail),
    settings: JSON.stringify(settings),
    sharedRecord: JSON.stringify(shared),
    privateRecord: JSON.stringify(privateRow.record),
  };
  await createVersionFour(name, (transaction) => {
    transaction.objectStore('records').put(shared, keyOf('shared'));
    transaction.objectStore('variants').put(
      {
        key: keyOf('shared'),
        blob: blobs.sharedThumbnail,
        bytes: blobs.sharedThumbnail.size,
        sourceSha: shared.sha256,
        lastUsedAt: 4,
      },
      idOf('shared'),
    );
    transaction
      .objectStore('private')
      .put(
        { record: privateRow.record, origin: privateRow.origin, addedAt: 11 },
        'private',
      );
    transaction.objectStore('privateMedia').put(
      {
        key: 'private',
        blob: blobs.original,
        bytes: blobs.original.size,
        addedAt: 11,
      },
      'private|full',
    );
    transaction.objectStore('privateMedia').put(
      {
        key: 'private',
        blob: blobs.thumbnail,
        bytes: blobs.thumbnail.size,
        addedAt: 11,
      },
      'private|thumbnail',
    );
    transaction.objectStore('sharedPrepared').put(
      {
        key: keyOf('shared'),
        blob: blobs.prepared,
        bytes: blobs.prepared.size,
      },
      keyOf('shared'),
    );
    transaction.objectStore('settings').put(settings, 'watermark');
  });
  const before = await describeDatabase(name);
  await openScenario({ name, reset: false });
  const { db } = scenario(name);
  const after = await describeDatabase(name);
  const actual = await db.run(
    [
      STORE.RECORDS,
      STORE.VARIANTS,
      STORE.PRIVATE,
      STORE.PRIVATE_MEDIA,
      STORE.SETTINGS,
      STORE.SHARED_PREPARED,
    ],
    'readonly',
    async (access) => ({
      sharedRecord: JSON.stringify(
        await access.get(STORE.RECORDS, keyOf('shared')),
      ),
      privateRecord: JSON.stringify(
        (await access.get(STORE.PRIVATE, 'private')).record,
      ),
      settings: JSON.stringify(await access.get(STORE.SETTINGS, 'watermark')),
      original: await access.get(STORE.PRIVATE_MEDIA, 'private|full'),
      thumbnail: await access.get(STORE.PRIVATE_MEDIA, 'private|thumbnail'),
      prepared: await access.get(STORE.SHARED_PREPARED, keyOf('shared')),
      sharedThumbnail: await access.get(STORE.VARIANTS, idOf('shared')),
    }),
  );
  const actualHashes = {
    original: await sha256(actual.original.blob),
    thumbnail: await sha256(actual.thumbnail.blob),
    prepared: await sha256(actual.prepared.blob),
    sharedThumbnail: await sha256(actual.sharedThumbnail.blob),
    settings: actual.settings,
    sharedRecord: actual.sharedRecord,
    privateRecord: actual.privateRecord,
  };
  const pass =
    before.version === 4 &&
    after.version === CACHE_DB_VERSION &&
    Object.keys(expected).every((key) => expected[key] === actualHashes[key]);
  return {
    name: 'boundedLibraryUpgradePreservesV4Bytes',
    pass,
    before,
    after,
    hashesMatch: Object.keys(expected).every(
      (key) => expected[key] === actualHashes[key],
    ),
    dbOpen: db.open,
  };
}

const legacy = { db: null, fenced: false };

/**
 * A real v3 database holding MORE originals than the limits allow, a stale v3
 * tab with the database open, then the v5 upgrade: every original keeps its
 * bytes (SHA-256 checked), the stale tab is fenced, the counter is rebuilt and
 * only new admission is refused. Nothing is cleared, copied or rewritten.
 */
export async function privateUpgradeKeepsOverLimitOriginals() {
  const name = 'o17-proof-upgrade';
  opened.get(name)?.db.close();
  await deleteDatabase(name);
  const limits = {
    ...BIG_LIMITS,
    privateRecordLimit: 3,
    privateMaxBytes: 256 * KIB,
  };
  const originals = [];
  for (let n = 0; n < 6; n += 1) {
    const blob = randomBlob(64 * KIB);
    originals.push({
      id: `u${n}`,
      addedAt: 10 + n,
      blob,
      digest: await sha256(blob),
    });
  }
  await createVersionThree(name, (transaction) => {
    for (const o of originals) {
      transaction
        .objectStore('private')
        .put(
          { record: wireRecord(o.id), origin: 'imported', addedAt: o.addedAt },
          o.id,
        );
      transaction
        .objectStore('privateMedia')
        .put(
          { key: o.id, blob: o.blob, bytes: o.blob.size, addedAt: o.addedAt },
          `${o.id}|full`,
        );
    }
  });
  const before = await describeDatabase(name);

  // The stale tab: an open v3 connection whose handler closes on versionchange,
  // exactly as the v3 bundle's wrapper does.
  legacy.fenced = false;
  legacy.db = await new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 3);
    request.onsuccess = () => {
      request.result.onversionchange = () => {
        legacy.fenced = true;
        request.result.close();
      };
      resolve(request.result);
    };
    request.onerror = () => reject(request.error);
  });

  await openScenario({ name, limits, reset: false });
  const { store, db } = scenario(name);
  const upgraded = await describeDatabase(name);
  const indexes = await new Promise((resolve) => {
    const request = indexedDB.open(name);
    request.onsuccess = () => {
      const names = [
        ...request.result.transaction('private').objectStore('private')
          .indexNames,
      ];
      request.result.close();
      resolve(names);
    };
  });
  const usage = await store.privateUsage();
  const rows = await store.loadPrivate();
  const hashes = [];
  for (const o of originals) {
    const row = rows.find((r) => r.record.id === o.id);
    hashes.push({
      id: o.id,
      ok: row ? (await sha256(row.full)) === o.digest : false,
    });
  }
  const refused = await store.admitPrivate({
    ...privateEntry('extra', 99, 'imported'),
    full: randomBlob(KIB),
  });
  const afterRefusal = await store.loadPrivate();

  // A v3 bundle opened after the upgrade cannot write: VersionError.
  const oldBundle = await new Promise((resolve) => {
    const request = indexedDB.open(name, 3);
    request.onsuccess = () => {
      request.result.close();
      resolve('opened');
    };
    request.onerror = () => resolve(request.error?.name ?? 'error');
  });

  // Only a confirmed removal frees anything.
  const removed = await store.removePrivate('u0', 10);
  const afterRemoval = await privateConsistency(name);
  const remaining = await store.loadPrivate();
  const remainingHashes = [];
  for (const row of remaining) {
    const o = originals.find((x) => x.id === row.record.id);
    remainingHashes.push((await sha256(row.full)) === o.digest);
  }
  return {
    name: 'privateUpgradeKeepsOverLimitOriginals',
    pass:
      before.version === 3 &&
      upgraded.version === CACHE_DB_VERSION &&
      indexes.includes('addedAt') &&
      legacy.fenced === true &&
      db.open === true &&
      usage.count === 6 &&
      usage.bytes === 6 * 64 * KIB &&
      rows.length === 6 &&
      hashes.every((h) => h.ok) &&
      refused.persisted === false &&
      refused.reason === 'record-limit' &&
      afterRefusal.length === 6 &&
      oldBundle === 'VersionError' &&
      removed.removed === true &&
      afterRemoval.rows === 5 &&
      isConsistent(afterRemoval) &&
      remainingHashes.length === 5 &&
      remainingHashes.every(Boolean),
    before,
    upgraded,
    indexes,
    fenced: legacy.fenced,
    usage,
    hashes,
    refused,
    oldBundle,
    afterRemoval,
  };
}

/** Race scenarios share one database between two pages of one context. */
export async function raceOpen({ seed = false, name = 'o17-proof-race' }) {
  const limits = {
    ...BIG_LIMITS,
    privateRecordLimit: 3,
    privateMaxBytes: 64 * MIB,
  };
  await openScenario({ name, limits, reset: seed });
  if (seed)
    for (const [id, at] of [
      ['s1', 1],
      ['s2', 2],
    ])
      await scenario(name).store.admitPrivate({
        ...privateEntry(id, at, 'imported'),
        full: randomBlob(8 * KIB),
      });
  return { rows: keysOf(await scenario(name).store.loadPrivate()) };
}

/** Both pages admit at once; `tag` marks which page made the call. */
export async function raceAdmit({
  id,
  addedAt,
  bytes = 8 * KIB,
  name = 'o17-proof-race',
}) {
  const { store } = scenario(name);
  const blob = randomBlob(bytes);
  const outcome = await store.admitPrivate({
    ...privateEntry(id, addedAt, 'imported'),
    full: blob,
  });
  return { id, addedAt, digest: await sha256(blob), outcome };
}

export async function raceInspect({ name = 'o17-proof-race' } = {}) {
  const { store } = scenario(name);
  const rows = await store.loadPrivate();
  const digests = {};
  for (const row of rows) digests[row.record.id] = await sha256(row.full);
  return {
    rows: rows.map((row) => ({
      id: row.record.id,
      addedAt: row.addedAt,
      origin: row.origin,
    })),
    digests,
    consistency: await privateConsistency(name),
  };
}

/** A page that writes originals back to back until it is killed. */
export async function killWriterStart() {
  const name = 'o17-proof-kill';
  await openScenario({
    name,
    limits: {
      ...BIG_LIMITS,
      privateRecordLimit: 1000,
      privateMaxBytes: 2048 * MIB,
    },
  });
  const { store } = scenario(name);
  window.__admitted = [];
  (async () => {
    for (let n = 0; ; n += 1) {
      const full = randomBlob(768 * KIB);
      const thumbnail = randomBlob(16 * KIB);
      const outcome = await store.admitPrivate({
        ...privateEntry(`k${n}`, 1000 + n, 'imported'),
        full,
        thumbnail,
      });
      window.__admitted.push({ n, persisted: outcome.persisted });
    }
  })().catch(() => {});
  return { started: true };
}

export const killWriterProgress = () => window.__admitted?.length ?? 0;

export async function killWriterVerify({ acknowledged }) {
  const name = 'o17-proof-kill';
  await openScenario({ name, reset: false });
  const consistency = await privateConsistency(name);
  const rows = await scenario(name).store.loadPrivate();
  return {
    name: 'privateKillMidWrite',
    pass:
      isConsistent(consistency) &&
      consistency.rowsWithoutFull === 0 &&
      rows.length >= acknowledged &&
      rows.every((row) => row.full && row.thumbnail),
    acknowledged,
    rows: rows.length,
    consistency,
  };
}

/** Real quota: admissions fail at the browser's limit and leave nothing partial. */
export async function privateQuotaAdmission({
  blobBytes = MIB,
  writes = 8,
} = {}) {
  const name = 'o17-proof-quota';
  await openScenario({
    name,
    limits: {
      ...BIG_LIMITS,
      privateRecordLimit: 1000,
      privateMaxBytes: 2048 * MIB,
    },
  });
  const { store } = scenario(name);
  const digests = new Map();
  const results = [];
  for (let n = 0; n < writes; n += 1) {
    const id = `q${n}`;
    const blob = randomBlob(blobBytes);
    const outcome = await store.admitPrivate({
      ...privateEntry(id, 100 + n, 'imported'),
      full: blob,
    });
    if (outcome.persisted) digests.set(id, await sha256(blob));
    results.push({ id, persisted: outcome.persisted, reason: outcome.reason });
    await pause(5);
  }
  const rows = await store.loadPrivate();
  const survivors = [];
  for (const row of rows)
    survivors.push((await sha256(row.full)) === digests.get(row.record.id));
  const consistency = await privateConsistency(name);
  const failed = results.filter((r) => !r.persisted);
  return {
    name: 'privateQuotaAdmission',
    pass:
      results[0].persisted &&
      failed.length > 0 &&
      failed.every(
        (r) => r.reason === 'quota' || r.reason === 'quota-backoff',
      ) &&
      survivors.every(Boolean) &&
      rows.length === digests.size &&
      isConsistent(consistency),
    results,
    stored: digests.size,
    consistency,
  };
}

/** Volatile-pool arithmetic with real Blobs, and what holding them costs. */
export async function volatileBlobBudget() {
  const { privateVolatileRecordLimit: slots, privateVolatileMaxBytes: cap } =
    DEFAULT_CLIENT_POLICY.cache;
  const each = Math.floor(cap / slots);
  const heap = () => performance.memory?.usedJSHeapSize ?? null;
  const usage = async () => (await navigator.storage.estimate()).usage;
  const before = { heap: heap(), usage: await usage() };
  const held = [];
  const started = performance.now();
  for (let n = 0; n < slots; n += 1) held.push(randomBlob(each));
  const createMs = Math.round(performance.now() - started);
  const during = { heap: heap(), usage: await usage() };
  // The first bytes of a held blob are readable without copying the rest.
  const readStart = performance.now();
  const head = new Uint8Array(await held[0].slice(0, 16).arrayBuffer());
  const sliceMs = Math.round(performance.now() - readStart);
  const used = { slots: slots - 1, bytes: each * (slots - 1) };
  const lastFits = planVolatileSlot(used, each, DEFAULT_CLIENT_POLICY.cache);
  const overBytes = planVolatileSlot(
    { slots: 0, bytes: cap - each + 1 },
    each,
    DEFAULT_CLIENT_POLICY.cache,
  );
  const full = planVolatileSlot(
    { slots, bytes: 0 },
    1,
    DEFAULT_CLIENT_POLICY.cache,
  );
  const stored = [];
  held.length = 0;
  return {
    name: 'volatileBlobBudget',
    pass:
      lastFits.slot === true &&
      lastFits.hold === true &&
      overBytes.slot === true &&
      overBytes.hold === false &&
      full.slot === false &&
      head.length === 16,
    slots,
    cap,
    each,
    createMs,
    sliceMs,
    heapMiB: {
      before: before.heap && Math.round(before.heap / MIB),
      during: during.heap && Math.round(during.heap / MIB),
    },
    storageUsageMiB: {
      before: Math.round(before.usage / MIB),
      during: Math.round(during.usage / MIB),
    },
    plans: { lastFits, overBytes, full },
    stored,
  };
}

// --- O17: removal protection after tombstone compaction ----------------------
// Vectors: fixtures/browser/private-write-integrity.json (passed in by the runner).

const TOMBSTONE_PROOF_DB = 'o17-proof-tombstones';
const TOMBSTONE_LIMITS = {
  ...BIG_LIMITS,
  privateRecordLimit: 3,
  privateMaxBytes: 4 * MIB,
};
const fenceFailure = { armed: false };

/** The real database, but a removal can be made to abort after all its writes. */
function abortingDb(db) {
  return {
    get open() {
      return db.open;
    },
    close: () => db.close(),
    run: (names, mode, work) =>
      db.run(names, mode, async (access) => {
        const result = await work(access);
        if (fenceFailure.armed && mode === 'readwrite') {
          fenceFailure.armed = false;
          throw new Error('proof abort after every removal write');
        }
        return result;
      }),
  };
}

/** Private tombstone and fence facts, measured in the page. */
async function tombstoneFacts(db) {
  return db.run(
    [STORE.PRIVATE_TOMBSTONES, STORE.META],
    'readonly',
    async (access) => {
      const encoded = (value) =>
        new TextEncoder().encode(JSON.stringify(value)).byteLength;
      let count = 0;
      let bytes = 0;
      await access.scan(STORE.PRIVATE_TOMBSTONES, null, (row, key) => {
        count += 1;
        bytes += encoded(key) + encoded(row);
      });
      return {
        count,
        bytes,
        fence:
          (await access.get(STORE.META, PRIVATE_REMOVAL_FENCE_KEY)) ?? null,
      };
    },
  );
}

const lateEntry = (vectors, extra = {}) => ({
  record: vectors.late_removed_entry.record,
  origin: vectors.late_removed_entry.origin,
  addedAt: vectors.late_removed_entry.added_at_ms,
  ...extra,
});

/** Page A or B joins the shared tombstone database; A starts it empty. */
export async function tombstoneTabOpen({ reset = false }) {
  if (reset) {
    opened.get(TOMBSTONE_PROOF_DB)?.db.close();
    await deleteDatabase(TOMBSTONE_PROOF_DB);
  }
  const raw = await openCacheDb({ name: TOMBSTONE_PROOF_DB });
  if (!raw) throw new Error('IndexedDB did not open');
  const db = abortingDb(raw);
  opened.set(TOMBSTONE_PROOF_DB, {
    db,
    store: createCacheStore(db, TOMBSTONE_LIMITS),
  });
  return { version: CACHE_DB_VERSION };
}

/** Page A: a surviving older row, then the vectors' confirmed-removal churn. */
export async function tombstoneChurn({ vectors }) {
  const { store, db } = scenario(TOMBSTONE_PROOF_DB);
  const survivorCase = vectors.cases.find(
    (c) => c.id === 'surviving-older-original-can-still-recover-media',
  );
  const survivor = await store.admitPrivate({
    record: {
      ...vectors.late_removed_entry.record,
      id: survivorCase.surviving_record_id,
    },
    origin: 'generated',
    addedAt: survivorCase.surviving_added_at_ms,
  });
  const { churn } = vectors;
  const failures = [];
  for (let n = 0; n < churn.count; n += 1) {
    const id = `${churn.record_id_prefix}${churn.first_number + n}`;
    const addedAt = churn.added_at_start_ms + n * churn.added_at_step_ms;
    const admitted = await store.admitPrivate({
      record: { id, image_id: id },
      origin: 'imported',
      addedAt,
      full: randomBlob(churn.original_bytes_per_record),
    });
    const removed = await store.removePrivate(id, addedAt);
    if (!admitted.persisted || !removed.removed) failures.push(id);
  }
  return { survivor, failures, facts: await tombstoneFacts(db) };
}

/** Page B (opened before the churn, or reloaded): the late writes. */
export async function tombstoneLateWrites({ vectors }) {
  const { store, db } = scenario(TOMBSTONE_PROOF_DB);
  const late = await store.admitPrivate(
    lateEntry(vectors, { full: randomBlob(KIB), thumbnail: randomBlob(KIB) }),
  );
  const lateRow = await store.readPrivate(vectors.late_removed_entry.record.id);
  const survivorCase = vectors.cases.find(
    (c) => c.id === 'surviving-older-original-can-still-recover-media',
  );
  const full = randomBlob(32 * KIB);
  const attach = await store.admitPrivate({
    record: {
      ...vectors.late_removed_entry.record,
      id: survivorCase.surviving_record_id,
    },
    origin: 'generated',
    addedAt: survivorCase.surviving_added_at_ms,
    full,
  });
  const survivor = await store.readPrivate(survivorCase.surviving_record_id);
  const survivorOk =
    attach.persisted === true &&
    attach.duplicate === false &&
    survivor?.full != null &&
    (await sha256(survivor.full)) === (await sha256(full)) &&
    survivor.record.original_selected_controls[0].value === false &&
    survivor.record.original_selected_controls[1].value === 0 &&
    survivor.record.extension.note === null;
  return {
    late,
    lateRowStored: lateRow !== null,
    attach,
    survivorOk,
    facts: await tombstoneFacts(db),
    consistency: await privateConsistency(TOMBSTONE_PROOF_DB),
  };
}

/** Page A: a deliberate reimport; B then writes the old add late. */
export async function tombstoneReimport({ vectors }) {
  const { store } = scenario(TOMBSTONE_PROOF_DB);
  const reimport = vectors.cases.find(
    (c) => c.id === 'deliberate-reimport-is-a-new-incarnation',
  );
  const full = randomBlob(16 * KIB);
  const outcome = await store.admitPrivate({
    record: {
      ...vectors.late_removed_entry.record,
      original_prompt: reimport.new_original_prompt,
    },
    origin: 'imported',
    addedAt: reimport.new_added_at_ms,
    full,
  });
  return { outcome, digest: await sha256(full) };
}

export async function tombstoneStaleOldWrite({ vectors, digest }) {
  const { store } = scenario(TOMBSTONE_PROOF_DB);
  const stale = await store.admitPrivate(
    lateEntry(vectors, { full: randomBlob(8 * KIB) }),
  );
  const row = await store.readPrivate(vectors.late_removed_entry.record.id);
  return {
    stale,
    storedAddedAt: row?.addedAt ?? null,
    storedPrompt: row?.record.original_prompt ?? null,
    bytesUnchanged: row?.full ? (await sha256(row.full)) === digest : false,
  };
}

/**
 * A removal that would compact the full tombstone store aborts natively after
 * all of its writes: row, original, thumbnail, counter, tombstones and fence
 * all survive, and both tabs can still recover the same add's media.
 */
export async function tombstoneFailedRemoval() {
  const { store, db } = scenario(TOMBSTONE_PROOF_DB);
  const full = randomBlob(24 * KIB);
  const thumbnail = randomBlob(2 * KIB);
  const kept = privateEntry('kept-through-failure', 50_000, 'imported');
  const admitted = await store.admitPrivate({ ...kept, full, thumbnail });
  const before = {
    facts: await tombstoneFacts(db),
    consistency: await privateConsistency(TOMBSTONE_PROOF_DB),
  };
  fenceFailure.armed = true;
  const removal = await store.removePrivate('kept-through-failure', 50_000);
  const after = {
    facts: await tombstoneFacts(db),
    consistency: await privateConsistency(TOMBSTONE_PROOF_DB),
  };
  const row = await store.readPrivate('kept-through-failure');
  const recovery = await store.admitPrivate({ ...kept, full, thumbnail });
  return {
    admitted,
    removal: { removed: removal.removed, error: removal.error?.message },
    unchanged: JSON.stringify(before) === JSON.stringify(after),
    before,
    after,
    bytesIntact:
      row !== null &&
      (await sha256(row.full)) === (await sha256(full)) &&
      (await sha256(row.thumbnail)) === (await sha256(thumbnail)),
    recovery,
  };
}

/** Page B, after the failed removal in A: recovery is allowed here too. */
export async function tombstoneRecoverInOtherTab() {
  const { store } = scenario(TOMBSTONE_PROOF_DB);
  return store.admitPrivate({
    ...privateEntry('kept-through-failure', 50_000, 'imported'),
    full: randomBlob(24 * KIB),
  });
}

export const tombstoneCeilings = () => ({
  limit: PRIVATE_TOMBSTONE_LIMIT,
  maxBytes: PRIVATE_TOMBSTONE_MAX_BYTES,
});

/** A raw v6 database: every current store, seeded as the previous release left it. */
function createVersionSix(name, seed) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 6);
    request.onupgradeneeded = () =>
      upgradeSchema(request.result, request.transaction);
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction(
        [
          STORE.PRIVATE,
          STORE.PRIVATE_MEDIA,
          STORE.PRIVATE_TOMBSTONES,
          STORE.SETTINGS,
          STORE.SHARED_PREPARED,
          STORE.META,
        ],
        'readwrite',
      );
      seed(transaction);
      transaction.oncomplete = () => {
        db.close();
        resolve();
      };
      transaction.onerror = () => reject(transaction.error);
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * v6 -> v7: a stale v6 tab is fenced, a v6 bundle cannot reopen, 200 legacy
 * tombstones (the two oldest already pruned by v6) are inferred into a fence
 * that refuses the vectors' late add, and every original, thumbnail, prepared
 * PNG and setting keeps its bytes. Only new admission is refused by the limit.
 */
export async function privateV6UpgradeFencesRemovals({ vectors }) {
  const name = 'o17-proof-v6-to-v7';
  opened.get(name)?.db.close();
  await deleteDatabase(name);
  const originals = [];
  for (let n = 0; n < 6; n += 1) {
    const full = randomBlob(48 * KIB);
    const thumbnail = randomBlob(4 * KIB);
    originals.push({
      id: `v6-${n}`,
      addedAt: 300 + n,
      full,
      thumbnail,
      digests: [await sha256(full), await sha256(thumbnail)],
    });
  }
  const prepared = randomBlob(6 * KIB);
  const preparedDigest = await sha256(prepared);
  const sharedPrepared = randomBlob(5 * KIB);
  const sharedPreparedDigest = await sha256(sharedPrepared);
  const settings = { enabled: false, opacity: 0, text: null, future: [0] };
  const { churn } = vectors;
  await createVersionSix(name, (transaction) => {
    const put = (store, value, key) =>
      transaction.objectStore(store).put(value, key);
    let bytes = 0;
    for (const o of originals) {
      put(
        STORE.PRIVATE,
        {
          record: wireRecord(o.id),
          origin: 'imported',
          addedAt: o.addedAt,
          watermark:
            o.id === 'v6-0'
              ? { analysis: { print_watermark_key: 'k' }, prepared: { v: 1 } }
              : undefined,
        },
        o.id,
      );
      put(
        STORE.PRIVATE_MEDIA,
        { key: o.id, blob: o.full, bytes: o.full.size, addedAt: o.addedAt },
        `${o.id}|full`,
      );
      put(
        STORE.PRIVATE_MEDIA,
        {
          key: o.id,
          blob: o.thumbnail,
          bytes: o.thumbnail.size,
          addedAt: o.addedAt,
        },
        `${o.id}|thumbnail`,
      );
      bytes += o.full.size + o.thumbnail.size;
    }
    put(
      STORE.PRIVATE_MEDIA,
      { key: 'v6-0', blob: prepared, bytes: prepared.size, addedAt: 300 },
      'v6-0|watermarked',
    );
    bytes += prepared.size;
    put(STORE.META, bytes, 'privateBytes');
    for (let n = 2; n < churn.count; n += 1) {
      const id = `${churn.record_id_prefix}${churn.first_number + n}`;
      put(
        STORE.PRIVATE_TOMBSTONES,
        { addedAt: churn.added_at_start_ms + n * churn.added_at_step_ms },
        id,
      );
    }
    put(STORE.SETTINGS, settings, 'watermark');
    put(
      STORE.SHARED_PREPARED,
      { key: 's/x.png', blob: sharedPrepared, bytes: sharedPrepared.size },
      's/x.png',
    );
  });

  const legacyTab = { db: null, fenced: false };
  legacyTab.db = await new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 6);
    request.onsuccess = () => {
      request.result.onversionchange = () => {
        legacyTab.fenced = true;
        request.result.close();
      };
      resolve(request.result);
    };
    request.onerror = () => reject(request.error);
  });

  await openScenario({ name, limits: TOMBSTONE_LIMITS, reset: false });
  const { store, db } = scenario(name);
  const oldBundle = await new Promise((resolve) => {
    const request = indexedDB.open(name, 6);
    request.onsuccess = () => {
      request.result.close();
      resolve('opened');
    };
    request.onerror = () => resolve(request.error?.name ?? 'error');
  });
  const factsBefore = await tombstoneFacts(db);
  const late = await store.admitPrivate(
    lateEntry(vectors, { full: randomBlob(KIB) }),
  );
  const factsAfterLate = await tombstoneFacts(db);
  const rows = await store.loadPrivate();
  const hashes = [];
  for (const o of originals) {
    const row = rows.find((r) => r.record.id === o.id);
    hashes.push(
      Boolean(row) &&
        (await sha256(row.full)) === o.digests[0] &&
        (await sha256(row.thumbnail)) === o.digests[1],
    );
  }
  const preparedNow = await store.readPrivateMedia(
    'v6-0',
    { addedAt: 300 },
    'watermarked',
  );
  const rawAfter = await db.run(
    [STORE.SETTINGS, STORE.SHARED_PREPARED],
    'readonly',
    async (access) => ({
      settings: await access.get(STORE.SETTINGS, 'watermark'),
      shared: await access.get(STORE.SHARED_PREPARED, 's/x.png'),
    }),
  );
  const refused = await store.admitPrivate({
    ...privateEntry('new-after-upgrade', Date.now(), 'imported'),
    full: randomBlob(KIB),
  });
  const recovery = await store.admitPrivate({
    ...privateEntry('v6-1', 301, 'imported'),
    record: wireRecord('v6-1'),
  });
  const removed = await store.removePrivate('v6-5', 305);
  const factsAfterRemoval = await tombstoneFacts(db);
  const lateAfterCompaction = await createCacheStore(
    db,
    TOMBSTONE_LIMITS,
  ).admitPrivate(lateEntry(vectors, { full: randomBlob(KIB) }));
  const consistency = await privateConsistency(name);
  const sharedDigest = rawAfter.shared
    ? await sha256(rawAfter.shared.blob)
    : null;
  return {
    name: 'privateV6UpgradeFencesRemovals',
    pass:
      legacyTab.fenced === true &&
      oldBundle === 'VersionError' &&
      factsBefore.count === churn.count - 2 &&
      factsBefore.fence === null &&
      late.persisted === false &&
      late.reason === 'removal-fenced' &&
      factsAfterLate.count === churn.count - 2 &&
      factsAfterLate.fence?.addedAt ===
        churn.added_at_start_ms + (churn.count - 1) * churn.added_at_step_ms &&
      rows.length === 6 &&
      hashes.every(Boolean) &&
      preparedNow !== null &&
      (await sha256(preparedNow)) === preparedDigest &&
      JSON.stringify(rawAfter.settings) === JSON.stringify(settings) &&
      sharedDigest === sharedPreparedDigest &&
      refused.persisted === false &&
      refused.reason === 'record-limit' &&
      recovery.persisted === true &&
      removed.removed === true &&
      factsAfterRemoval.count <= PRIVATE_TOMBSTONE_LIMIT &&
      factsAfterRemoval.bytes <= PRIVATE_TOMBSTONE_MAX_BYTES &&
      lateAfterCompaction.persisted === false &&
      isConsistent(consistency) &&
      consistency.rows === 5,
    fenced: legacyTab.fenced,
    oldBundle,
    factsBefore,
    late,
    factsAfterLate,
    hashes,
    preparedIntact: preparedNow
      ? (await sha256(preparedNow)) === preparedDigest
      : false,
    settingsIntact:
      JSON.stringify(rawAfter.settings) === JSON.stringify(settings),
    sharedPreparedIntact: sharedDigest === sharedPreparedDigest,
    refused,
    recovery,
    removed,
    factsAfterRemoval,
    lateAfterCompaction,
    consistency,
  };
}
