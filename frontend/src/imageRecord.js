/**
 * Saved-image identity and view data. Wire records are never rewritten: the
 * repository keeps them exactly as received (unknown and nullable fields
 * included) and this module derives what the screens display.
 *
 * Two record spellings reach the UI. A library record (A12) carries
 * `dimensions` as `{width, height}` and `created_at` as Unix seconds. A
 * completed job's result carries `dimensions` as `"WxH"`; its
 * `selected_controls` are the RESOLVED values and the original controls are in
 * `original_selected_controls`. A record in the library always holds the
 * ORIGINAL controls in `selected_controls`.
 */
import { ENDPOINTS } from './api.js';

/** Images whose sides differ by at most this share of the longer side are square. */
export const SQUARE_TOLERANCE_RATIO = 0.05;
export const ORIENTATIONS = ['portrait', 'landscape', 'square'];
/** Orientation of an image whose pixel size is not known (yet). */
export const UNKNOWN_ORIENTATION = 'unknown';
/** Storage type of an image that exists only in this browser (import history). */
export const BROWSER_UPLOAD_STORAGE_TYPE = 'browser-upload';
/** Longest side, in pixels, of the thumbnail variant used by lists. */
export const THUMBNAIL_MAX_PIXELS = 384;
const MILLISECONDS_PER_SECOND = 1000;

const positive = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : null;

/** `{width, height}` from a dimensions dict, a `"WxH"` string, or null. */
export function readDimensions(value) {
  if (typeof value === 'string') {
    const match = /^(\d+)x(\d+)$/.exec(value);
    return match
      ? readDimensions({ width: Number(match[1]), height: Number(match[2]) })
      : null;
  }
  const width = positive(value?.width);
  const height = positive(value?.height);
  return width && height ? { width, height } : null;
}

/**
 * Orientation of a pixel size. A missing or unusable size is `unknown`: it is
 * never guessed, so it neither inflates a count nor hides behind another one.
 */
export function classifyOrientation(size) {
  if (!size) return UNKNOWN_ORIENTATION;
  const longer = Math.max(size.width, size.height);
  if (Math.abs(size.width - size.height) <= longer * SQUARE_TOLERANCE_RATIO)
    return 'square';
  return size.width > size.height ? 'landscape' : 'portrait';
}

/** Unix seconds, or an ISO string, as milliseconds since the epoch; else null. */
export function readCreatedAtMs(value) {
  if (typeof value === 'number' && Number.isFinite(value))
    return value * MILLISECONDS_PER_SECOND;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/**
 * The stable identity of a saved image: its storage location when known,
 * otherwise its id. Delete and selection use this, never the title or position.
 */
export function imageKey(record) {
  return record.storage_id && record.filename
    ? `${record.storage_id}/${record.filename}`
    : String(record.id);
}

/**
 * A copy that already has its watermark drawn into the pixels (a downloaded
 * prepared file brought back in). Recognized by its own embedded metadata, so
 * no second mark is drawn over it and no mark can be removed from it.
 */
export const isBakedWatermark = (record) =>
  record?.derivative_type === 'watermarked';

/** An imported image that lives only in this browser, never in the server library. */
export const isBrowserUpload = (record) =>
  record.storage_type === BROWSER_UPLOAD_STORAGE_TYPE;

/**
 * Client-only marker of an image kept in this browser's private history:
 * `generated` (a private-mode result) or `imported`. It is never part of the
 * stored wire snapshot; the history adds it to the display view only.
 */
export const LOCAL_ORIGIN = Object.freeze({
  GENERATED: 'generated',
  IMPORTED: 'imported',
});

/** Private results and local uploads have no readable shared-library file. */
export const hasSharedMedia = (record) =>
  !isBrowserUpload(record) &&
  !record.local_origin &&
  record.visibility !== 'private' &&
  Boolean(record.storage_id && record.filename);

/**
 * An image that exists only in this browser, or whose server copy this client
 * must not manage: nothing shared (library, delete, prepare, analyze) may be
 * called for it. Decided by explicit markers, never by missing storage ids.
 */
export const isLocalOnly = (record) =>
  isBrowserUpload(record) ||
  Boolean(record.local_origin) ||
  record.visibility === 'private';

/**
 * Original bytes (PNG) of a saved image via the canonical file route. A browser
 * upload has no server file, so its `image_url` holds the local object URL.
 */
export function originalUrl(record) {
  return hasSharedMedia(record)
    ? ENDPOINTS.libraryFile(record.storage_id, record.filename)
    : (record.image_url ?? '');
}

/** A smaller JPEG for lists; the server clamps the size. */
export function thumbnailUrl(record, maxPixels = THUMBNAIL_MAX_PIXELS) {
  if (record.local_thumbnail_url) return record.local_thumbnail_url;
  const original = originalUrl(record);
  if (!hasSharedMedia(record)) return original;
  return `${original}?variant=thumbnail&max_size=${maxPixels}`;
}

const views = new WeakMap();

/**
 * Display data derived from a wire record. Memoized per record object so a
 * list re-render does not recompute it.
 */
export function describeImage(record) {
  let view = views.get(record);
  if (view) return view;
  const size =
    readDimensions({ width: record.width, height: record.height }) ??
    readDimensions(record.dimensions);
  view = Object.freeze({
    key: imageKey(record),
    size,
    requestedSize: readDimensions(record.requested_dimensions),
    orientation: classifyOrientation(size),
    createdAtMs: readCreatedAtMs(record.created_at),
    title: record.title || 'Untitled',
    originalPrompt: record.original_prompt ?? record.prompt ?? '',
    finalPrompt: record.final_prompt ?? '',
    originalUrl: originalUrl(record),
    thumbnailUrl: thumbnailUrl(record),
  });
  views.set(record, view);
  return view;
}

/** CSS `aspect-ratio` for a record, or null when its size is unknown. */
export const aspectRatioOf = (record) => {
  const { size } = describeImage(record);
  return size ? `${size.width} / ${size.height}` : null;
};
