/**
 * The browser-private history: images generated while the shared library is
 * off, and imported images, with their media, tombstones and removal fence.
 * Every admission, write and removal is one transaction in the private
 * stores; other tabs are told through a broadcast channel.
 */
import { PRIVATE_ADDED_INDEX, STORE } from './cacheDb.js';
import {
  ADMISSION_REFUSAL,
  PRIVATE_KINDS,
  PRIVATE_WATERMARKED_KIND,
  VARIANT_KIND,
  VARIANT_KINDS,
  planPrivateAdmission,
  variantId,
} from './cachePolicy.js';
import { imageKey } from '../records/imageRecord.js';
import {
  WRITE_SKIPPED,
  encodedBytes,
  isQuota,
  skipped,
} from './cacheKernel.js';

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

/** @param {ReturnType<typeof import('./cacheKernel.js').createCacheContext>} ctx */
export function createPrivateCache(ctx) {
  const { db, memory } = ctx;

  const readPrivateSeq = async (access) =>
    (await access.get(STORE.META, PRIVATE_SEQ_KEY)) ?? 0;
  const bumpPrivateSeq = async (access) => {
    const seq = (await readPrivateSeq(access)) + 1;
    await access.put(STORE.META, PRIVATE_SEQ_KEY, seq);
    return seq;
  };

  // --- Private history helpers ---------------------------------------------

  const privateChannel = () => {
    if (!memory.channelOpened) {
      memory.channelOpened = true;
      try {
        memory.channel = ctx.openChannel();
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

  return {
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
        throw new RangeError('Private around ctx.limits are invalid.');
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
      if (
        (full?.size ?? 0) + (thumbnail?.size ?? 0) >
        ctx.limits.privateMaxBytes
      )
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
          let plan = planPrivateAdmission(stored, incoming, ctx.limits);
          const released = [];
          if (!plan.admit && plan.reason === ADMISSION_REFUSAL.BYTE_LIMIT) {
            const deficit =
              stored.bytes + incomingBytes - ctx.limits.privateMaxBytes;
            const release = await planPreparedRelease(access, deficit);
            const countOk =
              !incoming.newRecord ||
              stored.count + 1 <= ctx.limits.privateRecordLimit;
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
      if (blob.size > ctx.limits.privateMaxBytes)
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
          if (total - previous + blob.size > ctx.limits.privateMaxBytes)
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
      if (blob.size > ctx.limits.privateMaxBytes)
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
          if (total - previous + blob.size > ctx.limits.privateMaxBytes)
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
  };
}
