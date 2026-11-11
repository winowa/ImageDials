import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import App from '../../src/app/App.jsx';
import { seededOrder } from '../../src/features/gallery/galleryPlayback.js';
import {
  FakeEventSource,
  fakeLibrary,
  fixtures,
  installApi,
  sizedRecord,
  withBoundedGallery,
} from '../helpers/testSupport.js';

const { m1 } = fixtures;
const LIST = 'GET /api/images/library';
const jobPolicy = { pollIntervalMs: 1, maxConsecutivePollFailures: 3 };
const SEED = 11;

let library;
let api;
let probes;

/** Records of the same shape: the newest first, ids `i0`, `i1`, … */
const group = (count, extra = () => ({})) =>
  Array.from({ length: count }, (_, i) =>
    sizedRecord(`i${i}`, 1152, 768, extra(i)),
  );
const keyOf = (id) => `local-0/${id}.png`;
const titleOf = (key) =>
  `Image ${key.replace('local-0/', '').replace('.png', '')}`;
/** The play order for a fixed seed: one shuffle of every image, the newest included. */
const cycle = (count) =>
  seededOrder(
    Array.from({ length: count }, (_, i) => keyOf(`i${i}`)),
    SEED,
  ).map(titleOf);

function open(
  records,
  { overrides = {}, configured = [], sessionSeed = null, ...props } = {},
) {
  window.history.replaceState(null, '', '/gallery');
  library = fakeLibrary(records);
  library.configured = configured;
  if (sessionSeed !== null) library.sessionSeed = sessionSeed;
  api = installApi({ ...library.routes, ...overrides });
  return render(<App jobPolicy={jobPolicy} {...props} />);
}
const stream = () =>
  FakeEventSource.all.find((s) => s.url.includes('library/events'));
const featured = () => document.querySelector('.gallery-img');
/** The selected image: the filmstrip's current thumbnail, else the details. */
const shownTitle = () =>
  document.querySelector('.strip [aria-current="true"]')?.ariaLabel ??
  within(
    screen.getByRole('complementary', { name: 'Image details' }),
  ).getByRole('heading').textContent;
const filmstrip = () => screen.getByRole('list', { name: 'Images' });
const thumbs = () => within(filmstrip()).getAllByRole('button');
const loaded = () => act(() => void fireEvent.load(featured()));
const press = (name) => fireEvent.click(screen.getByRole('button', { name }));
/** Press, then let a session read that the step waits for land. */
const pressAndRead = async (name) => {
  press(name);
  await flush();
};
const advance = (ms) => act(() => vi.advanceTimersByTime(ms));

/** Opens on the gallery; fake timers begin once the first screen is shown. */
async function ready(records, { playing = false, ...options } = {}) {
  localStorage.setItem('imagedials-gallery-playing', String(playing));
  const view = open(records, options);
  await screen.findByRole('region', { name: 'Gallery controls' });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  return view;
}

/** Let pending promises (fetches, leases) settle without moving the clock. */
const flush = () =>
  act(async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  });

/** A new record reaches the open gallery through the library change stream. */
async function arrive(...added) {
  library.records = [...added, ...library.records];
  stream().open();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  await flush();
}

beforeEach(() => {
  localStorage.clear();
  // These tests time the slideshow itself; effect timers are tested apart.
  localStorage.setItem('imagedials-gallery-effect', '"instant"');
  window.history.replaceState(null, '', '/');
  FakeEventSource.reset();
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.spyOn(Math, 'random').mockReturnValue(SEED / 0x100000000);
  // Every probe image the gallery creates is recorded; none loads by itself.
  probes = [];
  vi.stubGlobal(
    'Image',
    class {
      constructor() {
        probes.push(this);
      }
    },
  );
});
afterEach(() => {
  // The shared Gallery never reads the complete library listing.
  if (api) expect(api.called(LIST)).toEqual([]);
  api = null;
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('the carousel uses the playback shuffle and next visits adjacent thumbnails', async () => {
  await ready(group(8), { playing: false });
  const order = cycle(8);
  expect(thumbs().map((button) => button.getAttribute('aria-label'))).toEqual(
    order,
  );
  for (let index = 1; index < order.length; index += 1) {
    press('Next image');
    expect(shownTitle()).toBe(order[index]);
  }
});

test('the interval starts at the load and a stale image cannot start a timer', async () => {
  await ready(group(5), { playing: true });
  const order = cycle(5);
  expect(shownTitle()).toBe(order[0]);
  expect(vi.getTimerCount()).toBe(0);
  advance(60000);
  expect(shownTitle()).toBe(order[0]);

  const first = featured();
  press('Next image');
  expect(shownTitle()).toBe(order[1]);
  // The previous picture finishing late is ignored.
  act(() => void fireEvent.load(first));
  expect(vi.getTimerCount()).toBe(0);
  loaded();
  expect(vi.getTimerCount()).toBe(1);
  advance(5000);
  expect(shownTitle()).toBe(order[2]);
});

test('pausing, a new speed and leaving each cancel the running timer', async () => {
  await ready(group(5), { playing: true });
  loaded();
  expect(vi.getTimerCount()).toBe(1);
  press('Pause slideshow');
  expect(vi.getTimerCount()).toBe(0);
  press('Play slideshow');
  expect(vi.getTimerCount()).toBe(1);
  fireEvent.change(screen.getByRole('slider', { name: 'Speed' }), {
    target: { value: '6' },
  });
  expect(vi.getTimerCount()).toBe(1);
  advance(9999);
  expect(shownTitle()).toBe(cycle(5)[0]);
  advance(1);
  expect(shownTitle()).toBe(cycle(5)[1]);
});

test('a metadata refresh or a reordered list does not reshuffle the cycle', async () => {
  await ready(group(6));
  const order = cycle(6);
  press('Next image');
  expect(shownTitle()).toBe(order[1]);
  library.records = [...library.records]
    .reverse()
    .map((r) => ({ ...r, title: r.title, alt_text: 'changed' }));
  stream().open();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  await flush();
  expect(shownTitle()).toBe(order[1]);
  press('Next image');
  expect(shownTitle()).toBe(order[2]);
});

test('a new image while playing is held for the policy duration, then playback resumes', async () => {
  await ready(group(5), {
    playing: true,
    clientPolicy: { gallery: { newImageHoldMs: 7000 } },
  });
  const order = cycle(5);
  loaded();
  advance(5000);
  expect(shownTitle()).toBe(order[1]);
  loaded();

  await arrive(sizedRecord('fresh', 1152, 768));
  expect(shownTitle()).toBe('Image fresh');
  // The hold starts when the new picture has loaded, not on arrival.
  expect(vi.getTimerCount()).toBe(0);
  advance(60000);
  expect(shownTitle()).toBe('Image fresh');
  loaded();
  advance(6999);
  expect(shownTitle()).toBe('Image fresh');
  advance(1);
  // Nothing was skipped: playback goes on with what came after order[1].
  expect(shownTitle()).toBe(order[2]);
  loaded();
  advance(5000);
  expect(shownTitle()).toBe(order[3]);
});

test('a new image never interrupts a paused display and is reached by next', async () => {
  await ready(group(4), { playing: false });
  const order = cycle(4);
  press('Next image');
  expect(shownTitle()).toBe(order[1]);
  await arrive(sizedRecord('fresh', 1152, 768));
  expect(shownTitle()).toBe(order[1]);
  expect(vi.getTimerCount()).toBe(0);
  expect(
    within(filmstrip()).getByRole('button', { name: 'Image fresh' }),
  ).toBeTruthy();
  press('Next image');
  expect(shownTitle()).toBe('Image fresh');
});

test('an arrival hidden by the filters does not interrupt playback', async () => {
  localStorage.setItem(
    'imagedials-gallery-orientations',
    JSON.stringify(['landscape']),
  );
  await ready(group(4), { playing: true });
  loaded();
  await arrive(sizedRecord('tall', 768, 1152));
  expect(shownTitle()).toBe(cycle(4)[0]);
  expect(
    within(filmstrip()).queryByRole('button', { name: 'Image tall' }),
  ).toBeNull();
});

test('an image that cannot load is skipped for this view and nothing is deleted', async () => {
  await ready(group(5), { playing: true });
  const order = cycle(5);
  fireEvent.error(featured());
  expect(shownTitle()).toBe(order[1]);
  expect(screen.getAllByRole('button', { name: order[0] }).length).toBe(1);
  expect(library.deleted).toEqual([]);
  expect(api.called('DELETE /api/images/library')).toEqual([]);
  // Going back skips the failed image and wraps within the held session.
  press('Previous image');
  expect(shownTitle()).toBe(order[4]);

  // Another filter starts the view fresh.
  fireEvent.click(screen.getByRole('checkbox', { name: /^Portrait/ }));
  await flush();
  await pressAndRead('Next image');
  await pressAndRead('Next image');
  await pressAndRead('Next image');
  const seen = new Set();
  for (let i = 0; i < 5; i += 1) {
    seen.add(shownTitle());
    await pressAndRead('Next image');
  }
  expect(seen.has(order[0])).toBe(true);
});

test('a failed current image stays on screen while paused', async () => {
  await ready(group(3), { playing: false });
  fireEvent.error(featured());
  expect(document.querySelector('.img-missing.gallery-img')).toBeTruthy();
  expect(shownTitle()).toBe(cycle(3)[0]);
});

test('playing from an image that already failed moves on without waiting for a load', async () => {
  await ready(group(3), { playing: false });
  const order = cycle(3);
  fireEvent.error(featured());
  expect(shownTitle()).toBe(order[0]);
  press('Play slideshow');
  expect(shownTitle()).toBe(order[1]);
  loaded();
  advance(5000);
  expect(shownTitle()).toBe(order[2]);
});

test('one upcoming image is preloaded, and only while playing', async () => {
  await ready(group(6), { playing: true });
  const order = cycle(6);
  const nextUrl = (id) => `/api/images/library/file/local-0/${id}.png`;
  const ids = order.map((t) => t.replace('Image ', ''));
  // Nothing is requested before the featured picture is on screen.
  expect(probes.length).toBe(0);
  loaded();
  await flush();
  expect(probes.length).toBe(1);
  expect(probes[0].src).toBe(nextUrl(ids[1]));

  advance(5000);
  expect(shownTitle()).toBe(order[1]);
  // The finished preload is released; the next one waits for this load.
  loaded();
  await flush();
  expect(probes.length).toBe(2);
  expect(probes[1].src).toBe(nextUrl(ids[2]));
  // The preloaded picture is now the displayed one: its request is left to
  // finish and be shared by the display, not aborted and fetched again.
  expect(probes[0].src).toBe(nextUrl(ids[1]));
  expect(probes[0].onload).toBeNull();

  press('Pause slideshow');
  expect(probes[1].src).toBe('');
  expect(probes.length).toBe(2);
});

test('a preload that fails removes that image from the rotation', async () => {
  await ready(group(5), { playing: true });
  const order = cycle(5);
  loaded();
  await flush();
  expect(probes.length).toBe(1);
  act(() => probes[0].onerror());
  advance(5000);
  expect(shownTitle()).toBe(order[2]);
});

test('one image cannot play and a library of none shows no transport', async () => {
  await ready(group(1), { playing: true });
  loaded();
  expect(vi.getTimerCount()).toBe(0);
  expect(probes.length).toBe(0);
  expect(screen.getByRole('button', { name: 'Play slideshow' }).disabled).toBe(
    true,
  );
});

test('reduced motion starts paused and starts no timer', async () => {
  vi.stubGlobal('matchMedia', (query) => ({
    matches: query.includes('reduce'),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
  open(group(4));
  await screen.findByRole('region', { name: 'Gallery controls' });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  loaded();
  expect(screen.getByRole('button', { name: 'Play slideshow' })).toBeTruthy();
  expect(vi.getTimerCount()).toBe(0);
  expect(probes.length).toBe(0);
});

// --- Filmstrip ----------------------------------------------------------------------

test('the filmstrip opens on the policy count and grows by a batch near its end', async () => {
  await ready(group(100));
  expect(thumbs()).toHaveLength(36);
  const strip = filmstrip();
  Object.defineProperties(strip, {
    clientWidth: { configurable: true, value: 400 },
    scrollWidth: { configurable: true, value: 5000 },
  });
  strip.scrollLeft = 2000;
  fireEvent.scroll(strip);
  expect(thumbs()).toHaveLength(36);
  strip.scrollLeft = 4400;
  fireEvent.scroll(strip);
  await flush();
  expect(thumbs()).toHaveLength(60);
});

test('the policy sets the filmstrip counts', async () => {
  await ready(group(20), {
    clientPolicy: {
      gallery: { filmstripInitialCount: 5, filmstripBatchCount: 3 },
    },
  });
  expect(thumbs()).toHaveLength(5);
});

test('a selection far outside the window gets a bounded window that contains it', async () => {
  await ready(group(300));
  const order = cycle(300);
  await pressAndRead('Previous image');
  expect(shownTitle()).toBe(order[299]);
  const current = within(filmstrip())
    .getAllByRole('button')
    .find((b) => b.getAttribute('aria-current') === 'true');
  expect(current.getAttribute('aria-label')).toBe(order[299]);
  expect(thumbs().length).toBeLessThanOrEqual(49);
});

// --- Events -------------------------------------------------------------------------

const eventCapabilities = (events) => ({
  ...withBoundedGallery(m1.capabilities),
  events: {
    active_event_name: 'spring',
    active_event_id: 'spring',
    gallery_event_ids: events,
    gallery_event_names: events,
  },
});

test('the event choice narrows the loaded scope, is remembered, and adds no request', async () => {
  const records = [
    ...group(3, () => ({ event_id: 'spring' })).map((r, i) => ({
      ...r,
      id: `s${i}`,
      title: `Image s${i}`,
      filename: `s${i}.png`,
    })),
    ...group(2, () => ({ event_id: 'autumn' })).map((r, i) => ({
      ...r,
      id: `a${i}`,
      title: `Image a${i}`,
      filename: `a${i}.png`,
    })),
  ];
  const configured = ['spring', 'autumn', 'quiet'];
  await ready(records, {
    configured,
    overrides: {
      'GET /api/app-capabilities': () => eventCapabilities(configured),
    },
  });
  const select = screen.getByRole('combobox', { name: 'Event' });
  // The server lists event names in name order; a configured empty event stays.
  expect(
    [...select.options].map((o) => o.textContent.replace(/\s+/g, ' ')),
  ).toEqual(['All events', 'autumn · 2', 'quiet · 0', 'spring (active) · 3']);
  expect(thumbs()).toHaveLength(5);

  const before = api.called(LIST).length;
  fireEvent.change(select, { target: { value: 'autumn' } });
  await flush();
  // The session itself is scoped to the event, not narrowed in the browser.
  expect(library.created.at(-1).body.event_name).toBe('autumn');
  expect(select.value).toBe('autumn');
  expect(
    thumbs()
      .map((b) => b.getAttribute('aria-label'))
      .sort(),
  ).toEqual(['Image a0', 'Image a1']);
  expect(screen.getByText('2 visible')).toBeTruthy();
  expect(screen.getByText('5 total')).toBeTruthy();
  expect(localStorage.getItem('imagedials-gallery-event')).toBe('"autumn"');
  expect(api.called(LIST).length).toBe(before);
  expect(api.called(LIST).every((c) => !String(c.url).includes('event'))).toBe(
    true,
  );

  // A configured event with no images is a choice that matches nothing,
  // not an empty library: the controls stay.
  fireEvent.change(select, { target: { value: 'quiet' } });
  // The gallery stays mounted while the event's counts are read.
  expect(select.isConnected).toBe(true);
  expect(select.value).toBe('quiet');
  await flush();
  expect(screen.getByText('0 visible')).toBeTruthy();
  expect(screen.getByText('5 total')).toBeTruthy();
  expect(
    screen.getByText('No images match the selected filters.'),
  ).toBeTruthy();
  expect(screen.queryByText('No saved images yet.')).toBeNull();

  fireEvent.change(select, { target: { value: '' } });
  await flush();
  expect(thumbs()).toHaveLength(5);
});

test('a stored event outside the configured scope is not honoured', async () => {
  localStorage.setItem('imagedials-gallery-event', JSON.stringify('rogue'));
  await ready(
    group(3, (i) => ({ event_id: i === 0 ? 'spring' : 'autumn' })),
    {
      configured: ['spring', 'autumn'],
      overrides: {
        'GET /api/app-capabilities': () =>
          eventCapabilities(['spring', 'autumn']),
      },
    },
  );
  expect(screen.getByRole('combobox', { name: 'Event' }).value).toBe('');
  expect(thumbs()).toHaveLength(3);
  expect(library.created.every(({ body }) => !body.event_name)).toBe(true);
});

test('a single configured event offers no selector', async () => {
  await ready(
    group(3, () => ({ event_id: 'spring' })),
    {
      configured: ['spring'],
      overrides: {
        'GET /api/app-capabilities': () => eventCapabilities(['spring']),
      },
    },
  );
  expect(screen.queryByRole('combobox', { name: 'Event' })).toBeNull();
});

// --- Shortcuts ----------------------------------------------------------------------

test('Space, Escape and H toggle the controls; C toggles the carousel', async () => {
  await ready(group(4));
  const chrome = () => document.querySelector('.gallery').dataset.chrome;
  // Handled keys are consumed so the page does not scroll on Space.
  expect(fireEvent.keyDown(document.body, { key: ' ' })).toBe(false);
  expect(chrome()).toBe('hidden');
  expect(fireEvent.keyDown(document.body, { key: 'Escape' })).toBe(false);
  expect(chrome()).toBe('shown');
  fireEvent.keyDown(document.body, { key: 'h' });
  expect(chrome()).toBe('hidden');
  fireEvent.keyDown(document.body, { key: 'H' });
  fireEvent.keyDown(document.body, { key: 'c' });
  expect(screen.queryByRole('list', { name: 'Images' })).toBeNull();
  // Unhandled keys keep their default.
  expect(fireEvent.keyDown(document.body, { key: 'x' })).toBe(true);
});

test('shortcuts leave sliders, fields, buttons and dialogs to their own keys', async () => {
  await ready(group(4));
  const chrome = () => document.querySelector('.gallery').dataset.chrome;
  const title = shownTitle();
  const speed = screen.getByRole('slider', { name: 'Speed' });
  fireEvent.keyDown(speed, { key: 'ArrowRight' });
  fireEvent.keyDown(speed, { key: ' ' });
  expect(shownTitle()).toBe(title);
  expect(chrome()).toBe('shown');

  // Space on a button activates it instead of hiding the controls.
  const next = screen.getByRole('button', { name: 'Next image' });
  expect(fireEvent.keyDown(next, { key: ' ' })).toBe(true);
  expect(chrome()).toBe('shown');
  const box = screen.getByRole('checkbox', { name: /^Portrait/ });
  expect(fireEvent.keyDown(box, { key: ' ' })).toBe(true);
  expect(chrome()).toBe('shown');

  const dialog = document.body.appendChild(document.createElement('div'));
  dialog.setAttribute('role', 'dialog');
  const field = dialog.appendChild(document.createElement('textarea'));
  fireEvent.keyDown(field, { key: 'c' });
  fireEvent.keyDown(dialog, { key: 'Escape' });
  expect(screen.getByRole('list', { name: 'Images' })).toBeTruthy();
  expect(chrome()).toBe('shown');
  dialog.remove();

  // Leaving the gallery removes the handler.
  cleanup();
  expect(fireEvent.keyDown(document.body, { key: ' ' })).toBe(true);
});

test('the controls are revealed again by a tap on the image and list the shortcuts', async () => {
  await ready(group(4));
  fireEvent.click(screen.getByRole('button', { name: 'Keyboard shortcuts' }));
  expect(
    screen.getByRole('dialog', { name: 'Keyboard shortcuts' }).textContent,
  ).toMatch(/Space.*H.*Esc.*Show or hide controls/s);
  fireEvent.keyDown(document.body, { key: 'Escape' });
  fireEvent.click(screen.getByRole('button', { name: /^Hide controls/ }));
  expect(screen.queryByRole('button', { name: 'Show controls' })).toBeNull();
  tap(featured());
  expect(document.querySelector('.gallery').dataset.chrome).toBe('shown');
});

// --- Hide UI and the randomized opening ---------------------------------------------

test('the opening image is the first of the whole shuffle and a picked thumbnail then steps adjacently', async () => {
  await ready(group(8), { playing: false });
  const order = cycle(8);
  expect(shownTitle()).toBe(order[0]);
  const names = () =>
    thumbs().map((button) => button.getAttribute('aria-label'));
  expect(names()).toEqual(order);
  fireEvent.click(thumbs()[4]);
  expect(shownTitle()).toBe(order[4]);
  // Selecting moves the cursor; it does not reshuffle.
  expect(names()).toEqual(order);
  press('Next image');
  expect(shownTitle()).toBe(order[5]);
  press('Previous image');
  press('Previous image');
  expect(shownTitle()).toBe(order[3]);
});

test('different session seeds open on different images, the newest not favoured', async () => {
  // The server's keyed shuffle decides the opening; the browser must not bias
  // it by anchoring a first visit on any image.
  const opened = new Set();
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const view = await ready(group(6), { playing: false, sessionSeed: seed });
    opened.add(shownTitle());
    expect(library.created[0].body).not.toHaveProperty('first_image_id');
    expect(api.called(LIST)).toEqual([]);
    view.unmount();
    vi.useRealTimers();
  }
  expect(opened.size).toBeGreaterThan(2);
  expect([...opened].every((title) => title === 'Image i0')).toBe(false);
});

const hiddenState = () => document.querySelector('.gallery').dataset.chrome;
/** A primary pointer press, optional travel, and the click a tap produces. */
function tap(target, { dx = 0, dy = 0, cancel = false, click = true } = {}) {
  const at = { clientX: 200, clientY: 200 };
  const pointer = { pointerId: 7, isPrimary: true, button: 0 };
  fireEvent.pointerDown(target, { ...pointer, ...at });
  if (dx || dy)
    fireEvent.pointerMove(target, {
      ...pointer,
      clientX: at.clientX + dx,
      clientY: at.clientY + dy,
    });
  if (cancel) fireEvent.pointerCancel(target, pointer);
  else fireEvent.pointerUp(target, pointer);
  return click ? fireEvent.click(target) : true;
}
const headerWrap = () => document.querySelector('.app-header-wrap');

test('Hide UI hides the global header too, leaves no button, and a tap restores a carousel that was off', async () => {
  localStorage.setItem('imagedials-gallery-filmstrip', 'false');
  await ready(group(4));
  expect(screen.queryByRole('list', { name: 'Images' })).toBeNull();
  const title = shownTitle();
  fireEvent.click(screen.getByRole('button', { name: /^Hide controls/ }));
  expect(hiddenState()).toBe('hidden');
  expect(headerWrap().hasAttribute('data-hidden')).toBe(true);
  expect(document.querySelector('.app-header').hasAttribute('inert')).toBe(
    true,
  );
  // No reveal button: the stage itself holds focus, out of the tab order.
  expect(screen.queryByRole('button', { name: 'Show controls' })).toBeNull();
  expect(document.querySelector('.gallery-reveal')).toBeNull();
  expect(document.querySelector('.gallery-stage button')).toBeNull();
  const surface = document.querySelector('.gallery-stage');
  expect(document.activeElement).toBe(surface);
  expect(surface.tabIndex).toBe(-1);
  expect(surface.getAttribute('aria-describedby')).toBeTruthy();
  expect(document.querySelector('.gallery-side').hasAttribute('inert')).toBe(
    true,
  );
  expect(document.querySelector('.gallery-info').hasAttribute('inert')).toBe(
    true,
  );
  // The temporary hide wrote no preference.
  expect(localStorage.getItem('imagedials-gallery-filmstrip')).toBe('false');
  // C changes nothing while the carousel is hidden with everything else.
  fireEvent.keyDown(document.body, { key: 'c' });
  expect(localStorage.getItem('imagedials-gallery-filmstrip')).toBe('false');

  tap(surface);
  expect(hiddenState()).toBe('shown');
  expect(headerWrap().hasAttribute('data-hidden')).toBe(false);
  expect(document.querySelector('.app-header').hasAttribute('inert')).toBe(
    false,
  );
  expect(screen.queryByRole('list', { name: 'Images' })).toBeNull();
  expect(document.activeElement).toBe(
    screen.getByRole('button', { name: /^Hide controls/ }),
  );
  expect(shownTitle()).toBe(title);
});

test('hiding keeps playback running and a playing arrival is shown while hidden', async () => {
  await ready(group(4), { playing: true });
  loaded();
  fireEvent.keyDown(document.body, { key: 'h' });
  expect(hiddenState()).toBe('hidden');
  const before = shownTitle();
  advance(5000);
  expect(shownTitle()).not.toBe(before);
  await arrive(sizedRecord('fresh', 1152, 768, {}));
  expect(shownTitle()).toBe('Image fresh');
  expect(hiddenState()).toBe('hidden');
});

test('Escape that dismisses a popover does not hide the interface', async () => {
  await ready(group(4));
  const tip = document.body.appendChild(document.createElement('span'));
  tip.setAttribute('role', 'tooltip');
  expect(fireEvent.keyDown(document.body, { key: 'Escape' })).toBe(true);
  expect(hiddenState()).toBe('shown');
  tip.remove();
  fireEvent.keyDown(document.body, { key: 'Escape' });
  expect(hiddenState()).toBe('hidden');
});

test('leaving the gallery while hidden restores the global header', async () => {
  await ready(group(4));
  fireEvent.keyDown(document.body, { key: 'h' });
  expect(headerWrap().hasAttribute('data-hidden')).toBe(true);
  // The header is inert while hidden; leave as the browser's back does.
  act(() => {
    window.history.pushState(null, '', '/');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await flush();
  expect(document.querySelector('.gallery')).toBeNull();
  expect(headerWrap().hasAttribute('data-hidden')).toBe(false);
  expect(document.querySelector('.app-header').hasAttribute('inert')).toBe(
    false,
  );
});

// --- Whole-surface reveal -----------------------------------------------------------

test('while hidden, a tap anywhere reveals and never activates what it lands on', async () => {
  await ready(group(4));
  const title = shownTitle();
  const hide = () =>
    fireEvent.click(screen.getByRole('button', { name: /^Hide controls/ }));
  const nextButton = screen.getByRole('button', { name: 'Next image' });
  const homeLink = document.querySelector('.app-nav a[href$="/"]');
  const thumb = thumbs()[2];
  for (const target of [
    featured(),
    document.querySelector('.gallery-stage'),
    document.querySelector('.gallery'),
    document.body,
    nextButton,
    homeLink,
    thumb,
  ]) {
    hide();
    expect(hiddenState()).toBe('hidden');
    // The press is consumed: its default and every later handler are skipped.
    expect(tap(target)).toBe(false);
    expect(hiddenState()).toBe('shown');
    expect(document.querySelector('.gallery')).toBeTruthy();
    expect(shownTitle()).toBe(title);
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: /^Hide controls/ }),
    );
  }
  // Shown again, presses work normally.
  expect(tap(nextButton)).toBe(true);
  expect(shownTitle()).not.toBe(title);
});

test('a swipe, drag, scroll or secondary press does not reveal', async () => {
  await ready(group(4));
  fireEvent.click(screen.getByRole('button', { name: /^Hide controls/ }));
  const surface = document.querySelector('.gallery-stage');
  // A swipe that still ends in a click (a mouse drag) is consumed, not a tap.
  expect(tap(surface, { dx: 60 })).toBe(false);
  expect(hiddenState()).toBe('hidden');
  tap(surface, { dy: -40 });
  expect(hiddenState()).toBe('hidden');
  // A touch the browser turned into a scroll is cancelled and has no click.
  tap(surface, { dy: 80, cancel: true, click: false });
  expect(hiddenState()).toBe('hidden');
  // Small jitter inside the tap distance still counts as a tap.
  tap(surface, { dx: 4, dy: 3 });
  expect(hiddenState()).toBe('shown');

  fireEvent.click(screen.getByRole('button', { name: /^Hide controls/ }));
  fireEvent.pointerDown(surface, { pointerId: 2, isPrimary: true, button: 2 });
  fireEvent.contextMenu(surface);
  expect(hiddenState()).toBe('hidden');
  fireEvent.keyDown(document.body, { key: 'h' });
  expect(hiddenState()).toBe('shown');
});

test('hidden controls leave no tab stop and keyboard restore moves focus to Hide', async () => {
  await ready(group(4));
  fireEvent.keyDown(document.body, { key: 'h' });
  const surface = document.querySelector('.gallery-stage');
  expect(document.activeElement).toBe(surface);
  const tabbable = [
    ...document.querySelectorAll(
      'a[href], button, input, select, textarea, [tabindex]',
    ),
  ].filter(
    (element) =>
      !element.closest('[inert]') &&
      !element.disabled &&
      element.tabIndex >= 0 &&
      !element.closest('[hidden]'),
  );
  expect(tabbable).toEqual([]);
  fireEvent.keyDown(surface, { key: 'Escape' });
  expect(hiddenState()).toBe('shown');
  expect(document.activeElement).toBe(
    screen.getByRole('button', { name: /^Hide controls/ }),
  );
  expect(surface.hasAttribute('tabindex')).toBe(false);
  // The reveal listener is gone once shown, and when leaving while hidden.
  fireEvent.keyDown(document.body, { key: 'H' });
  cleanup();
  expect(fireEvent.click(document.body)).toBe(true);
});

test('scroll and additional pointers invalidate a press even if a click follows', async () => {
  await ready(group(4));
  fireEvent.keyDown(document.body, { key: 'h' });
  const surface = document.querySelector('.gallery-stage');
  const primary = {
    pointerId: 7,
    isPrimary: true,
    button: 0,
    clientX: 100,
    clientY: 100,
  };
  for (const cancel of [
    () => fireEvent.scroll(document),
    () => fireEvent.wheel(surface, { deltaY: 60 }),
    () =>
      fireEvent.pointerDown(surface, {
        pointerId: 8,
        isPrimary: false,
        button: 0,
      }),
  ]) {
    fireEvent.pointerDown(surface, primary);
    cancel();
    fireEvent.pointerUp(surface, primary);
    expect(fireEvent.click(surface)).toBe(false);
    expect(hiddenState()).toBe('hidden');
  }
  tap(surface);
  expect(hiddenState()).toBe('shown');
});

test('hiding an open transition picker removes it so Escape restores the Gallery', async () => {
  await ready(group(4));
  const trigger = screen.getByRole('button', { name: /^Transition/ });
  fireEvent.click(trigger);
  expect(screen.getByRole('dialog', { name: 'Transitions' })).toBeTruthy();
  // H remains a Gallery shortcut while the trigger has focus.
  act(() => trigger.focus());
  fireEvent.keyDown(trigger, { key: 'h' });
  expect(hiddenState()).toBe('hidden');
  expect(
    screen.queryByRole('dialog', { name: 'Transitions', hidden: true }),
  ).toBeNull();
  fireEvent.keyDown(document.querySelector('.gallery-stage'), {
    key: 'Escape',
  });
  expect(hiddenState()).toBe('shown');
  expect(document.activeElement).toBe(
    screen.getByRole('button', { name: /^Hide controls/ }),
  );
});
