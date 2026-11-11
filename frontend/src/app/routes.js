import { imageKey } from '../data/records/imageRecord.js';

/** Screens of the app; one definition for navigation and route-aware behavior. */
export const ROUTE = { create: '/', gallery: '/gallery', library: '/print' };

/** Query parameter that opens a saved image in the generator. */
export const EDIT_PARAM = 'edit';

/**
 * The deployment prefix of the page ('' at the origin root), from the build's
 * base URL. Only absolute prefixes count; a relative or empty base is the root.
 */
export function normalizeBase(baseUrl = '/') {
  const trimmed = String(baseUrl ?? '')
    .trim()
    .replace(/\/+$/, '');
  return trimmed.startsWith('/') ? trimmed : '';
}

/** The base path the build was made for. */
export const buildBase = () => normalizeBase(import.meta.env?.BASE_URL);

/**
 * The route of a location. Anything outside the prefix or unknown is the
 * generator. The edit target applies to the generator only.
 */
export function parseLocation({ pathname, search = '' }, base = '') {
  let rest = pathname;
  let inside = true;
  if (base) {
    inside = rest === base || rest.startsWith(`${base}/`);
    rest = inside ? rest.slice(base.length) : '/';
  }
  rest = rest.replace(/\/+$/, '') || '/';
  const route =
    inside && Object.values(ROUTE).includes(rest) ? rest : ROUTE.create;
  const edit =
    route === ROUTE.create
      ? new URLSearchParams(search).get(EDIT_PARAM) || null
      : null;
  return { route, edit };
}

/** The URL of a route inside the prefix, with an optional edit target. */
export function hrefFor(route, base = '', { edit = null } = {}) {
  const path = `${base}${route}`;
  const query =
    edit && route === ROUTE.create
      ? `?${EDIT_PARAM}=${encodeURIComponent(edit)}`
      : '';
  return `${path}${query}`;
}

/**
 * The edit target naming a saved image: its image id, else its record id (what
 * the record endpoint resolves), else its storage identity. Never the prompt or
 * title.
 */
export const editTarget = (record) =>
  String(record.image_id || record.id || imageKey(record));

export const sameTarget = (record, target) =>
  [record.image_id, imageKey(record), record.id, record.client_key]
    .filter((v) => v != null && v !== '')
    .some((v) => String(v) === target);

/** Resolve legacy local-storage links without searching catalog pages. */
export function recordIdForEditTarget(target) {
  if (typeof target !== 'string' || !target) return null;
  const stored = /^local-0\/([A-Za-z0-9_-]+)\.png$/.exec(target);
  if (stored) return stored[1];
  return target.includes('/') ? null : target;
}

/**
 * Decide what an edit link does with the history as it is now.
 *  - wait: the lists are not loaded; nothing is consumed
 *  - skip: the draft was edited since the link was opened
 *  - missing: the lists are loaded and hold no such image
 *  - restore: the exact image
 * A job still being created never matches.
 */
export function resolveEditLink({ target, items, ready, draftChanged }) {
  if (!ready) return { action: 'wait' };
  if (draftChanged) return { action: 'skip' };
  const item = items.find(
    (candidate) => !candidate.client_pending && sameTarget(candidate, target),
  );
  return item ? { action: 'restore', item } : { action: 'missing' };
}
