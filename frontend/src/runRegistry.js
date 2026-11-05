/**
 * Concurrent requests for the same work share one run. The run stops once no
 * caller waits for it, and a later request starts fresh.
 */

/** Resolve like `promise`, but reject early with an AbortError when `signal` aborts. */
export function untilAborted(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException('Aborted', 'AbortError'));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}

export function createRunRegistry() {
  const inflight = new Map();
  return {
    /**
     * @template T
     * @param {string} id identity of the work
     * @param {(signal: AbortSignal) => Promise<T>} start begins the shared run
     * @param {AbortSignal} [signal] cancels this caller's wait only
     * @returns {Promise<T>}
     */
    join(id, start, signal) {
      let entry = inflight.get(id);
      if (!entry) {
        const controller = new AbortController();
        entry = { controller, waiters: 0, promise: null };
        entry.promise = start(controller.signal).finally(() => {
          if (inflight.get(id) === entry) inflight.delete(id);
        });
        // Keep an unwatched run from reporting an unhandled rejection.
        entry.promise.catch(() => {});
        inflight.set(id, entry);
      }
      entry.waiters += 1;
      const leave = () => {
        entry.waiters -= 1;
        if (entry.waiters > 0) return;
        // Nobody waits any more: stop the run and let a new request start fresh.
        if (inflight.get(id) === entry) inflight.delete(id);
        entry.controller.abort();
      };
      return untilAborted(entry.promise, signal).finally(leave);
    },
    get pending() {
      return inflight.size;
    },
  };
}
