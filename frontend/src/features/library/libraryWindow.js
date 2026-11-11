/** Maximum number of adjacent summary pages retained by one surface. */
export const LIBRARY_WINDOW_MAX_PAGES = 3;

/** Create history page size: three pages stay inside the 132-node strip bound. */
export const CREATE_HISTORY_PAGE_LIMIT = 40;

const DEFAULT_LIMIT = 48;
const VALID_ORDERS = new Set(['newest', 'oldest']);
const VALID_DIRECTIONS = new Set([
  'first',
  'last',
  'forward',
  'backward',
  'around',
  'refresh',
]);

function normalizeBinding(binding = {}) {
  const limit = Number(binding.limit ?? DEFAULT_LIMIT);
  if (!Number.isInteger(limit) || limit < 1 || limit > 96)
    throw new RangeError('Library page limit must be between 1 and 96.');
  const order = binding.order ?? 'newest';
  if (!VALID_ORDERS.has(order)) throw new TypeError('Unknown library order.');
  return {
    q: String(binding.q ?? '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .join(' '),
    orientation: binding.orientation || null,
    eventName: binding.eventName || null,
    order,
    limit,
  };
}

function sameBinding(left, right) {
  return Object.keys(left).every((key) => left[key] === right[key]);
}

export function createLibraryWindow(binding = {}) {
  return {
    binding: normalizeBinding(binding),
    pages: [],
    activeIndex: -1,
    revision: null,
    pending: null,
    error: null,
    nextTicket: 0,
    /** A bounded page window is never evidence of an exhaustive catalog. */
    complete: false,
  };
}

function requestFor(state, direction, around) {
  const page = state.pages[state.activeIndex];
  if (direction === 'refresh' && page?.requestParams)
    return { ...page.requestParams };
  const params = { ...state.binding };
  if (params.q === '') delete params.q;
  if (!params.orientation) delete params.orientation;
  if (!params.eventName) delete params.eventName;
  if (params.order === 'newest') delete params.order;

  if (direction === 'forward' || direction === 'backward') {
    const cursor =
      page?.[direction === 'forward' ? 'next_cursor' : 'previous_cursor'];
    if (!cursor) return null;
    params.cursor = cursor;
  } else if (direction === 'around') {
    if (around === undefined || around === null || around === '')
      throw new TypeError(
        'An image identity is required for around navigation.',
      );
    params.around = String(around);
  } else if (direction === 'last') {
    params.edge = 'last';
  }
  return params;
}

/** Start a bounded page request. The returned ticket rejects older responses. */
export function beginLibraryWindowRequest(state, intent = {}) {
  let direction = intent.direction ?? 'first';
  if (!VALID_DIRECTIONS.has(direction))
    throw new TypeError('Unknown library navigation direction.');
  if (direction === 'refresh' && !state.pages[state.activeIndex]?.requestParams)
    direction = 'first';
  const binding = normalizeBinding({ ...state.binding, ...intent.binding });
  const changed = !sameBinding(binding, state.binding);
  if (changed && (direction === 'forward' || direction === 'backward'))
    direction = 'first';
  // A strip extends from its outer edge and keeps what is on screen; a Library
  // page moves within the retained pages and replaces them on a new revision.
  const retain = intent.retain === true;
  if (retain && !changed && state.pages.length) {
    if (direction === 'forward' || direction === 'backward') {
      const edge = direction === 'forward' ? state.pages.length - 1 : 0;
      const request = requestFor(
        { ...state, activeIndex: edge },
        direction,
        intent.around,
      );
      if (!request)
        return {
          state: { ...state, pending: null },
          request: null,
          ticket: null,
        };
      const ticket = state.nextTicket + 1;
      return {
        state: {
          ...state,
          activeIndex: edge,
          nextTicket: ticket,
          pending: { ticket, direction, requestParams: request, retain },
          error: null,
        },
        request,
        ticket,
      };
    }
  }
  if (
    !changed &&
    direction === 'forward' &&
    state.activeIndex < state.pages.length - 1
  )
    return {
      state: {
        ...state,
        activeIndex: state.activeIndex + 1,
        pending: null,
        nextTicket: state.nextTicket + 1,
        error: null,
      },
      request: null,
      ticket: null,
    };
  if (!changed && direction === 'backward' && state.activeIndex > 0)
    return {
      state: {
        ...state,
        activeIndex: state.activeIndex - 1,
        pending: null,
        nextTicket: state.nextTicket + 1,
        error: null,
      },
      request: null,
      ticket: null,
    };
  const base = changed
    ? { ...createLibraryWindow(binding), nextTicket: state.nextTicket }
    : state;
  const request = requestFor(base, direction, intent.around);
  if (!request)
    return { state: { ...state, pending: null }, request: null, ticket: null };
  const ticket = base.nextTicket + 1;
  return {
    state: {
      ...base,
      nextTicket: ticket,
      pending: { ticket, direction, requestParams: request },
      error: null,
    },
    request,
    ticket,
  };
}

function validPage(page) {
  return (
    page &&
    typeof page === 'object' &&
    !Array.isArray(page) &&
    page.listing_kind === 'summary-page' &&
    Array.isArray(page.images) &&
    Number.isInteger(page.count) &&
    page.count === page.images.length &&
    Number.isInteger(page.total) &&
    page.total >= page.count &&
    page.orientation_counts &&
    typeof page.orientation_counts === 'object' &&
    !Array.isArray(page.orientation_counts) &&
    Number.isInteger(page.revision) &&
    page.revision >= 0 &&
    (page.next_cursor === null || typeof page.next_cursor === 'string') &&
    (page.previous_cursor === null ||
      typeof page.previous_cursor === 'string') &&
    (page.position === null ||
      (Number.isInteger(page.position) && page.position >= 0))
  );
}

/** Adopt only the latest valid page; never merge across revisions. */
export function resolveLibraryWindowRequest(state, ticket, page, etag = null) {
  if (state.pending?.ticket !== ticket)
    return { state, accepted: false, stale: true };
  if (!validPage(page))
    return rejectLibraryWindowRequest(
      state,
      ticket,
      new Error('The library page was unreadable.'),
    );

  const entry = {
    ...page,
    etag,
    requestParams: state.pending.requestParams,
  };
  const { direction } = state.pending;
  let pages;
  let activeIndex;
  const revisionChanged =
    !state.pending.retain &&
    state.revision !== null &&
    state.revision !== page.revision;
  if (
    direction === 'first' ||
    direction === 'last' ||
    direction === 'around' ||
    (direction === 'refresh' && revisionChanged) ||
    revisionChanged
  ) {
    pages = [entry];
    activeIndex = 0;
  } else if (direction === 'refresh') {
    pages = [...state.pages];
    pages[state.activeIndex] = entry;
    activeIndex = state.activeIndex;
  } else if (direction === 'forward') {
    pages = [...state.pages.slice(0, state.activeIndex + 1), entry];
    if (pages.length > LIBRARY_WINDOW_MAX_PAGES) pages.shift();
    activeIndex = pages.length - 1;
  } else {
    pages = [entry, ...state.pages.slice(state.activeIndex)];
    if (pages.length > LIBRARY_WINDOW_MAX_PAGES) pages.pop();
    activeIndex = 0;
  }

  // A range emptied by concurrent deletions is only a route back to real rows.
  pages = pages.filter((retained) => retained === entry || retained.count > 0);
  activeIndex = pages.indexOf(entry);

  return {
    accepted: true,
    stale: false,
    state: {
      ...state,
      pages,
      activeIndex,
      revision: page.revision,
      pending: null,
      error: null,
      complete: false,
    },
  };
}

export function resolveLibraryWindowNotModified(state, ticket, etag = null) {
  if (state.pending?.ticket !== ticket)
    return { state, accepted: false, stale: true };
  const pages = [...state.pages];
  const requestParams = state.pending.requestParams;
  const index = pages.findIndex(
    (page) =>
      JSON.stringify(page.requestParams) === JSON.stringify(requestParams),
  );
  if (etag && index >= 0) pages[index] = { ...pages[index], etag };
  // An unchanged page is still the page that was asked for: Last or First must
  // move there even when the answer is a 304.
  const activeIndex = index >= 0 ? index : state.activeIndex;
  return {
    state: { ...state, pages, activeIndex, pending: null, error: null },
    accepted: true,
    stale: false,
  };
}

/**
 * Start revalidating every retained page of a strip, from its first page. An
 * unchanged first page proves the revision is unchanged, so one 304 is enough.
 */
export function beginLibraryWindowRevalidation(state) {
  const first = state.pages[0];
  if (!first?.requestParams) return { state, request: null, ticket: null };
  const ticket = state.nextTicket + 1;
  const request = { ...first.requestParams };
  return {
    state: {
      ...state,
      nextTicket: ticket,
      pending: { ticket, direction: 'refresh', requestParams: request },
      error: null,
    },
    request,
    ticket,
    etag: first.etag ?? null,
    pageCount: state.pages.length,
  };
}

/** The request for the page after `page` in the same binding, or null. */
export function nextRetainedRequest(state, page) {
  if (!page.next_cursor) return null;
  return { ...requestFor(state, 'first'), cursor: page.next_cursor };
}

/**
 * Replace a strip's pages together with pages read forward from its first one,
 * so a new head row cannot open a gap between a shifted page and a kept cursor.
 */
export function resolveLibraryWindowRevalidation(state, ticket, reads) {
  if (state.pending?.ticket !== ticket)
    return { state, accepted: false, stale: true };
  if (!reads.length || !reads.every(({ page }) => validPage(page)))
    return rejectLibraryWindowRequest(
      state,
      ticket,
      new Error('The library page was unreadable.'),
    );
  const entries = reads.map(({ page, etag, requestParams }) => ({
    ...page,
    etag,
    requestParams,
  }));
  const kept = entries.filter((entry) => entry.count > 0);
  const pages = (kept.length ? kept : entries.slice(0, 1)).slice(
    0,
    LIBRARY_WINDOW_MAX_PAGES,
  );
  return {
    accepted: true,
    stale: false,
    state: {
      ...state,
      pages,
      activeIndex: Math.min(state.activeIndex, pages.length - 1),
      revision: pages[pages.length - 1].revision,
      pending: null,
      error: null,
      complete: false,
    },
  };
}

/**
 * Drop a deleted identity from every retained page at once, so a failed
 * revalidation cannot keep showing it. `identityOf` keeps this module pure.
 */
export function removeFromLibraryWindow(state, key, identityOf) {
  let changed = false;
  const pages = state.pages.map((page) => {
    const images = page.images.filter((image) => identityOf(image) !== key);
    if (images.length === page.images.length) return page;
    changed = true;
    return {
      ...page,
      images,
      count: images.length,
      total: Math.max(images.length, page.total - 1),
      etag: null,
    };
  });
  return changed ? { ...state, pages } : state;
}

export function rejectLibraryWindowRequest(state, ticket, error) {
  if (state.pending?.ticket !== ticket)
    return { state, accepted: false, stale: true };
  return {
    state: { ...state, pending: null, error },
    accepted: true,
    stale: false,
  };
}
