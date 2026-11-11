/**
 * The filmstrip renders a contiguous window of the eligible list rather than
 * every thumbnail: `initial` from the front, `batch` more as the viewer
 * approaches an edge, and a window around the selection when it is far away.
 */

/** @returns {{start: number, end: number}} half-open index range */
export const initialWindow = (total, { initial }) => ({
  start: 0,
  end: Math.min(total, initial),
});

/**
 * Keep `win` valid after the list changed length. A window that still starts
 * at the front always shows at least the initial count, so a list that arrives
 * after the first render is not cut short.
 */
export function clampWindow(win, total, limits) {
  const end = Math.min(
    total,
    win.start === 0 ? Math.max(win.end, limits.initial) : win.end,
  );
  return end > win.start
    ? { start: win.start, end }
    : initialWindow(total, limits);
}

/** A window that contains `index`; a far selection replaces the window. */
export function revealIndex(win, index, total, { batch }) {
  if (index < 0 || (index >= win.start && index < win.end)) return win;
  const start = Math.max(0, index - batch);
  return {
    start: start <= batch ? 0 : start,
    end: Math.min(total, index + batch + 1),
  };
}

/** Most thumbnails kept in the DOM; growing past it drops the far side. */
export const maxSpan = ({ initial, batch }) => initial + 4 * batch;

export function growEnd(win, total, limits) {
  if (win.end >= total) return win;
  const end = Math.min(total, win.end + limits.batch);
  return { start: Math.max(win.start, end - maxSpan(limits)), end };
}

export function growStart(win, limits) {
  if (win.start <= 0) return win;
  const start = Math.max(0, win.start - limits.batch);
  return { start, end: Math.min(win.end, start + maxSpan(limits)) };
}

/**
 * Which edge the viewer is approaching. `margin` is the distance from the
 * edge, in pixels, that counts as approaching.
 */
export function approachedEdge(
  { scrollLeft, clientWidth, scrollWidth },
  margin,
) {
  const left = Math.abs(scrollLeft);
  return {
    start: left <= margin,
    end: scrollWidth - (left + clientWidth) <= margin,
  };
}
