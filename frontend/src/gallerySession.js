/**
 * The shared Gallery's bounded window over one server shuffle session, as
 * pure state. No React, timers or requests: `useGallerySession` owns those.
 *
 * The server owns the order. A window holds at most `maxRows` adjacent rows of
 * one session, in ascending `session_rank`, and the cursor (`current`) is
 * always one of them. Rows are `{key, rank, record, arrival}`:
 * - ranked rows come from session pages; deletions leave rank holes and only
 *   surviving rows are listed;
 * - an arrival (a new image saved after the session was built) is spliced in
 *   right after the row that was current when it arrived, with that row's rank,
 *   so the session cursor continues after it without skipping anything.
 *
 * `nextRank`/`previousRank` are where the next read in each direction starts;
 * null means the session has no eligible member beyond the window that way.
 * Stepping past a window edge records `pending` (what to read, then the step
 * to repeat); past the session's end it asks for a reseed, before its start for
 * a wrap to the session's last page.
 */
import { imageKey } from './imageRecord.js';

/** A read toward an edge starts once the cursor is this many rows from it. */
export const GALLERY_PREFETCH_ROWS = 6;
/** Automatic advancing stops after this many images failed to load in a row. */
export const GALLERY_MAX_CONSECUTIVE_FAILURES = 24;
/** Most rows (and so filmstrip thumbnails) a window holds, whatever the policy. */
export const GALLERY_MAX_WINDOW_ROWS = 132;
/** Largest page the session endpoint serves. */
export const GALLERY_SESSION_PAGE_MAX = 96;

export const WINDOW_NEED = Object.freeze({
  FORWARD: 'forward',
  BACKWARD: 'backward',
  /** Past the session's end: a new session is the next cycle. */
  RESEED: 'reseed',
  /** Before the session's first member: continue from its last page. */
  WRAP: 'wrap',
});

export const createSessionWindow = () => ({
  rows: [],
  nextRank: null,
  previousRank: null,
  snapshotTotal: 0,
  revision: null,
  current: null,
  /** The featured arrival whose first showing lasts the hold duration. */
  hold: null,
  /** The key whose full picture has actually loaded; the interval starts here. */
  loaded: null,
  /** Keys whose full picture failed to load in this view. */
  failed: [],
  /** Consecutive load failures; any successful load resets it. */
  failures: 0,
  /** `{delta, need}` while a step waits for a read. */
  pending: null,
});

const isRank = (value) => Number.isInteger(value) && value >= 0;

/** A ready session page in the documented shape, or false. */
export function validSessionPage(page) {
  if (
    !page ||
    typeof page !== 'object' ||
    page.state !== 'ready' ||
    !Array.isArray(page.images) ||
    page.count !== page.images.length ||
    !(page.next_rank === null || isRank(page.next_rank)) ||
    !(page.previous_rank === null || isRank(page.previous_rank)) ||
    !isRank(page.snapshot_total)
  )
    return false;
  let before = -1;
  for (const image of page.images) {
    if (!image || !isRank(image.session_rank) || image.session_rank <= before)
      return false;
    before = image.session_rank;
  }
  return true;
}

const rowOf = (record, rank, arrival = false) => ({
  key: imageKey(record),
  rank,
  record,
  arrival,
});

export const rowsOfPage = (page) =>
  page.images.map((image) => rowOf(image, image.session_rank));

const indexOfKey = (rows, key) =>
  key === null ? -1 : rows.findIndex((row) => row.key === key);

/** `state` with a new cursor; the load and hold belong to the previous one. */
const moveTo = (state, current) =>
  current === state.current
    ? { ...state, pending: null }
    : {
        ...state,
        current,
        loaded: null,
        hold: state.hold === current ? state.hold : null,
        pending: null,
      };

/**
 * Drop rows until at most `maxRows` remain, always from the side with more
 * rows beyond the cursor, so the cursor stays inside the window. Dropping a
 * ranked row moves that edge's next read back to it.
 */
export function boundWindow(state, maxRows) {
  if (state.rows.length <= maxRows) return state;
  const rows = [...state.rows];
  let { nextRank, previousRank } = state;
  while (rows.length > maxRows) {
    const at = Math.max(0, indexOfKey(rows, state.current));
    const fromEnd = rows.length - 1 - at >= at;
    const dropped = fromEnd ? rows.pop() : rows.shift();
    if (dropped.arrival) continue;
    if (fromEnd) nextRank = dropped.rank;
    else previousRank = dropped.rank;
  }
  // A failure is remembered only while its row is held.
  const held = new Set(rows.map((row) => row.key));
  const failed = state.failed.filter((key) => held.has(key));
  return { ...state, rows, nextRank, previousRank, failed };
}

const usable = (state, row) => !state.failed.includes(row.key);

/**
 * A new window from one page: a fresh session, a recovery or a wrap.
 * @param {object} state
 * @param {object} page a valid ready session page
 * @param {object} options
 * @param {string|null} [options.keep] stay on this key when it is listed
 * @param {string|null} [options.avoid] do not open on this key if another exists
 * @param {'start'|'end'} [options.at] where the cursor goes otherwise
 * @param {boolean} [options.forget] earlier load failures no longer apply
 * @param {number} options.maxRows
 */
export function openWindow(
  state,
  page,
  { keep = null, avoid = null, at = 'start', forget = false, maxRows },
) {
  const rows = rowsOfPage(page);
  const base = {
    ...state,
    rows,
    nextRank: page.next_rank,
    previousRank: page.previous_rank,
    snapshotTotal: page.snapshot_total,
    revision: page.revision ?? state.revision,
    failed: forget
      ? []
      : state.failed.filter((key) => rows.some((row) => row.key === key)),
    pending: null,
  };
  let current = null;
  if (keep !== null && indexOfKey(rows, keep) >= 0) current = keep;
  else {
    const ordered = at === 'end' ? [...rows].reverse() : rows;
    const candidates = ordered.filter((row) => usable(base, row));
    const pick =
      candidates.find((row) => row.key !== avoid) ?? candidates[0] ?? null;
    current = pick?.key ?? rows[0]?.key ?? null;
  }
  const opened =
    current === null
      ? { ...base, current: null, loaded: null, hold: null }
      : moveTo(base, current);
  return boundWindow(opened, maxRows);
}

/** Add a page read beyond one edge of the window. */
export function extendWindow(state, page, direction, { maxRows }) {
  const known = new Set(state.rows.map((row) => row.key));
  const ranked = state.rows.filter((row) => !row.arrival);
  const forward = direction === 'forward';
  const edgeRank = forward ? ranked.at(-1)?.rank : ranked[0]?.rank;
  const fresh = rowsOfPage(page).filter(
    (row) =>
      !known.has(row.key) &&
      (edgeRank === undefined ||
        (forward ? row.rank > edgeRank : row.rank < edgeRank)),
  );
  const next = {
    ...state,
    rows: forward ? [...state.rows, ...fresh] : [...fresh, ...state.rows],
    revision: page.revision ?? state.revision,
    snapshotTotal: page.snapshot_total,
  };
  if (forward) next.nextRank = page.next_rank;
  else next.previousRank = page.previous_rank;
  if (!state.rows.length) {
    next.nextRank = page.next_rank;
    next.previousRank = page.previous_rank;
  }
  return boundWindow(next, maxRows);
}

/**
 * Replace the ranked rows with a fresh read of the same range (after a catalog
 * change): deleted rows disappear, summaries refresh, the order never changes.
 * Arrivals keep their place after their anchor rank. A cursor whose image is
 * gone moves to the next survivor, or the previous one at the end.
 * @param {object[]} pages consecutive forward reads starting at the first rank
 */
export function revalidateWindow(state, pages, { maxRows }) {
  if (!pages.length) return state;
  const ranked = pages.flatMap(rowsOfPage);
  const arrivals = state.rows.filter((row) => row.arrival);
  const rows = [...ranked];
  for (const arrival of arrivals) {
    if (rows.some((row) => row.key === arrival.key)) continue;
    // After every row of a lower or equal rank, earlier arrivals included,
    // so arrivals keep the order they had among themselves.
    let at = 0;
    rows.forEach((row, index) => {
      if (row.rank <= arrival.rank) at = index + 1;
    });
    rows.splice(at, 0, arrival);
  }
  const next = {
    ...state,
    rows,
    previousRank: pages[0].previous_rank,
    nextRank: pages.at(-1).next_rank,
    snapshotTotal: pages.at(-1).snapshot_total,
    revision: pages.at(-1).revision ?? state.revision,
    failed: state.failed.filter((key) => rows.some((row) => row.key === key)),
  };
  if (indexOfKey(rows, state.current) >= 0 || state.current === null)
    return boundWindow(next, maxRows);
  const gone = state.rows.find((row) => row.key === state.current);
  const rank = gone?.rank ?? -1;
  const after = rows.find((row) => row.rank > rank && usable(next, row));
  const before = [...rows].reverse().find((row) => usable(next, row));
  const target = after ?? before ?? null;
  if (target) return boundWindow(moveTo(next, target.key), maxRows);
  return { ...next, current: null, loaded: null, hold: null };
}

/**
 * New images saved since the session was built, newest first. They follow the
 * current row; while playing the newest becomes current and is held.
 */
export function arriveWindow(state, records, playing, { maxRows }) {
  const known = new Set(state.rows.map((row) => row.key));
  const fresh = [];
  for (const record of records) {
    const key = imageKey(record);
    if (known.has(key)) continue;
    known.add(key);
    fresh.push(record);
  }
  if (!fresh.length) return state;
  const at = indexOfKey(state.rows, state.current);
  const anchorRank =
    at >= 0 ? state.rows[at].rank : (state.rows.at(-1)?.rank ?? 0);
  const arrivals = fresh.map((record) => rowOf(record, anchorRank, true));
  const insertAt = at >= 0 ? at + 1 : state.rows.length;
  const rows = [
    ...state.rows.slice(0, insertAt),
    ...arrivals,
    ...state.rows.slice(insertAt),
  ];
  let next = { ...state, rows };
  if (playing)
    next = { ...moveTo(next, arrivals[0].key), hold: arrivals[0].key };
  else if (state.current === null) next = moveTo(next, arrivals[0].key);
  return boundWindow(next, maxRows);
}

/**
 * Move along the window. A step past an edge asks for a read (or a reseed or
 * wrap) and is repeated once that read lands.
 */
export function stepWindow(state, delta) {
  if (state.pending) return state;
  const { rows } = state;
  const at = indexOfKey(rows, state.current);
  if (at < 0) return state;
  const forward = delta > 0;
  for (
    let index = at + (forward ? 1 : -1);
    index >= 0 && index < rows.length;
    index += forward ? 1 : -1
  )
    if (usable(state, rows[index]))
      return { ...moveTo(state, rows[index].key), hold: null };
  // The whole session is held and nothing else can be shown: stay.
  const whole = state.nextRank === null && state.previousRank === null;
  if (
    whole &&
    !rows.some((row) => row.key !== state.current && usable(state, row))
  )
    return state;
  // Back past the first member of a session that is held entirely continues
  // from its last member without another read.
  if (!forward && whole) {
    const last = [...rows].reverse().find((row) => usable(state, row));
    if (last) return { ...moveTo(state, last.key), hold: null };
  }
  const need = forward
    ? state.nextRank !== null
      ? WINDOW_NEED.FORWARD
      : WINDOW_NEED.RESEED
    : state.previousRank !== null
      ? WINDOW_NEED.BACKWARD
      : WINDOW_NEED.WRAP;
  return { ...state, pending: { delta, need } };
}

/** Repeat a step that was waiting for a read, now that the read has landed. */
export function resumePending(state) {
  if (!state.pending) return state;
  const { delta } = state.pending;
  const before = { ...state, pending: null };
  const after = stepWindow(before, delta);
  // Still at an edge after a read that added nothing usable: do not loop.
  return after.pending ? before : after;
}

/** A step waiting for a read that failed is abandoned; the image stays. */
export const cancelPending = (state) =>
  state.pending ? { ...state, pending: null } : state;

/**
 * The edge a read should extend before the cursor reaches it, or null.
 * @param {number} [distance] rows from an edge at which the read starts
 */
export function prefetchNeed(state, distance = GALLERY_PREFETCH_ROWS) {
  const at = indexOfKey(state.rows, state.current);
  if (at < 0) return null;
  if (state.nextRank !== null && state.rows.length - 1 - at < distance)
    return WINDOW_NEED.FORWARD;
  if (state.previousRank !== null && at < distance) return WINDOW_NEED.BACKWARD;
  return null;
}

/** The record playback would show next, when it is already in the window. */
export function peekWindowNext(state) {
  const at = indexOfKey(state.rows, state.current);
  if (at < 0) return null;
  for (let index = at + 1; index < state.rows.length; index += 1)
    if (usable(state, state.rows[index])) return state.rows[index];
  return null;
}

/** An explicit choice (a thumbnail): the cursor moves there. */
export function selectWindow(state, key) {
  if (indexOfKey(state.rows, key) < 0 || key === state.current) return state;
  return { ...moveTo(state, key), hold: null };
}

/** The featured picture is on screen: its interval may start. */
export function readyWindow(state, key) {
  if (key !== state.current) return state;
  if (state.loaded === key && state.failures === 0) return state;
  return { ...state, loaded: key, failures: 0 };
}

/**
 * A full picture failed to load. It leaves the rotation for this view only;
 * nothing is deleted. A failed image that is being played is skipped, until
 * too many failed in a row.
 */
export function failWindow(state, key, playing) {
  if (state.failed.includes(key) || indexOfKey(state.rows, key) < 0)
    return state;
  const next = { ...state, failed: [...state.failed, key] };
  if (key !== state.current) return next;
  const cleared = {
    ...next,
    loaded: null,
    hold: null,
    failures: state.failures + 1,
  };
  return playing && cleared.failures < GALLERY_MAX_CONSECUTIVE_FAILURES
    ? stepWindow(cleared, 1)
    : cleared;
}

/** Another view starts fresh: earlier failures no longer describe it. */
export const forgetWindowFailures = (state) =>
  state.failed.length || state.failures
    ? { ...state, failed: [], failures: 0 }
    : state;

export const isStalled = (state) =>
  state.failures >= GALLERY_MAX_CONSECUTIVE_FAILURES;
