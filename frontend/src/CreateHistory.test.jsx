import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import React, { StrictMode } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import App from './App.jsx';
import { isExactRecord, rememberExact } from './exactRecords.js';
import { STRIP_DOM_LIMIT } from './Create.jsx';
import {
  createLibraryWindow,
  beginLibraryWindowRequest,
  resolveLibraryWindowRequest,
} from './libraryWindow.js';
import {
  fakeLibrary,
  FakeEventSource,
  installApi,
  respond,
  sizedRecord,
} from './testSupport.js';

const GENERATE = 'POST /api/generate-image';
const LEGACY_LIST = 'GET /api/images/library';
const PAGE = 'GET /api/images/library/page';
const record = (id) => `GET /api/images/library/record/${id}`;
const jobPolicy = { pollIntervalMs: 1, maxConsecutivePollFailures: 3 };

const beam = {
  id: 'beam',
  kind: 'single-select',
  origin: 'generated',
  label: 'Beam color',
  options: { amber: 'Amber', teal: 'Teal' },
  value: 'teal',
  future_field: { keep: false, zero: 0 },
};
const fog = {
  id: 'fog',
  kind: 'slider',
  origin: 'generated',
  label: 'Fog depth',
  min: 0,
  max: 10,
  step: 1,
  value: 0,
};
const gulls = {
  id: 'gulls',
  kind: 'future-kind',
  origin: 'generated',
  label: 'Gulls',
  value: false,
};
const fruit = {
  id: 'fruit',
  kind: 'multi-select',
  origin: 'generated',
  label: 'Fruit type',
  options: { pear: 'Pear', plum: 'Plum' },
  value: ['plum'],
};
const alpha = () =>
  sizedRecord('alpha', 1152, 768, {
    title: 'Alpha',
    original_prompt: 'Alpha lighthouse at dawn',
    prompt: 'composed alpha prompt',
    selected_controls: [beam, fog, gulls],
    resolved_controls: [{ ...beam, value: 'RESOLVED' }],
    dynamic_controls_metadata: { owner: 'alpha', count: 0, enabled: false },
    must_have_terms: ['alpha term'],
    unknown_top: { flag: false, n: 0 },
  });
const beta = () =>
  sizedRecord('beta', 768, 1152, {
    title: 'Beta',
    original_prompt: 'Beta orchard in autumn',
    prompt: 'composed beta prompt',
    selected_controls: [fruit],
    dynamic_controls_metadata: { owner: 'beta' },
    must_have_terms: [],
  });

let library;
let api;

const open = (url, list, extra = {}, Wrapper = React.Fragment) => {
  window.history.replaceState(null, '', url);
  library = fakeLibrary(list);
  api = installApi({ ...library.routes, ...extra });
  return render(
    <Wrapper>
      <App jobPolicy={jobPolicy} />
    </Wrapper>,
  );
};
const prompt = () => screen.getByLabelText('Image idea');
const stripRegion = () => screen.findByRole('region', { name: 'Saved images' });
const thumbNamed = async (name) =>
  within(await stripRegion()).findByRole('button', { name });
const legacyReads = () => api.called(LEGACY_LIST);
const pageReads = () => api.calls.filter((c) => c.key.startsWith(PAGE));
/** A control's label inside the left pane only; the stage also lists them. */
const inPane = (label) =>
  within(document.querySelector('.options-card')).queryByText(label);
const gate = () => {
  let open_;
  const promise = new Promise((resolve) => {
    open_ = resolve;
  });
  return { promise, open: open_ };
};
const expectPane = async (image) => {
  await waitFor(() => expect(prompt().value).toBe(image.original_prompt));
};

beforeEach(() => {
  localStorage.clear();
  FakeEventSource.reset();
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal('scrollTo', () => {});
  // Regenerate scrolls the stage into view; jsdom has no such method.
  Element.prototype.scrollIntoView = () => {};
});
afterEach(() => {
  cleanup();
  delete Element.prototype.scrollIntoView;
  vi.unstubAllGlobals();
});

test('clicking saved thumbnails restores each one whole, from its exact record', async () => {
  const dynamic = vi.fn(() => respond(500, { detail: 'not asked' }));
  open('/', [beta(), alpha()], { 'POST /api/controls/dynamic': dynamic });
  fireEvent.click(await thumbNamed('Alpha'));
  await expectPane(alpha());
  // The original prompt, never the composed one; originals, never resolved.
  expect(inPane('Beam color')).toBeTruthy();
  expect(inPane('Fog depth')).toBeTruthy();
  expect(inPane('Fruit type')).toBeNull();
  expect(screen.getByRole('radio', { name: '3:2' }).checked).toBe(true);
  expect((await thumbNamed('Alpha')).getAttribute('aria-current')).toBe('true');

  fireEvent.click(await thumbNamed('Beta'));
  await expectPane(beta());
  expect(inPane('Fruit type')).toBeTruthy();
  expect(inPane('Beam color')).toBeNull();
  expect(screen.getByRole('radio', { name: '2:3' }).checked).toBe(true);

  // Bounded reads only, and restoring asks no model for anything.
  expect(legacyReads()).toHaveLength(0);
  expect(api.called(record('alpha'))).toHaveLength(1);
  expect(dynamic).not.toHaveBeenCalled();
  expect(api.called(GENERATE)).toHaveLength(0);
});

test('a restored draft submits the saved originals with false, 0 and unknown fields', async () => {
  const accepted = gate();
  open('/', [alpha()], {
    [GENERATE]: async () => {
      await accepted.promise;
      return respond(500, { detail: 'stop here' });
    },
    'POST /api/controls/dynamic': () => respond(500, { detail: 'no model' }),
  });
  fireEvent.click(await thumbNamed('Alpha'));
  await expectPane(alpha());
  fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
  await waitFor(() => expect(api.called(GENERATE)).toHaveLength(1));
  const [{ body }] = api.called(GENERATE);
  expect(body.prompt).toBe('Alpha lighthouse at dawn');
  expect(body.controls).toEqual(expect.arrayContaining([beam, fog, gulls]));
  expect(body.dynamic_controls_metadata).toEqual({
    owner: 'alpha',
    count: 0,
    enabled: false,
  });
  expect(body.must_have_terms).toEqual(['alpha term']);
  accepted.open();
  await screen.findAllByText(/stop here/);
});

test('the newest of several quick picks wins, whatever order the answers arrive in', async () => {
  const third = sizedRecord('third', 1152, 768, {
    title: 'Third',
    original_prompt: 'Third prompt',
    selected_controls: [],
  });
  const slowAlpha = gate();
  const slowThird = gate();
  open('/', [beta(), alpha(), third], {
    [record('alpha')]: async () => {
      await slowAlpha.promise;
      return alpha();
    },
    [record('third')]: async () => {
      await slowThird.promise;
      return third;
    },
  });
  fireEvent.click(await thumbNamed('Beta'));
  await expectPane(beta());
  fireEvent.click(await thumbNamed('Alpha'));
  fireEvent.click(await thumbNamed('Third'));
  // Nothing changes until an exact record is there: no half-restored draft.
  expect(prompt().value).toBe(beta().original_prompt);
  expect(inPane('Fruit type')).toBeTruthy();
  await act(async () => slowThird.open());
  await expectPane(third);
  await act(async () => slowAlpha.open());
  await act(async () => {});
  expect(prompt().value).toBe('Third prompt');
  expect(inPane('Beam color')).toBeNull();
});

test('an edit made while a pick loads is kept and the stage does not move', async () => {
  const slow = gate();
  open('/', [beta(), alpha()], {
    [record('alpha')]: async () => {
      await slow.promise;
      return alpha();
    },
  });
  fireEvent.click(await thumbNamed('Beta'));
  await expectPane(beta());
  const thumb = await thumbNamed('Alpha');
  fireEvent.click(thumb);
  await waitFor(() => expect(thumb.getAttribute('aria-busy')).toBe('true'));
  fireEvent.change(prompt(), { target: { value: 'Beta orchard in autumn!' } });
  await act(async () => slow.open());
  await screen.findByText(/draft changed before that image/);
  expect(prompt().value).toBe('Beta orchard in autumn!');
  expect(screen.getByRole('heading', { name: 'Beta' })).toBeTruthy();
  expect(thumb.getAttribute('aria-current')).toBe('false');
});

test('a failed read restores nothing and retry applies the exact record', async () => {
  let fail = true;
  open('/', [beta(), alpha()], {
    [record('alpha')]: () =>
      fail ? respond(500, { detail: 'storage' }) : alpha(),
  });
  fireEvent.click(await thumbNamed('Beta'));
  await expectPane(beta());
  fireEvent.click(await thumbNamed('Alpha'));
  await screen.findByText("This image's settings could not be loaded.");
  expect(prompt().value).toBe(beta().original_prompt);
  fail = false;
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await expectPane(alpha());
});

test('an answer that is still only a summary is refused, never restored', async () => {
  open('/', [beta(), alpha()], {
    [record('alpha')]: () => ({
      id: 'alpha',
      image_id: 'alpha',
      storage_id: alpha().storage_id,
      filename: alpha().filename,
      title: 'Alpha',
      display_prompt: 'Alpha lighthouse at dawn',
    }),
  });
  fireEvent.click(await thumbNamed('Beta'));
  await expectPane(beta());
  fireEvent.click(await thumbNamed('Alpha'));
  await screen.findByText("This image's settings could not be loaded.");
  expect(prompt().value).toBe(beta().original_prompt);
  expect(inPane('Fruit type')).toBeTruthy();
});

test('opening Library first keeps Create blank until an image is selected', async () => {
  open('/print', [beta(), alpha()]);
  await screen.findByText('Beta');
  fireEvent.click(screen.getByRole('link', { name: 'Create' }));
  expect(prompt().value).toBe('');
  fireEvent.click(await thumbNamed('Beta'));
  await expectPane(beta());
  expect(screen.getByRole('heading', { name: 'Beta' })).toBeTruthy();
  expect(inPane('Fruit type')).toBeTruthy();
  fireEvent.click(await thumbNamed('Alpha'));
  await expectPane(alpha());
  fireEvent.click(screen.getByRole('link', { name: 'Library' }));
  await screen.findByText('Beta');
  fireEvent.click(screen.getByRole('link', { name: 'Create' }));
  // Returning keeps the draft and its image; nothing is restored over it.
  await thumbNamed('Beta');
  expect(prompt().value).toBe(alpha().original_prompt);
  expect(screen.getByRole('heading', { name: 'Alpha' })).toBeTruthy();
  expect(legacyReads()).toHaveLength(0);
});

test('a fresh stage does not request an exact record until the user selects one', async () => {
  open('/', [beta(), alpha()]);
  await thumbNamed('Beta');
  expect(prompt().value).toBe('');
  expect(document.querySelector('.stage-img')).toBeNull();
  expect(api.called(record('beta'))).toHaveLength(0);
});

test('an empty catalog and a failed read do not claim an image is loading', async () => {
  open('/', []);
  await waitFor(() => expect(pageReads().length).toBeGreaterThan(0));
  await waitFor(() => expect(screen.queryByText('Loading image…')).toBeNull());
  expect(screen.getByText('No image yet')).toBeTruthy();
  cleanup();
  window.history.replaceState(null, '', '/');
  api = installApi({
    match: (key) =>
      key.startsWith(PAGE) ? () => respond(500, { detail: 'storage' }) : null,
  });
  render(<App jobPolicy={jobPolicy} />);
  await waitFor(() => expect(pageReads().length).toBeGreaterThan(0));
  await waitFor(() => expect(screen.queryByText('Loading image…')).toBeNull());
  expect(screen.getByText('No image yet')).toBeTruthy();
  expect(legacyReads()).toHaveLength(0);
});

test('a failed history read shows its error and Retry makes the record selectable', async () => {
  let fail = true;
  open('/', [beta(), alpha()], {
    match: (key) =>
      key.startsWith(PAGE) && fail
        ? () => respond(503, { detail: 'Saved image storage is unavailable' })
        : library.routes.match?.(key),
  });
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('Saved image storage is unavailable');
  expect(prompt().value).toBe('');
  fail = false;
  fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
  fireEvent.click(await thumbNamed('Beta'));
  await expectPane(beta());
  expect(inPane('Fruit type')).toBeTruthy();
  expect(legacyReads()).toHaveLength(0);
});

test.each(['n250', 'local-0/n250.png'])(
  'off-window link %s reads one exact record and opens around it',
  async (target) => {
    const many = Array.from({ length: 300 }, (_, i) =>
      sizedRecord(`n${i}`, 1152, 768, {
        title: `N${i}`,
        original_prompt: `Prompt ${i}`,
        selected_controls: [],
      }),
    );
    open(`/?edit=${encodeURIComponent(target)}`, many, {}, StrictMode);
    await waitFor(() => expect(prompt().value).toBe('Prompt 250'));
    const thumb = await thumbNamed('N250');
    await waitFor(() =>
      expect(thumb.getAttribute('aria-current')).toBe('true'),
    );
    expect(legacyReads()).toHaveLength(0);
    expect(api.calls.some((c) => c.key.includes('around=n250'))).toBe(true);
    expect(api.calls.some((c) => c.key.includes('cursor='))).toBe(false);
    expect(document.querySelectorAll('.carousel .thumb').length).toBeLessThan(
      STRIP_DOM_LIMIT,
    );
  },
);

test('an unknown link reports it missing with no scan, then history opens normally', async () => {
  open('/?edit=ghost', [beta(), alpha()]);
  await screen.findByText(/not in the library/);
  await thumbNamed('Beta');
  expect(prompt().value).toBe('');
  expect(pageReads().every((c) => !c.key.includes('cursor='))).toBe(true);
  expect(legacyReads()).toHaveLength(0);
});

test('history stays bounded while scrolling a 100k catalog and keeps the stage pinned', async () => {
  const TOTAL = 100_000;
  const row = (i) => ({
    id: `c${i}`,
    image_id: `c${i}`,
    storage_id: 'local-0',
    filename: `c${i}.png`,
    title: `C${i}`,
    created_at: TOTAL - i,
    dimensions: { width: 1152, height: 768 },
    image_url: `/api/images/c${i}/content`,
    thumbnail_url: `/api/images/library/file/local-0/c${i}.png?variant=thumbnail`,
    detail_url: `/api/images/library/record/c${i}`,
    display_prompt: `Prompt ${i}`,
  });
  const exact = (i) => ({
    ...row(i),
    original_prompt: `Prompt ${i}`,
    prompt: `Prompt ${i}`,
    selected_controls: [],
  });
  const pageAt = (from, limit) => ({
    listing_kind: 'summary-page',
    images: Array.from({ length: Math.min(limit, TOTAL - from) }, (_, n) =>
      row(from + n),
    ),
    count: Math.min(limit, TOTAL - from),
    total: TOTAL,
    orientation_counts: { landscape: TOTAL },
    next_cursor: from + limit < TOTAL ? `at:${from + limit}` : null,
    previous_cursor: from > 0 ? `at:${Math.max(0, from - limit)}` : null,
    position: from,
    anchor_index: null,
    revision: 1,
    order: 'newest',
  });
  window.history.replaceState(null, '', '/');
  api = installApi({
    match: (key) => {
      if (key.startsWith(PAGE)) {
        const query = new URLSearchParams(key.split('?')[1]);
        const cursor = query.get('cursor');
        return () =>
          pageAt(
            cursor ? Number(cursor.slice(3)) : 0,
            Number(query.get('limit')),
          );
      }
      const id = /library\/record\/c(\d+)$/.exec(key)?.[1];
      if (id) return () => exact(Number(id));
      if (key.includes('/library/file/') || key.includes('/events'))
        return () => respond(404, { detail: 'none' });
      return null;
    },
  });
  render(<App jobPolicy={jobPolicy} />);
  fireEvent.click(await screen.findByRole('button', { name: 'C0' }));
  await waitFor(() => expect(prompt().value).toBe('Prompt 0'));
  const list = (await stripRegion()).firstElementChild;
  // A real strip's geometry: 100px items laid out in a row.
  let left = 0;
  const liProto = HTMLLIElement.prototype;
  Object.defineProperty(liProto, 'offsetLeft', {
    configurable: true,
    get() {
      return [...this.parentElement.children].indexOf(this) * 100;
    },
  });
  Object.defineProperty(liProto, 'offsetWidth', {
    configurable: true,
    get: () => 100,
  });
  Object.defineProperty(list, 'clientWidth', { get: () => 800 });
  Object.defineProperty(list, 'scrollWidth', {
    get: () => list.children.length * 100,
  });
  Object.defineProperty(list, 'scrollLeft', {
    get: () => left,
    set: (value) => {
      left = value;
    },
  });
  const scrollToEnd = async () => {
    const reads = pageReads().length;
    left = list.scrollWidth - 800;
    fireEvent.scroll(list);
    await waitFor(() => expect(pageReads().length).toBe(reads + 1));
    await act(async () => {});
  };
  for (let n = 0; n < 4; n += 1) await scrollToEnd();
  expect(api.called(LEGACY_LIST)).toHaveLength(0);
  expect(
    document.querySelectorAll('.carousel .thumb').length,
  ).toBeLessThanOrEqual(STRIP_DOM_LIMIT);
  // The first page left the window; the stage and draft are still that image.
  expect(within(list).queryByRole('button', { name: 'C0' })).toBeNull();
  expect(screen.getByRole('heading', { name: 'C0' })).toBeTruthy();
  expect(prompt().value).toBe('Prompt 0');
  const deep = pageReads().length;
  fireEvent.keyDown(list, { key: 'Home' });
  await waitFor(() =>
    expect(within(list).getByRole('button', { name: 'C0' })).toBeTruthy(),
  );
  expect(pageReads().length).toBe(deep + 1);
  delete liProto.offsetLeft;
  delete liProto.offsetWidth;
});

test('a just-saved record and a stored summary with the same identity are one item', () => {
  const summary = {
    id: 'a',
    storage_id: 's',
    filename: 'a.png',
    display_prompt: 'x',
  };
  expect(isExactRecord(summary)).toBe(false);
  expect(isExactRecord({ ...summary, prompt: 'x' })).toBe(false);
  expect(isExactRecord({ ...summary, selected_controls: [] })).toBe(false);
  expect(
    isExactRecord({ ...summary, prompt: 'x', selected_controls: null }),
  ).toBe(true);
  expect(isExactRecord({ client_pending: {} })).toBe(true);
});

test('the exact pool evicts oldest unused records and never a pinned one', () => {
  const item = (id) => ({ id, prompt: id, selected_controls: [] });
  let pool = new Map();
  const pinned = new Set(['a']);
  for (const id of ['a', 'b', 'c', 'd'])
    pool = rememberExact(pool, item(id), pinned, 2);
  expect([...pool.keys()]).toEqual(['a', 'd']);
});

test('a strip keeps adjacent pages when a page arrives under a new revision', () => {
  const page = (n, revision, next) => ({
    listing_kind: 'summary-page',
    images: [{ id: `p${n}` }],
    count: 1,
    total: 9,
    orientation_counts: {},
    revision,
    next_cursor: next,
    previous_cursor: null,
    position: null,
  });
  let state = createLibraryWindow({ limit: 1 });
  let run = beginLibraryWindowRequest(state, { direction: 'first' });
  state = resolveLibraryWindowRequest(
    run.state,
    run.ticket,
    page(0, 1, 'n1'),
  ).state;
  run = beginLibraryWindowRequest(state, {
    direction: 'forward',
    retain: true,
  });
  state = resolveLibraryWindowRequest(
    run.state,
    run.ticket,
    page(1, 2, 'n2'),
  ).state;
  expect(state.pages).toHaveLength(2);
  run = beginLibraryWindowRequest(state, { direction: 'forward' });
  const collapsed = resolveLibraryWindowRequest(
    run.state,
    run.ticket,
    page(2, 3, null),
  ).state;
  expect(collapsed.pages).toHaveLength(1);
});
