import React, {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { Tip } from './ui.jsx';
import './ViewportResize.css';

/** Smallest a resized viewport can be, in CSS pixels. */
export const VIEWPORT_MIN_PX = 96;
/** Largest, as a fraction of the window height (see `viewportMaxPx`). */
export const VIEWPORT_MAX_FRACTION = 0.85;
const KEY_STEP_PX = 24;
const KEY_PAGE_PX = 120;

export const viewportMaxPx = () =>
  Math.max(
    VIEWPORT_MIN_PX + KEY_STEP_PX,
    Math.floor(window.innerHeight * VIEWPORT_MAX_FRACTION),
  );

/**
 * Height control for one scrolling viewport. The viewport keeps its compact,
 * content-driven default until the person resizes it. Native `resize` is not
 * used: touch browsers do not offer it and it has no keyboard path, so a
 * separator handle (drag, touch, arrow keys, Home/End, Enter to reset)
 * replaces it. The handle appears only while there is something to resize.
 *
 * Spread `viewport.props` on the scrolling element and render
 * `<ViewportHandle viewport={viewport} label="…" />` after it.
 */
export function useResizableViewport() {
  const id = useId();
  const element = useRef(null);
  const observer = useRef(null);
  const [height, setHeight] = useState(null);
  const [actual, setActual] = useState(0);
  const [overflowing, setOverflowing] = useState(false);
  const [limit, setLimit] = useState(viewportMaxPx);
  const [dragging, setDragging] = useState(false);
  const [focused, setFocused] = useState(false);

  const measure = useCallback(() => {
    const node = element.current;
    if (!node) return;
    setActual(Math.round(node.getBoundingClientRect().height));
    setOverflowing(node.scrollHeight > node.clientHeight + 1);
  }, []);

  // Re-measure after every render and re-watch whatever content is current.
  useLayoutEffect(() => {
    measure();
    const node = element.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    observer.current ??= new ResizeObserver(measure);
    observer.current.disconnect();
    observer.current.observe(node);
    if (node.firstElementChild)
      observer.current.observe(node.firstElementChild);
  });
  useEffect(() => () => observer.current?.disconnect(), []);
  useEffect(() => {
    const onResize = () => {
      setLimit(viewportMaxPx());
      measure();
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [measure]);

  const clamp = (px) =>
    Math.min(Math.max(Math.round(px), VIEWPORT_MIN_PX), limit);
  const current = () =>
    element.current ? element.current.getBoundingClientRect().height : actual;
  const sized = height !== null;

  return {
    id,
    sized,
    dragging,
    limit,
    value: clamp(actual || VIEWPORT_MIN_PX),
    visible: overflowing || sized || focused || dragging,
    props: {
      id,
      ref: element,
      'data-sized': sized,
      style: sized ? { height: clamp(height) } : undefined,
    },
    set: (px) => setHeight(clamp(px)),
    reset: () => setHeight(null),
    by: (delta) => setHeight(clamp(current() + delta)),
    current,
    setDragging,
    setFocused,
  };
}

/** Separator handle that resizes the viewport it controls. */
export function ViewportHandle({ viewport, label }) {
  const drag = useRef(null);
  const {
    visible,
    dragging,
    limit,
    value,
    id,
    set,
    by,
    reset,
    current,
    setDragging,
    setFocused,
  } = viewport;
  const onKeyDown = (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const keys = {
      ArrowDown: () => by(KEY_STEP_PX),
      ArrowUp: () => by(-KEY_STEP_PX),
      PageDown: () => by(KEY_PAGE_PX),
      PageUp: () => by(-KEY_PAGE_PX),
      Home: () => set(VIEWPORT_MIN_PX),
      End: () => set(limit),
      Enter: reset,
    };
    const act = keys[event.key];
    if (!act) return;
    event.preventDefault();
    act();
  };
  const end = (event) => {
    if (!drag.current || drag.current.id !== event.pointerId) return;
    const { id: pointer } = drag.current;
    drag.current = null;
    setDragging(false);
    try {
      event.currentTarget.releasePointerCapture?.(pointer);
    } catch {
      // The pointer was already released.
    }
  };
  return (
    <div className="viewport-grip" data-visible={visible} inert={!visible}>
      <div className="viewport-grip-inner">
        <Tip label="Drag or use arrow keys to resize" hidden={dragging}>
          <div
            role="separator"
            aria-orientation="horizontal"
            aria-controls={id}
            aria-label={`Resize ${label}`}
            aria-valuemin={VIEWPORT_MIN_PX}
            aria-valuemax={limit}
            aria-valuenow={value}
            aria-valuetext={`${value} pixels high`}
            tabIndex={0}
            className="viewport-handle"
            data-dragging={dragging}
            onKeyDown={onKeyDown}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onDoubleClick={reset}
            onPointerDown={(event) => {
              if (
                drag.current ||
                (event.pointerType === 'mouse' && event.button !== 0)
              )
                return;
              event.currentTarget.setPointerCapture?.(event.pointerId);
              drag.current = {
                id: event.pointerId,
                y: event.clientY,
                height: current(),
              };
              setDragging(true);
            }}
            onPointerMove={(event) => {
              if (drag.current?.id === event.pointerId)
                set(drag.current.height + event.clientY - drag.current.y);
            }}
            onPointerUp={end}
            onPointerCancel={end}
            onLostPointerCapture={end}
          />
        </Tip>
      </div>
    </div>
  );
}
