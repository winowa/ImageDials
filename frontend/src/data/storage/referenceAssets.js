/**
 * Explicitly retained reference originals. Separate from disposable caches and
 * private generated-image history: nothing is evicted to admit another file.
 * Listings read metadata only; an original Blob is read only for its checksum.
 */
import { STORE } from './cacheDb.js';
import { DEFAULT_CLIENT_POLICY } from '../api/clientPolicy.js';
import { sha256Hex } from '../media/privateThumbnail.js';

export const REFERENCE_ASSET_CHANNEL = 'imagedials-reference-assets';
export const REFERENCE_ASSET_STATE_KEY = 'referenceAssetsState';
export const REFERENCE_ASSET_NAME_LIMIT = 160;
export const REFERENCE_ASSET_DESCRIPTION_LIMIT = 4096;
export const REFERENCE_KEEP_REASON = Object.freeze({
  NO_STORAGE: 'no-storage',
  INVALID: 'invalid',
  CHECKSUM: 'checksum-mismatch',
  COUNT: 'record-limit',
  BYTES: 'byte-limit',
  CHANGED: 'changed',
  QUOTA: 'quota',
  FAILED: 'failed',
});
const TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const HASH = /^[a-f0-9]{64}$/;
const TABLES = [STORE.REFERENCE_ASSETS, STORE.REFERENCE_MEDIA, STORE.META];
const skipped = (reason) => ({ persisted: false, reason });
const text = (value, limit) =>
  typeof value === 'string' ? Array.from(value).slice(0, limit).join('') : '';
const generationId = () =>
  globalThis.crypto?.randomUUID?.() ??
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const dimensionsOf = (value) =>
  Number.isSafeInteger(value?.width) &&
  value.width > 0 &&
  Number.isSafeInteger(value?.height) &&
  value.height > 0
    ? { width: value.width, height: value.height }
    : null;

/**
 * `beginKeep()` precedes any async capture/checksum work. `keep(ticket, file)`
 * checks the deletion epoch inside its write transaction. Any removal fences
 * all older pending keeps; unrelated files can be saved concurrently. Refused
 * keeps can be retried explicitly with a fresh ticket; no file is retimed.
 *
 * On HTTP, digest may return null. The caller must then supply the checksum of
 * these same bytes from the existing inspect/analysis API. No model/fetch/Blob
 * decode happens inside an IndexedDB transaction.
 */
export function createReferenceAssetsStore(
  db,
  {
    getLimits = () => DEFAULT_CLIENT_POLICY.cache,
    digest = sha256Hex,
    clock = () => Date.now(),
    makeGeneration = generationId,
    openChannel = () =>
      typeof BroadcastChannel === 'function'
        ? new BroadcastChannel(REFERENCE_ASSET_CHANNEL)
        : null,
  } = {},
) {
  const listeners = new Set();
  let channel = null;
  const durable = () => Boolean(db) && db.open !== false;
  const limits = () => {
    const current = getLimits();
    return {
      maxRecords:
        current?.referenceRecordLimit ??
        DEFAULT_CLIENT_POLICY.cache.referenceRecordLimit,
      maxBytes:
        current?.referenceMaxBytes ??
        DEFAULT_CLIENT_POLICY.cache.referenceMaxBytes,
    };
  };
  const usage = (state) => ({
    count: state.count,
    bytes: state.bytes,
    sequence: state.sequence,
    ...limits(),
  });
  const emit = () => {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // Observer failures do not change the outcome of a committed write.
      }
    }
  };
  const connect = () => {
    if (channel) return channel;
    try {
      channel = openChannel();
      if (channel) channel.onmessage = emit;
    } catch {
      channel = null;
    }
    return channel;
  };
  const announce = () => {
    emit();
    try {
      connect()?.postMessage({ type: 'changed' });
    } catch {
      // Tabs without a channel can refresh on visibility or explicit use.
    } finally {
      if (!listeners.size) {
        channel?.close();
        channel = null;
      }
    }
  };
  const currentState = (access) =>
    access.get(STORE.META, REFERENCE_ASSET_STATE_KEY);
  const initialize = async (access) => {
    let state = await currentState(access);
    if (state) return state;
    state = {
      generation: makeGeneration(),
      removalEpoch: 0,
      sequence: 0,
      count: 0,
      bytes: 0,
    };
    await access.scan(STORE.REFERENCE_ASSETS, null, (row) => {
      state.count += 1;
      state.bytes += row.bytes;
      state.sequence = Math.max(state.sequence, row.revision);
    });
    await access.put(STORE.META, REFERENCE_ASSET_STATE_KEY, state);
    return state;
  };

  return {
    get durable() {
      return durable();
    },

    async beginKeep() {
      if (!durable()) return null;
      const state = await db.run(TABLES, 'readwrite', initialize);
      return {
        generation: state.generation,
        removalEpoch: state.removalEpoch,
      };
    },

    async keep(ticket, candidate) {
      if (!durable()) return skipped(REFERENCE_KEEP_REASON.NO_STORAGE);
      const sha256 = candidate?.sha256;
      const blob = candidate?.blob;
      if (
        !ticket ||
        !HASH.test(sha256 ?? '') ||
        !blob?.size ||
        !Number.isSafeInteger(blob.size) ||
        !TYPES.has(blob.type)
      )
        return skipped(REFERENCE_KEEP_REASON.INVALID);
      try {
        const actual = await digest(blob);
        if (actual && actual !== sha256)
          return skipped(REFERENCE_KEEP_REASON.CHECKSUM);
        const result = await db.run(TABLES, 'readwrite', async (access) => {
          const state = await initialize(access);
          if (
            state.generation !== ticket.generation ||
            state.removalEpoch !== ticket.removalEpoch
          )
            return skipped(REFERENCE_KEEP_REASON.CHANGED);
          const previous = await access.get(STORE.REFERENCE_ASSETS, sha256);
          if (previous) {
            if (previous.bytes !== blob.size)
              return skipped(REFERENCE_KEEP_REASON.CHECKSUM);
            // Repair only absent bytes; an existing original is never replaced.
            if (!(await access.has(STORE.REFERENCE_MEDIA, sha256)))
              await access.put(STORE.REFERENCE_MEDIA, sha256, blob);
            return {
              persisted: true,
              duplicate: true,
              entry: previous,
              usage: usage(state),
            };
          }
          const budget = limits();
          if (state.count >= budget.maxRecords)
            return skipped(REFERENCE_KEEP_REASON.COUNT);
          if (blob.size > budget.maxBytes - state.bytes)
            return skipped(REFERENCE_KEEP_REASON.BYTES);
          const next = {
            ...state,
            sequence: state.sequence + 1,
            count: state.count + 1,
            bytes: state.bytes + blob.size,
          };
          const entry = {
            sha256,
            name: text(candidate.name, REFERENCE_ASSET_NAME_LIMIT),
            description: text(
              candidate.description,
              REFERENCE_ASSET_DESCRIPTION_LIMIT,
            ),
            dimensions: dimensionsOf(candidate.dimensions),
            type: blob.type,
            bytes: blob.size,
            savedAt: clock(),
            revision: next.sequence,
          };
          await access.put(STORE.REFERENCE_ASSETS, sha256, entry);
          await access.put(STORE.REFERENCE_MEDIA, sha256, blob);
          await access.put(STORE.META, REFERENCE_ASSET_STATE_KEY, next);
          return {
            persisted: true,
            duplicate: false,
            entry,
            usage: usage(next),
          };
        });
        if (result.persisted) announce();
        return result;
      } catch (error) {
        return skipped(
          error?.name === 'QuotaExceededError'
            ? REFERENCE_KEEP_REASON.QUOTA
            : REFERENCE_KEEP_REASON.FAILED,
        );
      }
    },

    async list() {
      if (!durable())
        return {
          durable: false,
          items: [],
          usage: { count: 0, bytes: 0, sequence: 0, ...limits() },
        };
      return db.run(
        [STORE.REFERENCE_ASSETS, STORE.META],
        'readonly',
        async (access) => {
          const items = [];
          await access.scan(STORE.REFERENCE_ASSETS, null, (row) => {
            items.push(row);
          });
          const state = (await currentState(access)) ?? {
            count: items.length,
            bytes: items.reduce((sum, row) => sum + row.bytes, 0),
            sequence: 0,
          };
          items.sort(
            (a, b) => b.savedAt - a.savedAt || b.revision - a.revision,
          );
          return { durable: true, items, usage: usage(state) };
        },
      );
    },

    async read(sha256) {
      if (!durable() || !HASH.test(sha256 ?? '')) return null;
      return db.run(TABLES, 'readonly', async (access) => {
        const entry = await access.get(STORE.REFERENCE_ASSETS, sha256);
        if (!entry) return null;
        const blob = await access.get(STORE.REFERENCE_MEDIA, sha256);
        if (!blob || blob.size !== entry.bytes)
          throw new Error('The stored reference bytes are missing.');
        return { ...entry, blob };
      });
    },

    /** The displayed revision prevents an old dialog removing a new save. */
    async remove(sha256, { revision } = {}) {
      if (!durable())
        return { removed: false, reason: REFERENCE_KEEP_REASON.NO_STORAGE };
      if (!HASH.test(sha256 ?? '') || !Number.isSafeInteger(revision))
        return { removed: false, reason: REFERENCE_KEEP_REASON.INVALID };
      try {
        const result = await db.run(TABLES, 'readwrite', async (access) => {
          const state = await initialize(access);
          const entry = await access.get(STORE.REFERENCE_ASSETS, sha256);
          if (entry && entry.revision !== revision)
            return { removed: false, reason: REFERENCE_KEEP_REASON.CHANGED };
          const next = {
            ...state,
            removalEpoch: state.removalEpoch + 1,
            sequence: state.sequence + 1,
            count: state.count - (entry ? 1 : 0),
            bytes: state.bytes - (entry?.bytes ?? 0),
          };
          await access.delete(STORE.REFERENCE_ASSETS, sha256);
          await access.delete(STORE.REFERENCE_MEDIA, sha256);
          await access.put(STORE.META, REFERENCE_ASSET_STATE_KEY, next);
          return { removed: true, usage: usage(next) };
        });
        if (result.removed) announce();
        return result;
      } catch (error) {
        return {
          removed: false,
          reason:
            error?.name === 'QuotaExceededError'
              ? REFERENCE_KEEP_REASON.QUOTA
              : REFERENCE_KEEP_REASON.FAILED,
        };
      }
    },

    subscribe(listener) {
      listeners.add(listener);
      connect();
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          channel?.close();
          channel = null;
        }
      };
    },
  };
}
