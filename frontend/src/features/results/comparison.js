/**
 * Pure rules for comparing a result with an attached reference: which
 * references can be compared, which one is the result's recorded source, and
 * the shared zoom/pan/divider geometry. Comparison is visual: each image is
 * fitted inside the same frame and both receive the same transform. Images of
 * different size or framing are not registered pixel for pixel.
 */
import { recordReferences, REF_STATUS } from '../references/references.js';

export const ZOOM_MIN = 1;
export const ZOOM_MAX = 8;
/** Factor applied by one zoom button press or key press. */
export const ZOOM_STEP = 1.5;
/** Divider movement per arrow key, and per Page Up/Down, in percent. */
export const DIVIDER_STEP = 5;
export const DIVIDER_PAGE = 25;
/** Fraction of the frame moved per arrow key while zoomed. */
export const PAN_STEP = 0.1;
/** Aspect ratios closer than this are treated as the same framing. */
const ASPECT_TOLERANCE = 0.01;

export const FIT_VIEW = Object.freeze({ zoom: 1, x: 0, y: 0 });

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const validSize = (size) =>
  size && size.width > 0 && size.height > 0
    ? { width: size.width, height: size.height }
    : null;

/**
 * Sources that can be compared with `image`, in draft order, then recorded
 * order. Attached references qualify only when their exact bytes are held in
 * memory; a missing or still-reading one is never fetched. A reference with the
 * result's own bytes is left out. `matched` is true only when the bytes equal a
 * source recorded on the saved result.
 *
 * A recorded source that is not attached may still be offered, never attached
 * by this function: one held in this tab (`lookup.held(sha)` returns
 * `{blob, name, dimensions}`) or one kept in this browser (`lookup.kept(sha)`
 * returns its metadata, `lookup.load(sha, {signal})` resolves its Blob). A kept
 * source has no `blob` yet: `load` is called only after Compare opens.
 *
 * @param {object} image
 * @param {Array<object>} refs the draft's references
 * @param {{held?: (sha: string) => object|null, kept?: (sha: string) => object|null,
 *   load?: (sha: string, options: {signal?: AbortSignal}) => Promise<Blob|null>}} [lookup]
 */
export function comparisonSources(image, refs, lookup = {}) {
  if (!image || !Array.isArray(refs)) return [];
  const recorded = recordReferences(image);
  const own = typeof image.sha256 === 'string' ? image.sha256 : null;
  const sources = [];
  for (const ref of refs) {
    if (
      ref?.status !== REF_STATUS.ready ||
      !ref.blob ||
      typeof ref.sha256 !== 'string' ||
      ref.sha256 === own
    )
      continue;
    const recordedIndex = recorded.findIndex((d) => d.sha256 === ref.sha256);
    sources.push({
      id: ref.id,
      origin: 'attached',
      blob: ref.blob,
      sha256: ref.sha256,
      name: ref.name || 'reference',
      dimensions: validSize(ref.dimensions),
      matched: recordedIndex >= 0,
      recordedIndex,
    });
  }
  const seen = new Set(sources.map((source) => source.sha256));
  recorded.forEach((descriptor, recordedIndex) => {
    const sha = descriptor.sha256;
    if (typeof sha !== 'string' || sha === own || seen.has(sha)) return;
    const held = lookup.held?.(sha);
    if (held?.blob) {
      seen.add(sha);
      sources.push({
        id: `held:${sha}`,
        origin: 'held',
        blob: held.blob,
        sha256: sha,
        name: held.name || descriptor.filename || 'source',
        dimensions: validSize(held.dimensions ?? descriptor.dimensions),
        matched: true,
        recordedIndex,
      });
      return;
    }
    const kept = lookup.kept?.(sha);
    if (kept && lookup.load) {
      seen.add(sha);
      sources.push({
        id: `kept:${sha}`,
        origin: 'kept',
        blob: null,
        load: (options) => lookup.load(sha, options),
        sha256: sha,
        name: kept.name || descriptor.filename || 'source',
        dimensions: validSize(kept.dimensions ?? descriptor.dimensions),
        matched: true,
        recordedIndex,
      });
    }
  });
  return sources;
}

/**
 * The source compared by default: the result's recorded base if attached,
 * then its earliest other recorded source, then the first attached reference.
 */
export function defaultSourceId(sources) {
  if (!sources.length) return null;
  const matched = sources
    .filter((s) => s.matched)
    .sort((a, b) => a.recordedIndex - b.recordedIndex);
  return (matched[0] ?? sources[0]).id;
}

/** Short label for the "before" side: only a recorded source is called one. */
export const sourceLabel = (source) =>
  source?.matched ? 'Source' : 'Reference';

/** True when two sizes have visibly different aspect ratios. */
export function aspectsDiffer(a, b) {
  const first = validSize(a);
  const second = validSize(b);
  if (!first || !second) return false;
  const ratio = first.width / first.height / (second.width / second.height);
  return Math.abs(ratio - 1) > ASPECT_TOLERANCE;
}

/**
 * The largest box with the aspect of `size` inside `available`, centered.
 * Without a known size the whole available box is used.
 */
export function fitBox(available, size) {
  const width = Math.max(0, available?.width ?? 0);
  const height = Math.max(0, available?.height ?? 0);
  const box = validSize(size);
  if (!box || !width || !height) return { left: 0, top: 0, width, height };
  const scale = Math.min(width / box.width, height / box.height);
  const w = box.width * scale;
  const h = box.height * scale;
  return { left: (width - w) / 2, top: (height - h) / 2, width: w, height: h };
}

/**
 * Keep the zoomed content covering the frame: the view is scaled about the
 * frame center, so the pan may move at most (zoom - 1) half-frames each way.
 */
export function clampView(view, frame) {
  const zoom = clamp(Number(view?.zoom) || 1, ZOOM_MIN, ZOOM_MAX);
  const maxX = ((zoom - 1) * (frame?.width ?? 0)) / 2;
  const maxY = ((zoom - 1) * (frame?.height ?? 0)) / 2;
  return {
    zoom,
    x: clamp(Number(view?.x) || 0, -maxX, maxX) || 0,
    y: clamp(Number(view?.y) || 0, -maxY, maxY) || 0,
  };
}

/**
 * Zoom to `nextZoom` keeping the content under `point` (frame coordinates,
 * from the frame's top-left) where it is. Without a point, the frame center.
 */
export function zoomAt(view, nextZoom, frame, point = null) {
  const current = clampView(view, frame);
  const zoom = clamp(nextZoom, ZOOM_MIN, ZOOM_MAX);
  const cx = (frame?.width ?? 0) / 2;
  const cy = (frame?.height ?? 0) / 2;
  const px = (point?.x ?? cx) - cx;
  const py = (point?.y ?? cy) - cy;
  const ratio = zoom / current.zoom;
  return clampView(
    {
      zoom,
      x: px - ratio * (px - current.x),
      y: py - ratio * (py - current.y),
    },
    frame,
  );
}

export const panBy = (view, dx, dy, frame) =>
  clampView({ ...view, x: view.x + dx, y: view.y + dy }, frame);

/** The view after a keyboard command on the image, or null if not handled. */
export function viewForKey(key, view, frame) {
  const stepX = (frame?.width ?? 0) * PAN_STEP;
  const stepY = (frame?.height ?? 0) * PAN_STEP;
  switch (key) {
    case '+':
    case '=':
      return zoomAt(view, view.zoom * ZOOM_STEP, frame);
    case '-':
    case '_':
      return zoomAt(view, view.zoom / ZOOM_STEP, frame);
    case '0':
      return FIT_VIEW;
    // Arrow keys move the view toward the side named, revealing it.
    case 'ArrowLeft':
      return panBy(view, stepX, 0, frame);
    case 'ArrowRight':
      return panBy(view, -stepX, 0, frame);
    case 'ArrowUp':
      return panBy(view, 0, stepY, frame);
    case 'ArrowDown':
      return panBy(view, 0, -stepY, frame);
    default:
      return null;
  }
}

/** Divider percent for a pointer at `clientX` over `rect`. */
export function dividerFromPoint(clientX, rect) {
  if (!rect?.width) return 50;
  return clamp(((clientX - rect.left) / rect.width) * 100, 0, 100);
}

/** Divider percent after a slider key, or null if the key is not handled. */
export function dividerForKey(key, value) {
  const steps = {
    ArrowLeft: -DIVIDER_STEP,
    ArrowDown: -DIVIDER_STEP,
    ArrowRight: DIVIDER_STEP,
    ArrowUp: DIVIDER_STEP,
    PageDown: -DIVIDER_PAGE,
    PageUp: DIVIDER_PAGE,
  };
  if (key === 'Home') return 0;
  if (key === 'End') return 100;
  if (!(key in steps)) return null;
  return clamp(Math.round(value + steps[key]), 0, 100);
}

/** CSS transform shared by both images. */
export const viewTransform = (view) =>
  `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`;

/** "1024×768", or null for an unknown size. */
export function sizeText(size) {
  const box = validSize(size);
  return box ? `${box.width}×${box.height}` : null;
}
