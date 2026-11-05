import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import App from './App.jsx';
import { GALLERY_MAX_WINDOW_ROWS } from './gallerySession.js';
import {
  FakeEventSource,
  fakeLibrary,
  fixtures,
  installApi,
  respond,
  sizedRecord,
  withBoundedGallery,
} from './testSupport.js';

const { m1 } = fixtures;
const LIST = 'GET /api/images/library';
const CREATE = 'POST /api/images/library/shuffle-sessions';
const SESSION_READ =
  /^GET \/api\/images\/library\/shuffle-sessions\/([^/?]+)\?/;
const jobPolicy = { pollIntervalMs: 1, maxConsecutivePollFailures: 3 };
const TTL_MS = 1800 * 1000;

let library;
let api;

const group = (count, prefix = 'i') =>
  Array.from({ length: count }, (_, i) =>
    sizedRecord(`${prefix}${i}`, 1152, 768),
  );

/** Fake clock (timeouts, intervals and Date); promises and React keep running. */
const fakeClock = () =>
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'Date',
    ],
  });
const settle = async () => {
  for (let i = 0; i < 3; i += 1)
    await act(() => vi.advanceTimersByTimeAsync(0));
};
const advance = (ms) => act(() => vi.advanceTimersByTimeAsync(ms));

async function openGallery(
  records,
  { sessions = null, overrides = {}, playing = false } = {},
) {
  window.history.replaceState(null, '', '/gallery');
  localStorage.setItem('imagedials-gallery-playing', String(playing));
  library = fakeLibrary(records);
  if (typeof overrides === 'function') overrides = overrides(library);
  api = installApi({
    ...library.routes,
    ...(sessions
      ? {
          'GET /api/app-capabilities': () => {
            const capabilities = withBoundedGallery(m1.capabilities);
            capabilities.shared_library.shuffle_sessions = {
              ...capabilities.shared_library.shuffle_sessions,
              ...sessions,
            };
            return capabilities;
          },
        }
      : {}),
    ...overrides,
  });
  fakeClock();
  const view = render(<App jobPolicy={jobPolicy} />);
  await settle();
  return view;
}

/** Answer matching requests differently; others go to the fake server. */
function intercept(handler) {
  const match = api.routes.match;
  api.routes.match = (key) => handler(key) ?? match(key);
}

const filmstrip = () => screen.getByRole('list', { name: 'Images' });
const thumbs = () => within(filmstrip()).getAllByRole('button');
const shownTitle = () =>
  document.querySelector('.strip [aria-current="true"]')?.ariaLabel ?? null;
const press = (name) => fireEvent.click(screen.getByRole('button', { name }));
const toggle = (name) =>
  fireEvent.click(
    screen.getByRole('checkbox', { name: new RegExp(`^${name}`) }),
  );
const sessionReads = () =>
  api.calls.filter((call) => SESSION_READ.test(call.key));
const readLimits = () =>
  sessionReads().map((call) =>
    Number(new URLSearchParams(call.key.split('?')[1]).get('limit')),
  );

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('imagedials-gallery-effect', '"instant"');
  FakeEventSource.reset();
  vi.stubGlobal('EventSource', FakeEventSource);
});
afterEach(() => {
  // Whatever happened, the shared Gallery never read the complete listing.
  if (api) expect(api.called(LIST)).toEqual([]);
  api = null;
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// --- Leases -------------------------------------------------------------------------

test('an active session is renewed before its lease ends and is not replaced', async () => {
  await openGallery(group(6));
  expect(library.created).toHaveLength(1);
  await advance(TTL_MS / 2 - 60000);
  expect(library.renewed).toEqual([]);
  await advance(90000);
  expect(library.renewed).toEqual(['session-1']);
  // Renewals continue for a long slideshow; still one session.
  await advance(TTL_MS);
  expect(library.renewed.length).toBeGreaterThanOrEqual(2);
  expect(library.created).toHaveLength(1);
});

test('a lease lost on renewal is replaced around the shown image, keeping it', async () => {
  await openGallery(group(6));
  fireEvent.click(thumbs()[3]);
  const shown = shownTitle();
  const shownId = shown.replace('Image ', '');
  intercept((key) =>
    key.includes('/renew')
      ? () => respond(410, { detail: 'Gallery session expired' })
      : undefined,
  );
  await advance(TTL_MS / 2 + 30000);
  await settle();
  expect(library.created).toHaveLength(2);
  expect(library.created[1].body.first_image_id).toBe(shownId);
  expect(shownTitle()).toBe(shown);
  expect(screen.queryByRole('alert')).toBeNull();
});

test('renewal and anchoring follow the published session capabilities', async () => {
  await openGallery(group(30), {
    sessions: {
      renewal_enabled: false,
      first_image_enabled: false,
      max_limit: 20,
    },
  });
  await advance(TTL_MS * 2);
  expect(api.calls.some((call) => call.key.includes('/renew'))).toBe(false);
  toggle('Portrait');
  await settle();
  expect(library.created.at(-1).body).not.toHaveProperty('first_image_id');
  expect(Math.max(...readLimits())).toBeLessThanOrEqual(20);
});

// --- Expiry, capacity and failure --------------------------------------------------

test('recovery from lost sessions is bounded and Retry starts again with the image kept', async () => {
  await openGallery(group(4));
  const shown = shownTitle();
  let gone = true;
  intercept((key) => {
    const read = SESSION_READ.exec(key);
    return gone && read && read[1] !== 'session-1'
      ? () => respond(410, { detail: 'Gallery session expired' })
      : undefined;
  });
  // The end of the held session starts a new cycle, whose reads all fail.
  fireEvent.click(thumbs().at(-1));
  press('Next image');
  await settle();
  await advance(60000);
  await settle();
  const attempts = library.created.length;
  // The new cycle plus at most two replacements, then a stop.
  expect(attempts).toBeLessThanOrEqual(4);
  await advance(10 * 60000);
  expect(library.created).toHaveLength(attempts);
  const alert = screen.getByRole('alert');
  expect(alert.textContent).toMatch(/expired/);
  // The pictures stay on screen beside the report.
  expect(thumbs().length).toBe(4);

  gone = false;
  fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
  await settle();
  expect(library.created).toHaveLength(attempts + 1);
  expect(library.created.at(-1).body.first_image_id).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(shownTitle()).not.toBeNull();
  expect(shown).not.toBeNull();
});

test('a session limit (429) is retried after Retry-After, a bounded number of times', async () => {
  let refusals = 2;
  await openGallery(group(3), {
    overrides: {
      [CREATE]: (body) => {
        if (refusals > 0) {
          refusals -= 1;
          return respond(
            429,
            { detail: 'Too many gallery sessions' },
            { 'Retry-After': '1' },
          );
        }
        return library.createSession(body);
      },
    },
  });
  expect(screen.queryByRole('region', { name: 'Gallery controls' })).toBeNull();
  await advance(1000);
  await advance(1000);
  await settle();
  expect(screen.getByRole('region', { name: 'Gallery controls' })).toBeTruthy();
  expect(thumbs()).toHaveLength(3);
});

test('a session limit that persists is reported once with Retry, without looping', async () => {
  let posts = 0;
  await openGallery(group(3), {
    overrides: {
      [CREATE]: () => {
        posts += 1;
        return respond(
          429,
          { detail: 'Too many gallery sessions' },
          { 'Retry-After': '1' },
        );
      },
    },
  });
  await advance(5000);
  await settle();
  expect(posts).toBe(3);
  const alert = screen.getByRole('alert');
  expect(alert.textContent).toMatch(/session limit/);
  await advance(120000);
  expect(posts).toBe(3);
  expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
});

test('a failed build is reported with Retry, released, and not shown as an empty library', async () => {
  await openGallery(group(3), {
    overrides: (fake) => ({
      match: (key) => {
        const read = SESSION_READ.exec(key);
        if (read)
          return () => ({
            session_id: read[1],
            state: 'failed',
            error: 'The gallery order could not be built.',
          });
        return fake.routes.match(key);
      },
    }),
  });
  await settle();
  expect(screen.getByRole('alert').textContent).toMatch(/could not be built/);
  expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  expect(screen.queryByText('No saved images yet.')).toBeNull();
  expect(library.released).toContain('session-1');
});

// --- Ownership races -----------------------------------------------------------------

test('a session accepted after its view changed is released and never used', async () => {
  const records = [
    ...group(3),
    sizedRecord('tall0', 768, 1152),
    sizedRecord('box0', 1024, 1024),
  ];
  await openGallery(records);
  let late = null;
  api.routes[CREATE] = (body) => {
    if (!late)
      return new Promise((resolve) => {
        late = () => resolve(library.createSession(body));
      });
    return library.createSession(body);
  };
  toggle('Portrait');
  await settle();
  expect(late).toBeTypeOf('function');
  expect(library.released).toContain('session-1');
  toggle('Square');
  await settle();
  const used = library.created.at(-1).id;
  await act(async () => late());
  await settle();
  const lateId = library.created.at(-1).id;
  expect(lateId).not.toBe(used);
  expect(library.released).toContain(lateId);
  expect(library.released).not.toContain(used);
  // The strip shows the last view only: no portrait, no square.
  const names = thumbs().map((b) => b.getAttribute('aria-label'));
  expect(names.some((n) => n === 'Image tall0' || n === 'Image box0')).toBe(
    false,
  );
});

test('a page read for an abandoned view is ignored when it answers late', async () => {
  const records = [
    ...group(3),
    sizedRecord('tall0', 768, 1152),
    sizedRecord('box0', 1024, 1024),
  ];
  await openGallery(records);
  let hold = null;
  intercept((key) => {
    const read = SESSION_READ.exec(key);
    if (read && read[1] === 'session-2' && !hold)
      return () =>
        new Promise((resolve) => {
          hold = () =>
            resolve(
              library.readSession(
                'session-2',
                new URLSearchParams(key.split('?')[1]),
              ),
            );
        });
    return undefined;
  });
  toggle('Landscape');
  await settle();
  expect(hold).toBeTypeOf('function');
  toggle('Landscape');
  await settle();
  await act(async () => hold());
  await settle();
  // Landscape is enabled again: the abandoned landscape-free page is not shown.
  const names = thumbs().map((b) => b.getAttribute('aria-label'));
  expect(names).toHaveLength(5);
});

test('leaving the route or closing the page releases the session', async () => {
  await openGallery(group(4));
  act(() => void window.dispatchEvent(new Event('pagehide')));
  await settle();
  expect(library.released).toContain('session-1');
  // Restored from the back/forward cache: a new session around the shown image.
  const shownId = shownTitle().replace('Image ', '');
  const restored = new Event('pageshow');
  restored.persisted = true;
  act(() => void window.dispatchEvent(restored));
  await settle();
  expect(library.created).toHaveLength(2);
  expect(library.created[1].body.first_image_id).toBe(shownId);

  fireEvent.click(document.querySelector('.app-nav a[href$="/"]'));
  await settle();
  expect(library.released).toContain('session-2');
});

// --- Bounds ---------------------------------------------------------------------------

test('a long walk keeps at most 132 thumbnails and bounded reads, with details only for shown images', async () => {
  await openGallery(group(1000));
  let most = 0;
  const shown = new Set([shownTitle()]);
  for (let i = 0; i < 160; i += 1) {
    press('Next image');
    if (i % 4 === 0) await settle();
    shown.add(shownTitle());
    most = Math.max(most, thumbs().length);
  }
  await settle();
  expect(most).toBeLessThanOrEqual(GALLERY_MAX_WINDOW_ROWS);
  expect(Math.max(...readLimits())).toBeLessThanOrEqual(96);
  // One session for the whole walk.
  expect(library.created).toHaveLength(1);
  // Exact records are read only for images that were actually on screen.
  const details = api.calls
    .filter((call) => call.key.startsWith('GET /api/images/library/record/'))
    .map((call) => `Image ${decodeURIComponent(call.key.split('/').pop())}`);
  expect(details.length).toBeGreaterThan(0);
  expect(details.every((title) => shown.has(title))).toBe(true);
  expect(new Set(details).size).toBe(details.length);
}, 30000);
