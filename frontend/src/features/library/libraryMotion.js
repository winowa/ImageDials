import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

/**
 * Library card motion: FLIP reflow for cards that persist, a restrained
 * entrance for new cards and a one-shot exit for a confirmed deletion.
 *
 * Positions are measured against the list, so scrolling never counts as
 * movement. Visual positions are captured during render (including any
 * transform still in flight) so an interrupted move continues from where
 * the card is drawn. Card elements are never recreated or moved in the DOM.
 */

const FALLBACK = { move: 360, enter: 360, exit: 220, ease: 'ease-out' };
const STAGGER_MS = 16;
const STAGGER_STEPS = 6;
const MAX_ENTERING = 24;
const VIEW_MARGIN = 240;

const reducedMotion = () =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

/** Existing named motion tokens, read from the list's cascade. */
function tokens(list) {
  const style = getComputedStyle(list);
  const ms = (name, fallback) => {
    const value = Number.parseFloat(style.getPropertyValue(name));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  return {
    move: ms('--duration-reveal', FALLBACK.move),
    enter: ms('--duration-reveal', FALLBACK.enter),
    exit: ms('--duration-base', FALLBACK.exit),
    ease: style.getPropertyValue('--ease').trim() || FALLBACK.ease,
  };
}

/** @returns {Map<string, {x:number,y:number,w:number,h:number,top:number,bottom:number}>} */
export function measureCards(list) {
  const origin = list.getBoundingClientRect();
  const rects = new Map();
  for (const el of list.children) {
    const key = el.dataset?.cardKey;
    if (key === undefined) continue;
    const r = el.getBoundingClientRect();
    rects.set(key, {
      x: r.left - origin.left,
      y: r.top - origin.top,
      w: r.width,
      h: r.height,
      top: r.top,
      bottom: r.bottom,
    });
  }
  return rects;
}

const FREEZE_MAX = 480;

/**
 * Copy of a card for its exit. Loaded images become canvases drawn from the
 * pixels already decoded, so the copy never requests a source that a
 * deletion (or a released media lease) has just removed.
 */
function exitCopy(el) {
  const copy = el.cloneNode(true);
  const live = el.querySelectorAll('img');
  copy.querySelectorAll('img').forEach((img, index) => {
    const source = live[index];
    if (!source?.complete || !source.naturalWidth) return;
    const scale = Math.min(1, FREEZE_MAX / source.naturalWidth);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(source.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(source.naturalHeight * scale));
    try {
      canvas
        .getContext('2d')
        ?.drawImage(source, 0, 0, canvas.width, canvas.height);
    } catch {
      return;
    }
    canvas.className = img.className;
    img.replaceWith(canvas);
  });
  return copy;
}

/** Plays the one-shot exit of a copy of a deleted card. Never interactive. */
function playExit(list, ghost, from, timing, ghosts) {
  ghost.removeAttribute('data-card-key');
  ghost.setAttribute('aria-hidden', 'true');
  ghost.setAttribute('data-card-exit', '');
  ghost.inert = true;
  Object.assign(ghost.style, {
    position: 'absolute',
    left: `${from.x}px`,
    top: `${from.y}px`,
    width: `${from.w}px`,
    margin: '0',
    pointerEvents: 'none',
    zIndex: '1',
  });
  list.append(ghost);
  const animation = ghost.animate(
    [
      { opacity: 1, transform: 'none' },
      { opacity: 0, transform: 'scale(0.9)' },
    ],
    { duration: timing.exit, easing: timing.ease, fill: 'forwards' },
  );
  ghosts.add(animation);
  const done = () => {
    ghosts.delete(animation);
    ghost.remove();
  };
  animation.onfinish = done;
  animation.oncancel = done;
}

const nearView = (rect) =>
  rect.bottom > -VIEW_MARGIN && rect.top < window.innerHeight + VIEW_MARGIN;

/**
 * @param {string[]} keys card identities in display order
 * @param {number|string} density columns, so a density change also reflows
 */
export function useCardMotion(keys, density) {
  const [listEl, setListEl] = useState(null);
  const signature = `${density}|${keys.join('\u0000')}`;
  // Layout positions after the previous pass.
  const last = useRef(null);
  const exit = useRef(null);
  const running = useRef(new Set());
  const ghosts = useRef(new Set());

  const findCard = useCallback(
    (key) => {
      for (const el of listEl?.children ?? [])
        if (el.dataset?.cardKey === key) return el;
      return null;
    },
    [listEl],
  );
  const discardExit = useCallback(() => {
    exit.current = null;
  }, []);
  /** Snapshot a card before its deletion is confirmed; shown only on success. */
  const prepareExit = useCallback(
    (key) => {
      const el = findCard(key);
      exit.current = el ? { key, node: exitCopy(el) } : null;
    },
    [findCard],
  );

  useLayoutEffect(() => {
    const list = listEl;
    const previous = last.current;
    if (!list) {
      last.current = null;
      return;
    }
    const motionEnabled =
      !reducedMotion() && typeof list.animate === 'function';
    // Where each card is drawn now (any in-flight transform included), then
    // where layout put it. Their difference continues an interrupted move.
    // This first read is only needed to continue an enabled animation.
    const drawn = previous && motionEnabled ? measureCards(list) : null;
    for (const animation of running.current) animation.cancel();
    const after = measureCards(list);
    last.current = after;
    const snapshot = exit.current;
    if (!previous || previous.size === 0 || !motionEnabled) {
      if (snapshot && !after.has(snapshot.key)) exit.current = null;
      return;
    }
    const timing = tokens(list);
    const before = new Map();
    for (const [key, rect] of previous) {
      const now = drawn.get(key);
      const base = after.get(key);
      before.set(
        key,
        now && base
          ? {
              ...rect,
              x: rect.x + now.x - base.x,
              y: rect.y + now.y - base.y,
              top: rect.top + now.y - base.y,
              bottom: rect.bottom + now.y - base.y,
            }
          : rect,
      );
    }
    const cards = new Map();
    for (const el of list.children)
      if (el.dataset?.cardKey !== undefined) cards.set(el.dataset.cardKey, el);
    let persisted = 0;
    for (const key of after.keys()) if (before.has(key)) persisted += 1;

    let entering = 0;
    for (const [key, to] of after) {
      const from = before.get(key);
      const el = cards.get(key);
      if (!el) continue;
      if (from) {
        const dx = from.x - to.x;
        const dy = from.y - to.y;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
        if (!nearView(from) && !nearView(to)) continue;
        const animation = el.animate(
          [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
          { duration: timing.move, easing: timing.ease },
        );
        running.current.add(animation);
        const done = () => running.current.delete(animation);
        animation.onfinish = done;
        animation.oncancel = done;
      } else if (nearView(to) && entering < MAX_ENTERING) {
        // A whole new page only fades; an arrival among kept cards also
        // settles into place so it reads as an insertion.
        const replacing = persisted === 0;
        const frames = replacing
          ? [{ opacity: 0 }, { opacity: 1 }]
          : [
              { opacity: 0, transform: 'translateY(0.75rem) scale(0.94)' },
              { opacity: 1, transform: 'none' },
            ];
        const animation = el.animate(frames, {
          duration: replacing ? timing.exit : timing.enter,
          delay: replacing ? 0 : Math.min(entering, STAGGER_STEPS) * STAGGER_MS,
          easing: timing.ease,
          fill: 'backwards',
        });
        running.current.add(animation);
        const done = () => running.current.delete(animation);
        animation.onfinish = done;
        animation.oncancel = done;
        entering += 1;
      }
    }

    if (snapshot && before.has(snapshot.key) && !after.has(snapshot.key)) {
      exit.current = null;
      const from = before.get(snapshot.key);
      if (nearView(from))
        playExit(list, snapshot.node, from, timing, ghosts.current);
    }
  }, [signature, listEl]);

  // Route leave: nothing keeps animating or lingering.
  useEffect(() => {
    const live = running.current;
    const exiters = ghosts.current;
    return () => {
      for (const animation of live) animation.cancel();
      for (const animation of exiters) animation.cancel();
    };
  }, []);

  return { attachList: setListEl, findCard, prepareExit, discardExit };
}
