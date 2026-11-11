import { preserveError } from '../../shared/diagnostics/diagnostics.js';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { api } from '../../data/api/api.js';
import { speedIntervalMs } from '../../data/records/browse.js';
import { maxSpan } from './galleryFilmstrip.js';
import { dwellMs } from './galleryPlayback.js';
import {
  arriveWindow,
  cancelPending,
  createSessionWindow,
  extendWindow,
  failWindow,
  forgetWindowFailures,
  GALLERY_MAX_WINDOW_ROWS,
  GALLERY_PREFETCH_ROWS,
  GALLERY_SESSION_PAGE_MAX,
  isStalled,
  openWindow,
  peekWindowNext,
  prefetchNeed,
  readyWindow,
  resumePending,
  revalidateWindow,
  selectWindow,
  stepWindow,
  validSessionPage,
  WINDOW_NEED,
} from './gallerySession.js';
import {
  describeImage,
  imageKey,
  isLocalOnly,
} from '../../data/records/imageRecord.js';

/** First wait between status reads while a session builds; doubles to the cap. */
export const SESSION_BUILD_POLL_INITIAL_MS = 250;
export const SESSION_BUILD_POLL_MAX_MS = 1000;
/** Fast initial reads are limited to this many status responses. */
export const SESSION_PREVIEW_POLL_COUNT = 3;
export const SESSION_PREVIEW_POLL_INITIAL_MS = 100;
/** Capacity (429) retries before the session error is shown. */
export const SESSION_CAPACITY_MAX_ATTEMPTS = 3;
/** Longest honoured Retry-After, and the wait when none is sent. */
export const SESSION_CAPACITY_MAX_WAIT_MS = 30000;
export const SESSION_CAPACITY_DEFAULT_WAIT_MS = 2000;
/** Replacement sessions after expiry before recovery waits for Retry. */
export const SESSION_RECOVERY_MAX_ATTEMPTS = 2;
/** A lease is renewed once this share of its duration has passed. */
export const SESSION_RENEW_FRACTION = 0.5;
/** Longest interval between lease checks. */
export const SESSION_RENEW_CHECK_MAX_MS = 30000;
/** Newest rows read per enabled shape to recognise new images. */
export const ARRIVAL_HEAD_LIMIT = 8;
/** Image keys remembered as already seen at the head. */
export const ARRIVAL_KNOWN_LIMIT = 256;
const MILLISECONDS_PER_SECOND = 1000;

const HTTP_ACCEPTED = 202;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_GONE = 410;
const HTTP_TOO_MANY = 429;

const MESSAGES = {
  busy: 'The gallery is at its session limit. Try again shortly.',
  failed: 'The gallery order could not be prepared.',
  forbidden: 'The library refused the request.',
  unreadable: 'The gallery response was unreadable.',
  expired: 'The gallery order expired and could not be replaced.',
};

const aborted = (error) => error?.name === 'AbortError';
/** A session that the server no longer has (expired, released or changed). */
const lostSession = (error) =>
  [HTTP_GONE, HTTP_NOT_FOUND, HTTP_CONFLICT].includes(error?.status);

const recordId = (record) => {
  const id = record?.id ?? record?.image_id;
  return typeof id === 'string' && id && !isLocalOnly(record) ? id : null;
};

/** A compact, usable summary from the optional building response field. */
export function validGalleryPreview(value) {
  const record = value?.snapshot_revision && value?.image;
  if (!record || typeof record !== 'object' || Array.isArray(record))
    return null;
  const id = record.id ?? record.image_id;
  if (typeof id !== 'string' || !id || isLocalOnly(record)) return null;
  const key = imageKey(record);
  return key && key !== 'undefined' ? record : null;
}

const previewIdentity = (record) =>
  JSON.stringify([
    imageKey(record),
    record.sha256 ?? record.source_sha256 ?? null,
  ]);

class Superseded extends Error {
  constructor() {
    super('superseded');
    this.name = 'Superseded';
  }
}

/**
 * The shared Gallery's playback over one bounded server shuffle session.
 *
 * Lifecycle: a session is created per view (scope, event, shapes); the first
 * opening is unbiased, while a view change, an expiry recovery or a returned
 * tab anchors rank zero on the image being shown so its pixels stay. Obsolete
 * sessions are released, including one whose creation answered late. Leases
 * are renewed while the page is visible; a lost session is replaced a bounded
 * number of times. Reaching the end of the session starts the next cycle with
 * a new session that does not open on the image just shown.
 *
 * Every catalog change (a new `revision`) re-reads the retained rows and the
 * newest rows of the enabled shapes; new eligible images are spliced in after
 * the current row (featured with the hold while playing).
 *
 * @param {object} options
 * @param {boolean} options.active the view's scope is settled and sessions are offered
 * @param {string|null} options.eventName the chosen event, or null for all
 * @param {string[]|null} options.orientations enabled shapes, null for all
 * @param {number} options.visibleCount images the counts say match the view
 * @param {number|null} options.revision current catalog revision (from the counts)
 * @param {{initial: number, batch: number}} options.limits filmstrip policy
 * @param {number|null} options.ttlSeconds published lease duration
 * @param {object|null} [options.capabilities] `shared_library.shuffle_sessions`:
 *   `renewal_enabled` and `first_image_enabled` false turn those requests off;
 *   `max_limit` lowers the page size
 * @param {boolean} options.playing
 * @param {number} options.speedSeconds
 * @param {number} options.holdMs
 * @param {() => void} [options.onForbidden]
 */
export function useGallerySession({
  active,
  eventName,
  orientations,
  visibleCount,
  revision,
  limits,
  ttlSeconds,
  capabilities = null,
  playing,
  speedSeconds,
  holdMs,
  onForbidden,
}) {
  const renewal = capabilities?.renewal_enabled !== false;
  const anchoring = capabilities?.first_image_enabled !== false;
  const publishedMax = capabilities?.max_limit;
  const pageMax =
    Number.isInteger(publishedMax) && publishedMax > 0
      ? Math.min(GALLERY_SESSION_PAGE_MAX, publishedMax)
      : GALLERY_SESSION_PAGE_MAX;
  // The filmstrip policy shapes the window, within fixed DOM and page bounds.
  const maxRows = Math.min(GALLERY_MAX_WINDOW_ROWS, maxSpan(limits));
  const pageLimits = {
    initial: Math.max(1, Math.min(pageMax, limits.initial)),
    batch: Math.max(1, Math.min(pageMax, limits.batch)),
  };
  // A small opening count is not doubled by an immediate read beyond it.
  const prefetchRows = Math.max(
    1,
    Math.min(GALLERY_PREFETCH_ROWS, Math.floor(pageLimits.initial / 2)),
  );
  const [win, setWin] = useState(createSessionWindow);
  const [phase, setPhase] = useState({ status: 'idle', error: null });
  const [preview, setPreview] = useState(null);
  const previewRecord = useRef(null);
  const failedPreview = useRef(null);
  const winRef = useRef(win);
  const live = useRef({});
  useLayoutEffect(() => {
    live.current = {
      eventName,
      orientations,
      visibleCount,
      limits: pageLimits,
      pageMax,
      anchoring,
      maxRows,
      playing,
      ttlSeconds,
      onForbidden,
    };
  });

  /** Apply a pure change now; async callers see it at once. */
  const apply = useCallback((change) => {
    const next = change(winRef.current);
    if (next === winRef.current) return next;
    winRef.current = next;
    setWin(next);
    return next;
  }, []);

  // --- Session ownership ------------------------------------------------------
  /** `{id, eventName, renewedAt, ttlMs}` of the session in use. */
  const session = useRef(null);
  /** Changes whenever the session in use is replaced; older work stops. */
  const generation = useRef(0);
  const waits = useRef(new Set());
  const queue = useRef(Promise.resolve());
  const recoveries = useRef(0);
  const inflight = useRef({ forward: false, backward: false });
  const heads = useRef({ known: null, newest: null });
  const mounted = useRef(true);

  const wait = useCallback((ms) => {
    return new Promise((resolve) => {
      const entry = { resolve, timer: null };
      entry.timer = setTimeout(() => {
        waits.current.delete(entry);
        resolve();
      }, ms);
      waits.current.add(entry);
    });
  }, []);
  const stopWaits = () => {
    for (const entry of waits.current) {
      clearTimeout(entry.timer);
      entry.resolve();
    }
    waits.current.clear();
  };

  const release = useCallback((held, { keepalive = false } = {}) => {
    if (!held) return;
    api
      .releaseGallerySession(held.id, { eventName: held.eventName, keepalive })
      .catch(() => {
        // Expiry reclaims a session whose release did not arrive.
      });
  }, []);

  /** Give up the session in use; anything it started stops applying. */
  const abandon = useCallback(
    (options) => {
      generation.current += 1;
      stopWaits();
      // Work of the abandoned session stops at its next guard; the next
      // session does not wait behind it (a request that never answers).
      queue.current = Promise.resolve();
      const held = session.current;
      session.current = null;
      previewRecord.current = null;
      failedPreview.current = null;
      setPreview(null);
      inflight.current = { forward: false, backward: false };
      release(held, options);
    },
    [release],
  );

  /** Run window work one task at a time, in order. */
  const enqueue = useCallback((task) => {
    const run = queue.current.then(task, task);
    queue.current = run.catch(() => {});
    return run;
  }, []);

  const guard = (owner) => {
    if (owner !== generation.current || !mounted.current)
      throw new Superseded();
  };

  const forbid = useCallback((error = null) => {
    setPhase({
      status: 'error',
      error: MESSAGES.forbidden,
      errorDetail: error ? preserveError(error) : null,
    });
    live.current.onForbidden?.();
  }, []);

  const report = useCallback(
    (error) => {
      if (error instanceof Superseded || aborted(error)) return;
      if (error?.status === HTTP_FORBIDDEN) {
        forbid(error);
        return;
      }
      setPhase((now) => ({
        status: now.status === 'ready' ? 'ready' : 'error',
        error: error.message,
        errorDetail: preserveError(error),
      }));
    },
    [forbid],
  );

  /** Read a page of the session in use, waiting while it builds. */
  const readPage = useCallback(
    async (owner, params) => {
      guard(owner);
      const held = session.current;
      if (!held) throw new Superseded();
      let delay = SESSION_BUILD_POLL_INITIAL_MS;
      let fastReads = 0;
      for (;;) {
        guard(owner);
        const result = await api.readGallerySession(held.id, {
          ...params,
          eventName: held.eventName,
        });
        guard(owner);
        if (result.status === HTTP_ACCEPTED) {
          // Older servers omit this optional field. Omission also withdraws a
          // candidate that the server can no longer guarantee is current.
          const candidate = validGalleryPreview(result.session?.preview);
          const identity = candidate ? previewIdentity(candidate) : null;
          if (identity && failedPreview.current !== identity)
            failedPreview.current = null;
          previewRecord.current =
            identity && failedPreview.current === identity ? null : candidate;
          setPreview(previewRecord.current);
          setPhase((now) =>
            now.status === 'ready' ? now : { status: 'building', error: null },
          );
          const waitMs =
            fastReads < SESSION_PREVIEW_POLL_COUNT
              ? SESSION_PREVIEW_POLL_INITIAL_MS * 2 ** fastReads
              : delay;
          fastReads += 1;
          await wait(waitMs);
          if (fastReads > SESSION_PREVIEW_POLL_COUNT)
            delay = Math.min(delay * 2, SESSION_BUILD_POLL_MAX_MS);
          continue;
        }
        previewRecord.current = null;
        setPreview(null);
        const page = result.session;
        if (page?.state === 'failed') {
          const failure = new Error(page.error || MESSAGES.failed);
          failure.sessionFailed = true;
          throw failure;
        }
        if (!validSessionPage(page)) throw new Error(MESSAGES.unreadable);
        return page;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [wait],
  );

  /** POST a session, honouring capacity limits a bounded number of times. */
  const create = useCallback(
    async (owner, anchorId) => {
      const { eventName: scope, orientations: shapes } = live.current;
      for (let attempt = 1; ; attempt += 1) {
        guard(owner);
        let created;
        try {
          created = await api.createGallerySession({
            eventName: scope,
            orientations: shapes,
            firstImageId: live.current.anchoring ? anchorId : null,
          });
        } catch (error) {
          guard(owner);
          if (
            error.status !== HTTP_TOO_MANY ||
            attempt >= SESSION_CAPACITY_MAX_ATTEMPTS
          ) {
            if (error.status === HTTP_TOO_MANY) throw new Error(MESSAGES.busy);
            throw error;
          }
          const seconds = error.retryAfterSeconds;
          await wait(
            seconds === null || seconds === undefined
              ? SESSION_CAPACITY_DEFAULT_WAIT_MS
              : Math.min(
                  seconds * MILLISECONDS_PER_SECOND,
                  SESSION_CAPACITY_MAX_WAIT_MS,
                ),
          );
          continue;
        }
        const id = created?.session_id;
        if (typeof id !== 'string' || !id) throw new Error(MESSAGES.unreadable);
        const held = { id, eventName: scope };
        // The view changed while this was being accepted: it is not used.
        if (owner !== generation.current || !mounted.current) {
          release(held);
          throw new Superseded();
        }
        const publishedTtl = live.current.ttlSeconds;
        const ttlMs =
          Number.isFinite(publishedTtl) && publishedTtl > 0
            ? publishedTtl * MILLISECONDS_PER_SECOND
            : Math.max(
                0,
                created.expires_at * MILLISECONDS_PER_SECOND - Date.now(),
              );
        session.current = { ...held, renewedAt: Date.now(), ttlMs };
        return session.current;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [release, wait],
  );

  /** Bounded newest rows of the view, at most one read per enabled shape. */
  const readHeads = useCallback(async (owner) => {
    const { eventName: scope, orientations: shapes } = live.current;
    const reads = await Promise.all(
      (shapes ?? [null]).map((orientation) =>
        api.libraryPage({
          limit: ARRIVAL_HEAD_LIMIT,
          orientation,
          eventName: scope,
        }),
      ),
    );
    guard(owner);
    const rows = reads.flatMap((read) =>
      Array.isArray(read.page?.images) ? read.page.images : [],
    );
    return rows.sort(
      (a, b) =>
        (describeImage(b).createdAtMs ?? 0) -
        (describeImage(a).createdAtMs ?? 0),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const learnHeads = (rows) => {
    const known = new Set(heads.current.known ?? []);
    let newest = heads.current.newest;
    for (const row of rows) {
      known.add(imageKey(row));
      const at = describeImage(row).createdAtMs;
      if (at !== null) newest = Math.max(newest ?? -Infinity, at);
    }
    const kept = [...known];
    heads.current = {
      known: new Set(
        kept.slice(Math.max(0, kept.length - ARRIVAL_KNOWN_LIMIT)),
      ),
      newest,
    };
  };

  /**
   * Open a session for the view. `anchor` keeps the shown image when it is a
   * member; `avoid` keeps a new cycle from opening on the image just shown.
   */
  const openSession = useCallback(
    ({
      anchor = null,
      avoid = null,
      forget = false,
      baseline = false,
    } = {}) => {
      abandon();
      const owner = generation.current;
      setPhase((now) =>
        now.status === 'ready' ? now : { status: 'building', error: null },
      );
      return enqueue(async () => {
        try {
          guard(owner);
          const anchorId = recordId(anchor);
          await create(owner, anchorId);
          const page = await readPage(owner, {
            rank: 0,
            direction: 'forward',
            limit: live.current.limits.initial,
          });
          const keep = anchor ? imageKey(anchor) : null;
          const opened = apply((state) =>
            openWindow(state, page, {
              keep: page.first_image_member === true ? keep : null,
              avoid,
              forget,
              maxRows: live.current.maxRows,
            }),
          );
          recoveries.current = 0;
          setPhase({ status: 'ready', error: null });
          setPreview(null);
          if (baseline || heads.current.known === null) {
            try {
              learnHeads(await readHeads(owner));
            } catch (error) {
              if (error instanceof Superseded) throw error;
              // Without a baseline, arrivals are recognised from the next read.
            }
          }
          return opened;
        } catch (error) {
          if (error instanceof Superseded || aborted(error)) return null;
          previewRecord.current = null;
          setPreview(null);
          // A failed build holds a server slot until released.
          if (error.sessionFailed) abandon();
          apply(cancelPending);
          report(error);
          return null;
        }
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [abandon, apply, create, enqueue, readHeads, readPage, report],
  );

  /** The session is gone: replace it around the shown image, a bounded number of times. */
  const recover = useCallback(() => {
    session.current = null;
    if (recoveries.current >= SESSION_RECOVERY_MAX_ATTEMPTS) {
      generation.current += 1;
      apply(cancelPending);
      setPhase({ status: 'error', error: MESSAGES.expired });
      return Promise.resolve(null);
    }
    recoveries.current += 1;
    const shown = winRef.current.rows.find(
      (row) => row.key === winRef.current.current,
    );
    return openSession({ anchor: shown?.record ?? null });
  }, [apply, openSession]);

  const handleReadError = useCallback(
    (error) => {
      if (error instanceof Superseded || aborted(error)) return;
      apply(cancelPending);
      if (lostSession(error)) {
        void recover();
        return;
      }
      report(error);
    },
    [apply, recover, report],
  );

  /** Read beyond one edge of the window. */
  const loadEdge = useCallback(
    (direction) => {
      const state = winRef.current;
      const rank =
        direction === WINDOW_NEED.FORWARD ? state.nextRank : state.previousRank;
      if (rank === null || !session.current) {
        // Nothing can be read that way now; a waiting step is abandoned.
        apply(cancelPending);
        return;
      }
      if (inflight.current[direction]) return;
      inflight.current[direction] = true;
      const owner = generation.current;
      void enqueue(async () => {
        try {
          const page = await readPage(owner, {
            rank,
            direction,
            limit: live.current.limits.batch,
          });
          apply((now) =>
            resumePending(
              extendWindow(now, page, direction, {
                maxRows: live.current.maxRows,
              }),
            ),
          );
          setPhase({ status: 'ready', error: null });
        } catch (error) {
          handleReadError(error);
        } finally {
          if (owner === generation.current) inflight.current[direction] = false;
        }
      });
    },
    [apply, enqueue, handleReadError, readPage],
  );

  /** Before the first member: continue from the session's last page. */
  const wrap = useCallback(() => {
    const owner = generation.current;
    const last = winRef.current.snapshotTotal - 1;
    if (!session.current || last < 0) {
      apply(cancelPending);
      return;
    }
    void enqueue(async () => {
      try {
        const page = await readPage(owner, {
          rank: last,
          direction: 'backward',
          limit: live.current.limits.initial,
        });
        apply((now) =>
          openWindow({ ...now, pending: null }, page, {
            at: 'end',
            maxRows: live.current.maxRows,
          }),
        );
      } catch (error) {
        handleReadError(error);
      }
    });
  }, [apply, enqueue, handleReadError, readPage]);

  // --- The view's session ------------------------------------------------------
  const viewKey = JSON.stringify([eventName, orientations]);
  const emptySelection =
    Array.isArray(orientations) && orientations.length === 0;
  useEffect(() => {
    mounted.current = true;
    if (!active) return undefined;
    if (emptySelection) {
      // No shape enabled selects nothing; no session is needed for that.
      abandon();
      apply(() => createSessionWindow());
      setPhase({ status: 'ready', error: null });
      return undefined;
    }
    const state = winRef.current;
    const shown = state.rows.find((row) => row.key === state.current);
    // The first opening is unbiased; a later view keeps the shown image.
    void openSession({
      anchor: shown?.record ?? null,
      forget: true,
      baseline: true,
    });
    return () => abandon();
  }, [active, viewKey, emptySelection, abandon, apply, openSession]);

  useEffect(
    () => () => {
      mounted.current = false;
      abandon();
    },
    [abandon],
  );

  // A closing page releases its session; a page restored from the back/forward
  // cache opens a new one around the image it still shows.
  useEffect(() => {
    if (!active) return undefined;
    const onHide = () => abandon({ keepalive: true });
    const onShow = (event) => {
      if (!event.persisted || emptySelection) return;
      const state = winRef.current;
      const shown = state.rows.find((row) => row.key === state.current);
      void openSession({ anchor: shown?.record ?? null });
    };
    window.addEventListener('pagehide', onHide);
    window.addEventListener('pageshow', onShow);
    return () => {
      window.removeEventListener('pagehide', onHide);
      window.removeEventListener('pageshow', onShow);
    };
  }, [active, emptySelection, abandon, openSession]);

  // --- Lease renewal -----------------------------------------------------------
  const sessionId =
    renewal && phase.status === 'ready' ? (session.current?.id ?? null) : null;
  useEffect(() => {
    if (!sessionId) return undefined;
    let renewing = false;
    const check = () => {
      const held = session.current;
      if (!held || held.id !== sessionId || renewing) return;
      if (document.visibilityState === 'hidden') return;
      if (Date.now() - held.renewedAt < held.ttlMs * SESSION_RENEW_FRACTION)
        return;
      renewing = true;
      const owner = generation.current;
      api
        .renewGallerySession(held.id, { eventName: held.eventName })
        .then(
          () => {
            if (owner === generation.current && session.current === held)
              held.renewedAt = Date.now();
          },
          (error) => {
            if (owner !== generation.current) return;
            if (error.status === HTTP_FORBIDDEN) forbid();
            else if (lostSession(error)) void recover();
            // A network failure is tried again at the next check.
          },
        )
        .finally(() => {
          renewing = false;
        });
    };
    const held = session.current;
    const every = Math.max(
      1000,
      Math.min(
        SESSION_RENEW_CHECK_MAX_MS,
        (held?.ttlMs ?? 0) * SESSION_RENEW_FRACTION * 0.5,
      ),
    );
    const interval = setInterval(check, every);
    document.addEventListener('visibilitychange', check);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', check);
    };
  }, [sessionId, forbid, recover]);

  // --- Catalog changes -----------------------------------------------------------
  const seenRevision = useRef(null);
  useEffect(() => {
    if (!active || revision === null) return;
    const before = seenRevision.current;
    seenRevision.current = revision;
    if (before === null || before === revision || !session.current) return;
    const owner = generation.current;
    void enqueue(async () => {
      try {
        guard(owner);
        const state = winRef.current;
        const ranked = state.rows.filter((row) => !row.arrival);
        if (ranked.length) {
          const pages = [];
          let rank = ranked[0].rank;
          let wanted = ranked.length;
          while (wanted > 0 && rank !== null) {
            const limit = Math.min(live.current.pageMax, wanted);
            const page = await readPage(owner, {
              rank,
              direction: 'forward',
              limit,
            });
            pages.push(page);
            wanted -= limit;
            rank = page.next_rank;
          }
          apply((now) =>
            revalidateWindow(now, pages, { maxRows: live.current.maxRows }),
          );
        }
        const rows = await readHeads(owner);
        const { known, newest } = heads.current;
        const arrivals = known
          ? rows.filter((row) => {
              const at = describeImage(row).createdAtMs;
              return (
                !known.has(imageKey(row)) &&
                (at === null || newest === null || at >= newest)
              );
            })
          : [];
        learnHeads(rows);
        if (arrivals.length)
          apply((now) =>
            arriveWindow(now, arrivals, live.current.playing, {
              maxRows: live.current.maxRows,
            }),
          );
        // An empty view that the counts now say has images opens a new session.
        if (!winRef.current.rows.length && live.current.visibleCount > 0)
          void openSession({ baseline: true });
      } catch (error) {
        handleReadError(error);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, revision]);

  // --- Pending steps and prefetch --------------------------------------------------
  const { pending } = win;
  useEffect(() => {
    if (!pending) return;
    if (
      pending.need === WINDOW_NEED.FORWARD ||
      pending.need === WINDOW_NEED.BACKWARD
    )
      loadEdge(pending.need);
    else if (pending.need === WINDOW_NEED.WRAP) wrap();
    else if (pending.need === WINDOW_NEED.RESEED) {
      const state = winRef.current;
      void openSession({ avoid: state.current });
    }
  }, [pending, loadEdge, wrap, openSession]);

  const prefetch = prefetchNeed(win, prefetchRows);
  useEffect(() => {
    if (prefetch && phase.status === 'ready') loadEdge(prefetch);
  }, [prefetch, win.rows, phase.status, loadEdge]);

  // --- Playback ------------------------------------------------------------------
  const step = useCallback(
    (delta) => {
      if (phase.status !== 'ready') return;
      apply((s) => stepWindow(s, delta));
    },
    [apply, phase.status],
  );
  const select = useCallback(
    (key) => {
      if (phase.status !== 'ready') return;
      apply((s) => selectWindow(s, key));
    },
    [apply, phase.status],
  );
  const ready = useCallback(
    (key) => apply((s) => readyWindow(s, key)),
    [apply],
  );
  const unavailable = useCallback(
    (key) => apply((s) => failWindow(s, key, live.current.playing)),
    [apply],
  );
  const forget = useCallback(() => apply(forgetWindowFailures), [apply]);
  const previewFailed = useCallback((key) => {
    const value = previewRecord.current;
    if (!value || imageKey(value) !== key) return;
    failedPreview.current = previewIdentity(value);
    previewRecord.current = null;
    setPreview(null);
  }, []);

  // Playing from an image that already failed must not wait for a load.
  const { current, loaded, hold, failed } = win;
  const stalled = isStalled(win);
  useEffect(() => {
    if (playing && current !== null && failed.includes(current) && !stalled)
      step(1);
  }, [playing, current, failed, stalled, step]);

  const speedMs = speedIntervalMs(speedSeconds);
  useEffect(() => {
    if (!playing || current === null || loaded !== current) return undefined;
    const timer = setTimeout(
      () => step(1),
      dwellMs({ current, hold }, { speedMs, holdMs }),
    );
    return () => clearTimeout(timer);
  }, [playing, current, loaded, hold, speedMs, holdMs, step]);

  /** A person's Retry: a fresh session around the shown image. */
  const retry = useCallback(() => {
    recoveries.current = 0;
    const state = winRef.current;
    const shown = state.rows.find((row) => row.key === state.current);
    setPhase((now) => ({ ...now, error: null }));
    return openSession({ anchor: shown?.record ?? null, baseline: true });
  }, [openSession]);

  return {
    status: phase.status,
    error: phase.error,
    errorDetail: phase.errorDetail,
    preview,
    previewFailed,
    retry,
    rows: win.rows,
    current,
    loaded,
    hold,
    failed,
    stalled,
    nextRow: peekWindowNext(win),
    hasMore: {
      forward: win.nextRank !== null,
      backward: win.previousRank !== null,
    },
    loadEdge,
    step,
    select,
    ready,
    unavailable,
    forget,
  };
}
