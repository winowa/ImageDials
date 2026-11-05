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
import { seededOrder } from './galleryPlayback.js';
import { EFFECT_IDS, GALLERY_EFFECTS } from './galleryEffects.js';
import {
  FakeEventSource,
  fakeLibrary,
  installApi,
  sizedRecord,
} from './testSupport.js';

const jobPolicy = { pollIntervalMs: 1, maxConsecutivePollFailures: 3 };
const SEED = 11;
const STORE = 'imagedials-gallery-effect';
const LIST_STORE = 'imagedials-gallery-effects';

let probes;

const group = (count) =>
  Array.from({ length: count }, (_, i) => sizedRecord(`i${i}`, 1152, 768));
const keyOf = (id) => `local-0/${id}.png`;
const titleOf = (key) =>
  `Image ${key.replace('local-0/', '').replace('.png', '')}`;
const cycle = (count) =>
  seededOrder(
    Array.from({ length: count }, (_, i) => keyOf(`i${i}`)),
    SEED,
  ).map(titleOf);

const stage = () => document.querySelector('.gallery-stage');
const layers = () => [...stage().querySelectorAll('.stage-layer')];
const roles = () => layers().map((l) => l.dataset.role);
/** The running effects on the stage, as their CSS sees them. */
const running = () => stage().dataset.effects;
/** The `--fx-ms` of each effect ring in the layer with `role`. */
const ringTimes = (role) =>
  Object.fromEntries(
    [
      ...stage().querySelectorAll(`.stage-layer[data-role="${role}"] .fx-ring`),
    ].map((ring) => [ring.dataset.fx, ring.style.getPropertyValue('--fx-ms')]),
  );
/** The layer showing `title`. */
const layerOf = (title) =>
  layers().find((l) => l.querySelector('img')?.alt === title);
const loadLayer = (title) =>
  act(() => {
    const picture = layerOf(title).querySelector('img');
    // jsdom does not decode images; reflect the browser's loaded pixel state.
    Object.defineProperties(picture, {
      complete: { value: true, configurable: true },
      naturalWidth: { value: 1152, configurable: true },
    });
    fireEvent.load(picture);
  });
const heading = () =>
  within(
    screen.getByRole('complementary', { name: 'Image details' }),
  ).getByRole('heading').textContent;
const selected = () =>
  document.querySelector('.strip [aria-current="true"]').ariaLabel;
const press = (name) => fireEvent.click(screen.getByRole('button', { name }));
const advance = (ms) => act(() => vi.advanceTimersByTime(ms));
const flush = () =>
  act(async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  });

async function ready(count, { playing = false, stored, list } = {}) {
  vi.useRealTimers();
  localStorage.setItem('imagedials-gallery-playing', String(playing));
  if (stored !== undefined) localStorage.setItem(STORE, stored);
  if (list !== undefined) localStorage.setItem(LIST_STORE, list);
  window.history.replaceState(null, '', '/gallery');
  const library = fakeLibrary(group(count));
  installApi({ ...library.routes });
  render(<App jobPolicy={jobPolicy} />);
  await screen.findByRole('region', { name: 'Gallery controls' });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const order = cycle(count);
  loadLayer(order[0]);
  return order;
}

/** A `prefers-reduced-motion` query whose value can change while mounted. */
const reduceMotion = (initial) => {
  const queries = [];
  let reduced = initial;
  vi.stubGlobal('matchMedia', (query) => {
    const listeners = new Set();
    const entry = {
      media: query,
      get matches() {
        return reduced && query.includes('reduce');
      },
      addEventListener: (_, fn) => listeners.add(fn),
      removeEventListener: (_, fn) => listeners.delete(fn),
      listeners,
    };
    queries.push(entry);
    return entry;
  });
  return (value) => {
    reduced = value;
    act(() => queries.forEach((q) => q.listeners.forEach((fn) => fn())));
  };
};

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, '', '/');
  FakeEventSource.reset();
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.spyOn(Math, 'random').mockReturnValue(SEED / 0x100000000);
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
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// --- Continuity --------------------------------------------------------------------

test('the old picture stays until the replacement has loaded, then the effect runs and ends', async () => {
  const order = await ready(5, { stored: '"fade"' });
  expect(roles()).toEqual(['shown']);

  press('Next image');
  // Chosen, not yet loaded: the old picture and its details stay.
  expect(selected()).toBe(order[1]);
  expect(roles()).toEqual(['loading', 'shown']);
  expect(layerOf(order[1]).getAttribute('aria-hidden')).toBe('true');
  expect(layerOf(order[0]).getAttribute('aria-hidden')).toBeNull();
  expect(heading()).toBe(order[0]);
  advance(10000);
  expect(roles()).toEqual(['loading', 'shown']);

  loadLayer(order[1]);
  expect(roles()).toEqual(['entering', 'exiting']);
  expect(running()).toBe('fade');
  expect(ringTimes('entering').fade).toBe('600ms');
  expect(heading()).toBe(order[1]);

  advance(599);
  expect(roles()).toEqual(['entering', 'exiting']);
  advance(1);
  expect(roles()).toEqual(['shown']);
  expect(running()).toBeUndefined();
  expect(vi.getTimerCount()).toBe(0);
});

test('a late load of an abandoned replacement is ignored and its layer is gone', async () => {
  const order = await ready(5, { stored: '"wipe"' });
  press('Next image');
  const abandoned = layerOf(order[1]).querySelector('img');
  press('Next image');
  expect(roles()).toEqual(['loading', 'shown']);
  expect(layerOf(order[1])).toBeUndefined();
  act(() => void fireEvent.load(abandoned));
  expect(roles()).toEqual(['loading', 'shown']);
  expect(heading()).toBe(order[0]);
  loadLayer(order[2]);
  expect(roles()).toEqual(['entering', 'exiting']);
  expect(heading()).toBe(order[2]);
});

test('returning to the already shown picture before its replacement loads keeps autoplay ready', async () => {
  const order = await ready(5, { stored: '"fade"' });
  const picture = layerOf(order[0]).querySelector('img');
  press('Next image');
  expect(roles()).toEqual(['loading', 'shown']);
  press('Previous image');
  expect(selected()).toBe(order[0]);
  expect(roles()).toEqual(['shown']);
  // This is the same loaded element; it will emit no new load event.
  expect(layerOf(order[0]).querySelector('img')).toBe(picture);
  press('Play slideshow');
  expect(vi.getTimerCount()).toBe(1);
  advance(5000);
  expect(selected()).toBe(order[1]);
});

test('choosing another image during an effect settles it at once', async () => {
  const order = await ready(5, { stored: '"flip"' });
  press('Next image');
  loadLayer(order[1]);
  advance(300);
  expect(roles()).toEqual(['entering', 'exiting']);
  press('Next image');
  // The running effect ended on the spot: no waiting for its duration.
  expect(roles()).toEqual(['loading', 'shown']);
  expect(layerOf(order[1])).toBeDefined();
  expect(running()).toBeUndefined();
  expect(vi.getTimerCount()).toBe(0);
  loadLayer(order[2]);
  advance(900);
  expect(roles()).toEqual(['shown']);
  expect(heading()).toBe(order[2]);
});

test('the interval starts at the load and the effect never lengthens it', async () => {
  const order = await ready(5, { playing: true, stored: '"flip"' });
  // First picture: the dwell timer only.
  expect(vi.getTimerCount()).toBe(1);
  advance(4999);
  expect(selected()).toBe(order[0]);
  advance(1);
  expect(selected()).toBe(order[1]);
  expect(vi.getTimerCount()).toBe(0);
  advance(60000);
  expect(selected()).toBe(order[1]);

  loadLayer(order[1]);
  // The effect timer and the dwell timer start together at the load.
  expect(vi.getTimerCount()).toBe(2);
  advance(900);
  expect(roles()).toEqual(['shown']);
  advance(5000 - 900 - 1);
  expect(selected()).toBe(order[1]);
  advance(1);
  expect(selected()).toBe(order[2]);
});

test('a failed replacement shows the unavailable placeholder and moves on', async () => {
  const order = await ready(4, { stored: '"fade"' });
  press('Next image');
  const broken = layerOf(order[1]).querySelector('img');
  act(() => void fireEvent.error(broken));
  expect(document.querySelector('.img-missing.gallery-img')).toBeTruthy();
  expect(roles()).toEqual(['shown']);
  expect(vi.getTimerCount()).toBe(0);
});

test('leaving the gallery mid-effect leaves no timer behind', async () => {
  const order = await ready(5, { stored: '"zoom"' });
  press('Next image');
  loadLayer(order[1]);
  expect(vi.getTimerCount()).toBe(1);
  fireEvent.click(screen.getByRole('link', { name: 'Create' }));
  expect(screen.queryByRole('region', { name: 'Gallery controls' })).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});

test('every effect runs on the stage with its own duration', async () => {
  const order = await ready(3);
  const moving = GALLERY_EFFECTS.filter((e) => e.animated);
  let at = 0;
  for (const effect of moving) {
    localStorage.setItem(STORE, JSON.stringify(effect.id));
    cleanup();
    await ready(3, { stored: JSON.stringify(effect.id) });
    press('Next image');
    loadLayer(order[1]);
    expect(running()).toBe(effect.id);
    expect(ringTimes('entering')[effect.id]).toBe(`${effect.durationMs}ms`);
    advance(effect.durationMs - 1);
    expect(roles()).toEqual(['entering', 'exiting']);
    advance(1);
    expect(roles()).toEqual(['shown']);
    at += 1;
  }
  expect(at).toBe(moving.length);
});

test('the instant effect swaps without a second layer or timer', async () => {
  const order = await ready(4, { stored: '"instant"' });
  press('Next image');
  loadLayer(order[1]);
  expect(roles()).toEqual(['shown']);
  expect(vi.getTimerCount()).toBe(0);
  expect(heading()).toBe(order[1]);
});

// --- Preference and reduced motion ----------------------------------------------------

test('a valid stored effect is used and an invalid one falls back', async () => {
  await ready(3, { stored: '"glitch"' });
  expect(
    screen.getByRole('button', { name: /Transition\s*Glitch/ }),
  ).toBeTruthy();
  cleanup();
  for (const bad of ['"spin"', '7', 'not json', 'null']) {
    await ready(3, { stored: bad });
    expect(
      screen.getByRole('button', { name: /Transition\s*Reveal/ }),
    ).toBeTruthy();
    cleanup();
  }
});

test('reduced motion swaps at once, starts paused and follows a later change', async () => {
  const setReduced = reduceMotion(true);
  localStorage.setItem(STORE, '"zoom"');
  window.history.replaceState(null, '', '/gallery');
  const library = fakeLibrary(group(4));
  installApi({ ...library.routes });
  render(<App jobPolicy={jobPolicy} />);
  await screen.findByRole('region', { name: 'Gallery controls' });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const order = cycle(4);
  loadLayer(order[0]);
  expect(screen.getByRole('button', { name: 'Play slideshow' })).toBeTruthy();
  press('Next image');
  loadLayer(order[1]);
  expect(roles()).toEqual(['shown']);
  expect(vi.getTimerCount()).toBe(0);
  // The stored choice is untouched.
  expect(localStorage.getItem(STORE)).toBe('"zoom"');

  // The preference is switched off while the page is open.
  setReduced(false);
  press('Next image');
  loadLayer(order[2]);
  expect(roles()).toEqual(['entering', 'exiting']);
});

test('switching to reduced motion mid-effect settles it', async () => {
  const setReduced = reduceMotion(false);
  localStorage.setItem(STORE, '"flip"');
  window.history.replaceState(null, '', '/gallery');
  const library = fakeLibrary(group(4));
  installApi({ ...library.routes });
  render(<App jobPolicy={jobPolicy} />);
  await screen.findByRole('region', { name: 'Gallery controls' });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const order = cycle(4);
  loadLayer(order[0]);
  localStorage.setItem('imagedials-gallery-playing', 'false');
  press('Next image');
  loadLayer(order[1]);
  expect(roles()).toEqual(['entering', 'exiting']);
  setReduced(true);
  expect(roles()).toEqual(['shown']);
});

// --- Simultaneous effects and the stored choice -----------------------------------

test('chosen effects start together on the same change and end with the longest', async () => {
  const order = await ready(4, { list: '["iris","fade","zoom"]' });
  press('Next image');
  loadLayer(order[1]);
  expect(roles()).toEqual(['entering', 'exiting']);
  // One change carries every chosen effect, in canonical order, at once.
  expect(running()).toBe('fade zoom iris');
  // Each effect has its own ring on both layers, so they compose, with its own duration.
  for (const role of ['entering', 'exiting'])
    expect(ringTimes(role)).toMatchObject({
      fade: '600ms',
      zoom: '700ms',
      iris: '800ms',
    });
  // A single timer ends the change after the longest of them.
  expect(vi.getTimerCount()).toBe(1);
  advance(799);
  expect(roles()).toEqual(['entering', 'exiting']);
  expect(running()).toBe('fade zoom iris');
  advance(1);
  expect(roles()).toEqual(['shown']);
  expect(vi.getTimerCount()).toBe(0);
});

test('the shown layer keeps its element while the choice changes, so no reload', async () => {
  const order = await ready(4, { list: '["fade"]' });
  const picture = layerOf(order[0]).querySelector('img');
  fireEvent.click(trigger());
  fireEvent.click(within(panel()).getByRole('checkbox', { name: 'Zoom' }));
  fireEvent.click(within(panel()).getByRole('checkbox', { name: 'Instant' }));
  expect(layerOf(order[0]).querySelector('img')).toBe(picture);
});

test('an older single stored effect becomes the list and is left in place', async () => {
  await ready(3, { stored: '"glitch"' });
  expect(trigger().textContent).toContain('Glitch');
  expect(localStorage.getItem(STORE)).toBe('"glitch"');
  cleanup();
  await ready(3, { stored: '"instant"' });
  expect(trigger().textContent).toContain('Instant');
  cleanup();
  // A saved list wins over the older single choice.
  await ready(3, { stored: '"glitch"', list: '["slide","wipe"]' });
  expect(trigger().textContent).toContain('Slide + Wipe');
});

test('a saved choice survives a reload, Instant included', async () => {
  await ready(3);
  fireEvent.click(trigger());
  fireEvent.click(within(panel()).getByRole('checkbox', { name: 'Focus' }));
  expect(JSON.parse(localStorage.getItem(LIST_STORE))).toEqual([
    'reveal',
    'focus',
  ]);
  cleanup();
  await ready(3);
  expect(trigger().textContent).toContain('Reveal + Focus');
  fireEvent.click(trigger());
  fireEvent.click(within(panel()).getByRole('checkbox', { name: 'Instant' }));
  cleanup();
  await ready(3);
  expect(trigger().textContent).toContain('Instant');
  expect(JSON.parse(localStorage.getItem(LIST_STORE))).toEqual([]);
});

// --- Chooser ---------------------------------------------------------------------------

const trigger = () => screen.getByRole('button', { name: /^Transition/ });
const panel = () => screen.queryByRole('dialog', { name: 'Transitions' });
const boxes = () => within(panel()).getAllByRole('checkbox');
const checked = () =>
  boxes()
    .filter((box) => box.getAttribute('aria-checked') === 'true')
    .map((box) => box.querySelector('.effect-option-label').firstChild.data);

test('the chooser lists every effect with a preview and combines them by click or tap', async () => {
  await ready(4);
  fireEvent.click(trigger());
  expect(trigger().getAttribute('aria-expanded')).toBe('true');
  expect(
    boxes().map(
      (box) => box.querySelector('.effect-option-label').firstChild.data,
    ),
  ).toEqual(GALLERY_EFFECTS.map((e) => e.label));
  expect(panel().querySelectorAll('.effect-preview')).toHaveLength(
    EFFECT_IDS.length,
  );
  expect(checked()).toEqual(['Reveal']);

  // Animations combine, the panel stays open while choosing.
  fireEvent.click(within(panel()).getByRole('checkbox', { name: 'Wipe' }));
  expect(panel()).toBeTruthy();
  expect(checked()).toEqual(['Reveal', 'Wipe']);
  expect(trigger().textContent).toContain('Reveal + Wipe');
  expect(JSON.parse(localStorage.getItem(LIST_STORE))).toEqual([
    'reveal',
    'wipe',
  ]);
});

test('Instant is exclusive and is what remains when the last animation is unchecked', async () => {
  await ready(4, { list: '["fade","slide"]' });
  fireEvent.click(trigger());
  const box = (name) => within(panel()).getByRole('checkbox', { name });
  expect(box('Instant').getAttribute('aria-describedby')).toBeTruthy();
  expect(
    document.getElementById(box('Instant').getAttribute('aria-describedby'))
      .textContent,
  ).toBe('No animation');

  fireEvent.click(box('Instant'));
  expect(checked()).toEqual(['Instant']);
  expect(trigger().textContent).toContain('Instant');
  // Pressing Instant again keeps it chosen.
  fireEvent.click(box('Instant'));
  expect(checked()).toEqual(['Instant']);

  // Choosing an animation clears Instant.
  fireEvent.click(box('Zoom'));
  expect(checked()).toEqual(['Zoom']);
  fireEvent.click(box('Glitch'));
  expect(checked()).toEqual(['Zoom', 'Glitch']);
  fireEvent.click(box('Zoom'));
  fireEvent.click(box('Glitch'));
  expect(checked()).toEqual(['Instant']);
  expect(JSON.parse(localStorage.getItem(LIST_STORE))).toEqual([]);

  // Instant swaps without a second layer or timer.
  fireEvent.keyDown(trigger(), { key: 'Escape' });
  press('Next image');
  loadLayer(cycle(4)[1]);
  expect(roles()).toEqual(['shown']);
  expect(vi.getTimerCount()).toBe(0);
});

test('the chooser opens on hover and focus, and closes on Escape, outside press and repeat press', async () => {
  await ready(4);
  fireEvent.mouseEnter(trigger().parentElement);
  expect(panel()).toBeTruthy();
  fireEvent.mouseLeave(trigger().parentElement);
  act(() => vi.advanceTimersByTime(200));
  expect(panel()).toBeNull();

  act(() => trigger().focus());
  expect(panel()).toBeTruthy();
  fireEvent.keyDown(trigger(), { key: 'Escape' });
  expect(panel()).toBeNull();
  // Escape closed the panel and did not hide the controls.
  expect(screen.getByRole('region', { name: 'Gallery controls' })).toBeTruthy();
  expect(document.querySelector('.gallery').dataset.chrome).toBe('shown');

  fireEvent.click(trigger());
  fireEvent.mouseLeave(trigger().parentElement);
  act(() => vi.advanceTimersByTime(500));
  expect(panel()).toBeTruthy();
  fireEvent.pointerDown(document.body);
  expect(panel()).toBeNull();

  fireEvent.click(trigger());
  expect(panel()).toBeTruthy();
  fireEvent.click(trigger());
  expect(panel()).toBeNull();
});

test('arrow keys move between options and wrap; every checkbox is in tab order', async () => {
  await ready(4, { list: '["fade"]' });
  fireEvent.click(trigger());
  const all = boxes();
  expect(all.every((box) => box.tabIndex === 0)).toBe(true);
  act(() => all[2].focus());
  fireEvent.keyDown(all[2], { key: 'ArrowRight' });
  expect(document.activeElement).toBe(all[3]);
  fireEvent.keyDown(all[3], { key: 'ArrowUp' });
  expect(document.activeElement).toBe(all[2]);
  act(() => all[0].focus());
  fireEvent.keyDown(all[0], { key: 'ArrowLeft' });
  expect(document.activeElement).toBe(all[all.length - 1]);
  fireEvent.keyDown(all[all.length - 1], { key: 'ArrowDown' });
  expect(document.activeElement).toBe(all[0]);
  // Space and Enter toggle through the native button.
  expect(all[0].tagName).toBe('BUTTON');
});

test('previews reuse the filmstrip thumbnails and add no probe load', async () => {
  await ready(4);
  const stripSources = new Set(
    [
      ...screen.getByRole('list', { name: 'Images' }).querySelectorAll('img'),
    ].map((img) => img.getAttribute('src')),
  );
  fireEvent.click(trigger());
  const previewSources = [
    ...panel().querySelectorAll('.effect-preview img'),
  ].map((img) => img.getAttribute('src'));
  expect(previewSources.length).toBeGreaterThan(0);
  for (const src of previewSources) expect(stripSources.has(src)).toBe(true);
  expect(probes).toHaveLength(0);
});

test('reduced motion keeps previews still and says so', async () => {
  reduceMotion(true);
  window.history.replaceState(null, '', '/gallery');
  const library = fakeLibrary(group(4));
  installApi({ ...library.routes });
  render(<App jobPolicy={jobPolicy} />);
  await screen.findByRole('region', { name: 'Gallery controls' });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  fireEvent.click(trigger());
  expect(within(panel()).getByText(/Reduced motion is on/)).toBeTruthy();
  fireEvent.mouseEnter(
    within(panel()).getByRole('checkbox', { name: 'Instant' }),
  );
  expect(vi.getTimerCount()).toBe(0);
  act(() => vi.advanceTimersByTime(5000));
  expect(
    panel().querySelectorAll('.stage-layer[data-role="entering"]'),
  ).toHaveLength(0);
});

test('an inspected option animates alone and stops when closed', async () => {
  await ready(4);
  fireEvent.click(trigger());
  act(() => vi.advanceTimersByTime(400));
  const moving = () =>
    [...panel().querySelectorAll('.effect-preview')].filter((p) =>
      p.querySelector('[data-role="entering"]'),
    );
  expect(moving().map((p) => p.dataset.effects)).toEqual(['reveal']);
  fireEvent.mouseEnter(within(panel()).getByRole('checkbox', { name: 'Iris' }));
  act(() => vi.advanceTimersByTime(1500));
  expect(moving().every((p) => p.dataset.effects === 'iris')).toBe(true);
  fireEvent.keyDown(trigger(), { key: 'Escape' });
  expect(panel()).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});

test('the Instant preview cuts between its pictures without any moving layer', async () => {
  await ready(4);
  fireEvent.click(trigger());
  const instant = within(panel()).getByRole('checkbox', { name: 'Instant' });
  fireEvent.mouseEnter(instant);
  const preview = instant.querySelector('.effect-preview');
  const front = () =>
    [...preview.querySelectorAll('.stage-layer')].findIndex(
      (layer) => layer.dataset.role === 'shown',
    );
  const before = front();
  act(() => vi.advanceTimersByTime(300));
  expect(front()).toBe(1 - before);
  expect(preview.dataset.effects).toBeUndefined();
  expect(preview.querySelector('[data-role="entering"]')).toBeNull();
  act(() => vi.advanceTimersByTime(900));
  expect(front()).toBe(before);
});

// --- Preload bounds ----------------------------------------------------------------------

test('a preload for an image that is not chosen is aborted; the chosen one is shared', async () => {
  const order = await ready(6, { playing: true, stored: '"fade"' });
  await flush();
  expect(probes).toHaveLength(1);
  const [next] = probes;
  // Choose a different image from the filmstrip: the preload is abandoned.
  const other = order[3];
  fireEvent.click(
    within(screen.getByRole('list', { name: 'Images' })).getByRole('button', {
      name: other,
    }),
  );
  expect(next.src).toBe('');
  loadLayer(other);
  await flush();
  // One upcoming image only.
  expect(probes.filter((p) => p.src !== '' && p !== next).length).toBe(1);
});
