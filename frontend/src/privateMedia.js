import { VARIANT_KIND } from './cachePolicy.js';
import { imageKey } from './imageRecord.js';
import { makeThumbnail } from './privateThumbnail.js';

export const PRIVATE_MEDIA_CONCURRENCY = 4;
export const PRIVATE_MEDIA_QUEUE_LIMIT = 192;

const hasBlob = (blob) => Number.isFinite(blob?.size) && blob.size > 0;
const hasLiveConsumer = (signals) => signals.some((signal) => !signal?.aborted);

/** Leases share the application's URL ledger, never a second URL owner. */
export function createPrivateMedia({
  store,
  urls,
  makeThumbnail: renderThumbnail = makeThumbnail,
}) {
  const held = new Map();
  const pending = new Map();
  const queue = [];
  let active = 0;

  const idOf = (record, kind) =>
    JSON.stringify([imageKey(record), record.local_added_at, kind]);
  const readOriginal = (record) =>
    store.readPrivateMedia(
      imageKey(record),
      { addedAt: record.local_added_at },
      VARIANT_KIND.FULL,
    );

  async function recoverBlob(record, signals) {
    if (!hasLiveConsumer(signals)) return null;
    const original = await readOriginal(record);
    if (!hasBlob(original) || !hasLiveConsumer(signals)) return null;
    const thumbnail = await renderThumbnail(original);
    if (!hasBlob(thumbnail) || !hasLiveConsumer(signals)) return null;

    let saved = null;
    try {
      saved = await store.savePrivateThumbnail?.(
        imageKey(record),
        { addedAt: record.local_added_at },
        thumbnail,
      );
    } catch {
      // Keep the derived image transient if storage refused the write.
    }
    if (!hasLiveConsumer(signals)) return null;
    if (saved?.persisted === true) return thumbnail;

    // A refusal can mean quota, a changed incarnation, or a concurrent remove.
    // Only the exact still-stored original permits a transient display.
    const confirmed = await readOriginal(record);
    return hasBlob(confirmed) && hasLiveConsumer(signals) ? thumbnail : null;
  }

  const thumbnailRecoveryId = (record) =>
    idOf(record, `${VARIANT_KIND.THUMBNAIL}:recovery`);

  function makeLease(id, blob) {
    if (!hasBlob(blob)) return null;
    let entry = held.get(id);
    if (!entry) {
      entry = { url: urls.acquire(blob), count: 0 };
      held.set(id, entry);
    } else urls.retain(entry.url);
    entry.count++;
    let released = false;
    return {
      url: entry.url,
      release() {
        if (released) return;
        released = true;
        urls.release(entry.url);
        if (--entry.count === 0 && held.get(id) === entry) held.delete(id);
      },
    };
  }

  function pump() {
    while (active < PRIVATE_MEDIA_CONCURRENCY && queue.length) {
      const job = queue.shift();
      if (!hasLiveConsumer(job.signals)) {
        job.resolve(null);
        continue;
      }
      active++;
      Promise.resolve()
        .then(() => job.read(job.signals))
        .then(job.resolve, job.reject)
        .finally(() => {
          active--;
          pump();
        });
    }
  }

  function requestBlob(id, read, signal) {
    let job = pending.get(id);
    if (!job) {
      job = { signals: [], read };
      job.promise = new Promise((resolve, reject) => {
        job.resolve = resolve;
        job.reject = reject;
      });
      pending.set(id, job);
      queue.push(job);
      if (queue.length > PRIVATE_MEDIA_QUEUE_LIMIT) queue.shift().resolve(null);
    }
    job.signals.push(signal);
    pump();
    return job.promise.finally(() => {
      if (pending.get(id) === job) pending.delete(id);
    });
  }

  async function leaseRead(id, read, signal) {
    if (signal?.aborted) return null;
    const existing = held.get(id);
    if (existing) return retainLease(id, existing);
    const blob = await requestBlob(id, read, signal).catch(() => null);
    if (signal?.aborted || !hasBlob(blob)) return null;
    return makeLease(id, blob);
  }

  function retainLease(id, entry) {
    urls.retain(entry.url);
    entry.count++;
    let released = false;
    return {
      url: entry.url,
      release() {
        if (released) return;
        released = true;
        urls.release(entry.url);
        if (--entry.count === 0 && held.get(id) === entry) held.delete(id);
      },
    };
  }

  function thumbnailBlob(record, signals) {
    return store
      .readPrivateMedia(
        imageKey(record),
        { addedAt: record.local_added_at },
        VARIANT_KIND.THUMBNAIL,
      )
      .then((blob) => (hasBlob(blob) ? blob : recoverBlob(record, signals)));
  }

  return {
    accepts: (record) => Number.isFinite(record?.local_added_at),
    peek: (record, kind) => held.get(idOf(record, kind))?.url ?? null,
    async lease(record, kind, { signal } = {}) {
      const id = idOf(record, kind);
      const read =
        kind === VARIANT_KIND.THUMBNAIL
          ? (signals) => thumbnailBlob(record, signals)
          : () =>
              store.readPrivateMedia(
                imageKey(record),
                { addedAt: record.local_added_at },
                kind,
              );
      return leaseRead(id, read, signal);
    },
    async recoverThumbnail(record, { signal } = {}) {
      if (signal?.aborted) return null;
      const id = thumbnailRecoveryId(record);
      return leaseRead(id, (signals) => recoverBlob(record, signals), signal);
    },
    // A failed private display never falls back to a wire URL or removes bytes.
    capture() {},
    drop() {},
  };
}
