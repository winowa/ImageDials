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
 */
import {
  LIBRARY_DETAIL_USE_INDEX,
  PRIVATE_ADDED_INDEX,
  LIBRARY_SUMMARY_IDENTITY_INDEX,
  STORE,
  VARIANT_USE_INDEX,
} from './cacheDb.js';
import {
  VARIANT_KIND,
  listingForStorage,
  planPrivateAdmission,
  ADMISSION_REFUSAL,
  PRIVATE_KINDS,
  PRIVATE_WATERMARKED_KIND,
  planVariantEviction,
  planLibraryDetailEviction,
  reconcileDeletions,
  VARIANT_KINDS,
  variantId,
} from './cachePolicy.js';
import { imageKey } from './imageRecord.js';
import { createLocalWatermarkStore } from './localWatermarkStore.js';
import { createReferenceAssetsStore } from './referenceAssets.js';
import { createControlPresetStore } from './controlPresetStore.js';
import { createImageAnnotationStore } from './imageAnnotationStore.js';

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
const PRIVATE_STORES = [
  STORE.PRIVATE,
  STORE.PRIVATE_MEDIA,
  STORE.PRIVATE_TOMBSTONES,
  STORE.META,
];
/** Broadcast name tabs use to tell each other the private history changed. */
export const PRIVATE_CHANNEL_NAME = 'imagedials-private-history';
/** Removed private images remembered so a late write cannot bring one back. */
export const PRIVATE_TOMBSTONE_LIMIT = 200;
/** Serialized size (UTF-8 JSON of key and row) the private tombstones may use. */
export const PRIVATE_TOMBSTONE_MAX_BYTES = 32 * 1024;
/** `meta` key of the removal fence that replaces compacted private tombstones. */
export const PRIVATE_REMOVAL_FENCE_KEY = 'privateRemovalFence';
export const PRIVATE_SEQ_KEY = 'privateSeq';
export const PRIVATE_READ_PAGE_LIMIT = 96;
export const PRIVATE_PAGE_METADATA_MAX_BYTES = 1024 * 1024;
export const PRIVATE_SCAN_METADATA_BYTES = 256 * 1024;

function validatePrivateAnchor(anchor) {
  if (
    anchor !== null &&
    (!anchor ||
      !Number.isFinite(anchor.addedAt) ||
      typeof anchor.key !== 'string' ||
      !anchor.key.length)
  )
    throw new TypeError(
      'Private anchor must contain addedAt and a nonempty key.',
    );
}

/** Why a write did not persist. */
export const WRITE_SKIPPED = Object.freeze({
  NO_STORAGE: 'no-storage',
  OVERSIZE: 'oversize',
  /** The private history already holds its record limit. */
  RECORD_LIMIT: ADMISSION_REFUSAL.RECORD_LIMIT,
  /** The private history has no byte budget left for this original. */
  BYTE_LIMIT: ADMISSION_REFUSAL.BYTE_LIMIT,
  PINNED: 'pinned',
  DELETED: 'deleted',
  /**
   * The add is at or below the private removal fence and is not the stored
   * row's add: it may have been removed, so it is never stored.
   */
  FENCED: 'removal-fenced',
  NOT_LISTED: 'not-listed',
  ORIGINAL_MISSING: 'original-missing',
  CHANGED: 'changed',
  STALE: 'stale',
  QUOTA: 'quota',
  QUOTA_BACKOFF: 'quota-backoff',
  FAILED: 'failed',
});

/** How long cache writes stay paused after a second quota failure. */
export const QUOTA_BACKOFF_MS = 60_000;
/** Share of the stored variants kept after a quota failure frees room for a retry. */
export const QUOTA_RETRY_BUDGET_RATIO = 0.5;
/** Recent-use updates are batched this long into one transaction. */
export const TOUCH_FLUSH_MS = 1000;

const isQuota = (error) => error?.name === 'QuotaExceededError';
const skipped = (reason) => ({ persisted: false, reason });
const ACTIVE_LIBRARY_PAGE_KEY = 'active-library-window';

function encodedBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

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
  let limits = initialLimits;
  /** In-tab guards: they hold even when a transaction fails or there is no db. */
  const memory = {
    epoch: 0,
    tombstones: new Map(),
    pausedUntil: 0,
    /** imageKey -> addedAt of each private removal still awaiting its commit. */
    privateRemoving: new Map(),
    /**
     * Without a database only: imageKey -> addedAt of confirmed removals, the
     * oldest released beyond `PRIVATE_TOMBSTONE_LIMIT`. With a database the
     * committed tombstone or fence protects a removal and nothing is kept.
     */
    privateRemoved: new Map(),
    touched: new Set(),
    touchTimer: null,
    /** Lazily opened channel to other tabs, and this tab's listeners. */
    channel: null,
    channelOpened: false,
    listeners: new Set(),
  };

  const readSeq = async (access) => (await access.get(STORE.META, 'seq')) ?? 0;
  const readPrivateSeq = async (access) =>
    (await access.get(STORE.META, PRIVATE_SEQ_KEY)) ?? 0;
  const bumpPrivateSeq = async (access) => {
    const seq = (await readPrivateSeq(access)) + 1;
    await access.put(STORE.META, PRIVATE_SEQ_KEY, seq);
    return seq;
  };
  const bump = async (access) => {
    const seq = (await readSeq(access)) + 1;
    await access.put(STORE.META, 'seq', seq);
    return seq;
  };

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
      if (isQuota(error)) memory.pausedUntil = Date.now() + quotaBackoffMs;
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

  // --- Private history helpers ---------------------------------------------

  const privateChannel = () => {
    if (!memory.channelOpened) {
      memory.channelOpened = true;
      try {
        memory.channel = openChannel();
      } catch {
        memory.channel = null;
      }
      if (memory.channel)
        memory.channel.onmessage = () => {
          for (const listener of memory.listeners) listener();
        };
    }
    return memory.channel;
  };

  /** Tell other tabs a private commit happened; a failed post is harmless. */
  const announcePrivateChange = () => {
    try {
      privateChannel()?.postMessage({ type: 'changed' });
    } catch {
      // Tabs also re-read when they become visible.
    }
  };

  /**
   * Stored private bytes. The counter is rebuilt once, by a cursor over the
   * media rows, when it is absent (a database from before the counter); after
   * that every writer maintains it in its own transaction.
   */
  async function privateBytes(access) {
    const counted = await access.get(STORE.META, 'privateBytes');
    if (Number.isSafeInteger(counted) && counted >= 0) return counted;
    let sum = 0;
    await access.scan(STORE.PRIVATE_MEDIA, null, (row) => {
      sum += row.bytes;
    });
    await access.put(STORE.META, 'privateBytes', sum);
    return sum;
  }

  const adjustPrivateBytes = async (access, delta) => {
    if (!delta) return;
    const bytes = await privateBytes(access);
    await access.put(STORE.META, 'privateBytes', Math.max(0, bytes + delta));
  };

  /** Remove an entry and EVERY kind of its media, derivatives included. */
  async function dropPrivate(access, key) {
    let freed = 0;
    await access.delete(STORE.PRIVATE, key);
    for (const kind of PRIVATE_KINDS) {
      const id = variantId(key, kind);
      const row = await access.get(STORE.PRIVATE_MEDIA, id);
      if (!row) continue;
      await access.delete(STORE.PRIVATE_MEDIA, id);
      freed += row.bytes;
    }
    await adjustPrivateBytes(access, -freed);
  }

  /** One stored entry with its media, in the shape `loadPrivate` returns. */
  async function readEntry(access, key, row) {
    const media = {};
    for (const kind of PRIVATE_KINDS)
      media[kind] =
        (await access.get(STORE.PRIVATE_MEDIA, variantId(key, kind)))?.blob ??
        null;
    // A prepared file that is recorded but missing counts as not made.
    const watermark = row.watermark
      ? {
          ...row.watermark,
          prepared: media[PRIVATE_WATERMARKED_KIND]
            ? (row.watermark.prepared ?? null)
            : null,
        }
      : null;
    return {
      record: row.record,
      origin: row.origin,
      addedAt: row.addedAt,
      full: media[VARIANT_KIND.FULL],
      thumbnail: media[VARIANT_KIND.THUMBNAIL],
      watermark,
      preparedBytes: media[PRIVATE_WATERMARKED_KIND]?.size ?? 0,
    };
  }

  async function privateMetadata(access, key, row) {
    return {
      key,
      addedAt: row.addedAt,
      origin: row.origin,
      record: row.record,
      watermark: row.watermark ?? null,
      hasFull: await access.has(
        STORE.PRIVATE_MEDIA,
        variantId(key, VARIANT_KIND.FULL),
      ),
      hasThumbnail: await access.has(
        STORE.PRIVATE_MEDIA,
        variantId(key, VARIANT_KIND.THUMBNAIL),
      ),
      hasPrepared: await access.has(
        STORE.PRIVATE_MEDIA,
        variantId(key, PRIVATE_WATERMARKED_KIND),
      ),
    };
  }

  /**
   * Plan the oldest rebuildable prepared PNGs to give up so `incoming` bytes
   * fit. Returns null if even all of them would not make room, so nothing is
   * removed for a write that is refused anyway.
   */
  async function planPreparedRelease(access, deficit) {
    const prepared = [];
    const suffix = `|${PRIVATE_WATERMARKED_KIND}`;
    await access.scan(STORE.PRIVATE_MEDIA, null, (row, id) => {
      if (id.endsWith(suffix))
        prepared.push({
          id,
          key: row.key,
          bytes: row.bytes,
          addedAt: row.addedAt,
        });
    });
    prepared.sort(
      (a, b) =>
        a.addedAt - b.addedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    const release = [];
    let freed = 0;
    for (const entry of prepared) {
      if (freed >= deficit) break;
      release.push(entry);
      freed += entry.bytes;
    }
    return freed >= deficit ? release : null;
  }

  /** Why a write for the add `addedAt` of `key` must not happen, or null. */
  async function privateWriteBlock(access, key, addedAt) {
    const tombstone = await access.get(STORE.PRIVATE_TOMBSTONES, key);
    if (tombstone && addedAt <= tombstone.addedAt) return WRITE_SKIPPED.DELETED;
    const row = await access.get(STORE.PRIVATE, key);
    if (!row || row.addedAt !== addedAt) return WRITE_SKIPPED.NOT_LISTED;
    return null;
  }

  /**
   * The removal fence, inferred once when absent: a database written before
   * the fence kept at most `PRIVATE_TOMBSTONE_LIMIT` tombstones by dropping the
   * oldest, so its newest remaining tombstone is at or above every one it
   * dropped. Removals it forgot in any other way cannot be recovered.
   * @returns {Promise<number|null>} null when nothing is fenced
   */
  async function removalFence(access) {
    const stored = await access.get(STORE.META, PRIVATE_REMOVAL_FENCE_KEY);
    if (stored && 'addedAt' in stored) return stored.addedAt;
    let inferred = null;
    await access.scan(STORE.PRIVATE_TOMBSTONES, null, (row) => {
      inferred = Math.max(inferred ?? row.addedAt, row.addedAt);
    });
    await access.put(STORE.META, PRIVATE_REMOVAL_FENCE_KEY, {
      addedAt: inferred,
    });
    return inferred;
  }

  const isFenced = (fence, addedAt) => fence !== null && addedAt <= fence;

  /**
   * Keep the private tombstones within their ceilings, inside the removal's
   * transaction: drop those the fence covers, then move the oldest into the
   * fence until both ceilings hold.
   */
  async function compactPrivateTombstones(access, fence) {
    const rows = [];
    await access.scan(STORE.PRIVATE_TOMBSTONES, null, (row, key) => {
      rows.push({
        key,
        addedAt: row.addedAt,
        bytes: encodedBytes(key) + encodedBytes(row),
      });
    });
    rows.sort(
      (a, b) =>
        a.addedAt - b.addedAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    );
    let count = rows.length;
    let bytes = rows.reduce((sum, row) => sum + row.bytes, 0);
    let next = fence;
    for (const row of rows) {
      const over =
        count > PRIVATE_TOMBSTONE_LIMIT || bytes > PRIVATE_TOMBSTONE_MAX_BYTES;
      if (!over && !isFenced(next, row.addedAt)) break;
      if (!isFenced(next, row.addedAt)) next = row.addedAt;
      await access.delete(STORE.PRIVATE_TOMBSTONES, row.key);
      count -= 1;
      bytes -= row.bytes;
    }
    if (next !== fence)
      await access.put(STORE.META, PRIVATE_REMOVAL_FENCE_KEY, {
        addedAt: next,
      });
  }

  /** Newest removed add of `key` this tab still guards, or -Infinity. */
  const removedThrough = (key) =>
    Math.max(
      ...(memory.privateRemoving.get(key) ?? []),
      memory.privateRemoved.get(key) ?? -Infinity,
    );
  const isRemovedPrivate = (key, addedAt) => addedAt <= removedThrough(key);

  /** Withdraw one pending removal, whether it committed or failed. */
  function settleRemoval(key, addedAt) {
    const pending = memory.privateRemoving.get(key) ?? [];
    pending.splice(pending.indexOf(addedAt), 1);
    if (!pending.length) memory.privateRemoving.delete(key);
  }

  /** Without a database, keep a bounded record of confirmed removals. */
  function rememberRemovalWithoutStorage(key, addedAt) {
    memory.privateRemoved.delete(key);
    memory.privateRemoved.set(key, addedAt);
    for (const oldest of memory.privateRemoved.keys()) {
      if (memory.privateRemoved.size <= PRIVATE_TOMBSTONE_LIMIT) break;
      memory.privateRemoved.delete(oldest);
    }
  }

  /** Recoverable shared variants are the first thing given up for private bytes. */
  const freeSharedVariants = () =>
    db.run(
      [STORE.VARIANTS, STORE.META, STORE.SHARED_PREPARED],
      'readwrite',
      async (access) => {
        const ids = [];
        await access.scan(STORE.VARIANTS, null, (_row, id) => ids.push(id));
        for (const id of ids) await access.delete(STORE.VARIANTS, id);
        await access.put(STORE.META, 'variantBytes', 0);
        // Prepared watermark copies of shared originals are rebuildable too.
        const prepared = [];
        await access.scan(STORE.SHARED_PREPARED, null, (_row, id) =>
          prepared.push(id),
        );
        for (const id of prepared)
          await access.delete(STORE.SHARED_PREPARED, id);
      },
    );

  /**
   * A private write that hit the quota frees the shared variants and retries
   * once. A transaction that aborts keeps every earlier private copy, and
   * nothing here ever prunes private history to make room.
   */
  async function withPrivateQuotaRetry(write) {
    try {
      return await write();
    } catch (error) {
      if (!isQuota(error)) return skipped(WRITE_SKIPPED.FAILED);
    }
    try {
      await freeSharedVariants();
      return await write();
    } catch (error) {
      return skipped(
        isQuota(error) ? WRITE_SKIPPED.QUOTA : WRITE_SKIPPED.FAILED,
      );
    }
  }

  /** Browser-local watermark settings and prepared copies of shared originals. */
  const local = createLocalWatermarkStore(db, () => limits);

  return {
    get durable() {
      return Boolean(db) && db.open !== false;
    },

    local,
    controlPresets: createControlPresetStore(db),
    imageAnnotations: createImageAnnotationStore(db),
    referenceAssets: createReferenceAssetsStore(db, {
      getLimits: () => limits,
    }),

    setLimits(next) {
      limits = next;
    },

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
          Math.min(3, limits.sharedPageManifestLimit ?? 3) ||
        summaryCount > limits.sharedRecordLimit ||
        pageBytes > limits.sharedPageMaxBytes
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
        libraryDetailLimit: limits.sharedDetailRecordLimit,
        libraryDetailMaxBytes: limits.sharedDetailMaxBytes,
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
                limits.sharedRecordLimit,
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
      if (blob.size > limits.sharedVariantMaxBytes)
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
                count + 1 > limits.sharedVariantLimit ||
                bytes + blob.size > limits.sharedVariantMaxBytes
              ) {
                // Walk the recency index and stop as soon as this write fits,
                // so a full cache does not visit every variant per thumbnail.
                const victims = [];
                let remaining = count;
                let remainingBytes = bytes;
                const fits = () =>
                  remaining + 1 <= limits.sharedVariantLimit &&
                  remainingBytes + blob.size <= limits.sharedVariantMaxBytes;
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

    // --- Private browser history ------------------------------------------------

    async privateCount() {
      if (!db) return { count: 0, seq: 0 };
      return db.run(PRIVATE_STORES, 'readonly', async (access) => ({
        count: await access.count(STORE.PRIVATE),
        seq: await readPrivateSeq(access),
      }));
    },

    async readPrivateDetail(key) {
      if (!db) return null;
      return db.run(PRIVATE_STORES, 'readonly', async (access) => {
        const row = await access.get(STORE.PRIVATE, key);
        return !row || isRemovedPrivate(key, row.addedAt)
          ? null
          : privateMetadata(access, key, row);
      });
    },

    async readPrivatePage({
      edge = 'newest',
      anchor = null,
      direction = 'older',
      limit = 40,
    } = {}) {
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > PRIVATE_READ_PAGE_LIMIT
      )
        throw new RangeError(
          `Private page limit must be between 1 and ${PRIVATE_READ_PAGE_LIMIT}.`,
        );
      if (direction !== 'older' && direction !== 'newer')
        throw new TypeError('Private page direction must be older or newer.');
      if (edge !== 'newest' && edge !== 'oldest')
        throw new TypeError('Invalid private page edge.');
      validatePrivateAnchor(anchor);
      if (!db) return { rows: [], next: null, previous: null, seq: 0 };
      return db.run(PRIVATE_STORES, 'readonly', async (access) => {
        const seq = await readPrivateSeq(access);
        const effectiveDirection = anchor
          ? direction
          : edge === 'oldest'
            ? 'newer'
            : 'older';
        const cursorDirection =
          effectiveDirection === 'older' ? 'prev' : 'next';
        const rows = [];
        let bytes = 0;
        let oversized = false;
        let hasRequestedNeighbor = false;
        await access.scanKeyset(
          STORE.PRIVATE,
          PRIVATE_ADDED_INDEX,
          anchor,
          cursorDirection,
          async (row, key) => {
            if (isRemovedPrivate(key, row.addedAt)) return true;
            const metadataBytes = encodedBytes({ key, ...row });
            if (
              rows.length >= limit ||
              (rows.length &&
                bytes + metadataBytes > PRIVATE_PAGE_METADATA_MAX_BYTES)
            ) {
              hasRequestedNeighbor = true;
              return false;
            }
            // One oversized record remains reachable without retaining a page
            // of oversized snapshots. The flag lets consumers handle it explicitly.
            oversized = metadataBytes > PRIVATE_PAGE_METADATA_MAX_BYTES;
            rows.push(await privateMetadata(access, key, row));
            bytes += metadataBytes;
            return true;
          },
        );
        if (effectiveDirection === 'newer') rows.reverse();
        const first = rows[0];
        const last = rows.at(-1);
        const exists = async (from, dir) => {
          if (!from) return false;
          let foundOne = false;
          await access.scanKeyset(
            STORE.PRIVATE,
            PRIVATE_ADDED_INDEX,
            from,
            dir,
            (row, key) => {
              if (!isRemovedPrivate(key, row.addedAt)) {
                foundOne = true;
                return false;
              }
              return true;
            },
          );
          return foundOne;
        };
        const older =
          hasRequestedNeighbor && effectiveDirection === 'older'
            ? true
            : await exists(
                last && { addedAt: last.addedAt, key: last.key },
                'prev',
              );
        const newer =
          hasRequestedNeighbor && effectiveDirection === 'newer'
            ? true
            : await exists(
                first && { addedAt: first.addedAt, key: first.key },
                'next',
              );
        return {
          rows,
          next: older && last ? { addedAt: last.addedAt, key: last.key } : null,
          previous:
            newer && first ? { addedAt: first.addedAt, key: first.key } : null,
          seq,
          oversized,
        };
      });
    },

    async readPrivateAround(identity, { before = 1, after = 1 } = {}) {
      validatePrivateAnchor(identity);
      if (!identity) throw new TypeError('Private identity is required.');
      if (
        !Number.isInteger(before) ||
        before < 0 ||
        !Number.isInteger(after) ||
        after < 0 ||
        before + after + 1 > PRIVATE_READ_PAGE_LIMIT
      )
        throw new RangeError('Private around limits are invalid.');
      if (!db) return { missing: true, rows: [], seq: 0 };
      return db.run(PRIVATE_STORES, 'readonly', async (access) => {
        const seq = await readPrivateSeq(access);
        const stored = await access.get(STORE.PRIVATE, identity.key);
        if (
          !stored ||
          stored.addedAt !== identity.addedAt ||
          isRemovedPrivate(identity.key, stored.addedAt)
        )
          return { missing: true, rows: [], seq };
        const detail = await privateMetadata(access, identity.key, stored);
        let bytes = encodedBytes({ key: identity.key, ...stored });
        const oversized = bytes > PRIVATE_PAGE_METADATA_MAX_BYTES;
        const neighbors = async (direction, count) => {
          const rows = [];
          if (!count || oversized) return rows;
          await access.scanKeyset(
            STORE.PRIVATE,
            PRIVATE_ADDED_INDEX,
            identity,
            direction,
            async (row, key) => {
              if (isRemovedPrivate(key, row.addedAt)) return true;
              const size = encodedBytes({ key, ...row });
              if (bytes + size > PRIVATE_PAGE_METADATA_MAX_BYTES) return false;
              bytes += size;
              rows.push(await privateMetadata(access, key, row));
              return rows.length < count;
            },
          );
          return rows;
        };
        const newer = await neighbors('next', before);
        const older = await neighbors('prev', after);
        return {
          missing: false,
          rows: [...newer.reverse(), detail, ...older],
          seq,
          oversized,
        };
      });
    },

    async scanPrivateSlice({
      anchor = null,
      direction = 'older',
      maxRows = PRIVATE_READ_PAGE_LIMIT,
      maxBytes = PRIVATE_SCAN_METADATA_BYTES,
    } = {}) {
      if (
        !Number.isInteger(maxRows) ||
        maxRows < 1 ||
        maxRows > PRIVATE_READ_PAGE_LIMIT ||
        !Number.isSafeInteger(maxBytes) ||
        maxBytes < 1 ||
        maxBytes > PRIVATE_PAGE_METADATA_MAX_BYTES
      )
        throw new RangeError('Private scan bounds are invalid.');
      if (direction !== 'older' && direction !== 'newer')
        throw new TypeError('Private scan direction must be older or newer.');
      validatePrivateAnchor(anchor);
      if (!db)
        return {
          rows: [],
          cursor: anchor,
          scanned: 0,
          done: true,
          oversized: false,
          seq: 0,
        };
      return db.run(PRIVATE_STORES, 'readonly', async (access) => {
        const seq = await readPrivateSeq(access);
        const rows = [];
        let bytes = 0,
          scanned = 0,
          oversized = false,
          cursor = anchor;
        let hasMore = false;
        await access.scanKeyset(
          STORE.PRIVATE,
          PRIVATE_ADDED_INDEX,
          anchor,
          direction === 'older' ? 'prev' : 'next',
          async (row, key) => {
            scanned++;
            const candidate = { addedAt: row.addedAt, key };
            if (isRemovedPrivate(key, row.addedAt)) {
              cursor = candidate;
              if (scanned >= maxRows + 1) {
                hasMore = true;
                return false;
              }
              return true;
            }
            const size = encodedBytes({ key, ...row });
            if (
              rows.length >= maxRows ||
              (rows.length && bytes + size > maxBytes)
            ) {
              hasMore = true;
              return false;
            }
            if (size > maxBytes) oversized = true;
            rows.push(await privateMetadata(access, key, row));
            cursor = candidate;
            bytes += size;
            return true;
          },
        );
        return {
          rows,
          cursor,
          scanned,
          done: !hasMore,
          oversized,
          seq,
        };
      });
    },

    /**
     * Every stored private entry, newest first, with its bytes. Rejects when
     * the database cannot be read so the caller can say so.
     * @returns {Promise<{record: object, origin: string, addedAt: number,
     *   full: Blob|null, thumbnail: Blob|null, watermark: object|null,
     *   preparedBytes: number}[]>}
     */
    async loadPrivate() {
      if (!db) return [];
      return db.run(PRIVATE_STORES, 'readonly', async (access) => {
        const rows = [];
        await access.scan(STORE.PRIVATE, null, (row, key) => {
          rows.push({ key, row });
        });
        const entries = [];
        for (const { key, row } of rows) {
          if (isRemovedPrivate(key, row.addedAt)) continue;
          entries.push(await readEntry(access, key, row));
        }
        return entries.sort((a, b) => b.addedAt - a.addedAt);
      });
    },

    /** One stored entry, or null; rejects when the database cannot be read. */
    async readPrivate(key) {
      if (!db) return null;
      return db.run(PRIVATE_STORES, 'readonly', async (access) => {
        const row = await access.get(STORE.PRIVATE, key);
        if (!row || isRemovedPrivate(key, row.addedAt)) return null;
        return readEntry(access, key, row);
      });
    },

    /** Stored private record count and bytes (the transactional counter). */
    async privateUsage() {
      if (!db) return { count: 0, bytes: 0 };
      return db.run(PRIVATE_STORES, 'readwrite', async (access) => ({
        count: await access.count(STORE.PRIVATE),
        bytes: await privateBytes(access),
      }));
    },

    /**
     * Admit one private image in ONE transaction: its row and, when given, its
     * original and thumbnail. Nothing older is ever pruned.
     *
     * - A removed add (tombstone) is refused as `deleted`; an add at or below
     *   the removal fence that is not the stored row's add as `removal-fenced`.
     *   Neither is ever retimed: only a deliberate new add gets a new addedAt.
     * - A row already stored for the key by ANOTHER add is not touched; the
     *   caller adopts it: `{persisted: true, duplicate: true, addedAt, origin}`.
     * - The record and byte budgets are checked against the stored count and
     *   the byte counter. A byte refusal first releases the oldest prepared
     *   watermark PNGs, but only if that makes the write fit; the released keys
     *   are reported in `preparedReleased`.
     * - Repeating the same add is idempotent and may attach bytes to its row.
     *
     * Never throws.
     * @returns {Promise<{persisted: boolean, duplicate?: boolean,
     *   addedAt?: number, origin?: string, preparedReleased?: string[],
     *   reason?: string}>}
     */
    async admitPrivate({
      record,
      origin,
      addedAt,
      full = null,
      thumbnail = null,
    }) {
      const key = imageKey(record);
      if (isRemovedPrivate(key, addedAt)) return skipped(WRITE_SKIPPED.DELETED);
      if (!db) return skipped(WRITE_SKIPPED.NO_STORAGE);
      if ((full?.size ?? 0) + (thumbnail?.size ?? 0) > limits.privateMaxBytes)
        return skipped(WRITE_SKIPPED.OVERSIZE);
      const outcome = await withPrivateQuotaRetry(() =>
        db.run(PRIVATE_STORES, 'readwrite', async (access) => {
          const tombstone = await access.get(STORE.PRIVATE_TOMBSTONES, key);
          if (tombstone && addedAt <= tombstone.addedAt)
            return skipped(WRITE_SKIPPED.DELETED);
          const existing = await access.get(STORE.PRIVATE, key);
          const ownRow = existing?.addedAt === addedAt;
          if (!ownRow && isFenced(await removalFence(access), addedAt))
            return skipped(WRITE_SKIPPED.FENCED);
          if (existing && !ownRow)
            return {
              persisted: true,
              duplicate: true,
              addedAt: existing.addedAt,
              origin: existing.origin,
            };

          const replaced = {};
          let replacedBytes = 0;
          for (const kind of VARIANT_KINDS) {
            const row = await access.get(
              STORE.PRIVATE_MEDIA,
              variantId(key, kind),
            );
            replaced[kind] = row;
            replacedBytes += row?.bytes ?? 0;
          }
          const incomingBytes = (full?.size ?? 0) + (thumbnail?.size ?? 0);
          const stored = {
            count: await access.count(STORE.PRIVATE),
            bytes: (await privateBytes(access)) - replacedBytes,
          };
          const incoming = { newRecord: !existing, bytes: incomingBytes };
          let plan = planPrivateAdmission(stored, incoming, limits);
          const released = [];
          if (!plan.admit && plan.reason === ADMISSION_REFUSAL.BYTE_LIMIT) {
            const deficit =
              stored.bytes + incomingBytes - limits.privateMaxBytes;
            const release = await planPreparedRelease(access, deficit);
            const countOk =
              !incoming.newRecord ||
              stored.count + 1 <= limits.privateRecordLimit;
            if (release && countOk) {
              for (const entry of release) {
                await access.delete(STORE.PRIVATE_MEDIA, entry.id);
                const owner = await access.get(STORE.PRIVATE, entry.key);
                if (owner?.watermark)
                  await access.put(STORE.PRIVATE, entry.key, {
                    ...owner,
                    watermark: { ...owner.watermark, prepared: null },
                  });
                stored.bytes -= entry.bytes;
                released.push(entry.key);
              }
              await access.put(
                STORE.META,
                'privateBytes',
                stored.bytes + replacedBytes,
              );
              plan = { admit: true };
            }
          }
          if (!plan.admit) return skipped(plan.reason);

          // The tombstone stays: it still refuses the removed, older add.
          if (!existing)
            await access.put(STORE.PRIVATE, key, { record, origin, addedAt });
          const blobs = { [VARIANT_KIND.FULL]: full };
          if (thumbnail) blobs[VARIANT_KIND.THUMBNAIL] = thumbnail;
          if (full)
            for (const kind of VARIANT_KINDS) {
              const id = variantId(key, kind);
              if (blobs[kind])
                await access.put(STORE.PRIVATE_MEDIA, id, {
                  key,
                  blob: blobs[kind],
                  bytes: blobs[kind].size,
                  addedAt,
                });
              else await access.delete(STORE.PRIVATE_MEDIA, id);
            }
          await adjustPrivateBytes(
            access,
            full ? incomingBytes - replacedBytes : 0,
          );
          await bumpPrivateSeq(access);
          return {
            persisted: true,
            duplicate: false,
            preparedReleased: released,
          };
        }),
      );
      if (outcome.persisted && !outcome.duplicate) announcePrivateChange();
      return outcome;
    },

    /**
     * Record the watermark analysis of a private entry (outside its wire
     * record). A new analysis makes any prepared file stale, so that file is
     * removed in the same transaction. Refused when the entry was removed,
     * pruned or replaced since `addedAt`.
     * @returns {Promise<{persisted: boolean, reason?: string}>}
     */
    async savePrivateWatermark(key, { addedAt }, state) {
      if (isRemovedPrivate(key, addedAt)) return skipped(WRITE_SKIPPED.DELETED);
      if (!db) return skipped(WRITE_SKIPPED.NO_STORAGE);
      const outcome = await withPrivateQuotaRetry(() =>
        db.run(PRIVATE_STORES, 'readwrite', async (access) => {
          const blocked = await privateWriteBlock(access, key, addedAt);
          if (blocked) return skipped(blocked);
          const row = await access.get(STORE.PRIVATE, key);
          await access.put(STORE.PRIVATE, key, {
            ...row,
            watermark: { ...state, prepared: null },
          });
          const preparedId = variantId(key, PRIVATE_WATERMARKED_KIND);
          const stale = await access.get(STORE.PRIVATE_MEDIA, preparedId);
          if (stale) {
            await access.delete(STORE.PRIVATE_MEDIA, preparedId);
            await adjustPrivateBytes(access, -stale.bytes);
          }
          await bumpPrivateSeq(access);
          return { persisted: true };
        }),
      );
      if (outcome.persisted) announcePrivateChange();
      return outcome;
    },

    /**
     * Store the one prepared PNG of a private entry together with the state
     * that describes it. The entry's other copies are never pruned for it: if
     * the PNG does not fit beside everything else the write is refused
     * (`oversize`). Refused as `changed` when the stored analysis is no longer
     * the one the PNG was made from.
     * @returns {Promise<{persisted: boolean, reason?: string}>}
     */
    async savePrivatePrepared(key, { addedAt }, state, blob) {
      if (isRemovedPrivate(key, addedAt)) return skipped(WRITE_SKIPPED.DELETED);
      if (!db) return skipped(WRITE_SKIPPED.NO_STORAGE);
      if (blob.size > limits.privateMaxBytes)
        return skipped(WRITE_SKIPPED.OVERSIZE);
      const id = variantId(key, PRIVATE_WATERMARKED_KIND);
      const outcome = await withPrivateQuotaRetry(() =>
        db.run(PRIVATE_STORES, 'readwrite', async (access) => {
          const blocked = await privateWriteBlock(access, key, addedAt);
          if (blocked) return skipped(blocked);
          const row = await access.get(STORE.PRIVATE, key);
          if (
            row.watermark?.analysis?.print_watermark_key !==
            state.analysis.print_watermark_key
          )
            return skipped(WRITE_SKIPPED.CHANGED);
          const previous =
            (await access.get(STORE.PRIVATE_MEDIA, id))?.bytes ?? 0;
          const total = await privateBytes(access);
          if (total - previous + blob.size > limits.privateMaxBytes)
            return skipped(WRITE_SKIPPED.OVERSIZE);
          await access.put(STORE.PRIVATE_MEDIA, id, {
            key,
            blob,
            bytes: blob.size,
            addedAt,
          });
          await adjustPrivateBytes(access, blob.size - previous);
          await access.put(STORE.PRIVATE, key, { ...row, watermark: state });
          await bumpPrivateSeq(access);
          return { persisted: true };
        }),
      );
      if (outcome.persisted) announcePrivateChange();
      return outcome;
    },

    /**
     * Replace only a rebuildable thumbnail of the exact stored add. Never
     * admits a record, touches its original, or evicts another private copy.
     * Decode happens outside the transaction; the original and incarnation
     * must still exist when the derived bytes commit.
     */
    async savePrivateThumbnail(key, { addedAt }, blob) {
      if (isRemovedPrivate(key, addedAt)) return skipped(WRITE_SKIPPED.DELETED);
      if (!db) return skipped(WRITE_SKIPPED.NO_STORAGE);
      if (!(blob?.size > 0)) return skipped(WRITE_SKIPPED.FAILED);
      if (blob.size > limits.privateMaxBytes)
        return skipped(WRITE_SKIPPED.OVERSIZE);
      const id = variantId(key, VARIANT_KIND.THUMBNAIL);
      const outcome = await withPrivateQuotaRetry(() =>
        db.run(PRIVATE_STORES, 'readwrite', async (access) => {
          const blocked = await privateWriteBlock(access, key, addedAt);
          if (blocked) return skipped(blocked);
          if (
            !(await access.has(
              STORE.PRIVATE_MEDIA,
              variantId(key, VARIANT_KIND.FULL),
            ))
          )
            return skipped(WRITE_SKIPPED.ORIGINAL_MISSING);
          const previous =
            (await access.get(STORE.PRIVATE_MEDIA, id))?.bytes ?? 0;
          const total = await privateBytes(access);
          if (total - previous + blob.size > limits.privateMaxBytes)
            return skipped(WRITE_SKIPPED.OVERSIZE);
          await access.put(STORE.PRIVATE_MEDIA, id, {
            key,
            blob,
            bytes: blob.size,
            addedAt,
          });
          await adjustPrivateBytes(access, blob.size - previous);
          await bumpPrivateSeq(access);
          return { persisted: true };
        }),
      );
      if (outcome.persisted) announcePrivateChange();
      return outcome;
    },

    /**
     * One stored medium of a private entry (`full`, `thumbnail`,
     * `watermarked`), only while the add `addedAt` is still the stored one.
     * @returns {Promise<Blob|null>} null when absent; rejects if unreadable
     */
    async readPrivateMedia(key, { addedAt }, kind) {
      if (!db || isRemovedPrivate(key, addedAt)) return null;
      return db.run(PRIVATE_STORES, 'readonly', async (access) => {
        const row = await access.get(STORE.PRIVATE, key);
        if (!row || row.addedAt !== addedAt) return null;
        return (
          (await access.get(STORE.PRIVATE_MEDIA, variantId(key, kind)))?.blob ??
          null
        );
      });
    },

    /**
     * Remove a private entry from this browser only. The in-tab guard is set
     * before anything is awaited and withdrawn once the transaction settles:
     * after a commit the stored tombstone (or fence) protects the removal in
     * every tab; after a failure the entry is the only copy and must stay, so
     * the failure is returned. Tombstone compaction and any fence advance
     * commit or roll back with the removal itself.
     * @param {string} key
     * @param {number} [addedAt] the add being removed (it may not be stored yet)
     * @param {{requireIncarnation?: boolean}} [options] refuse a changed stored add
     * @returns {Promise<{removed: boolean, error?: Error, reason?: string}>}
     */
    async removePrivate(key, addedAt = 0, { requireIncarnation = false } = {}) {
      const pending = memory.privateRemoving.get(key) ?? [];
      pending.push(addedAt);
      memory.privateRemoving.set(key, pending);
      if (!db) {
        settleRemoval(key, addedAt);
        if (requireIncarnation)
          return { removed: false, reason: WRITE_SKIPPED.NO_STORAGE };
        rememberRemovalWithoutStorage(
          key,
          Math.max(addedAt, memory.privateRemoved.get(key) ?? addedAt),
        );
        return { removed: true };
      }
      try {
        const removed = await db.run(
          PRIVATE_STORES,
          'readwrite',
          async (access) => {
            const row = await access.get(STORE.PRIVATE, key);
            if (requireIncarnation && row?.addedAt !== addedAt) return false;
            const fence = await removalFence(access);
            const previous = await access.get(STORE.PRIVATE_TOMBSTONES, key);
            await access.put(STORE.PRIVATE_TOMBSTONES, key, {
              addedAt: Math.max(
                addedAt,
                row?.addedAt ?? addedAt,
                previous?.addedAt ?? addedAt,
              ),
            });
            await dropPrivate(access, key);
            await compactPrivateTombstones(access, fence);
            await bumpPrivateSeq(access);
            return true;
          },
        );
        if (!removed) {
          settleRemoval(key, addedAt);
          return { removed: false, reason: WRITE_SKIPPED.CHANGED };
        }
      } catch (error) {
        settleRemoval(key, addedAt);
        return { removed: false, error };
      }
      settleRemoval(key, addedAt);
      announcePrivateChange();
      return { removed: true };
    },

    /**
     * Be told when another tab commits or removes a private image. Returns the
     * unsubscribe function. Without BroadcastChannel nothing is ever delivered
     * (tabs then re-read when they become visible).
     */
    onPrivateChange(listener) {
      memory.listeners.add(listener);
      privateChannel();
      return () => {
        memory.listeners.delete(listener);
        if (!memory.listeners.size && memory.channel) {
          memory.channel.close();
          memory.channel = null;
          memory.channelOpened = false;
        }
      };
    },

    touch,

    /** Write pending recency updates now (page hide, tests). */
    flushTouches,
  };
}
