/**
 * Cached image variants as displayable object URLs.
 *
 * A mounted image holds a LEASE on the URL of its cached blob. Leases on the
 * same variant share one object URL; the URL is revoked only when the last
 * lease is released. Eviction and deletion change the database only, so an
 * image that is on screen keeps its picture, and an on-screen variant is
 * pinned against eviction.
 *
 * A cache miss shows the network URL; once it has loaded, `capture` fetches the
 * bytes through a small bounded queue and stores them. Capture is never on the
 * display path.
 */
import { variantId } from '../storage/cachePolicy.js';
import { imageKey } from '../records/imageRecord.js';

/** Variants fetched for storing at the same time. */
export const CAPTURE_CONCURRENCY = 2;
/** Waiting captures kept; beyond this the oldest is dropped. */
export const CAPTURE_QUEUE_LIMIT = 64;
/** Refusals that will not change by trying again this session. */
const FINAL_REFUSALS = new Set(['oversize', 'deleted']);

/**
 * @param {object} options
 * @param {ReturnType<typeof import('../storage/cacheStore.js').createCacheStore>} options.store
 * @param {ReturnType<typeof import('./objectUrls.js').createUrlLedger>} options.urls
 * @param {(url: string) => Promise<Blob>} options.fetchBlob
 */
export function createVariantMedia({ store, urls, fetchBlob }) {
  /** id -> {url, count}: one object URL per variant while any lease is held. */
  const held = new Map();
  const queue = [];
  const queued = new Set();
  const refused = new Set();
  let active = 0;

  const idOf = (record, kind) => variantId(imageKey(record), kind);

  function makeLease(id, entry) {
    let released = false;
    return {
      url: entry.url,
      release() {
        if (released) return;
        released = true;
        urls.release(entry.url);
        entry.count -= 1;
        if (entry.count === 0 && held.get(id) === entry) held.delete(id);
      },
    };
  }

  function hold(id, entry) {
    entry.count += 1;
    urls.retain(entry.url);
    return makeLease(id, entry);
  }

  async function captureOne({ record, kind, url, id }) {
    try {
      const blob = await fetchBlob(url);
      if (!blob.size || !blob.type.startsWith('image/')) return;
      const result = await store.putVariant(record, kind, blob, {
        pinned: new Set(held.keys()),
      });
      if (!result.persisted && FINAL_REFUSALS.has(result.reason))
        refused.add(id);
    } catch {
      // The picture is already displayed from the network; try again later.
    }
  }

  function pump() {
    while (active < CAPTURE_CONCURRENCY && queue.length) {
      const job = queue.shift();
      active += 1;
      captureOne(job).finally(() => {
        active -= 1;
        queued.delete(job.id);
        pump();
      });
    }
  }

  return {
    /** The URL of a variant some mounted image already holds, else null. */
    peek: (record, kind) => held.get(idOf(record, kind))?.url ?? null,

    /**
     * Hold the cached variant, or resolve null on a miss.
     * @returns {Promise<{url: string, release: () => void}|null>}
     */
    async lease(record, kind) {
      const id = idOf(record, kind);
      const current = held.get(id);
      if (current) return hold(id, current);
      const found = await store.getVariant(record, kind);
      if (!found?.blob?.size) return null;
      // Another lease may have loaded the same variant meanwhile.
      const raced = held.get(id);
      if (raced) return hold(id, raced);
      const entry = { url: urls.acquire(found.blob), count: 1 };
      held.set(id, entry);
      return makeLease(id, entry);
    },

    /** The cached bytes of a variant, or null; nothing is leased or fetched. */
    async blob(record, kind) {
      const found = await store.getVariant(record, kind);
      return found?.blob?.size ? found.blob : null;
    },

    /** Store the bytes behind `url`, which has just displayed `record`. */
    capture(record, kind, url) {
      const id = idOf(record, kind);
      if (queued.has(id) || refused.has(id)) return;
      queued.add(id);
      queue.push({ record, kind, url, id });
      if (queue.length > CAPTURE_QUEUE_LIMIT) {
        const dropped = queue.shift();
        queued.delete(dropped.id);
      }
      pump();
    },

    /** A cached blob that cannot be displayed: remove it and use the network. */
    drop: (record, kind) => store.dropVariant(imageKey(record), kind),
  };
}
