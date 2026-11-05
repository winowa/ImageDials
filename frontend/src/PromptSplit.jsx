import React, { useLayoutEffect, useRef, useState } from 'react';

import { usePreference } from './preferences.js';
import {
  DEFAULT_PANEL_FRACTION,
  DIVIDER_PX,
  draggedPx,
  fractionOf,
  keyedPx,
  panelPx,
  percentages,
  sanitizeFraction,
  splitBounds,
} from './panelSplit.js';
import './PromptSplit.css';

/** Measures a split around its actual available CSS width. */
export function usePromptSplit(containerRef) {
  const [containerWidth, setContainerWidth] = useState(0);
  const [fraction, saveFraction] = usePreference(
    'prompt-panel-fraction',
    DEFAULT_PANEL_FRACTION,
    sanitizeFraction,
  );
  const [dragWidth, setDragWidth] = useState(null);
  const drag = useRef(null);
  const bounds = splitBounds(containerWidth);
  const width = dragWidth ?? panelPx(fraction, bounds);

  useLayoutEffect(() => {
    const node = containerRef.current;
    if (!node) return undefined;
    const measure = () => {
      const next = node.getBoundingClientRect().width;
      setContainerWidth((previous) => (previous === next ? previous : next));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [containerRef]);

  const saveWidth = (pixels) => saveFraction(fractionOf(pixels, bounds));
  const pointerDown = (event) => {
    if (event.button !== 0 || !bounds.resizable) return;
    drag.current = {
      id: event.pointerId,
      x: event.clientX,
      width,
      bounds,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDragWidth(width);
    event.preventDefault();
  };
  const pointerMove = (event) => {
    const start = drag.current;
    if (!start || start.id !== event.pointerId) return;
    if (start.bounds.available !== bounds.available) {
      drag.current = null;
      setDragWidth(null);
      return;
    }
    setDragWidth(draggedPx(start.width, event.clientX - start.x, start.bounds));
  };
  const pointerUp = (event) => {
    const start = drag.current;
    if (!start || start.id !== event.pointerId) return;
    if (start.bounds.available !== bounds.available) {
      drag.current = null;
      setDragWidth(null);
      return;
    }
    const pixels = draggedPx(
      start.width,
      event.clientX - start.x,
      start.bounds,
    );
    drag.current = null;
    setDragWidth(null);
    saveWidth(pixels);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };
  const pointerCancel = () => {
    drag.current = null;
    setDragWidth(null);
  };
  const keyDown = (event) => {
    const next = keyedPx(event.key, width, bounds);
    if (next === null || !bounds.resizable) return;
    event.preventDefault();
    saveWidth(next);
  };

  return {
    bounds,
    width,
    layout: bounds.layout,
    fraction,
    columns:
      bounds.layout === 'stacked'
        ? 'minmax(0, 1fr)'
        : bounds.resizable
          ? `${width}px ${DIVIDER_PX}px minmax(0, 1fr)`
          : `${width}px minmax(0, 1fr)`,
    columnGap: bounds.resizable ? '0px' : `${DIVIDER_PX}px`,
    separator: bounds.resizable
      ? {
          ...percentages(width, bounds),
          pointerDown,
          pointerMove,
          pointerUp,
          pointerCancel,
          keyDown,
        }
      : null,
  };
}

export default function PromptSplit({ id, separator }) {
  if (!separator) return null;
  return (
    <div
      className="prompt-split"
      role="separator"
      aria-label="Prompt panel width"
      aria-orientation="vertical"
      aria-controls={id}
      aria-valuemin={separator.min}
      aria-valuemax={separator.max}
      aria-valuenow={separator.now}
      aria-valuetext={`${separator.now}% of available width`}
      tabIndex={0}
      onPointerDown={separator.pointerDown}
      onPointerMove={separator.pointerMove}
      onPointerUp={separator.pointerUp}
      onPointerCancel={separator.pointerCancel}
      onLostPointerCapture={separator.pointerCancel}
      onKeyDown={separator.keyDown}
    />
  );
}
