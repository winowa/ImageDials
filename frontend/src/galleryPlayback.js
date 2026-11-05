/**
 * Pure gallery scheduling: seeded play order, the cycle cursor, new-image
 * arrival, and load-failure exclusion. No React and no timers, so every rule is
 * testable with plain values; `useGalleryPlayback` owns the timers.
 *
 * Playback state is one order (a shuffle of the eligible image keys) and a
 * cursor into it (`current`):
 * - the order is stable while the eligible identity set is unchanged;
 *   metadata refreshes and library reordering never reshuffle it;
 * - manual previous/next move along the same order, so they stay coherent
 *   with automatic playback; an explicit selection moves the cursor there;
 * - reaching the end of the order is the end of a cycle: the order is reseeded
 *   and its first image differs from the one just shown where possible;
 * - a new image (never seen since the gallery opened) is placed right after the
 *   cursor, so it plays next without skipping anything. While playing it is
 *   also featured with a `hold`; while paused it never interrupts.
 */

const UINT32 = 0x100000000;

/** A small deterministic generator (mulberry32) returning floats in [0, 1). */
export function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / UINT32;
  };
}

/** The seed after `seed`; used when a cycle ends. */
export const nextSeed = (seed) =>
  (Math.imul(seed >>> 0, 1664525) + 1013904223) >>> 0;

/**
 * A shuffle of `keys` that depends only on the key set and the seed, never on
 * the order the keys were given in.
 */
export function seededOrder(keys, seed) {
  const out = [...keys].sort();
  const random = seededRandom(seed);
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export const createPlayback = (seed) => ({
  seed: seed >>> 0,
  /** Every eligible key in play order (failed ones stay, and are skipped). */
  order: [],
  current: null,
  /** The featured new image whose first showing lasts the hold duration. */
  hold: null,
  /** The key whose full image has actually loaded; the interval starts here. */
  loaded: null,
  /** Keys whose full image failed to load in this view. */
  failed: [],
  /** Every key seen since the gallery opened, to recognise arrivals. */
  known: null,
  newest: null,
});

const newestOf = (items, from = null) =>
  items.reduce(
    (max, item) =>
      item.createdAtMs == null
        ? max
        : Math.max(max ?? -Infinity, item.createdAtMs),
    from,
  );

const sameKeys = (order, keys) => {
  if (order.length !== keys.length) return false;
  const set = new Set(order);
  return keys.every((key) => set.has(key));
};

/** `state` with a new cursor; the load and hold belong to the previous one. */
const moveTo = (state, current) =>
  current === state.current
    ? state
    : {
        ...state,
        current,
        loaded: null,
        hold: state.hold === current ? state.hold : null,
      };

/**
 * Follow the library and the filters.
 *
 * @param {object} state
 * @param {object} input
 * @param {{key: string, createdAtMs: number|null}[]} input.library every record
 * @param {string[]} input.eligible eligible keys, newest first
 * @param {boolean} input.playing whether an arrival may be featured
 */
export function syncPlayback(state, input) {
  const next = followLibrary(state, input);
  // Playing from an image that already failed must not wait for a load that
  // cannot come: move to the next one that can.
  return input.playing &&
    next.current !== null &&
    next.failed.includes(next.current)
    ? stepPlayback(next, 1)
    : next;
}

function followLibrary(state, { library, eligible, playing }) {
  const eligibleSet = new Set(eligible);
  let { known, newest } = state;
  let arrivals = [];
  let learned = false;
  if (known === null) {
    known = new Set(library.map((item) => item.key));
    newest = newestOf(library);
    learned = true;
  } else {
    const fresh = library.filter((item) => !known.has(item.key));
    if (fresh.length) {
      // Only an image newer than everything seen counts as a new arrival; an
      // older record that appears later (an import, a restored list) does not.
      arrivals = fresh
        .filter(
          (item) =>
            eligibleSet.has(item.key) &&
            (item.createdAtMs == null ||
              newest == null ||
              item.createdAtMs >= newest),
        )
        .sort((a, b) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0));
      known = new Set([...known, ...fresh.map((item) => item.key)]);
      newest = newestOf(fresh, newest);
      learned = true;
    }
  }

  const failed = state.failed.filter((key) => eligibleSet.has(key));
  if (
    !learned &&
    failed.length === state.failed.length &&
    sameKeys(state.order, eligible)
  )
    return state;

  const base = { ...state, known, newest, failed };
  if (!eligible.length)
    return { ...base, order: [], current: null, loaded: null, hold: null };

  if (!state.order.length) {
    // The whole order is the seeded shuffle, first image included: the newest
    // image is only the first one when the shuffle happens to place it there.
    const order = seededOrder(eligible, state.seed);
    return moveTo({ ...base, order }, order[0]);
  }

  const survivors = state.order.filter((key) => eligibleSet.has(key));
  const kept = new Set(survivors);
  const arrived = new Set(arrivals.map((item) => item.key));
  // Keys that came back through a filter join the end of the cycle.
  const returned = seededOrder(
    eligible.filter((key) => !kept.has(key) && !arrived.has(key)),
    state.seed,
  );
  const at = state.order.indexOf(state.current);
  const insertAt = kept.has(state.current)
    ? survivors.indexOf(state.current) + 1
    : state.order.slice(0, Math.max(at, 0)).filter((k) => kept.has(k)).length;
  const order = [
    ...survivors.slice(0, insertAt),
    ...arrivals.map((item) => item.key),
    ...survivors.slice(insertAt),
    ...returned,
  ];
  let current = kept.has(state.current)
    ? state.current
    : (order[insertAt] ?? order[0]);
  let hold = state.hold;
  if (playing && arrivals.length) {
    // The latest arrival wins the hold; earlier ones follow in the cycle.
    current = arrivals[0].key;
    hold = current;
  }
  return moveTo({ ...base, order, hold }, current);
}

/**
 * Move along the order. Past the end the cycle is reseeded; before the start
 * it wraps without reseeding. Failed images are skipped.
 */
export function stepPlayback(state, delta) {
  const { order, failed } = state;
  const usable = order.filter((key) => !failed.includes(key));
  if (!usable.length || (usable.length === 1 && usable[0] === state.current))
    return state;
  let next = state;
  let { order: list } = state;
  let index = list.indexOf(state.current);
  let reseeded = false;
  const forward = delta > 0;
  for (let tries = 0; tries <= list.length * 2; tries += 1) {
    index += forward ? 1 : -1;
    if (forward && index >= list.length) {
      if (!reseeded) {
        reseeded = true;
        const seed = nextSeed(next.seed);
        list = seededOrder(list, seed);
        // Do not open the new cycle on the image that ended the old one.
        if (list.length > 1 && list[0] === state.current)
          [list[0], list[1]] = [list[1], list[0]];
        next = { ...next, seed, order: list };
      }
      index = 0;
    } else if (!forward && index < 0) {
      index = list.length - 1;
    }
    if (!failed.includes(list[index])) break;
  }
  return moveTo({ ...next, hold: null }, list[index]);
}

/** The key playback would show after the current one, or null. */
export function peekNext(state) {
  const { order, failed, current } = state;
  const n = order.length;
  if (n < 2) return null;
  const at = order.indexOf(current);
  for (let offset = 1; offset < n; offset += 1) {
    const index = at + offset;
    // Past the end the order is reseeded, which cannot be predicted here.
    if (index >= n) return null;
    if (!failed.includes(order[index])) return order[index];
  }
  return null;
}

/** An explicit choice (a thumbnail): the cursor moves there. */
export function selectPlayback(state, key) {
  if (!state.order.includes(key) || key === state.current) return state;
  return moveTo({ ...state, hold: null }, key);
}

/** The featured image's full picture is on screen: its interval may start. */
export function readyPlayback(state, key) {
  return key === state.current && state.loaded !== key
    ? { ...state, loaded: key }
    : state;
}

/**
 * A full image failed to load. It leaves the rotation for this view only;
 * nothing is deleted. A failed image that is being played is skipped.
 */
export function failPlayback(state, key, playing) {
  if (state.failed.includes(key) || !state.order.includes(key)) return state;
  const failed = [...state.failed, key];
  const next = { ...state, failed };
  if (key !== state.current) return next;
  const cleared = { ...next, loaded: null, hold: null };
  return playing ? stepPlayback(cleared, 1) : cleared;
}

/** Filters changed: earlier failures no longer describe this view. */
export const forgetFailures = (state) =>
  state.failed.length ? { ...state, failed: [] } : state;

/** How long the featured image stays before playback advances. */
export const dwellMs = (state, { speedMs, holdMs }) =>
  state.hold !== null && state.hold === state.current ? holdMs : speedMs;

// --- Events --------------------------------------------------------------------

/**
 * Event choices for the presentation filter. The configured scope (from the
 * capabilities the backend published) is the only authority: records outside
 * it are never listed and the choice only narrows what is already loaded. With
 * no configured scope, the events found on the loaded records are offered.
 *
 * @returns {{show: boolean, options: {value: string, label: string, count: number, active: boolean}[], selected: string|null}}
 */
export function galleryEvents({ capabilities, items, stored }) {
  const events = capabilities?.events ?? {};
  const active = events.active_event_name ?? null;
  const configured = Array.isArray(events.gallery_event_names)
    ? events.gallery_event_names
    : [];
  const scope = configured.length ? configured : active ? [active] : [];
  const counts = new Map();
  for (const item of items) {
    const id = item.event_id;
    if (typeof id === 'string' && id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const names = scope.length ? scope : [...counts.keys()].sort();
  const options = names.map((value) => ({
    value,
    label: value,
    count: counts.get(value) ?? 0,
    active: value === active,
  }));
  const selected =
    typeof stored === 'string' && names.includes(stored) ? stored : null;
  return { show: options.length > 1, options, selected };
}

/** A stored event choice is any string; its validity depends on the scope. */
export const sanitizeEvent = (stored) =>
  typeof stored === 'string' && stored ? stored : null;
