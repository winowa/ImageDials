/**
 * Brings the image frame fully into view after an explicit Generate. Every
 * scrolling ancestor (the sticky side pane, then the page) moves by the
 * smallest amount that shows the whole frame, or aligns its top edge when the
 * frame is taller than the visible area. Nothing else ever calls this.
 */
const EDGE_GAP = 8;

const scrollable = (node) => {
  const { overflowY } = getComputedStyle(node);
  return (
    /(auto|scroll|overlay)/.test(overflowY) &&
    node.scrollHeight > node.clientHeight + 1
  );
};

const calm = () =>
  Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

/** The vertical shift (positive scrolls down) that reveals `rect` in `view`. */
export function revealDelta(rect, view, gap = EDGE_GAP) {
  const top = view.top + gap;
  const bottom = view.bottom - gap;
  if (rect.top >= top && rect.bottom <= bottom) return 0;
  if (rect.height > bottom - top || rect.top < top) return rect.top - top;
  return rect.bottom - bottom;
}

/** The part of `delta` this pane can still scroll; an exhausted pane moves 0. */
export function achievable(node, delta) {
  const room =
    delta > 0
      ? node.scrollHeight - node.clientHeight - node.scrollTop
      : -node.scrollTop;
  const moved =
    delta > 0
      ? Math.min(delta, Math.max(0, room))
      : Math.max(delta, Math.min(0, room)) + 0;
  return moved;
}

export function scrollStageIntoView(root = document) {
  const frame = root.querySelector('#result .stage');
  if (!frame) return;
  const behavior = calm() ? 'auto' : 'smooth';
  let rect = frame.getBoundingClientRect();
  for (let node = frame.parentElement; node; node = node.parentElement) {
    if (node === document.body || node === document.documentElement) break;
    if (!scrollable(node)) continue;
    const box = node.getBoundingClientRect();
    const delta = revealDelta(rect, box);
    if (delta) {
      const moved = achievable(node, delta);
      if (moved) {
        node.scrollBy({ top: moved, behavior });
        rect = new DOMRect(rect.x, rect.y - moved, rect.width, rect.height);
      }
    }
  }
  const page = revealDelta(rect, { top: 0, bottom: window.innerHeight });
  if (page) window.scrollBy({ top: page, behavior });
}

/** Shows the error left by a refused submission. */
export function scrollNoticeIntoView(root = document) {
  const target = root.querySelector('.prompt-card .notice, .status-line');
  target?.scrollIntoView?.({
    behavior: calm() ? 'auto' : 'smooth',
    block: 'nearest',
  });
}
