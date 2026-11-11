/**
 * Cached image variants of the shared library: bounded blobs with recency
 * batching, quota trimming and the byte counter. Reads and writes of variants
 * keep their one-transaction check-write rule.
 */
import {
  LIBRARY_SUMMARY_IDENTITY_INDEX,
  STORE,
  VARIANT_USE_INDEX,
} from './cacheDb.js';
import {
  VARIANT_KINDS,
  planVariantEviction,
  variantId,
} from './cachePolicy.js';
import { imageKey } from '../records/imageRecord.js';
import {
  QUOTA_RETRY_BUDGET_RATIO,
  TOUCH_FLUSH_MS,
  WRITE_SKIPPED,
  isQuota,
  skipped,
} from './cacheKernel.js';

/** @param {ReturnType<typeof import('./cacheKernel.js').createCacheContext>} ctx */
export function createVariantCache(ctx) {
  const { db, memory } = ctx;

  async function removeVariants(access, key) {
    let freed = 0;
    for (const kind of VARIANT_KINDS) {
      const id = variantId(key, kind);
      const row = await access.get(STORE.VARIANTS, id);
      if (!row) continue;
      await access.delete(STORE.VARIANTS, id);
      freed += row.bytes;
    }
    return freed;
  }

  const adjustVariantBytes = async (access, delta) => {
    if (!delta) return;
    const bytes = (await access.get(STORE.META, 'variantBytes')) ?? 0;
    await access.put(STORE.META, 'variantBytes', Math.max(0, bytes + delta));
  };

  /** Run a write; on quota trim the cache once and retry, then back off. */
  async function withQuotaRetry(write, trim) {
    if (Date.now() < memory.pausedUntil)
      return skipped(WRITE_SKIPPED.QUOTA_BACKOFF);
    try {
      return await write();
    } catch (error) {
      if (!isQuota(error)) return skipped(WRITE_SKIPPED.FAILED);
    }
    try {
      await trim();
      return await write();
    } catch (error) {
      if (isQuota(error)) memory.pausedUntil = Date.now() + ctx.quotaBackoffMs;
      return skipped(
        isQuota(error) ? WRITE_SKIPPED.QUOTA : WRITE_SKIPPED.FAILED,
      );
    }
  }

  const variantEntries = async (access) => {
    const entries = [];
    await access.scan(STORE.VARIANTS, VARIANT_USE_INDEX, (row, id) => {
      entries.push({ id, bytes: row.bytes, lastUsedAt: row.lastUsedAt });
    });
    return entries;
  };

  /**
   * Free room after a quota failure: evict the oldest unpinned variants until
   * a share of what is stored now remains. (The budgets are ceilings; the
   * browser's real quota may be far below them.)
   */
  const trimVariants = (pinned) => () =>
    db.run([STORE.VARIANTS, STORE.META], 'readwrite', async (access) => {
      const entries = await variantEntries(access);
      const stored = entries.reduce((sum, entry) => sum + entry.bytes, 0);
      const plan = planVariantEviction(
        entries,
        null,
        {
          sharedVariantLimit: Math.floor(
            entries.length * QUOTA_RETRY_BUDGET_RATIO,
          ),
          sharedVariantMaxBytes: Math.floor(stored * QUOTA_RETRY_BUDGET_RATIO),
        },
        pinned,
      );
      let freed = 0;
      for (const id of plan.evict) {
        const row = await access.get(STORE.VARIANTS, id);
        await access.delete(STORE.VARIANTS, id);
        freed += row?.bytes ?? 0;
      }
      await adjustVariantBytes(access, -freed);
    });

  async function flushTouches() {
    clearTimeout(memory.touchTimer);
    memory.touchTimer = null;
    if (!db || !memory.touched.size) return;
    const ids = [...memory.touched];
    memory.touched.clear();
    try {
      await db.run([STORE.VARIANTS], 'readwrite', async (access) => {
        const now = Date.now();
        for (const id of ids) {
          const row = await access.get(STORE.VARIANTS, id);
          if (row)
            await access.put(STORE.VARIANTS, id, { ...row, lastUsedAt: now });
        }
      });
    } catch {
      // Recency is only a hint for eviction order.
    }
  }

  /** Note that a variant was just used; recency writes are batched. */
  function touch(id) {
    if (!db) return;
    memory.touched.add(id);
    memory.touchTimer ??= setTimeout(flushTouches, TOUCH_FLUSH_MS);
  }

  return {
    // Helpers the shared-library module composes into its own transactions.
    removeVariants,
    adjustVariantBytes,
    withQuotaRetry,
    trimVariants,
    api: {
      /**
       * The cached bytes for a listed record, or null. A variant made for other
       * source bytes (the record's `sha256` changed) is not returned.
       */
      async getVariant(record, kind) {
        if (!db) return null;
        const key = imageKey(record);
        if (memory.tombstones.has(key)) return null;
        const id = variantId(key, kind);
        try {
          const row = await db.run([STORE.VARIANTS], 'readonly', (access) =>
            access.get(STORE.VARIANTS, id),
          );
          if (!row || row.sourceSha !== (record.sha256 ?? null)) return null;
          touch(id);
          return { blob: row.blob, bytes: row.bytes };
        } catch {
          return null;
        }
      },

      /**
       * Store a fetched variant if its image is still listed (not deleted, same
       * source bytes), evicting least-recently-used variants that are not
       * `pinned`. Never throws; a refusal only means the image is not cached.
       * @returns {Promise<{persisted: boolean, reason?: string}>}
       */
      async putVariant(record, kind, blob, { pinned = new Set() } = {}) {
        const key = imageKey(record);
        if (memory.tombstones.has(key)) return skipped(WRITE_SKIPPED.DELETED);
        if (!db) return skipped(WRITE_SKIPPED.NO_STORAGE);
        if (blob.size > ctx.limits.sharedVariantMaxBytes)
          return skipped(WRITE_SKIPPED.OVERSIZE);
        const id = variantId(key, kind);
        const sourceSha = record.sha256 ?? null;

        return withQuotaRetry(
          () =>
            db.run(
              [
                STORE.RECORDS,
                STORE.VARIANTS,
                STORE.TOMBSTONES,
                STORE.META,
                STORE.LIBRARY_SUMMARIES,
                STORE.LIBRARY_DETAILS,
              ],
              'readwrite',
              async (access) => {
                if (await access.get(STORE.TOMBSTONES, key))
                  return skipped(WRITE_SKIPPED.DELETED);
                const legacy = await access.get(STORE.RECORDS, key);
                const summary = await access.getIndex(
                  STORE.LIBRARY_SUMMARIES,
                  LIBRARY_SUMMARY_IDENTITY_INDEX,
                  key,
                );
                const detail = await access.get(STORE.LIBRARY_DETAILS, key);
                const listed = legacy ?? summary?.summary ?? detail?.record;
                if (!listed) return skipped(WRITE_SKIPPED.NOT_LISTED);
                if ((listed.sha256 ?? null) !== sourceSha)
                  return skipped(WRITE_SKIPPED.CHANGED);

                const existing = await access.get(STORE.VARIANTS, id);
                let bytes = (await access.get(STORE.META, 'variantBytes')) ?? 0;
                bytes -= existing?.bytes ?? 0;
                const count =
                  (await access.count(STORE.VARIANTS)) - (existing ? 1 : 0);
                if (
                  count + 1 > ctx.limits.sharedVariantLimit ||
                  bytes + blob.size > ctx.limits.sharedVariantMaxBytes
                ) {
                  // Walk the recency index and stop as soon as this write fits,
                  // so a full cache does not visit every variant per thumbnail.
                  const victims = [];
                  let remaining = count;
                  let remainingBytes = bytes;
                  const fits = () =>
                    remaining + 1 <= ctx.limits.sharedVariantLimit &&
                    remainingBytes + blob.size <=
                      ctx.limits.sharedVariantMaxBytes;
                  await access.scan(
                    STORE.VARIANTS,
                    VARIANT_USE_INDEX,
                    (row, victim) => {
                      if (fits()) return false;
                      if (victim === id || pinned.has(victim)) return true;
                      victims.push(victim);
                      remaining -= 1;
                      remainingBytes -= row.bytes;
                      return true;
                    },
                  );
                  if (!fits()) return skipped(WRITE_SKIPPED.PINNED);
                  for (const victim of victims)
                    await access.delete(STORE.VARIANTS, victim);
                  bytes = remainingBytes;
                }
                await access.put(STORE.VARIANTS, id, {
                  key,
                  blob,
                  bytes: blob.size,
                  sourceSha,
                  lastUsedAt: Date.now(),
                });
                await access.put(STORE.META, 'variantBytes', bytes + blob.size);
                return { persisted: true };
              },
            ),
          trimVariants(pinned),
        );
      },

      /** Remove one variant that could not be read back. */
      async dropVariant(key, kind) {
        if (!db) return;
        const id = variantId(key, kind);
        try {
          await db.run(
            [STORE.VARIANTS, STORE.META],
            'readwrite',
            async (access) => {
              const row = await access.get(STORE.VARIANTS, id);
              if (!row) return;
              await access.delete(STORE.VARIANTS, id);
              await adjustVariantBytes(access, -row.bytes);
            },
          );
        } catch {
          // The entry stays; it will be dropped again if it is read again.
        }
      },

      touch,

      /** Write pending recency updates now (page hide, tests). */
      flushTouches,
    },
  };
}
