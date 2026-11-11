/**
 * Browser-local storage for the watermark workflow, on the one cache database:
 *
 *   settings        name -> value              SVG markup (too large for LocalStorage)
 *   sharedPrepared  imageKey -> {state, blob, bytes, lastUsedAt}
 *                   the analysis and the one prepared PNG of a SHARED original,
 *                   made with this browser's watermark content
 *
 * Prepared copies are rebuildable: they share the shared-variant budgets, the
 * least recently used are evicted for a new one, and a quota failure refuses
 * the write instead of pruning anything else. Private originals are never
 * touched here. Without a database the same rules hold in memory for the tab.
 * Only one row is read per image; nothing scans the blobs.
 */
import { STORE } from './cacheDb.js';

/** Why a write was not kept (matches the cache store's vocabulary). */
export const KEEP_SKIPPED = Object.freeze({
  OVERSIZE: 'oversize',
  QUOTA: 'quota',
  FAILED: 'failed',
});

const isQuota = (error) => error?.name === 'QuotaExceededError';
const skipped = (reason) => ({ persisted: false, reason });

/**
 * Which stored copies must go so `incoming` fits the budgets.
 * @param {{id: string, bytes: number, lastUsedAt: number}[]} entries stored rows
 * @param {{id: string, bytes: number}} incoming
 * @param {{sharedVariantLimit: number, sharedVariantMaxBytes: number}} limits
 * @returns {{fits: boolean, evict: string[]}}
 */
export function planPreparedEviction(entries, incoming, limits) {
  if (incoming.bytes > limits.sharedVariantMaxBytes)
    return { fits: false, evict: [] };
  const others = entries.filter((entry) => entry.id !== incoming.id);
  const oldestFirst = [...others].sort((a, b) => a.lastUsedAt - b.lastUsedAt);
  let count = others.length + 1;
  let bytes =
    others.reduce((sum, entry) => sum + entry.bytes, 0) + incoming.bytes;
  const evict = [];
  for (const entry of oldestFirst) {
    if (
      count <= limits.sharedVariantLimit &&
      bytes <= limits.sharedVariantMaxBytes
    )
      break;
    evict.push(entry.id);
    count -= 1;
    bytes -= entry.bytes;
  }
  return { fits: true, evict };
}

/**
 * @param {ReturnType<typeof import('./cacheDb.js').openCacheDb> extends Promise<infer D> ? D : never} db
 *   null when storage is unusable
 * @param {() => {sharedVariantLimit: number, sharedVariantMaxBytes: number}} getLimits
 */
export function createLocalWatermarkStore(db, getLimits) {
  /** Tab-only copies: used without a database, and for settings that would not store. */
  const memory = { settings: new Map(), prepared: new Map() };
  const clock = () => Date.now();

  const memoryEntries = () =>
    [...memory.prepared].map(([id, row]) => ({ id, ...row }));

  return {
    get durable() {
      return Boolean(db) && db.open !== false;
    },

    /** A stored setting, or undefined. Rejects only when the database fails. */
    async readSetting(name) {
      if (!db) return memory.settings.get(name);
      return db.run([STORE.SETTINGS], 'readonly', (access) =>
        access.get(STORE.SETTINGS, name),
      );
    },

    /** @returns {Promise<{persisted: boolean, reason?: string}>} */
    async writeSetting(name, value) {
      if (!db) {
        memory.settings.set(name, value);
        return { persisted: false, reason: 'no-storage' };
      }
      try {
        await db.run([STORE.SETTINGS], 'readwrite', (access) =>
          access.put(STORE.SETTINGS, name, value),
        );
        return { persisted: true };
      } catch (error) {
        memory.settings.set(name, value);
        return skipped(
          isQuota(error) ? KEEP_SKIPPED.QUOTA : KEEP_SKIPPED.FAILED,
        );
      }
    },

    async deleteSetting(name) {
      memory.settings.delete(name);
      if (!db) return;
      try {
        await db.run([STORE.SETTINGS], 'readwrite', (access) =>
          access.delete(STORE.SETTINGS, name),
        );
      } catch {
        // A value that cannot be removed is replaced by the next save.
      }
    },

    /** The stored row of one shared original, or null. Never throws. */
    async readPrepared(key) {
      if (!db) return memory.prepared.get(key) ?? null;
      try {
        const row = await db.run(
          [STORE.SHARED_PREPARED],
          'readonly',
          (access) => access.get(STORE.SHARED_PREPARED, key),
        );
        return row ?? null;
      } catch {
        return null;
      }
    },

    /**
     * Keep the analysis (and PNG, if any) of one shared original, evicting
     * the least recently used other copies to fit the budgets.
     * @returns {Promise<{persisted: boolean, memory?: boolean, reason?: string}>}
     */
    async writePrepared(key, { state, blob = null }) {
      const bytes = blob?.size ?? 0;
      const row = { state, blob, bytes, lastUsedAt: clock() };
      const limits = getLimits();
      if (!db) {
        const plan = planPreparedEviction(
          memoryEntries(),
          { id: key, bytes },
          limits,
        );
        if (!plan.fits) return skipped(KEEP_SKIPPED.OVERSIZE);
        for (const id of plan.evict) memory.prepared.delete(id);
        memory.prepared.set(key, row);
        return { persisted: true, memory: true };
      }
      try {
        return await db.run(
          [STORE.SHARED_PREPARED],
          'readwrite',
          async (access) => {
            const entries = [];
            await access.scan(STORE.SHARED_PREPARED, null, (value, id) => {
              entries.push({
                id,
                bytes: value.bytes,
                lastUsedAt: value.lastUsedAt,
              });
            });
            const plan = planPreparedEviction(
              entries,
              { id: key, bytes },
              limits,
            );
            if (!plan.fits) return skipped(KEEP_SKIPPED.OVERSIZE);
            for (const id of plan.evict)
              await access.delete(STORE.SHARED_PREPARED, id);
            await access.put(STORE.SHARED_PREPARED, key, row);
            return { persisted: true };
          },
        );
      } catch (error) {
        return skipped(
          isQuota(error) ? KEEP_SKIPPED.QUOTA : KEEP_SKIPPED.FAILED,
        );
      }
    },

    /** Drop the copy of one shared original (it was deleted). Never throws. */
    async deletePrepared(key) {
      memory.prepared.delete(key);
      if (!db) return;
      try {
        await db.run([STORE.SHARED_PREPARED], 'readwrite', (access) =>
          access.delete(STORE.SHARED_PREPARED, key),
        );
      } catch {
        // The copy is checked against the source hash before it is used.
      }
    },
  };
}
