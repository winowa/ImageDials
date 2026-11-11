/**
 * Pieces every cache store module shares: why a write was skipped, the quota
 * and recency constants, and the in-tab state (`ctx.memory`) whose guards hold
 * even when a transaction fails or there is no database. `ctx.limits` is
 * replaced by `setLimits`; modules read it at call time.
 */
import { ADMISSION_REFUSAL } from './cachePolicy.js';

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

export const isQuota = (error) => error?.name === 'QuotaExceededError';
export const skipped = (reason) => ({ persisted: false, reason });

export function encodedBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

/**
 * @param {object|null} db
 * @param {object} initialLimits
 * @param {{quotaBackoffMs: number, openChannel: () => (BroadcastChannel|null)}} options
 */
export function createCacheContext(
  db,
  initialLimits,
  { quotaBackoffMs, openChannel },
) {
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
  return { db, limits: initialLimits, quotaBackoffMs, openChannel, memory };
}
