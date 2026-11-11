import { preserveError } from '../../shared/diagnostics/diagnostics.js';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { api } from '../../data/api/api.js';
import { SOURCE } from '../../data/storage/cachePolicy.js';
import { createCacheStore } from '../../data/storage/cacheStore.js';
import { WRITE_SKIPPED } from '../../data/storage/cacheKernel.js';
import { DEFAULT_CLIENT_POLICY } from '../../data/api/clientPolicy.js';
import { imageKey } from '../../data/records/imageRecord.js';
import { createLibrarySync } from './librarySync.js';
import {
  beginLibraryWindowRequest,
  beginLibraryWindowRevalidation,
  createLibraryWindow,
  nextRetainedRequest,
  rejectLibraryWindowRequest,
  removeFromLibraryWindow,
  resolveLibraryWindowNotModified,
  resolveLibraryWindowRequest,
  resolveLibraryWindowRevalidation,
} from './libraryWindow.js';
import { isExactRecord } from '../../data/records/exactRecords.js';

const aborted = (error) => error?.name === 'AbortError';
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;

const UNAVAILABLE_MESSAGE =
  'The server capabilities could not be read, so the library is not requested.';
const FORBIDDEN_MESSAGE =
  'The library refused the request. Saved copies are shown and may be out of date.';
const MALFORMED_MESSAGE = 'The library response was unreadable.';
const WINDOW_CACHE_WARNING =
  'This page could not be saved on this device, so it may be unavailable offline.';
const CACHE_WARNING =
  'The image was deleted, but its saved copy on this device could not be cleared.';

const initialState = {
  /** Wire records exactly as the server returned them, newest first. */
  items: [],
  /** `loading` until the first read ends; `error` keeps the last good items. */
  status: 'loading',
  error: null,
  errorDetail: null,
  watermarkSettings: null,
  /** Progress of the bulk analysis batch (`completion_scope: 'analysis'`), if any. */
  watermarkBackfill: null,
  /** Set when a delete worked on the server but the local copy was not cleared. */
  cacheWarning: null,
};

/**
 * The last resolved source. While capabilities reload (`pending`) the previous
 * source stays in force so sync and the shown images are not torn down.
 */
function useLatchedSource(source) {
  const [latched, setLatched] = useState(source);
  if (source !== SOURCE.PENDING && source !== latched) setLatched(source);
  return source === SOURCE.PENDING ? latched : source;
}

/**
 * The saved-image repository: one place that owns the canonical list (A12),
 * its ETag, the browser cache of it, and identity-exact deletion (A15).
 *
 * - `source` (from capabilities only) decides what may be requested. `pending`
 *   and `private` make no library, event-stream or cache request at all;
 *   `unavailable` asks the caller to retry capabilities instead.
 * - Shared: cached images are shown first, then the server list reconciles.
 *   A 200 with an `images` array (even `[]`) is authoritative and is stored; a
 *   304 keeps what is shown; a failed, unreadable or 403 read keeps the images
 *   and the stored copy and reports the error beside them.
 * - Only the newest read applies. Inserting or deleting also invalidates reads
 *   already in flight, here and (through the store) in other tabs.
 * - A 403 stops automatic refreshes, reports, and asks for capabilities once;
 *   only a capabilities change can resume them or change the source.
 * - A deleted image is removed by storage identity, never by position or title.
 *
 * @param {object} [options]
 * @param {'pending'|'unavailable'|'shared'|'private'} [options.source]
 * @param {string|null} [options.scopeKey] listing identity from `scopeKeyOf`
 * @param {ReturnType<typeof createCacheStore>} [options.store] defaults to no storage
 * @param {{enabled: boolean, timing: object, pollMs: number|null, pauseOnPointer: boolean}|null} [options.sync]
 * @param {() => void} [options.refreshCapabilities] called on 403 and when `unavailable`
 */
export function useLibrary({
  source: requestedSource = SOURCE.SHARED,
  scopeKey = null,
  store: providedStore = null,
  sync = null,
  refreshCapabilities = null,
  paged = false,
  surface = null,
  retainWindow = false,
  windowBinding = undefined,
  sessionSurface = false,
} = {}) {
  const source = useLatchedSource(requestedSource);
  const [fallbackStore] = useState(() =>
    createCacheStore(null, DEFAULT_CLIENT_POLICY.cache),
  );
  const store = providedStore ?? fallbackStore;
  const [state, setState] = useState(initialState);
  const [windowState, setWindowState] = useState(() =>
    createLibraryWindow(windowBinding),
  );
  const [restoreRecord, setRestoreRecord] = useState(null);
  const [replacedRecord, setReplacedRecord] = useState(null);
  const [halted, setHalted] = useState(false);
  /**
   * Counts invalidations (stream, polling, Retry) for a surface that reads its
   * own bounded data (the shared Gallery's sessions): nothing is listed here.
   */
  const [changeTick, setChangeTick] = useState(0);
  // One window per browsing surface. The swap happens while rendering, so no
  // effect of the new surface ever sees the previous surface's rows.
  const [surfaceWindows, setSurfaceWindows] = useState({});
  const [windowSurface, setWindowSurface] = useState(surface);
  if (surface !== windowSurface) {
    setSurfaceWindows({
      ...surfaceWindows,
      [windowSurface]: { ...windowState, pending: null },
    });
    setWindowSurface(surface);
    setWindowState(
      surfaceWindows[surface] ?? createLibraryWindow(windowBinding),
    );
  }
  const syncRef = useRef(null);
  const etag = useRef(null);
  const readToken = useRef(0);
  const inflight = useRef(null);
  const alive = useRef(true);
  const haltedRef = useRef(false);
  const live = useRef({});
  const windowRef = useRef(windowState);
  const windowToken = useRef(0);
  const windowController = useRef(null);
  const loadWindowRef = useRef(null);
  const windowScope = useRef(scopeKey);
  const halt = useCallback((on) => {
    haltedRef.current = on;
    setHalted(on);
  }, []);
  useLayoutEffect(() => {
    live.current = {
      source,
      scopeKey,
      store,
      refreshCapabilities,
      paged,
      retainWindow,
      sessionSurface,
    };
    windowRef.current = windowState;
  });
  // A request of the previous surface can no longer land anywhere.
  useLayoutEffect(() => {
    windowToken.current += 1;
    windowController.current?.abort();
    windowController.current = null;
  }, [windowSurface]);

  const applyWindow = useCallback((next) => {
    windowRef.current = next;
    setWindowState(next);
  }, []);

  const loadWindow = useCallback(
    async (intent = {}) => {
      const { source: now, scopeKey: scope, store: cache } = live.current;
      if (now !== SOURCE.SHARED || !live.current.paged) return;
      const token = ++windowToken.current;
      windowController.current?.abort();
      windowController.current = null;
      const direction = intent.direction ?? 'first';
      const binding = createLibraryWindow(
        intent.binding ?? windowRef.current.binding,
      ).binding;
      const retain = live.current.retainWindow;
      const normalizedIntent = { ...intent, binding, retain };
      let current = windowRef.current;
      if (windowScope.current !== scope) {
        windowScope.current = scope;
        setSurfaceWindows({});
        halt(false);
        current = createLibraryWindow(binding);
        applyWindow(current);
        await cache.clearLibraryWindow();
        if (token !== windowToken.current) return;
      }
      const bindingChanged =
        JSON.stringify(current.binding) !== JSON.stringify(binding);
      if (direction === 'first' && (!current.pages.length || bindingChanged)) {
        const cached = await cache.hydrateLibraryWindow(scope, binding);
        if (token !== windowToken.current) return;
        if (cached) {
          current = {
            ...createLibraryWindow(binding),
            ...cached,
            nextTicket: current.nextTicket,
            pending: null,
            error: null,
            errorDetail: null,
          };
          applyWindow(current);
        }
      }
      // A strip revalidates all its retained pages as one contiguous range.
      const revalidating =
        retain && direction === 'refresh' && current.pages.length > 0;
      const started = revalidating
        ? beginLibraryWindowRevalidation(current)
        : beginLibraryWindowRequest(current, normalizedIntent);
      applyWindow(started.state);
      if (!started.request || started.ticket === null) return;
      const controller = new AbortController();
      windowController.current = controller;
      try {
        const readTicket = await cache.beginRead();
        if (controller.signal.aborted || token !== windowToken.current) return;
        const matchingPage = current.pages.find(
          (page) =>
            JSON.stringify(page.requestParams) ===
            JSON.stringify(started.request),
        );
        const etag = matchingPage?.etag ?? null;
        const result = await api.libraryPage(started.request, {
          etag,
          signal: controller.signal,
        });
        if (controller.signal.aborted || token !== windowToken.current) return;
        const reads = [
          {
            page: result.page,
            etag: result.etag,
            requestParams: started.request,
          },
        ];
        if (revalidating && !result.notModified)
          while (reads.length < started.pageCount) {
            const previous = reads[reads.length - 1].page;
            if (!previous?.next_cursor) break;
            const requestParams = nextRetainedRequest(current, previous);
            const next = await api.libraryPage(requestParams, {
              signal: controller.signal,
            });
            if (controller.signal.aborted || token !== windowToken.current)
              return;
            reads.push({ page: next.page, etag: next.etag, requestParams });
          }
        const resolved = result.notModified
          ? resolveLibraryWindowNotModified(
              windowRef.current,
              started.ticket,
              result.etag,
            )
          : revalidating
            ? resolveLibraryWindowRevalidation(
                windowRef.current,
                started.ticket,
                reads,
              )
            : resolveLibraryWindowRequest(
                windowRef.current,
                started.ticket,
                result.page,
                result.etag,
              );
        if (!resolved.accepted) return;
        const landed = resolved.state.pages[resolved.state.activeIndex];
        if (
          !result.notModified &&
          landed?.count === 0 &&
          landed.total > 0 &&
          !intent.emptyRetry
        ) {
          // Concurrent deletions emptied this range: return toward real rows
          // instead of reporting an empty library.
          applyWindow(resolved.state);
          void loadWindowRef.current?.({
            direction: landed.previous_cursor
              ? 'backward'
              : landed.next_cursor
                ? 'forward'
                : 'first',
            binding,
            emptyRetry: true,
          });
          return;
        }
        let saveFailed = false;
        if (!result.notModified) {
          const persisted = await cache.persistLibraryWindow(
            scope,
            resolved.state,
            readTicket,
          );
          if (controller.signal.aborted || token !== windowToken.current)
            return;
          if (persisted.stale) {
            // Repeat what was asked for: a person's navigation is not a refresh.
            void loadWindowRef.current?.({ ...intent, binding });
            return;
          }
          saveFailed =
            persisted.reason === WRITE_SKIPPED.OVERSIZE ||
            persisted.reason === WRITE_SKIPPED.FAILED;
        }
        applyWindow(resolved.state);
        halt(false);
        if (resolved.state.error) {
          setState((prev) => ({
            ...prev,
            status: 'error',
            error: resolved.state.error.message,
            errorDetail: preserveError(resolved.state.error),
          }));
          return;
        }
        // The head of the catalog now decides what a just-saved image shows as.
        const atHead =
          !result.notModified &&
          resolved.state.pages[0]?.previous_cursor === null;
        setState((prev) => ({
          ...prev,
          items: atHead ? [] : prev.items,
          status: resolved.state.pages.length ? 'ready' : 'loading',
          error: null,
          errorDetail: null,
          cacheWarning: saveFailed
            ? WINDOW_CACHE_WARNING
            : prev.cacheWarning === WINDOW_CACHE_WARNING
              ? null
              : prev.cacheWarning,
          cacheWarningDetail: saveFailed
            ? preserveError(WINDOW_CACHE_WARNING)
            : prev.cacheWarning === WINDOW_CACHE_WARNING
              ? null
              : prev.cacheWarningDetail,
          // Cursor pages omit the envelope; an explicit null means no batch.
          watermarkBackfill:
            result.page && Object.hasOwn(result.page, 'watermark_backfill')
              ? result.page.watermark_backfill
              : prev.watermarkBackfill,
        }));
      } catch (error) {
        if (
          aborted(error) ||
          controller.signal.aborted ||
          token !== windowToken.current
        )
          return;
        // The image a strip was opened around is gone or out of scope: the
        // strip falls back to the head without broadening anything.
        if (
          retain &&
          error.status === HTTP_NOT_FOUND &&
          (direction === 'around' || revalidating)
        ) {
          applyWindow(createLibraryWindow(binding));
          void loadWindowRef.current?.({ direction: 'first', binding });
          return;
        }
        if (
          error.status === 409 &&
          direction !== 'first' &&
          !intent.conflictRetry
        ) {
          applyWindow(createLibraryWindow(binding));
          setState((prev) => ({ ...prev, status: 'loading', error: null }));
          void cache.clearLibraryWindow().then(() => {
            if (token === windowToken.current)
              loadWindowRef.current?.({
                direction: 'first',
                binding,
                conflictRetry: true,
              });
          });
          return;
        }
        if (error.status === HTTP_FORBIDDEN) {
          halt(true);
          live.current.refreshCapabilities?.();
        }
        const failure =
          error.status === HTTP_FORBIDDEN
            ? new Error(FORBIDDEN_MESSAGE)
            : error;
        const rejected = rejectLibraryWindowRequest(
          windowRef.current,
          started.ticket,
          failure,
        );
        if (rejected.accepted) {
          applyWindow(rejected.state);
          setState((prev) => ({
            ...prev,
            status: 'error',
            error: failure.message,
            errorDetail: preserveError(error),
          }));
        }
      }
    },
    [applyWindow, halt],
  );
  useLayoutEffect(() => {
    loadWindowRef.current = loadWindow;
  }, [loadWindow]);

  const loadLibraryRecord = useCallback(async (summary, { signal } = {}) => {
    if (live.current.source !== SOURCE.SHARED)
      throw new Error('Full shared-library detail is unavailable.');
    const id = summary.id ?? summary.image_id;
    if (typeof id !== 'string' || !id)
      throw new Error('The selected image identity is unavailable.');
    const key = imageKey(summary);
    const stored = await live.current.store.getLibraryDetail(key);
    // A stored copy that is not a full record is never revalidated into use.
    const cached = stored && isExactRecord(stored.record) ? stored : null;
    let result;
    try {
      result = await api.libraryRecord(id, {
        etag: cached?.etag,
        signal,
      });
    } catch (error) {
      // Saved records are immutable, so an unreachable server can still restore
      // an exact stored copy. A refusal or a missing image is never overruled.
      if (cached && error.network && !aborted(error)) return cached.record;
      throw error;
    }
    const record = result.notModified ? cached?.record : result.record;
    if (
      !record ||
      record.listing_kind === 'summary-page' ||
      !isExactRecord(record) ||
      imageKey(record) !== key
    )
      throw new Error('The selected image details were unreadable.');
    if (!result.notModified) {
      // Persistence is best-effort. A slow browser transaction must not keep
      // the exact server record in a loading state or block its actions.
      void live.current.store
        .putLibraryDetail(record, result.etag, { pinned: new Set([key]) })
        .catch(() => {});
    }
    return record;
  }, []);

  /** The exact record of an edit link: its identity is the target, verbatim. */
  const loadLibraryRecordById = useCallback(async (id, { signal } = {}) => {
    if (live.current.source !== SOURCE.SHARED)
      throw new Error('Full shared-library detail is unavailable.');
    const result = await api.libraryRecord(id, { signal });
    const { record } = result;
    if (
      !record ||
      !isExactRecord(record) ||
      (record.id !== id && record.image_id !== id)
    )
      throw new Error('The selected image details were unreadable.');
    void live.current.store
      .putLibraryDetail(record, result.etag, {
        pinned: new Set([imageKey(record)]),
      })
      .catch(() => {});
    return record;
  }, []);

  const rememberRecordForRestore = useCallback((record) => {
    if (record && Array.isArray(record.selected_controls))
      setRestoreRecord(record);
  }, []);

  /** Abort the read in flight and make its result ignorable. */
  const invalidateReads = useCallback(() => {
    readToken.current += 1;
    inflight.current?.abort();
    inflight.current = null;
    return readToken.current;
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      inflight.current?.abort();
      windowToken.current += 1;
      windowController.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (paged && source === SOURCE.SHARED) return undefined;
    windowToken.current += 1;
    windowController.current?.abort();
    windowController.current = null;
    return undefined;
  }, [paged, source]);

  /**
   * One read of the shared list. `automatic` reads (stream, polling) are
   * skipped while the library is refusing us; a person's retry is not.
   */
  const readOnce = useCallback(
    async ({ automatic }) => {
      const { source: now, scopeKey: scope, store: cache } = live.current;
      if (now === SOURCE.UNAVAILABLE) {
        live.current.refreshCapabilities?.();
        return;
      }
      if (now !== SOURCE.SHARED) return;
      if (automatic && haltedRef.current) return;
      const token = invalidateReads();
      const controller = new AbortController();
      inflight.current = controller;
      const current = () => alive.current && readToken.current === token;
      try {
        const ticket = await cache.beginRead();
        if (!current()) return;
        const result = await api.library({
          etag: etag.current,
          signal: controller.signal,
        });
        if (!current()) return;
        if (result.notModified) {
          inflight.current = null;
          halt(false);
          setState((prev) => ({ ...prev, status: 'ready', error: null }));
          return;
        }
        const library = result.library;
        if (!Array.isArray(library?.images)) throw new Error(MALFORMED_MESSAGE);
        const watermarkSettings = library.watermark_settings ?? null;
        const commit = await cache.commitListing(scope, ticket, {
          images: library.images,
          etag: result.etag,
          watermarkSettings,
        });
        if (!current()) return;
        inflight.current = null;
        halt(false);
        // A list that was filtered or raced is not what the ETag describes.
        etag.current =
          commit.stale || commit.images.length !== library.images.length
            ? null
            : result.etag;
        setState((prev) => ({
          ...prev,
          items: commit.images,
          status: 'ready',
          error: null,
          errorDetail: null,
          watermarkSettings,
          watermarkBackfill: library.watermark_backfill ?? null,
        }));
        // The authoritative full list now decides whether that record exists.
        setRestoreRecord(null);
        return commit.stale;
      } catch (error) {
        if (aborted(error) || !current()) return;
        inflight.current = null;
        const forbidden = error.status === HTTP_FORBIDDEN;
        if (forbidden) {
          halt(true);
          live.current.refreshCapabilities?.();
        }
        setState((prev) => ({
          ...prev,
          status: 'error',
          error: forbidden ? FORBIDDEN_MESSAGE : error.message,
          errorDetail: preserveError(error),
        }));
      }
    },
    [invalidateReads, halt],
  );

  /** A read that raced a mutation is repeated once, with a fresh ticket. */
  const readLibrary = useCallback(
    async (options = {}) => {
      if (
        live.current.sessionSurface &&
        live.current.source === SOURCE.SHARED
      ) {
        if (options.automatic && haltedRef.current) return;
        setChangeTick((tick) => tick + 1);
        return;
      }
      if (live.current.paged && live.current.source === SOURCE.SHARED) {
        if (options.automatic && haltedRef.current) return;
        await loadWindow({ direction: 'refresh' });
        return;
      }
      if (await readOnce(options)) await readOnce(options);
    },
    [loadWindow, readOnce],
  );

  // Source or scope changed (or the first time they are known): show the stored
  // list first, then reconcile with the server.
  const shownScope = useRef(undefined);
  useEffect(() => {
    if (source !== SOURCE.SHARED || paged || sessionSurface) return undefined;
    let cancelled = false;
    haltedRef.current = false;
    (async () => {
      const cached = await store.hydrate(scopeKey);
      if (cancelled) return;
      setHalted(false);
      const scopeChanged =
        shownScope.current !== undefined && shownScope.current !== scopeKey;
      shownScope.current = scopeKey;
      etag.current = cached?.etag ?? null;
      setState((prev) =>
        prev.items.length && !scopeChanged
          ? prev
          : {
              ...prev,
              items: cached?.items ?? [],
              watermarkSettings:
                cached?.watermarkSettings ?? prev.watermarkSettings,
            },
      );
      readLibrary({ automatic: false });
    })();
    return () => {
      cancelled = true;
      invalidateReads();
    };
  }, [
    source,
    scopeKey,
    store,
    readLibrary,
    invalidateReads,
    paged,
    sessionSurface,
  ]);

  // Not shared: no library request. Show what is already in memory.
  const previousSource = useRef(source);
  useEffect(() => {
    const before = previousSource.current;
    previousSource.current = source;
    if (source === SOURCE.PRIVATE) {
      invalidateReads();
      etag.current = null;
      // Images of a shared listing do not belong to a private history.
      setState((prev) => ({
        ...prev,
        items: before === SOURCE.SHARED ? [] : prev.items,
        status: 'ready',
        error: null,
        errorDetail: null,
      }));
    } else if (source === SOURCE.UNAVAILABLE) {
      invalidateReads();
      setState((prev) => ({
        ...prev,
        status: 'error',
        error: UNAVAILABLE_MESSAGE,
        errorDetail: null,
      }));
    }
  }, [source, invalidateReads]);

  const reload = useCallback(
    () => readLibrary({ automatic: false }),
    [readLibrary],
  );

  const syncEnabled =
    Boolean(sync?.enabled) && source === SOURCE.SHARED && !halted;
  const syncTiming = sync?.timing;
  useEffect(() => {
    if (!syncEnabled) return undefined;
    const controller = createLibrarySync({
      refresh: () => readLibrary({ automatic: true }),
      timing: syncTiming,
    });
    syncRef.current = controller;
    return () => {
      controller.close();
      syncRef.current = null;
    };
  }, [syncEnabled, syncTiming, readLibrary]);

  const pollMs = sync?.pollMs ?? null;
  const pauseOnPointer = Boolean(sync?.pauseOnPointer);
  useEffect(() => {
    syncRef.current?.setPolling(pollMs, pauseOnPointer);
  }, [syncEnabled, syncTiming, readLibrary, pollMs, pauseOnPointer]);

  /**
   * Show a newly saved record at once. It is stored with the next
   * authoritative server read, never from here.
   */
  const insert = useCallback(
    (record) => {
      invalidateReads();
      etag.current = null;
      live.current.store.noteMutation();
      if (live.current.paged) {
        windowToken.current += 1;
        windowController.current?.abort();
        windowController.current = null;
      }
      setState((prev) => ({
        ...prev,
        status: 'ready',
        error: null,
        errorDetail: null,
        items: [
          record,
          ...prev.items.filter((item) => imageKey(item) !== imageKey(record)),
        ],
      }));
    },
    [invalidateReads],
  );

  /**
   * Swap in a record the server just returned (analysis or prepared file) at
   * its own identity. A record that is no longer listed is not brought back.
   */
  const replace = useCallback(
    async (record) => {
      invalidateReads();
      etag.current = null;
      setReplacedRecord(record);
      if (live.current.sessionSurface) {
        await live.current.store.putLibraryDetail(record, null);
        setChangeTick((tick) => tick + 1);
        return;
      }
      if (live.current.paged) {
        await live.current.store.putLibraryDetail(record, null);
        await loadWindow({ direction: 'refresh' });
        return;
      }
      live.current.store.putRecord(live.current.scopeKey, record);
      const key = imageKey(record);
      setState((prev) => ({
        ...prev,
        items: prev.items.map((item) =>
          imageKey(item) === key ? record : item,
        ),
      }));
    },
    [invalidateReads, loadWindow],
  );

  /** Show settings the server just returned; a following reload reconciles records. */
  const applySettings = useCallback((settings) => {
    setState((prev) => ({ ...prev, watermarkSettings: settings }));
  }, []);

  /**
   * Delete one saved image. The server goes first and a failure changes
   * nothing; a 404 means it is already gone. The local copy is then cleared; if
   * only that fails, the image is still removed from view and the state's
   * `cacheWarning` says so.
   * @returns {Promise<string|null>} an error message, or null when deleted
   */
  const remove = useCallback(
    async (record) => {
      const deleted = imageKey(record);
      setState((prev) =>
        prev.removeErrorDetail ? { ...prev, removeErrorDetail: null } : prev,
      );
      const sharedFile = live.current.source !== SOURCE.PRIVATE;
      if (sharedFile) {
        try {
          await api.deleteLibraryImage(record);
        } catch (error) {
          if (error.status !== HTTP_NOT_FOUND) {
            setState((prev) => ({
              ...prev,
              removeErrorDetail: preserveError(error),
            }));
            return error.message;
          }
        }
      }
      // The in-tab tombstone is set by this call, before anything is awaited.
      const cleanup = sharedFile
        ? live.current.store.purgeShared(deleted)
        : Promise.resolve();
      if (live.current.paged) {
        windowToken.current += 1;
        windowController.current?.abort();
        windowController.current = null;
      }
      invalidateReads();
      etag.current = null;
      applyWindow(
        removeFromLibraryWindow(windowRef.current, deleted, imageKey),
      );
      setSurfaceWindows((windows) =>
        Object.fromEntries(
          Object.entries(windows).map(([name, held]) => [
            name,
            removeFromLibraryWindow(held, deleted, imageKey),
          ]),
        ),
      );
      setRestoreRecord((held) =>
        held && imageKey(held) === deleted ? null : held,
      );
      if (alive.current)
        setState((prev) => ({
          ...prev,
          cacheWarning: null,
          cacheWarningDetail: null,
          items: prev.items.filter((item) => imageKey(item) !== deleted),
        }));
      try {
        await cleanup;
      } catch (error) {
        if (alive.current)
          setState((prev) => ({
            ...prev,
            cacheWarning: CACHE_WARNING,
            cacheWarningDetail: preserveError(error),
          }));
      }
      if (live.current.paged) await loadWindow({ direction: 'refresh' });
      return null;
    },
    [applyWindow, invalidateReads, loadWindow],
  );

  return {
    images: state,
    source,
    reload,
    insert,
    replace,
    applySettings,
    remove,
    libraryWindow: windowState,
    loadLibraryWindow: loadWindow,
    loadLibraryRecord,
    loadLibraryRecordById,
    restoreRecord,
    rememberRecordForRestore,
    replacedRecord,
    changeTick,
  };
}
