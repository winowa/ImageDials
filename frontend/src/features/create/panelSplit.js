/**
 * Width of the generator's prompt panel beside the image stage.
 *
 * The preference is a fraction of the width the two columns share, so the
 * proportion survives resizing and rotation. Pixel bounds are applied to the
 * space that is actually available, never to a device.
 */

/** Space between the columns; the divider lives here. */
export const DIVIDER_PX = 28;
/** The narrowest the prompt panel may be. */
export const MIN_PANEL_PX = 352;
/** The narrowest the image stage may be; below that the columns stack. */
export const MIN_STAGE_PX = 480;
/** The panel never takes more than this share of the shared width. */
export const MAX_PANEL_FRACTION = 0.65;
/** Panel share when nothing is stored. */
export const DEFAULT_PANEL_FRACTION = 5 / 11;
/** Arrow-key change, as a share of the shared width. */
export const KEY_STEP_FRACTION = 0.02;
/** Page Up/Down change, as a share of the shared width. */
export const KEY_PAGE_FRACTION = 0.1;
/** Smallest movable range worth showing a divider for. */
export const MIN_RANGE_PX = 48;
/** Stored fractions outside this range are ignored. */
const STORED_MIN = 0.2;
const STORED_MAX = 0.8;

const finite = (n) => typeof n === 'number' && Number.isFinite(n);

/** A stored value as a usable fraction, else the fallback. */
export function sanitizeFraction(stored, fallback = DEFAULT_PANEL_FRACTION) {
  return finite(stored) && stored >= STORED_MIN && stored <= STORED_MAX
    ? stored
    : fallback;
}

/**
 * Layout and limits for the width the two columns occupy.
 * `layout` is `stacked` when neither column can keep its minimum; the divider
 * is `resizable` only when the panel has a worthwhile range to move through.
 */
export function splitBounds(containerWidth) {
  const available = finite(containerWidth)
    ? Math.max(0, containerWidth - DIVIDER_PX)
    : 0;
  const min = MIN_PANEL_PX;
  const max = Math.floor(
    Math.min(available * MAX_PANEL_FRACTION, available - MIN_STAGE_PX),
  );
  const split = available > 0 && max >= min;
  return {
    layout: split ? 'split' : 'stacked',
    resizable: split && max - min >= MIN_RANGE_PX,
    available,
    min,
    max: split ? max : min,
  };
}

/** Pixel width for a fraction, kept inside the bounds. */
export function panelPx(fraction, bounds) {
  const wanted = Math.round(sanitizeFraction(fraction) * bounds.available);
  return Math.min(bounds.max, Math.max(bounds.min, wanted));
}

/** The fraction a pixel width represents. */
export const fractionOf = (px, bounds) =>
  bounds.available > 0 ? px / bounds.available : DEFAULT_PANEL_FRACTION;

/** Rounded whole percentages for assistive technology. */
export function percentages(px, bounds) {
  const share = (n) =>
    bounds.available > 0 ? Math.round((n / bounds.available) * 100) : 0;
  return { now: share(px), min: share(bounds.min), max: share(bounds.max) };
}

/**
 * The pixel width a key asks for, or null for a key that does not resize.
 * Left/Right (and Up/Down) step; Page Up/Down take a larger step; Home and End
 * go to the limits. The result is clamped to the bounds.
 */
export function keyedPx(key, px, bounds) {
  const step = KEY_STEP_FRACTION * bounds.available;
  const page = KEY_PAGE_FRACTION * bounds.available;
  const delta = {
    ArrowLeft: -step,
    ArrowDown: -step,
    ArrowRight: step,
    ArrowUp: step,
    PageDown: -page,
    PageUp: page,
  }[key];
  let next;
  if (key === 'Home') next = bounds.min;
  else if (key === 'End') next = bounds.max;
  else if (delta !== undefined) next = px + delta;
  else return null;
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(next)));
}

/** Pixel width after the pointer moves `delta` from a drag that began at `start`. */
export const draggedPx = (start, delta, bounds) =>
  Math.min(bounds.max, Math.max(bounds.min, Math.round(start + delta)));
