/**
 * Observe one accepted job: the event stream first, status polling when the
 * stream is unavailable or drops. Both feed the reducer in jobs.js, so the job
 * state is identical whichever transport delivered it. A transport failure is
 * never a job failure, and accepted work is never resubmitted.
 */
import { ENDPOINTS } from './api.js';
import { applyEvent, isTerminal, JOB_EVENT, trackJob } from './jobs.js';

const STREAM_EVENTS = Object.values(JOB_EVENT);

/** Why the stream ended. */
const END = {
  terminal: 'terminal',
  superseded: 'superseded',
  fallback: 'fallback',
};

/**
 * @returns {Promise<{state: object, end: string}>} resolves once; the source is
 *   closed and every listener removed before it does.
 */
function readStream({ job, EventSourceImpl, onUpdate, isCurrent, signal }) {
  return new Promise((resolve) => {
    let state = job;
    let source = null;
    const end = (reason) => {
      signal?.removeEventListener('abort', onAbort);
      source?.close();
      resolve({ state, end: reason });
    };
    const onAbort = () => end(END.superseded);
    if (signal?.aborted) return end(END.superseded);
    signal?.addEventListener('abort', onAbort);
    try {
      source = new EventSourceImpl(ENDPOINTS.generationEvents(job.id));
    } catch {
      return end(END.fallback);
    }
    for (const name of STREAM_EVENTS)
      source.addEventListener(name, (message) => {
        if (!isCurrent()) return end(END.superseded);
        let data;
        try {
          data = JSON.parse(message.data);
        } catch {
          return end(END.fallback);
        }
        const next = applyEvent(state, { event: name, data });
        if (next !== state) {
          state = next;
          onUpdate(state);
        }
        if (isTerminal(state)) end(END.terminal);
      });
    // The browser would retry on its own; polling is the specified fallback.
    source.addEventListener('error', () => end(END.fallback));
  });
}

/**
 * @param {object} options
 * @param {object} options.job accepted job
 * @param {(id: string) => Promise<object>} options.fetchStatus
 * @param {(job: object) => void} options.onUpdate called on every change
 * @param {() => boolean} options.isCurrent false once the view no longer tracks this job
 * @param {AbortSignal} [options.signal] aborted when the observer is superseded or unmounted
 * @param {typeof EventSource | null} [options.EventSourceImpl] defaults to the browser's
 * @returns {Promise<object>} the last known job state
 */
export async function observeJob({
  EventSourceImpl = globalThis.EventSource ?? null,
  ...options
}) {
  let { job } = options;
  if (EventSourceImpl) {
    const streamed = await readStream({ ...options, EventSourceImpl });
    if (streamed.end !== END.fallback) return streamed.state;
    job = streamed.state;
  }
  const { signal } = options;
  return trackJob({
    ...options,
    job,
    isCurrent: () => options.isCurrent() && !signal?.aborted,
  });
}
