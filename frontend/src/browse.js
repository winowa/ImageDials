/**
 * Pure rules for browsing saved images: gallery filtering and playback policy,
 * library search, pagination and density. No React, so the policies are
 * testable and shared by the labels and the logic that uses them.
 */
import { selectionSummary } from './controls.js';
import {
  describeImage,
  ORIENTATIONS,
  UNKNOWN_ORIENTATION,
} from './imageRecord.js';
import { orientationOf } from './measure.js';

// --- Gallery -----------------------------------------------------------------

/** Seconds each image is shown while playing; the speed slider steps through these. */
export const GALLERY_SPEEDS_SECONDS = [2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 30];
export const GALLERY_DEFAULT_SPEED_SECONDS = 5;
const MILLISECONDS_PER_SECOND = 1000;

/** Filter choices: the three shapes plus images whose size is still unknown. */
export const FILTER_ORIENTATIONS = [...ORIENTATIONS, UNKNOWN_ORIENTATION];

/**
 * Images per orientation. `measured` holds sizes read from loaded originals for
 * records that carry none; an image without any size counts as unknown.
 */
export const orientationCounts = (images, measured) => {
  const counts = Object.fromEntries(FILTER_ORIENTATIONS.map((o) => [o, 0]));
  for (const image of images) counts[orientationOf(image, measured)] += 1;
  return counts;
};

/** Images whose orientation is enabled; `enabled` is a set of orientation names. */
export const filterByOrientation = (images, enabled, measured) =>
  images.filter((image) => enabled.has(orientationOf(image, measured)));

export const speedIntervalMs = (seconds) => seconds * MILLISECONDS_PER_SECOND;

/** A stored speed that is not one of the named steps falls back to the default. */
export const validSpeedSeconds = (seconds) =>
  GALLERY_SPEEDS_SECONDS.includes(seconds)
    ? seconds
    : GALLERY_DEFAULT_SPEED_SECONDS;

/** The index of `key` in `images`, or 0 when it is absent (first image). */
export const indexOfKey = (images, key) =>
  Math.max(
    0,
    images.findIndex((image) => describeImage(image).key === key),
  );

/** Wrapping neighbour of the image at `index`. */
export const stepIndex = (length, index, delta) =>
  length ? (index + delta + length) % length : 0;

// --- Library -----------------------------------------------------------------

export const LIBRARY_PAGE_SIZES = [24, 48, 96];
export const LIBRARY_DEFAULT_PAGE_SIZE = 24;
/** Columns offered by the density control. */
export const LIBRARY_DENSITIES = [3, 4, 6, 8];
export const LIBRARY_DEFAULT_DENSITY = 6;

const searchTexts = new WeakMap();
/** Nesting and size bounds so one odd record cannot make search expensive. */
const SEARCH_MAX_DEPTH = 16;
const SEARCH_MAX_STRING = 20_000;

/**
 * Every readable value of a wire record, nested unknown fields included.
 * Binary data and inline data URLs are skipped, never expanded.
 */
function collectValues(value, out, seen, depth) {
  if (value === null || value === undefined) return;
  if (typeof value === 'string') {
    if (value.length <= SEARCH_MAX_STRING && !value.startsWith('data:'))
      out.push(value);
    return;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    out.push(String(value));
    return;
  }
  if (typeof value !== 'object' || depth > SEARCH_MAX_DEPTH) return;
  if (
    seen.has(value) ||
    ArrayBuffer.isView(value) ||
    value instanceof ArrayBuffer ||
    (typeof Blob !== 'undefined' && value instanceof Blob)
  )
    return;
  seen.add(value);
  for (const item of Object.values(value))
    collectValues(item, out, seen, depth + 1);
}

/** Lower-cased text a search query is matched against; cached per record. */
function searchableText(record) {
  let text = searchTexts.get(record);
  if (text !== undefined) return text;
  const view = describeImage(record);
  const parts = [];
  collectValues(record, parts, new WeakSet(), 0);
  if (view.size) parts.push(`${view.size.width}x${view.size.height}`);
  for (const s of selectionSummary(record)) parts.push(`${s.label} ${s.value}`);
  text = parts.join('\n').toLowerCase();
  searchTexts.set(record, text);
  return text;
}

/** Records matching every whitespace-separated term of `query`. */
export function searchImages(images, query) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return images;
  return images.filter((image) => {
    const text = searchableText(image);
    return terms.every((term) => text.includes(term));
  });
}

/**
 * One page of `items`, with the requested page clamped into range after the
 * result set or page size changed.
 */
export function paginate(items, page, pageSize) {
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const current = Math.min(Math.max(1, Math.trunc(page) || 1), pageCount);
  return {
    page: current,
    pageCount,
    items: items.slice((current - 1) * pageSize, current * pageSize),
  };
}
