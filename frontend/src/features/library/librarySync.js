/**
 * Keeps the saved-image list current without a framework. The change stream is
 * only an invalidation signal (it is neither durable nor replayed), so every
 * time it opens or reopens the list is refreshed, and while it is down the
 * list is polled at the visible screen's interval.
 *
 * Automatic refreshes are debounced and, when asked, paused while the pointer
 * is moving; an invalidation that arrives meanwhile is applied once the
 * pointer has been idle.
 */
import { ENDPOINTS } from '../../data/api/api.js';
import { ROUTE } from '../../app/routes.js';

const CHANGE_EVENT = 'changed';
const POINTER_EVENT = 'pointermove';

/**
 * @param {object} options
 * @param {() => unknown} options.refresh reloads the list (conditional request)
 * @param {object} options.timing millisecond budgets from the client policy:
 *   reconnectInitialMs, reconnectMaxMs, changeDebounceMs, pointerIdleMs
 * @param {typeof EventSource | null} [options.EventSourceImpl]
 * @param {EventTarget | null} [options.pointerTarget]
 * @returns {{ setPolling(intervalMs: number|null, pauseOnPointer?: boolean): void, close(): void }}
 */
export function createLibrarySync({
  refresh,
  timing,
  EventSourceImpl = globalThis.EventSource ?? null,
  pointerTarget = globalThis.window ?? null,
}) {
  let closed = false;
  let source = null;
  let connected = false;
  let backoffMs = timing.reconnectInitialMs;
  let reconnectTimer = null;
  let debounceTimer = null;
  let pollTimer = null;
  let pollMs = null;
  let runningPollMs = null;
  let pauseOnPointer = false;
  let pointerActive = false;
  let pointerTimer = null;
  let pending = false;

  /** One automatic refresh, deferred while the pointer is moving. */
  const refreshNow = () => {
    if (closed) return;
    if (pauseOnPointer && pointerActive) {
      pending = true;
      return;
    }
    pending = false;
    refresh();
  };

  const invalidate = () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      refreshNow();
    }, timing.changeDebounceMs);
  };

  const onPointerMove = () => {
    pointerActive = true;
    clearTimeout(pointerTimer);
    pointerTimer = setTimeout(() => {
      pointerTimer = null;
      pointerActive = false;
      if (pending) refreshNow();
    }, timing.pointerIdleMs);
  };
  pointerTarget?.addEventListener(POINTER_EVENT, onPointerMove, {
    passive: true,
  });

  /**
   * Run the fallback timer exactly while it is wanted. It is left alone when
   * its state is unchanged, so repeated reconnect failures cannot keep
   * postponing the next poll.
   */
  const startPolling = () => {
    const wanted = !closed && !connected && pollMs ? pollMs : null;
    if (wanted === runningPollMs) return;
    clearInterval(pollTimer);
    pollTimer = wanted ? setInterval(refreshNow, wanted) : null;
    runningPollMs = wanted;
  };

  const disconnected = () => {
    source?.close();
    source = null;
    connected = false;
    startPolling();
    if (closed || !EventSourceImpl) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, backoffMs);
    backoffMs = Math.min(backoffMs * 2, timing.reconnectMaxMs);
  };

  function connect() {
    reconnectTimer = null;
    if (closed || !EventSourceImpl) return;
    let opened;
    try {
      opened = new EventSourceImpl(ENDPOINTS.libraryEvents);
    } catch {
      disconnected();
      return;
    }
    source = opened;
    opened.addEventListener('open', () => {
      if (source !== opened) return;
      connected = true;
      backoffMs = timing.reconnectInitialMs;
      startPolling();
      // The subscription is live, so nothing saved from here on is missed;
      // this read recovers whatever changed before it.
      refreshNow();
    });
    opened.addEventListener(CHANGE_EVENT, () => {
      if (source === opened) invalidate();
    });
    opened.addEventListener('error', () => {
      if (source === opened) disconnected();
    });
  }

  if (EventSourceImpl) connect();
  else startPolling();

  return {
    /** Fallback interval for the visible screen, or null for none. */
    setPolling(intervalMs, pauseWhileMoving = false) {
      pollMs = intervalMs;
      pauseOnPointer = pauseWhileMoving;
      startPolling();
    },
    close() {
      closed = true;
      source?.close();
      source = null;
      clearTimeout(reconnectTimer);
      clearTimeout(debounceTimer);
      clearTimeout(pointerTimer);
      clearInterval(pollTimer);
      runningPollMs = null;
      pointerTarget?.removeEventListener(POINTER_EVENT, onPointerMove);
    },
  };
}

/**
 * Fallback polling for the visible screen while the stream is down: the
 * gallery and the library poll at their own intervals, the generator never
 * does. Only the library browser holds refreshes while the pointer moves.
 * @returns {{pollMs: number|null, pauseOnPointer: boolean}}
 */
export function fallbackFor(route, transport) {
  if (route === ROUTE.gallery)
    return { pollMs: transport.galleryPollIntervalMs, pauseOnPointer: false };
  if (route === ROUTE.library)
    return { pollMs: transport.libraryPollIntervalMs, pauseOnPointer: true };
  return { pollMs: null, pauseOnPointer: false };
}

/** The stream and refresh budgets of a normalized client policy's transport section. */
export const timingFrom = (transport) => ({
  reconnectInitialMs: transport.libraryReconnectInitialMs,
  reconnectMaxMs: transport.libraryReconnectMaxMs,
  changeDebounceMs: transport.libraryChangeDebounceMs,
  pointerIdleMs: transport.libraryPointerIdleMs,
});
