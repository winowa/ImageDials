import { expect, test } from 'vitest';

import {
  approachedEdge,
  clampWindow,
  growEnd,
  growStart,
  initialWindow,
  revealIndex,
} from './galleryFilmstrip.js';
import { galleryShortcut } from './galleryKeys.js';
import {
  createPlayback,
  dwellMs,
  failPlayback,
  forgetFailures,
  galleryEvents,
  nextSeed,
  peekNext,
  readyPlayback,
  seededOrder,
  selectPlayback,
  stepPlayback,
  syncPlayback,
} from './galleryPlayback.js';

const keys = (n) => Array.from({ length: n }, (_, i) => `k${i}`);
const records = (list, base = 1000) =>
  list.map((key, i) => ({ key, createdAtMs: base - i }));
const open = (list, { seed = 5, playing = false } = {}) =>
  syncPlayback(createPlayback(seed), {
    library: records(list),
    eligible: list,
    playing,
  });

test('the shuffle depends only on the key set and the seed', () => {
  const list = keys(12);
  const shuffled = seededOrder(list, 7);
  expect(seededOrder([...list].reverse(), 7)).toEqual(shuffled);
  expect(seededOrder(list, 7)).toEqual(shuffled);
  expect([...shuffled].sort()).toEqual([...list].sort());
  expect(seededOrder(list, 8)).not.toEqual(shuffled);
  // Pinned so an accidental change of the algorithm is noticed.
  expect(seededOrder(keys(6), 11)).toEqual([
    'k0',
    'k5',
    'k1',
    'k4',
    'k2',
    'k3',
  ]);
  expect(nextSeed(11)).toBe(nextSeed(11));
  expect(nextSeed(11)).not.toBe(11);
});

test('a first sync opens on the first image of the whole seeded shuffle', () => {
  const list = keys(6);
  const state = open(list, { seed: 11 });
  expect(state.order).toEqual(seededOrder(list, 11));
  expect(state.current).toBe(state.order[0]);
  expect(state.loaded).toBeNull();
});

test('the opening image is not biased toward the newest', () => {
  const list = keys(6);
  const firsts = new Set();
  const counts = new Map();
  for (let seed = 0; seed < 600; seed += 1) {
    const { current, order } = open(list, { seed });
    expect([...order].sort()).toEqual([...list].sort());
    firsts.add(current);
    counts.set(current, (counts.get(current) ?? 0) + 1);
  }
  // Every image, the newest included, can open the gallery by chance ...
  expect(firsts.size).toBe(list.length);
  // ... and none is favoured: each share stays near 1/6 of 600 (fixed seeds,
  // so this bound is deterministic rather than flaky).
  for (const count of counts.values()) {
    expect(count).toBeGreaterThan(60);
    expect(count).toBeLessThan(140);
  }
  // The newest opens it for some seeds only, never as a rule.
  expect(counts.get('k0')).toBeLessThan(600);
});

test('the opening order is the same whatever order the library lists', () => {
  const list = keys(7);
  const reversed = [...list].reverse();
  const a = open(list, { seed: 21 });
  const b = open(reversed, { seed: 21 });
  expect(b.order).toEqual(a.order);
  expect(b.current).toBe(a.current);
});

test('metadata refresh, reordering and replayed lists never reshuffle', () => {
  const list = keys(8);
  const state = open(list);
  const reordered = [...list].reverse();
  const again = syncPlayback(state, {
    library: records(reordered).map((r) => ({ ...r, createdAtMs: 1 })),
    eligible: reordered,
    playing: true,
  });
  expect(again).toBe(state);
});

test('a full cycle reseeds and never reopens on the image that ended it', () => {
  for (let seed = 0; seed < 60; seed += 1) {
    let state = open(keys(4), { seed });
    const seen = [];
    for (let i = 0; i < 4; i += 1) {
      seen.push(state.current);
      state = stepPlayback(state, 1);
    }
    expect(new Set(seen).size).toBe(4);
    expect(state.seed).toBe(nextSeed(seed));
    expect(state.current).not.toBe(seen[3]);
  }
});

test('stepping back wraps without reseeding, and one image cannot step', () => {
  const state = open(keys(5), { seed: 3 });
  const back = stepPlayback(state, -1);
  expect(back.current).toBe(state.order[4]);
  expect(back.seed).toBe(state.seed);
  const single = open(['only']);
  expect(stepPlayback(single, 1)).toBe(single);
  const none = open([]);
  expect(none.current).toBeNull();
  expect(stepPlayback(none, 1)).toBe(none);
});

test('an explicit selection moves the cursor and survives refreshes', () => {
  const state = open(keys(6), { seed: 2 });
  const target = state.order[3];
  const chosen = selectPlayback(state, target);
  expect(chosen.current).toBe(target);
  expect(chosen.loaded).toBeNull();
  const refreshed = syncPlayback(chosen, {
    library: records(keys(6)),
    eligible: keys(6),
    playing: true,
  });
  expect(refreshed.current).toBe(target);
  expect(stepPlayback(chosen, 1).current).toBe(state.order[4]);
  expect(selectPlayback(chosen, 'absent')).toBe(chosen);
});

test('a load only counts for the image that is current', () => {
  const state = open(keys(3));
  expect(readyPlayback(state, 'k2')).toBe(state);
  expect(readyPlayback(state, 'k0').loaded).toBe('k0');
  const moved = stepPlayback(readyPlayback(state, 'k0'), 1);
  expect(moved.loaded).toBeNull();
});

const withArrival = (state, key, { playing, at = 5000, extra = [] } = {}) => {
  const list = [key, ...extra, ...state.order];
  return syncPlayback(state, {
    library: [
      { key, createdAtMs: at },
      ...extra.map((k, i) => ({ key: k, createdAtMs: at - 1 - i })),
      ...state.order.map((k) => ({ key: k, createdAtMs: 100 })),
    ],
    eligible: list,
    playing,
  });
};

test('initial hydration is not an arrival, and a new image joins after the cursor', () => {
  const state = open(keys(4), { seed: 4, playing: true });
  expect(state.hold).toBeNull();
  const advanced = stepPlayback(state, 1);
  const paused = withArrival(advanced, 'fresh', { playing: false });
  expect(paused.current).toBe(advanced.current);
  expect(paused.hold).toBeNull();
  const at = paused.order.indexOf(advanced.current);
  expect(paused.order[at + 1]).toBe('fresh');
  // Pressing next reaches it without skipping anything.
  expect(stepPlayback(paused, 1).current).toBe('fresh');
});

test('while playing a new image is featured with a hold, then playback resumes', () => {
  const state = stepPlayback(open(keys(4), { seed: 4, playing: true }), 1);
  const after = state.order[state.order.indexOf(state.current) + 1];
  const arrived = withArrival(state, 'fresh', { playing: true });
  expect(arrived.current).toBe('fresh');
  expect(arrived.hold).toBe('fresh');
  expect(arrived.loaded).toBeNull();
  expect(dwellMs(arrived, { speedMs: 5000, holdMs: 20000 })).toBe(20000);
  const resumed = stepPlayback(arrived, 1);
  expect(resumed.current).toBe(after);
  expect(resumed.hold).toBeNull();
  expect(dwellMs(resumed, { speedMs: 5000, holdMs: 20000 })).toBe(5000);
});

test('several arrivals feature the latest and the rest follow in the cycle', () => {
  const state = open(keys(3), { seed: 1, playing: true });
  const arrived = withArrival(state, 'newest', {
    playing: true,
    extra: ['mid', 'low'],
  });
  expect(arrived.current).toBe('newest');
  expect(arrived.hold).toBe('newest');
  const at = arrived.order.indexOf('newest');
  expect(arrived.order.slice(at, at + 3)).toEqual(['newest', 'mid', 'low']);
  // A later arrival replaces the hold rather than queueing another.
  const later = withArrival(arrived, 'newer', { playing: true, at: 9000 });
  expect(later.current).toBe('newer');
  expect(later.hold).toBe('newer');
});

test('replays, older records and ineligible arrivals do not interrupt', () => {
  const state = open(keys(3), { seed: 1, playing: true });
  const library = (extra) => [
    ...state.order.map((key) => ({ key, createdAtMs: 100 })),
    ...extra,
  ];
  // Older than everything seen (an import, a restored list).
  const old = syncPlayback(state, {
    library: library([{ key: 'old', createdAtMs: 5 }]),
    eligible: [...state.order, 'old'],
    playing: true,
  });
  expect(old.hold).toBeNull();
  expect(old.current).toBe(state.current);
  // Newer, but filtered out by orientation or event.
  const hidden = syncPlayback(state, {
    library: library([{ key: 'hidden', createdAtMs: 9000 }]),
    eligible: state.order,
    playing: true,
  });
  expect(hidden.hold).toBeNull();
  expect(hidden.order).toEqual(state.order);
  // Showing it later through a filter is a return, not an arrival.
  const shown = syncPlayback(hidden, {
    library: library([{ key: 'hidden', createdAtMs: 9000 }]),
    eligible: [...state.order, 'hidden'],
    playing: true,
  });
  expect(shown.hold).toBeNull();
  expect(shown.order.at(-1)).toBe('hidden');
});

test('a deleted current image hands over to its successor', () => {
  const state = selectPlayback(
    open(keys(5), { seed: 9 }),
    open(keys(5), { seed: 9 }).order[2],
  );
  const gone = state.current;
  const next = state.order[3];
  const eligible = keys(5).filter((k) => k !== gone);
  const synced = syncPlayback(state, {
    library: records(eligible),
    eligible,
    playing: false,
  });
  expect(synced.current).toBe(next);
  expect(synced.order).not.toContain(gone);
  const empty = syncPlayback(synced, {
    library: [],
    eligible: [],
    playing: false,
  });
  expect(empty.current).toBeNull();
});

test('failed images leave the rotation for this view only', () => {
  const state = open(keys(5), { seed: 6 });
  const bad = state.order[1];
  const skipped = failPlayback(state, bad, true);
  expect(skipped.failed).toEqual([bad]);
  expect(skipped.order).toEqual(state.order);
  expect(stepPlayback(skipped, 1).current).toBe(state.order[2]);
  // The current image failing while playing moves on; while paused it stays.
  const atBad = selectPlayback(state, bad);
  expect(failPlayback(atBad, bad, true).current).toBe(state.order[2]);
  expect(failPlayback(atBad, bad, false).current).toBe(bad);
  // A failure of the upcoming image is not offered as next.
  expect(peekNext(selectPlayback(skipped, state.order[0]))).toBe(
    state.order[2],
  );
  expect(forgetFailures(skipped).failed).toEqual([]);
  expect(forgetFailures(state)).toBe(state);
});

test('when every image failed nothing moves', () => {
  let state = open(keys(2));
  state = failPlayback(state, state.order[1], true);
  state = failPlayback(state, state.order[0], true);
  expect(stepPlayback(state, 1)).toBe(state);
});

// --- Events -----------------------------------------------------------------------

const eventRecords = (...ids) => ids.map((event_id) => ({ event_id }));

test('events come only from the configured scope, with accurate counts', () => {
  const capabilities = {
    events: {
      active_event_name: 'spring',
      gallery_event_names: ['spring', 'autumn', 'empty'],
    },
  };
  const items = eventRecords('spring', 'spring', 'autumn', 'rogue', null);
  const view = galleryEvents({ capabilities, items, stored: 'autumn' });
  expect(view.show).toBe(true);
  expect(view.options.map((o) => [o.value, o.count, o.active])).toEqual([
    ['spring', 2, true],
    ['autumn', 1, false],
    ['empty', 0, false],
  ]);
  expect(view.selected).toBe('autumn');
  // A stored choice outside the scope is ignored, not honoured as authority.
  expect(
    galleryEvents({ capabilities, items, stored: 'rogue' }).selected,
  ).toBeNull();
});

test('a single event or no scope offers nothing to choose', () => {
  const only = {
    events: { active_event_name: 'spring', gallery_event_names: [] },
  };
  expect(
    galleryEvents({
      capabilities: only,
      items: eventRecords('spring'),
      stored: null,
    }).show,
  ).toBe(false);
  const loose = galleryEvents({
    capabilities: { events: {} },
    items: eventRecords('b', 'a', 'a'),
    stored: 'a',
  });
  expect(loose.options.map((o) => [o.value, o.count])).toEqual([
    ['a', 2],
    ['b', 1],
  ]);
  expect(loose.selected).toBe('a');
  expect(
    galleryEvents({ capabilities: null, items: [], stored: null }).show,
  ).toBe(false);
});

// --- Filmstrip window ---------------------------------------------------------------

const limits = { initial: 36, batch: 24 };

test('the filmstrip opens on 36 and grows by 24 at an edge', () => {
  let win = initialWindow(100, limits);
  expect(win).toEqual({ start: 0, end: 36 });
  win = growEnd(win, 100, limits);
  expect(win).toEqual({ start: 0, end: 60 });
  expect(growEnd({ start: 0, end: 100 }, 100, limits).end).toBe(100);
  expect(initialWindow(10, limits)).toEqual({ start: 0, end: 10 });
  expect(growStart({ start: 70, end: 100 }, limits)).toEqual({
    start: 46,
    end: 100,
  });
  expect(growStart({ start: 10, end: 100 }, limits).start).toBe(0);
});

test('growing past the DOM cap drops the far side', () => {
  const grown = growEnd({ start: 0, end: 132 }, 500, limits);
  expect(grown).toEqual({ start: 24, end: 156 });
  const back = growStart({ start: 300, end: 432 }, limits);
  expect(back).toEqual({ start: 276, end: 408 });
});

test('a far selection gets a bounded window and a near one changes nothing', () => {
  const win = initialWindow(500, limits);
  expect(revealIndex(win, 20, 500, limits)).toBe(win);
  const far = revealIndex(win, 300, 500, limits);
  expect(far).toEqual({ start: 276, end: 325 });
  expect(far.end - far.start).toBeLessThanOrEqual(2 * limits.batch + 1);
  expect(revealIndex(win, 40, 500, limits).start).toBe(0);
  expect(revealIndex(win, 499, 500, limits).end).toBe(500);
  expect(clampWindow({ start: 0, end: 60 }, 20, limits)).toEqual({
    start: 0,
    end: 20,
  });
  expect(clampWindow({ start: 80, end: 100 }, 20, limits)).toEqual({
    start: 0,
    end: 20,
  });
});

test('edges are detected from scroll geometry', () => {
  const at = (scrollLeft) =>
    approachedEdge({ scrollLeft, clientWidth: 400, scrollWidth: 4000 }, 400);
  expect(at(0)).toEqual({ start: true, end: false });
  expect(at(1700)).toEqual({ start: false, end: false });
  expect(at(3300)).toEqual({ start: false, end: true });
});

// --- Shortcuts ---------------------------------------------------------------------

const press = (key, target = document.body, init = {}) => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, ...init });
  Object.defineProperty(event, 'target', { value: target });
  return galleryShortcut(event);
};
const element = (html) => {
  const holder = document.createElement('div');
  holder.innerHTML = html;
  return holder.firstElementChild;
};

test('shortcuts map to actions and leave other controls alone', () => {
  expect(press('ArrowRight')).toBe('next');
  expect(press('ArrowLeft')).toBe('previous');
  expect(press(' ')).toBe('chrome');
  expect(press('Escape')).toBe('chrome');
  expect(press('H')).toBe('chrome');
  expect(press('c')).toBe('filmstrip');
  expect(press('x')).toBeNull();
  expect(press('c', document.body, { ctrlKey: true })).toBeNull();
  expect(press('h', document.body, { metaKey: true })).toBeNull();
  for (const html of [
    '<input type="text">',
    '<input type="range">',
    '<textarea></textarea>',
    '<select></select>',
    '<div contenteditable="true"></div>',
    '<div role="dialog"><button>x</button></div>',
  ])
    expect(press('ArrowRight', element(html))).toBeNull();
  // Space activates buttons, links and checkboxes instead of hiding the chrome.
  expect(press(' ', element('<button>go</button>'))).toBeNull();
  expect(press(' ', element('<a href="/x">go</a>'))).toBeNull();
  expect(press(' ', element('<input type="checkbox">'))).toBeNull();
  expect(press('h', element('<button>go</button>'))).toBe('chrome');
  expect(press('ArrowRight', element('<input type="checkbox">'))).toBe('next');
});

test('filtering the last selected image wraps to the remaining eligible image', () => {
  const initial = open(keys(2));
  const remaining = initial.order[0];
  const selected = selectPlayback(initial, initial.order.at(-1));
  const filtered = syncPlayback(selected, {
    library: records(keys(2)),
    eligible: [remaining],
    playing: false,
  });
  expect(filtered.order).toEqual([remaining]);
  expect(filtered.current).toBe(remaining);
  expect(filtered.loaded).toBeNull();
});
