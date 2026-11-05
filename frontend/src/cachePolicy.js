/**
 * Pure cache decisions: which library source applies, which listing scope a
 * cached list belongs to, what to evict, and which records a read may still
 * show after a delete. Nothing here touches IndexedDB, React or the network, so
 * every boundary is unit-testable. Limits come from `policy.cache` only.
 */
import { imageKey } from './imageRecord.js';

export const SOURCE = Object.freeze({
  /** Capabilities have not settled; nothing may be read, streamed or hydrated. */
  PENDING: 'pending',
  /** Capabilities could not be read; the library is not requested. */
  UNAVAILABLE: 'unavailable',
  SHARED: 'shared',
  PRIVATE: 'private',
});

export const VARIANT_KIND = Object.freeze({
  THUMBNAIL: 'thumbnail',
  FULL: 'full',
});
export const VARIANT_KINDS = Object.values(VARIANT_KIND);

/**
 * Kinds of private media: the shared kinds plus the one watermarked PNG made
 * from the original. Shared-library caching never sees the extra kind.
 */
export const PRIVATE_WATERMARKED_KIND = 'watermarked';
export const PRIVATE_KINDS = [...VARIANT_KINDS, PRIVATE_WATERMARKED_KIND];

const BROWSER_PRIVATE_HISTORY = 'browser-private';

/** Row id of one cached image variant. */
export const variantId = (key, kind) => `${key}|${kind}`;

/**
 * Only resolved capabilities choose the source. A failed read is `unavailable`,
 * never a guess, and a loading slot is `pending` even if old data is present.
 * @param {{status: string, data: object|null}} capabilitiesSlot
 */
export function selectSource(capabilitiesSlot) {
  const { status, data } = capabilitiesSlot ?? {};
  if (status === 'error') return SOURCE.UNAVAILABLE;
  if (status !== 'ready' || !data) return SOURCE.PENDING;
  const privateHistory =
    data.shared_library?.enabled === false ||
    data.history_source === BROWSER_PRIVATE_HISTORY;
  return privateHistory ? SOURCE.PRIVATE : SOURCE.SHARED;
}

/**
 * Stable identity of the listing a cached list answers: the store plus the
 * event scope. Two capability documents with the same scope give the same key
 * whatever the order of the gallery names.
 * @returns {string|null} null until capabilities are available
 */
export function scopeKeyOf(capabilities) {
  if (!capabilities) return null;
  const events = capabilities.events ?? {};
  return JSON.stringify({
    store: capabilities.shared_library?.store ?? null,
    active: events.active_event_name ?? null,
    gallery: [...(events.gallery_event_names ?? [])].sort(),
  });
}

/**
 * Choose variants to evict so `incoming` fits both budgets. Oldest
 * `lastUsedAt` goes first (ties by id, so the plan is deterministic) and
 * pinned ids, which a mounted image is displaying, are never chosen. An
 * incoming variant larger than the whole byte budget is refused up front and
 * evicts nothing. The row being replaced (same id) is not counted twice.
 *
 * @param {{id: string, bytes: number, lastUsedAt: number}[]} entries stored variants
 * @param {{id: string, bytes: number}|null} incoming `null` plans a pure trim
 * @param {{sharedVariantLimit: number, sharedVariantMaxBytes: number}} limits
 * @param {Set<string>} [pinned]
 * @returns {{store: boolean, evict: string[], reason: 'oversize'|'pinned'|null}}
 */
export function planVariantEviction(
  entries,
  incoming,
  limits,
  pinned = new Set(),
) {
  if (incoming && incoming.bytes > limits.sharedVariantMaxBytes)
    return { store: false, evict: [], reason: 'oversize' };
  const others = entries.filter((entry) => entry.id !== incoming?.id);
  let count = others.length + (incoming ? 1 : 0);
  let bytes =
    others.reduce((sum, entry) => sum + entry.bytes, 0) +
    (incoming?.bytes ?? 0);
  const candidates = others
    .filter((entry) => !pinned.has(entry.id))
    .sort(
      (a, b) =>
        a.lastUsedAt - b.lastUsedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  const evict = [];
  for (const entry of candidates) {
    if (
      count <= limits.sharedVariantLimit &&
      bytes <= limits.sharedVariantMaxBytes
    )
      break;
    evict.push(entry.id);
    count -= 1;
    bytes -= entry.bytes;
  }
  if (count > limits.sharedVariantLimit || bytes > limits.sharedVariantMaxBytes)
    return { store: false, evict: [], reason: 'pinned' };
  return { store: true, evict, reason: null };
}

/**
 * The newest `limit` records of a newest-first listing. A truncated listing is
 * not `complete`, and only a complete one may keep its ETag: a 304 against a
 * partial cache would freeze the partial list.
 */
export function listingForStorage(images, limit) {
  return { images: images.slice(0, limit), complete: images.length <= limit };
}

/**
 * Choose oldest unpinned full-detail records to keep the selected-record LRU
 * within the published shared-record count and byte ceilings.
 */
export function planLibraryDetailEviction(
  entries,
  incoming,
  limits,
  pinned = new Set(),
) {
  if (incoming.bytes > limits.libraryDetailMaxBytes)
    return { store: false, evict: [], reason: 'oversize' };
  const others = entries.filter((entry) => entry.id !== incoming.id);
  let count = others.length + 1;
  let bytes =
    others.reduce((sum, entry) => sum + entry.bytes, 0) + incoming.bytes;
  const candidates = others
    .filter((entry) => !pinned.has(entry.id))
    .sort(
      (a, b) =>
        a.lastUsedAt - b.lastUsedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  const evict = [];
  for (const entry of candidates) {
    if (
      count <= limits.libraryDetailLimit &&
      bytes <= limits.libraryDetailMaxBytes
    )
      break;
    evict.push(entry.id);
    count -= 1;
    bytes -= entry.bytes;
  }
  if (count > limits.libraryDetailLimit || bytes > limits.libraryDetailMaxBytes)
    return { store: false, evict: [], reason: 'pinned' };
  return { store: true, evict, reason: null };
}

/**
 * Apply delete tombstones to a read. `tombstones` maps image key to the
 * sequence number assigned when it was deleted and `ticket` is the sequence
 * number when the read began.
 *
 * - A tombstone newer than the ticket means the read may predate the delete,
 *   so that image is dropped from the result.
 * - A tombstone at or below the ticket is settled: the read began after the
 *   delete, so the server's answer is authoritative and the tombstone can go.
 *
 * @param {object[]} images wire records
 * @param {Map<string, number>} tombstones
 * @param {number} ticket
 * @returns {{images: object[], settled: string[]}}
 */
export function reconcileDeletions(images, tombstones, ticket) {
  const settled = [];
  for (const [key, seq] of tombstones) if (seq <= ticket) settled.push(key);
  const kept = images.filter((image) => {
    const seq = tombstones.get(imageKey(image));
    return seq === undefined || seq <= ticket;
  });
  return { images: kept, settled };
}

/** Why a new private original was not admitted to durable storage. */
export const ADMISSION_REFUSAL = Object.freeze({
  RECORD_LIMIT: 'record-limit',
  BYTE_LIMIT: 'byte-limit',
});

/**
 * Decide whether one more private entry fits the durable budgets. Nothing is
 * ever chosen for eviction here: a refusal leaves every stored original alone
 * (the caller may give up rebuildable prepared copies, never originals).
 * Entries already above a lowered limit stay; they only refuse new admission.
 *
 * @param {{count: number, bytes: number}} stored current record count and
 *   stored private bytes
 * @param {{newRecord: boolean, bytes: number}} incoming `newRecord` is false
 *   when the entry's row already exists and only bytes are being added
 * @param {{privateRecordLimit: number, privateMaxBytes: number}} limits
 * @returns {{admit: true}|{admit: false, reason: string}}
 */
export function planPrivateAdmission(stored, incoming, limits) {
  if (incoming.newRecord && stored.count + 1 > limits.privateRecordLimit)
    return { admit: false, reason: ADMISSION_REFUSAL.RECORD_LIMIT };
  if (stored.bytes + incoming.bytes > limits.privateMaxBytes)
    return { admit: false, reason: ADMISSION_REFUSAL.BYTE_LIMIT };
  return { admit: true };
}

/** Why the tab's bounded pool of not-yet-stored private images has no room. */
export const VOLATILE_REFUSAL = Object.freeze({
  NO_SLOT: 'no-slot',
  NO_BYTES: 'no-bytes',
});

/**
 * Plan a place in the per-tab pool that holds images which are not durably
 * stored. Every such image takes a slot, including one that is only a server
 * link. Held bytes are counted separately: an image whose bytes do not fit the
 * remaining byte budget still takes a slot but holds nothing (`hold: false`).
 *
 * @param {{slots: number, bytes: number}} used slots in use and bytes held
 * @param {number|null} incomingBytes size of the original, or null if unknown
 * @param {{privateVolatileRecordLimit: number, privateVolatileMaxBytes: number}} limits
 * @param {number} [slots] places needed at once (a group of variations)
 * @returns {{slot: false, reason: string}|{slot: true, hold: boolean}}
 */
export function planVolatileSlot(used, incomingBytes, limits, slots = 1) {
  if (used.slots + slots > limits.privateVolatileRecordLimit)
    return { slot: false, reason: VOLATILE_REFUSAL.NO_SLOT };
  const hold =
    incomingBytes !== null &&
    used.bytes + incomingBytes <= limits.privateVolatileMaxBytes;
  return { slot: true, hold };
}
