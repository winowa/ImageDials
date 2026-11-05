import { expect, test } from 'vitest';

import {
  beginLibraryWindowRequest,
  createLibraryWindow,
  LIBRARY_WINDOW_MAX_PAGES,
  rejectLibraryWindowRequest,
  removeFromLibraryWindow,
  resolveLibraryWindowNotModified,
  resolveLibraryWindowRequest,
} from './libraryWindow.js';

function page(index, options = {}) {
  return {
    listing_kind: 'summary-page',
    count: 1,
    total: 20,
    orientation_counts: { landscape: 20, portrait: 0, square: 0, unknown: 0 },
    revision: options.revision ?? 1,
    position: options.position === undefined ? index * 2 : options.position,
    images: [
      {
        id: `image-${index}`,
        extension: { enabled: false, count: 0 },
        ...options.image,
      },
    ],
    next_cursor: options.next === false ? null : `next-${index}`,
    previous_cursor: options.previous === false ? null : `previous-${index}`,
  };
}

function fetchPage(state, direction, result, options = {}) {
  const started = beginLibraryWindowRequest(state, {
    direction,
    ...options,
  });
  return resolveLibraryWindowRequest(
    started.state,
    started.ticket,
    result,
    `etag-${result.revision}-${result.position}`,
  );
}

test('keeps a three-page cursor window and moves forward and backward', () => {
  let state = createLibraryWindow({ limit: 2 });
  state = fetchPage(state, 'first', page(0)).state;
  state = fetchPage(state, 'forward', page(1)).state;
  state = fetchPage(state, 'forward', page(2)).state;
  state = fetchPage(state, 'forward', page(3)).state;
  expect(state.pages).toHaveLength(LIBRARY_WINDOW_MAX_PAGES);
  expect(state.pages.map((item) => item.images[0].id)).toEqual([
    'image-1',
    'image-2',
    'image-3',
  ]);
  expect(state.activeIndex).toBe(2);

  const back = beginLibraryWindowRequest(state, { direction: 'backward' });
  expect(back.request).toBeNull();
  state = back.state;
  expect(state.activeIndex).toBe(1);
  expect(state.pages.map((item) => item.images[0].id)).toEqual([
    'image-1',
    'image-2',
    'image-3',
  ]);
});

test('around and last requests carry scope and do not invent page numbers', () => {
  let state = createLibraryWindow({
    limit: 24,
    q: '  blue   ceramic ',
    eventName: 'Spring Show',
    orientation: 'landscape',
  });
  let started = beginLibraryWindowRequest(state, {
    direction: 'around',
    around: 'target/1',
  });
  expect(started.request).toEqual({
    limit: 24,
    q: 'blue ceramic',
    eventName: 'Spring Show',
    orientation: 'landscape',
    around: 'target/1',
  });
  state = resolveLibraryWindowRequest(started.state, started.ticket, {
    ...page(8, { position: null }),
    anchor_index: 1,
  }).state;
  expect(state.pages[0].position).toBeNull();
  expect(state.complete).toBe(false);

  started = beginLibraryWindowRequest(state, { direction: 'last' });
  expect(started.request.edge).toBe('last');
  expect(started.request.cursor).toBeUndefined();
});

test('changing a binding starts a fresh first page and cannot reuse old cursors', () => {
  let state = fetchPage(createLibraryWindow(), 'first', page(0)).state;
  const started = beginLibraryWindowRequest(state, {
    direction: 'forward',
    binding: { q: 'new query', limit: 12, order: 'oldest' },
  });
  expect(started.request).toEqual({
    limit: 12,
    q: 'new query',
    order: 'oldest',
  });
  expect(started.request.cursor).toBeUndefined();
  expect(started.state.pages).toEqual([]);
});

test('stale tickets are ignored and a revision change replaces the old window', () => {
  const initial = createLibraryWindow();
  const older = beginLibraryWindowRequest(initial, { direction: 'first' });
  const newer = beginLibraryWindowRequest(older.state, { direction: 'first' });
  expect(
    resolveLibraryWindowRequest(newer.state, older.ticket, page(0)).stale,
  ).toBe(true);
  let state = resolveLibraryWindowRequest(
    newer.state,
    newer.ticket,
    page(0),
  ).state;
  state = fetchPage(state, 'forward', page(1)).state;
  const changed = fetchPage(
    state,
    'forward',
    page(9, { revision: 2, position: null }),
  );
  expect(changed.state.pages).toHaveLength(1);
  expect(changed.state.pages[0].images[0].id).toBe('image-9');
  expect(changed.state.pages[0].position).toBeNull();
  expect(changed.state.revision).toBe(2);
  expect(changed.state.complete).toBe(false);
});

test('304 and failed reads preserve page data and expose errors without merging summaries', () => {
  const summary = {
    id: 'image-0',
    extension: { enabled: false, count: 0 },
  };
  let state = fetchPage(
    createLibraryWindow(),
    'first',
    page(0, { image: summary }),
  ).state;
  const started = beginLibraryWindowRequest(state, { direction: 'refresh' });
  state = resolveLibraryWindowNotModified(
    started.state,
    started.ticket,
    'same',
  ).state;
  expect(state.pages[0].etag).toBe('same');
  expect(state.pages[0].images[0]).toEqual(summary);

  const failed = beginLibraryWindowRequest(state, { direction: 'forward' });
  const failure = new Error('offline');
  state = rejectLibraryWindowRequest(
    failed.state,
    failed.ticket,
    failure,
  ).state;
  expect(state.pages).toHaveLength(1);
  expect(state.pages[0].images[0]).toEqual(summary);
  expect(state.error).toBe(failure);
  expect(state.complete).toBe(false);
});

test('cached navigation invalidates any older pending page request', () => {
  let state = createLibraryWindow();
  state = fetchPage(state, 'first', page(0)).state;
  state = fetchPage(state, 'forward', page(1)).state;
  const pending = beginLibraryWindowRequest(state, { direction: 'forward' });
  const returned = beginLibraryWindowRequest(pending.state, {
    direction: 'backward',
  });
  expect(returned.request).toBeNull();
  expect(returned.state.pending).toBeNull();
  expect(
    resolveLibraryWindowRequest(returned.state, pending.ticket, page(2)).stale,
  ).toBe(true);
});

test('an invalid page is rejected without replacing the visible page', () => {
  const state = fetchPage(createLibraryWindow(), 'first', page(0)).state;
  const started = beginLibraryWindowRequest(state, { direction: 'forward' });
  const invalid = resolveLibraryWindowRequest(started.state, started.ticket, {
    ...page(4),
    count: 2,
  });
  expect(invalid.accepted).toBe(true);
  expect(invalid.state.pages[0].images[0].id).toBe('image-0');
  expect(invalid.state.error.message).toBe('The library page was unreadable.');
});

test('a 304 for Last moves to the retained last page instead of staying put', () => {
  let state = fetchPage(
    createLibraryWindow(),
    'last',
    page(9, { next: false }),
  ).state;
  state = fetchPage(state, 'backward', page(8)).state;
  expect(state.activeIndex).toBe(0);
  const started = beginLibraryWindowRequest(state, { direction: 'last' });
  const resolved = resolveLibraryWindowNotModified(
    started.state,
    started.ticket,
    'etag',
  );
  expect(resolved.state.activeIndex).toBe(1);
  expect(resolved.state.pages[1].images[0].id).toBe('image-9');
  expect(resolved.state.pending).toBeNull();
});

test('a navigation with no cursor clears a pending request it replaced', () => {
  let state = fetchPage(
    createLibraryWindow(),
    'first',
    page(0, { next: false }),
  ).state;
  state = beginLibraryWindowRequest(state, { direction: 'refresh' }).state;
  expect(state.pending).not.toBeNull();
  const next = beginLibraryWindowRequest(state, { direction: 'forward' });
  expect(next.request).toBeNull();
  expect(next.state.pending).toBeNull();
});

test('a range emptied by deletions is not retained beside real rows', () => {
  const empty = { ...page(1), images: [], count: 0, position: null };
  let state = fetchPage(createLibraryWindow(), 'first', empty).state;
  state = fetchPage(state, 'backward', page(0)).state;
  expect(state.pages.map((entry) => entry.count)).toEqual([1]);
  expect(state.activeIndex).toBe(0);
});

test('a deleted identity leaves every retained page and forgets its ETag', () => {
  let state = fetchPage(createLibraryWindow(), 'first', page(0)).state;
  state = fetchPage(state, 'forward', page(1)).state;
  const next = removeFromLibraryWindow(state, 'image-0', (image) => image.id);
  expect(next.pages[0].images).toEqual([]);
  expect(next.pages[0]).toMatchObject({ count: 0, total: 19, etag: null });
  expect(next.pages[1]).toBe(state.pages[1]);
  expect(removeFromLibraryWindow(next, 'nope', (image) => image.id)).toBe(next);
});
