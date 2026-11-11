/**
 * The shared-library cache: cached records and listings, bounded image
 * variants, and the delete bookkeeping that stops a late read or fetch from
 * bringing a deleted image back.
 *
 * `createCacheStore(null, limits)` is the no-storage store: reads are empty,
 * writes report `{persisted: false, reason}`, and the in-tab guards still work.
 * With a database every read-check-write is ONE transaction; nothing awaits a
 * fetch, decode or digest inside it. Rows (key -> value):
 *
 *   records     imageKey -> wire record (exactly as the server sent it)
 *   listings    scopeKey -> legacy full-list manifest
 *   libraryPages  active -> bounded three-page summary manifest
 *   librarySummaries key -> exact summary row referenced by that manifest
 *   libraryDetails imageKey -> exact full record, with an indexed bounded LRU
 *   variants    `key|kind` -> {key, blob, bytes, sourceSha, lastUsedAt}
 *   tombstones  imageKey -> {seq}   deleted at sequence `seq`
 *   meta        seq (mutation counter), variantBytes (sum of variants.bytes),
 *               privateBytes (sum of privateMedia.bytes, rebuilt once if absent)
 *
 * The private browser history uses stores of its own, so an imported image
 * that shares an identity with a shared record never touches the shared rows:
 *
 *   private           imageKey -> {record, origin, addedAt}   record = wire snapshot
 *   privateMedia      `key|kind` -> {key, blob, bytes, addedAt}
 *   privateTombstones imageKey -> {addedAt}   removed; older writes are refused
 *   meta privateRemovalFence     {addedAt: number|null}  compacted removals
 *
 * `addedAt` is the local time of adding. It identifies one add: a late write
 * carrying an `addedAt` at or below the tombstone's, or one that no longer
 * matches the stored row, is refused and cannot resurrect a removed entry.
 *
 * Removal metadata is bounded (`PRIVATE_TOMBSTONE_LIMIT` rows and
 * `PRIVATE_TOMBSTONE_MAX_BYTES`). A removal that would exceed either ceiling
 * compacts the oldest tombstones into the removal fence in its own transaction:
 * the fence rises to the newest `addedAt` it covers, and every tombstone at or
 * below it is dropped. An add at or below the fence that is NOT the stored
 * row's add is refused as `removal-fenced` (it may be a removed one); the
 * stored row's own add keeps attaching media and saving settings. A database
 * from before the fence infers it once from its remaining tombstones.
 *
 * A private original is never evicted, pruned or replaced to make room. Only a
 * confirmed `removePrivate` deletes one. Admission (`admitPrivate`) is a single
 * transaction that checks the record and byte budgets against the stored count
 * and the `privateBytes` counter and either writes everything or nothing. A
 * refusal may first give up rebuildable prepared watermark PNGs, never
 * originals. Stored entries above a lowered limit stay readable and removable.
 *
 * `seq` is bumped by every delete/insert/replace, in any tab. A read takes a
 * ticket (`beginRead`) before its request; committing it checks the ticket
 * against the tombstones and `seq`, so a read that began before a delete in
 * another tab cannot resurrect the image.
 *
 * `createCacheStore` only composes the owners of those rows, each a factory
 * over one shared context (`cacheKernel.js`: database, limits, in-tab guards):
 * `cacheShared.js` (records, listings, library window, exact details),
 * `cacheVariants.js` (variants, recency, quota trimming) and `cachePrivate.js`
 * (private history, its media, tombstones and fence). Transactions never span
 * a fetch and each keeps its own atomic read-check-write.
 */
import { createControlPresetStore } from './controlPresetStore.js';
import { createImageAnnotationStore } from './imageAnnotationStore.js';
import { createLocalWatermarkStore } from './localWatermarkStore.js';
import { createReferenceAssetsStore } from './referenceAssets.js';
import { QUOTA_BACKOFF_MS, createCacheContext } from './cacheKernel.js';
import { createPrivateCache, PRIVATE_CHANNEL_NAME } from './cachePrivate.js';
import { createSharedLibraryCache } from './cacheShared.js';
import { createVariantCache } from './cacheVariants.js';

/**
 * @param {ReturnType<typeof import('./cacheDb.js').openCacheDb> extends Promise<infer D> ? D : never} db
 * @param {{sharedRecordLimit: number, sharedVariantLimit: number, sharedVariantMaxBytes: number}} initialLimits
 * @param {{quotaBackoffMs?: number}} [options]
 */
export function createCacheStore(
  db,
  initialLimits,
  {
    quotaBackoffMs = QUOTA_BACKOFF_MS,
    openChannel = () =>
      typeof BroadcastChannel === 'function'
        ? new BroadcastChannel(PRIVATE_CHANNEL_NAME)
        : null,
  } = {},
) {
  const ctx = createCacheContext(db, initialLimits, {
    quotaBackoffMs,
    openChannel,
  });

  /** Browser-local watermark settings and prepared copies of shared originals. */
  const local = createLocalWatermarkStore(db, () => ctx.limits);
  const variants = createVariantCache(ctx);
  const shared = createSharedLibraryCache(ctx, variants);
  const privateHistory = createPrivateCache(ctx);

  return {
    get durable() {
      return Boolean(db) && db.open !== false;
    },

    local,
    controlPresets: createControlPresetStore(db),
    imageAnnotations: createImageAnnotationStore(db),
    referenceAssets: createReferenceAssetsStore(db, {
      getLimits: () => ctx.limits,
    }),

    setLimits(next) {
      ctx.limits = next;
    },

    ...shared,
    ...variants.api,
    ...privateHistory,
  };
}
