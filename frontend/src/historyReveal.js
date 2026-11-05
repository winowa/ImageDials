import { useCallback, useLayoutEffect, useRef } from 'react';

/** Reveal a selected completion once, after its row and layout are available. */
export function useHistoryReveal(ref, items, request, onDone) {
  const done = useRef(null);
  const touching = useRef({ pointer: false, touch: false, scrolling: false });
  const latest = useRef(null);
  const resizeObserver = useRef(null);
  const restoreSnap = useRef(null);
  useLayoutEffect(() => {
    latest.current = { request, onDone };
  });
  const attempt = useCallback(() => {
    const strip = ref.current;
    const { request: wanted, onDone: finish } = latest.current;
    if (
      !strip ||
      !wanted ||
      done.current === wanted ||
      touching.current.pointer ||
      touching.current.touch ||
      touching.current.scrolling
    )
      return;
    const row = [...strip.children].find((n) => n.dataset.key === wanted.key);
    if (!row || !strip.clientWidth || !row.offsetWidth) return;
    const left = strip.scrollLeft;
    const start = row.offsetLeft;
    const end = start + row.offsetWidth;
    // Immediate positioning deliberately avoids smooth-scroll work outliving
    // the selection, competing with touch inertia or anchor restoration. It
    // also needs no separate reduced-motion path or animation cleanup.
    const target =
      start < left
        ? start
        : end > left + strip.clientWidth
          ? Math.max(start, end - strip.clientWidth)
          : left;
    if (Math.abs(target - left) > 1) {
      restoreSnap.current?.();
      const snap = strip.style.scrollSnapType;
      // A catalog commit can leave the browser's old snap target scheduled
      // after this layout effect. Release it through the commit, then restore
      // native snapping at the new position. Two frames only, never a loop.
      strip.style.scrollSnapType = 'none';
      if (typeof strip.scrollTo === 'function')
        strip.scrollTo({ left: target, behavior: 'instant' });
      else strip.scrollLeft = target;
      let inner;
      const restore = () => {
        cancelAnimationFrame(outer);
        if (inner !== undefined) cancelAnimationFrame(inner);
        strip.style.scrollSnapType = snap;
        restoreSnap.current = null;
      };
      const outer = requestAnimationFrame(() => {
        inner = requestAnimationFrame(restore);
      });
      restoreSnap.current = restore;
    }
    done.current = wanted;
    finish?.(wanted);
  }, [ref]);
  const mounted = items.length > 0;
  useLayoutEffect(() => {
    const strip = ref.current;
    if (!strip) return undefined;
    let settleTimer;
    const settled = () => {
      clearTimeout(settleTimer);
      if (touching.current.pointer || touching.current.touch) return;
      touching.current.scrolling = false;
      attempt();
    };
    // Some engines have no scrollend. One timer per real scroll event also
    // covers touch inertia without a polling loop or a permanent listener job.
    const released = () => {
      if (touching.current.scrolling) {
        clearTimeout(settleTimer);
        settleTimer = setTimeout(settled, 160);
      } else attempt();
    };
    const scrolled = () => {
      if (
        touching.current.touch ||
        touching.current.pointer ||
        touching.current.scrolling
      ) {
        touching.current.scrolling = true;
        released();
      }
    };
    const down = () => {
      restoreSnap.current?.();
      touching.current.pointer = true;
    };
    const up = () => {
      touching.current.pointer = false;
      released();
    };
    const touchStart = () => {
      restoreSnap.current?.();
      touching.current.touch = true;
    };
    const touchEnd = (event) => {
      touching.current.touch = event.touches.length > 0;
      released();
    };
    strip.addEventListener('scroll', scrolled, { passive: true });
    strip.addEventListener('scrollend', settled, { passive: true });
    strip.addEventListener('touchstart', touchStart, { passive: true });
    window.addEventListener('touchend', touchEnd, { passive: true });
    window.addEventListener('touchcancel', touchEnd, { passive: true });
    strip.addEventListener('pointerdown', down, { passive: true });
    window.addEventListener('pointerup', up, { passive: true });
    window.addEventListener('pointercancel', up, { passive: true });
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => attempt());
    resizeObserver.current = observer;
    observer?.observe(strip);
    return () => {
      resizeObserver.current = null;
      restoreSnap.current?.();
      clearTimeout(settleTimer);
      touching.current = { pointer: false, touch: false, scrolling: false };
      strip.removeEventListener('scroll', scrolled);
      strip.removeEventListener('scrollend', settled);
      strip.removeEventListener('touchstart', touchStart);
      window.removeEventListener('touchend', touchEnd);
      window.removeEventListener('touchcancel', touchEnd);
      strip.removeEventListener('pointerdown', down);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      observer?.disconnect();
    };
  }, [ref, mounted, attempt]);
  useLayoutEffect(() => {
    const row =
      request &&
      [...(ref.current?.children ?? [])].find(
        (node) => node.dataset.key === request.key,
      );
    const observer = resizeObserver.current;
    if (row) observer?.observe(row);
    attempt();
    return () => {
      if (row) observer?.unobserve?.(row);
    };
  }, [ref, items, request, attempt]);
}
