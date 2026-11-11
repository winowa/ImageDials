/**
 * The shared library's cached records, listings, bounded page window and
 * exact details, with the sequence/tombstone bookkeeping that stops a late
 * read from resurrecting a deleted image. Variants are owned by
 * `cacheVariants.js`; the helpers it exports join these transactions.
 */
import { LIBRARY_DETAIL_USE_INDEX, STORE } from './cacheDb.js';
import {
  listingForStorage,
  planLibraryDetailEviction,
  reconcileDeletions,
} from './cachePolicy.js';
import { imageKey } from '../records/imageRecord.js';
import { WRITE_SKIPPED, encodedBytes, skipped } from './cacheKernel.js';

/** Stores of the shared-library cache; the private history has its own. */
const SHARED_STORES = [
  STORE.RECORDS,
  STORE.LISTINGS,
  STORE.VARIANTS,
  STORE.TOMBSTONES,
  STORE.META,
  STORE.LIBRARY_SUMMARIES,
  STORE.LIBRARY_PAGES,
  STORE.LIBRARY_DETAILS,
];
const ACTIVE_LIBRARY_PAGE_KEY = 'active-library-window';

/**
 * @param {ReturnType<typeof import('./cacheKernel.js').createCacheContext>} ctx
 * @param {ReturnType<typeof import('./cacheVariants.js').createVariantCache>} variants
 */
export function createSharedLibraryCache(ctx, variants) {
  const { db, memory } = ctx;
  const { removeVariants, adjustVariantBytes, withQuotaRetry, trimVariants } =
    variants;

  const readSeq = async (access) => (await access.get(STORE.META, 'seq')) ?? 0;
  const bump = async (access) => {
    const seq = (await readSeq(access)) + 1;
    await access.put(STORE.META, 'seq', seq);
    return seq;
  };

  async function removeLibraryDetail(access, key) {
    const row = await access.get(STORE.LIBRARY_DETAILS, key);
    if (!row) return;
    // Read first: absent counters are rebuilt, never assumed to be zero.
    const { count, bytes } = await readLibraryDetailUsage(access);
    await access.delete(STORE.LIBRARY_DETAILS, key);
    await access.put(STORE.META, 'libraryDetailCount', Math.max(0, count - 1));
    await access.put(
      STORE.META,
      'libraryDetailBytes',
      Math.max(0, bytes - row.bytes),
    );
  }

  async function readLibraryDetailUsage(access) {
    let count = await access.get(STORE.META, 'libraryDetailCount');
    let bytes = await access.get(STORE.META, 'libraryDetailBytes');
    if (Number.isSafeInteger(count) && Number.isSafeInteger(bytes))
      return { count, bytes };
    count = 0;
    bytes = 0;
    await access.scan(STORE.LIBRARY_DETAILS, null, (row) => {
      count += 1;
      bytes += row.bytes;
    });
    await access.put(STORE.META, 'libraryDetailCount', count);
    await access.put(STORE.META, 'libraryDetailBytes', bytes);
    return { count, bytes };
  }

  async function nextLibraryDetailUse(access, previous = 0) {
    const clock = (await access.get(STORE.META, 'libraryDetailClock')) ?? 0;
    const next = Math.max(Date.now(), clock + 1, previous + 1);
    await access.put(STORE.META, 'libraryDetailClock', next);
    return next;
  }

  async function clearLibraryWindowRows(access) {
    const manifest = await access.get(
      STORE.LIBRARY_PAGES,
      ACTIVE_LIBRARY_PAGE_KEY,
    );
    for (const entry of manifest?.pages ?? [])
      for (const key of entry.summaryKeys)
        await access.delete(STORE.LIBRARY_SUMMARIES, key);
    await access.delete(STORE.LIBRARY_PAGES, ACTIVE_LIBRARY_PAGE_KEY);
  }

  return {
    /** The cached listing for a scope, or null. Never throws. */
    async hydrate(scopeKey) {
      if (!db || scopeKey === null) return null;
      try {
        return await db.run(
          [STORE.LISTINGS, STORE.RECORDS],
          'readonly',
          async (access) => {
            const listing = await access.get(STORE.LISTINGS, scopeKey);
            if (!listing) return null;
            const items = [];
            let missing = false;
            for (const key of listing.keys) {
              const record = await access.get(STORE.RECORDS, key);
              if (record && !memory.tombstones.has(key)) items.push(record);
              else missing = true;
            }
            return {
              items,
              // A listing with a missing record must be re-read in full.
              etag: missing ? null : listing.etag,
              watermarkSettings: listing.watermarkSettings ?? null,
            };
          },
        );
      } catch {
        return null;
      }
    },

    /** Read the one cached bounded summary window, if its scope and filters match. */
    async hydrateLibraryWindow(scopeKey, binding) {
      if (!db || scopeKey === null) return null;
      try {
        return await db.run(
          [STORE.LIBRARY_PAGES, STORE.LIBRARY_SUMMARIES],
          'readwrite',
          async (access) => {
            const manifest = await access.get(
              STORE.LIBRARY_PAGES,
              ACTIVE_LIBRARY_PAGE_KEY,
            );
            if (
              !manifest ||
              manifest.scopeKey !== scopeKey ||
              JSON.stringify(manifest.binding) !== JSON.stringify(binding)
            )
              return null;
            const pages = [];
            for (const stored of manifest.pages) {
              const images = [];
              for (const key of stored.summaryKeys) {
                const summary = await access.get(STORE.LIBRARY_SUMMARIES, key);
                if (!summary) return null;
                // A local cleanup that failed must not bring an image back.
                if (
                  memory.tombstones.has(
                    summary.identity ?? imageKey(summary.summary ?? summary),
                  )
                )
                  return null;
                if (summary.summary) images.push(summary.summary);
                else {
                  // Upgrade v5 raw summary rows into the v6 indexed wrapper
                  // while visiting only this bounded active window.
                  const migrated = {
                    identity: imageKey(summary),
                    summary,
                  };
                  await access.put(STORE.LIBRARY_SUMMARIES, key, migrated);
                  images.push(summary);
                }
              }
              pages.push({ ...stored.page, images });
            }
            return {
              binding: manifest.binding,
              pages,
              activeIndex: manifest.activeIndex,
              revision: manifest.revision,
              complete: false,
            };
          },
        );
      } catch {
        return null;
      }
    },

    /** Replace the persisted bounded window atomically; never stores full detail here. */
    async persistLibraryWindow(scopeKey, window, ticket = null) {
      if (!db || scopeKey === null)
        return {
          ...skipped(WRITE_SKIPPED.NO_STORAGE),
          stale: Boolean(ticket && memory.epoch !== ticket.epoch),
        };
      const manifest = {
        scopeKey,
        binding: window.binding,
        pages: window.pages.map((page, pageIndex) => ({
          page: Object.fromEntries(
            Object.entries(page).filter(([key]) => key !== 'images'),
          ),
          summaryKeys: page.images.map(
            (image, imageIndex) =>
              `${pageIndex}|${imageIndex}|${imageKey(image)}`,
          ),
        })),
        activeIndex: window.activeIndex,
        revision: window.revision,
      };
      const pageBytes = encodedBytes({
        manifest,
        summaries: window.pages.flatMap((page) => page.images),
      });
      const summaryCount = window.pages.reduce(
        (total, page) => total + page.images.length,
        0,
      );
      // `sharedPageManifestLimit` counts retained page entries inside this one
      // active manifest; the in-memory/navigation contract independently caps
      // the window at three pages.
      if (
        window.pages.length >
          Math.min(3, ctx.limits.sharedPageManifestLimit ?? 3) ||
        summaryCount > ctx.limits.sharedRecordLimit ||
        pageBytes > ctx.limits.sharedPageMaxBytes
      )
        return { ...skipped(WRITE_SKIPPED.OVERSIZE), stale: false };
      try {
        return await db.run(
          [STORE.LIBRARY_PAGES, STORE.LIBRARY_SUMMARIES, STORE.META],
          'readwrite',
          async (access) => {
            if (
              ticket &&
              (memory.epoch !== ticket.epoch ||
                (ticket.seq !== null && (await readSeq(access)) !== ticket.seq))
            )
              return { persisted: false, stale: true };
            await clearLibraryWindowRows(access);
            const pages = [];
            for (const [pageIndex, page] of window.pages.entries()) {
              const summaryKeys = [];
              for (const [imageIndex, image] of page.images.entries()) {
                const key = `${pageIndex}|${imageIndex}|${imageKey(image)}`;
                summaryKeys.push(key);
                await access.put(STORE.LIBRARY_SUMMARIES, key, {
                  identity: imageKey(image),
                  summary: image,
                });
              }
              const { images: _images, ...metadata } = page;
              pages.push({ page: metadata, summaryKeys });
            }
            await access.put(STORE.LIBRARY_PAGES, ACTIVE_LIBRARY_PAGE_KEY, {
              ...manifest,
              pages,
            });
            return { persisted: true, stale: false };
          },
        );
      } catch {
        return { ...skipped(WRITE_SKIPPED.FAILED), stale: false };
      }
    },

    /** Remove the summary window without touching any exact full details. */
    async clearLibraryWindow() {
      if (!db) return skipped(WRITE_SKIPPED.NO_STORAGE);
      try {
        await db.run(
          [STORE.LIBRARY_PAGES, STORE.LIBRARY_SUMMARIES],
          'readwrite',
          async (access) => {
            await clearLibraryWindowRows(access);
          },
        );
        return { persisted: true };
      } catch {
        return skipped(WRITE_SKIPPED.FAILED);
      }
    },

    /** Exact full detail from its independent indexed LRU, or null. */
    async getLibraryDetail(recordOrKey) {
      if (!db) return null;
      const key =
        typeof recordOrKey === 'string' ? recordOrKey : imageKey(recordOrKey);
      if (memory.tombstones.has(key)) return null;
      try {
        return await db.run(
          [STORE.LIBRARY_DETAILS, STORE.TOMBSTONES, STORE.META],
          'readwrite',
          async (access) => {
            if (await access.get(STORE.TOMBSTONES, key)) return null;
            const row = await access.get(STORE.LIBRARY_DETAILS, key);
            if (!row) return null;
            const lastUsedAt = await nextLibraryDetailUse(
              access,
              row.lastUsedAt,
            );
            await access.put(STORE.LIBRARY_DETAILS, key, {
              ...row,
              lastUsedAt,
            });
            return { record: row.record, etag: row.etag ?? null };
          },
        );
      } catch {
        return null;
      }
    },

    /** Cache full provenance under count/byte ceilings, evicting by its own LRU index. */
    async putLibraryDetail(record, etag, { pinned = new Set() } = {}) {
      if (!db) return skipped(WRITE_SKIPPED.NO_STORAGE);
      const key = imageKey(record);
      if (memory.tombstones.has(key)) return skipped(WRITE_SKIPPED.DELETED);
      const bytes = encodedBytes(record);
      const detailLimits = {
        libraryDetailLimit: ctx.limits.sharedDetailRecordLimit,
        libraryDetailMaxBytes: ctx.limits.sharedDetailMaxBytes,
      };
      if (bytes > detailLimits.libraryDetailMaxBytes)
        return skipped(WRITE_SKIPPED.OVERSIZE);
      try {
        return await db.run(
          [STORE.LIBRARY_DETAILS, STORE.RECORDS, STORE.TOMBSTONES, STORE.META],
          'readwrite',
          async (access) => {
            if (await access.get(STORE.TOMBSTONES, key))
              return skipped(WRITE_SKIPPED.DELETED);
            const usage = await readLibraryDetailUsage(access);
            const old = await access.get(STORE.LIBRARY_DETAILS, key);
            // Records are large: visit them only when something must go.
            const candidates = [];
            if (
              usage.count + (old ? 0 : 1) > detailLimits.libraryDetailLimit ||
              usage.bytes + bytes - (old?.bytes ?? 0) >
                detailLimits.libraryDetailMaxBytes
            )
              await access.scan(
                STORE.LIBRARY_DETAILS,
                LIBRARY_DETAIL_USE_INDEX,
                (row, id) => {
                  candidates.push({
                    id,
                    bytes: row.bytes,
                    lastUsedAt: row.lastUsedAt,
                  });
                },
                { direction: 'next' },
              );
            const plan = candidates.length
              ? planLibraryDetailEviction(
                  candidates,
                  { id: key, bytes },
                  detailLimits,
                  pinned,
                )
              : { store: true, evict: [] };
            if (!plan.store) return skipped(WRITE_SKIPPED.PINNED);
            for (const victim of plan.evict) {
              const removed = await access.get(STORE.LIBRARY_DETAILS, victim);
              await access.delete(STORE.LIBRARY_DETAILS, victim);
              usage.count -= 1;
              usage.bytes -= removed?.bytes ?? 0;
            }
            const lastUsedAt = await nextLibraryDetailUse(
              access,
              old?.lastUsedAt ?? 0,
            );
            await access.put(STORE.LIBRARY_DETAILS, key, {
              record,
              etag: etag ?? null,
              bytes,
              lastUsedAt,
            });
            if (!old) usage.count += 1;
            usage.bytes += bytes - (old?.bytes ?? 0);
            await access.put(STORE.META, 'libraryDetailCount', usage.count);
            await access.put(STORE.META, 'libraryDetailBytes', usage.bytes);
            if (await access.get(STORE.RECORDS, key))
              await access.put(STORE.RECORDS, key, record);
            return { persisted: true };
          },
        );
      } catch {
        return skipped(WRITE_SKIPPED.FAILED);
      }
    },

    /** Take a ticket before a library request; see the file comment. */
    async beginRead() {
      let seq = null;
      if (db) {
        try {
          seq = await db.run([STORE.META], 'readonly', readSeq);
        } catch {
          seq = null;
        }
      }
      return { seq, epoch: memory.epoch };
    },

    /**
     * Apply an authoritative server list. Returns the images to show (deleted
     * images removed), whether it was persisted, and `stale` when something
     * changed since the ticket so the caller should read once more.
     * @returns {Promise<{images: object[], persisted: boolean, reason?: string, stale: boolean}>}
     */
    async commitListing(scopeKey, ticket, { images, etag, watermarkSettings }) {
      const inTab = reconcileDeletions(images, memory.tombstones, ticket.epoch);
      for (const key of inTab.settled) memory.tombstones.delete(key);
      const inTabStale = memory.epoch !== ticket.epoch;
      if (!db || ticket.seq === null)
        return {
          images: inTab.images,
          ...skipped(WRITE_SKIPPED.NO_STORAGE),
          stale: inTabStale,
        };

      const outcome = await withQuotaRetry(
        () =>
          db
            .run(SHARED_STORES, 'readwrite', async (access) => {
              const tombstones = new Map();
              await access.scan(STORE.TOMBSTONES, null, (row, key) => {
                tombstones.set(key, row.seq);
              });
              const reconciled = reconcileDeletions(
                inTab.images,
                tombstones,
                ticket.seq,
              );
              if ((await readSeq(access)) !== ticket.seq || inTabStale)
                return { images: reconciled.images, stale: true };
              for (const key of reconciled.settled)
                await access.delete(STORE.TOMBSTONES, key);

              const stored = listingForStorage(
                reconciled.images,
                ctx.limits.sharedRecordLimit,
              );
              const keys = stored.images.map(imageKey);
              const keptKeys = new Set(keys);
              const previous = await access.get(STORE.LISTINGS, scopeKey);

              // Server-dropped images lose their variants too.
              let freed = 0;
              for (const key of previous?.keys ?? [])
                if (!keptKeys.has(key))
                  freed += await removeVariants(access, key);
              await adjustVariantBytes(access, -freed);

              // One listing per scope; records no listing keeps are removed.
              const staleScopes = [];
              await access.scan(STORE.LISTINGS, null, (_row, key) => {
                if (key !== scopeKey) staleScopes.push(key);
              });
              for (const scope of staleScopes)
                await access.delete(STORE.LISTINGS, scope);
              const orphans = [];
              await access.scan(STORE.RECORDS, null, (_row, key) => {
                if (!keptKeys.has(key)) orphans.push(key);
              });
              for (const key of orphans)
                await access.delete(STORE.RECORDS, key);

              for (const [index, record] of stored.images.entries())
                await access.put(STORE.RECORDS, keys[index], record);
              await access.put(STORE.LISTINGS, scopeKey, {
                keys,
                etag: stored.complete ? (etag ?? null) : null,
                complete: stored.complete,
                watermarkSettings: watermarkSettings ?? null,
              });
              return { images: reconciled.images, stale: false };
            })
            .then((result) => ({ ...result, persisted: !result.stale })),
        trimVariants(new Set()),
      );
      if (outcome.images)
        return {
          images: outcome.images,
          persisted: outcome.persisted,
          ...(outcome.stale ? { reason: WRITE_SKIPPED.STALE } : {}),
          stale: outcome.stale,
        };
      return { images: inTab.images, ...outcome, stale: inTabStale };
    },

    /** A record was inserted or changed in this tab: reads in flight are stale. */
    async noteMutation() {
      memory.epoch += 1;
      if (!db) return skipped(WRITE_SKIPPED.NO_STORAGE);
      try {
        await db.run([STORE.META], 'readwrite', bump);
        return { persisted: true };
      } catch {
        return skipped(WRITE_SKIPPED.FAILED);
      }
    },

    /**
     * Replace one cached record with what the server just returned (analysis,
     * prepared file). The listing's ETag is forgotten so the next read
     * revalidates. A record that is not cached is not added.
     */
    async putRecord(scopeKey, record) {
      memory.epoch += 1;
      if (!db) return skipped(WRITE_SKIPPED.NO_STORAGE);
      const key = imageKey(record);
      try {
        await db.run(
          [STORE.RECORDS, STORE.LISTINGS, STORE.META],
          'readwrite',
          async (access) => {
            await bump(access);
            if (await access.get(STORE.RECORDS, key))
              await access.put(STORE.RECORDS, key, record);
            const listing = await access.get(STORE.LISTINGS, scopeKey);
            if (listing)
              await access.put(STORE.LISTINGS, scopeKey, {
                ...listing,
                etag: null,
              });
          },
        );
        return { persisted: true };
      } catch {
        return skipped(WRITE_SKIPPED.FAILED);
      }
    },

    /**
     * Forget a deleted image: tombstone, record, variants, listing entry and
     * ETag go in one transaction. The in-tab tombstone is set synchronously,
     * before anything is awaited. Rejects if the cleanup transaction fails.
     */
    async purgeShared(key) {
      memory.epoch += 1;
      memory.tombstones.set(key, memory.epoch);
      if (!db) return { cleared: false };
      await db.run(SHARED_STORES, 'readwrite', async (access) => {
        const seq = await bump(access);
        await access.put(STORE.TOMBSTONES, key, { seq });
        await access.delete(STORE.RECORDS, key);
        await removeLibraryDetail(access, key);
        await clearLibraryWindowRows(access);
        await adjustVariantBytes(access, -(await removeVariants(access, key)));
        const listings = [];
        await access.scan(STORE.LISTINGS, null, (row, scope) => {
          listings.push([scope, row]);
        });
        for (const [scope, row] of listings)
          await access.put(STORE.LISTINGS, scope, {
            ...row,
            keys: row.keys.filter((listed) => listed !== key),
            etag: null,
          });
      });
      return { cleared: true };
    },
  };
}
