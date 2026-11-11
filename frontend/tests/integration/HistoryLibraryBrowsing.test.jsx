import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
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
  libraryRecord,
  respond,
  sizedRecord,
} from '../helpers/testSupport.js';

const { m1, m2 } = fixtures;
const LIST = 'GET /api/images/library';
const DELETE = 'DELETE /api/images/library';
const GENERATE = 'POST /api/generate-image';
const jobPolicy = { pollIntervalMs: 1, maxConsecutivePollFailures: 3 };

let library;
let api;

function setup(records, overrides = {}) {
  library = fakeLibrary(records);
  api = installApi({ ...library.routes, ...overrides });
}

function openRoute(path, records, overrides) {
  window.history.replaceState(null, '', path);
  setup(records, overrides);
  return render(<App jobPolicy={jobPolicy} />);
}

const nav = (name) => fireEvent.click(screen.getByRole('link', { name }));
const prompt = () => screen.getByLabelText('Image idea');

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  localStorage.clear();
  // These tests time the slideshow itself; effect timers are tested apart.
  localStorage.setItem('imagedials-gallery-effect', '"instant"');
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// --- History strip -------------------------------------------------------------

test('Create has no delete action; Library detail retains it', async () => {
  openRoute('/', [sizedRecord('a', 1152, 768)]);
  fireEvent.click(await screen.findByRole('button', { name: 'Image a' }));
  await screen.findByRole('heading', { name: 'Image a' });
  expect(
    screen.queryByRole('button', { name: /Delete|Remove from browser/ }),
  ).toBeNull();
  expect(api.called(DELETE)).toHaveLength(0);
  nav('Library');
  await screen.findByText('Image a');
  const dialog = await openDetail('Image a');
  expect(within(dialog).getByRole('button', { name: 'Delete' })).toBeTruthy();
  expect(api.called(DELETE)).toHaveLength(0);
});

test('choosing a saved history item restores its full draft', async () => {
  const portrait = libraryRecord({ id: 'portrait', title: 'Portrait image' });
  const asset = sizedRecord('asset', 1152, 768, {
    mode: 'asset-image',
    generation_mode: 'trellis',
    aspect: '3:2',
    original_prompt: 'A brass key',
    prompt: 'A brass key',
    selected_controls: [],
    dynamic_controls_metadata: null,
  });
  openRoute('/', [asset, portrait]);
  const strip = await screen.findByRole('region', { name: 'Saved images' });
  fireEvent.click(
    within(strip).getByRole('button', { name: 'Portrait image' }),
  );

  // Prompt, controls (false, zero and unknown kinds), size and provenance.
  await waitFor(() => expect(prompt().value).toBe(portrait.original_prompt));
  expect(screen.getByRole('radio', { name: '2:3' }).checked).toBe(true);
  expect(
    screen
      .getByRole('switch', { name: 'Etched pattern' })
      .getAttribute('aria-checked'),
  ).toBe('false');
  expect(screen.getByRole('slider', { name: 'Head angle' }).value).toBe('0');
  expect(screen.getByText('future-control')).toBeTruthy();
  expect(screen.getByRole('heading', { name: portrait.title })).toBeTruthy();
  fireEvent.keyDown(prompt(), { key: 'Enter' });
  await waitFor(() => expect(api.called(GENERATE)).toHaveLength(1));
  const body = api.called(GENERATE)[0].body;
  expect(body.controls).toEqual(portrait.selected_controls);
  expect(body.dynamic_controls_metadata).toEqual(
    portrait.dynamic_controls_metadata,
  );
  expect(body.generation_mode).toBe('standard');

  // A different record restores its own mode and nearest supported size.
  cleanup();
  openRoute('/', [asset, portrait]);
  const second = await screen.findByRole('region', { name: 'Saved images' });
  fireEvent.click(within(second).getByRole('button', { name: 'Image asset' }));
  await waitFor(() => expect(prompt().value).toBe('A brass key'));
  expect(screen.getByRole('radio', { name: '3:2' }).checked).toBe(true);
  expect(
    screen.getByRole('radio', { name: 'Asset image for 3D' }).checked,
  ).toBe(true);
});

test('the history strip never scrolls itself and keeps its position on selection', async () => {
  const scrollIntoView = vi.fn();
  Element.prototype.scrollIntoView = scrollIntoView;
  const records = Array.from({ length: 6 }, (_, i) =>
    sizedRecord(`r${i}`, 1152, 768),
  );
  openRoute('/', records);
  const strip = (await screen.findByRole('region', { name: 'Saved images' }))
    .firstElementChild;
  strip.scrollLeft = 120;
  fireEvent.click(within(strip).getByRole('button', { name: 'Image r3' }));
  await screen.findByRole('heading', { name: 'Image r3' });
  expect(strip.scrollLeft).toBe(120);
  expect(scrollIntoView).not.toHaveBeenCalled();
  delete Element.prototype.scrollIntoView;
});

test('a completed job does not move the history strip', async () => {
  const scrollIntoView = vi.fn();
  Element.prototype.scrollIntoView = scrollIntoView;
  const older = sizedRecord('older', 1152, 768);
  openRoute('/', [older], {
    'POST /api/controls/dynamic': () => m1.dynamic_response,
    [GENERATE]: () => respond(202, m1.accepted),
    'GET /api/generation-jobs/fixture-image-1': () => {
      const status = m1.job_complete;
      library.records = [
        {
          ...status.result,
          selected_controls: status.result.original_selected_controls,
        },
        ...library.records,
      ];
      return status;
    },
  });
  const strip = (await screen.findByRole('region', { name: 'Saved images' }))
    .firstElementChild;
  strip.scrollLeft = 40;
  fireEvent.click(within(strip).getByRole('button', { name: 'Image older' }));
  await waitFor(() => expect(prompt().value).toBe(older.original_prompt));
  fireEvent.change(prompt(), { target: { value: 'An amber glass bird' } });
  fireEvent.keyDown(prompt(), { key: 'Enter' });
  await screen.findByRole('heading', { name: m1.job_complete.result.title });
  expect(strip.scrollLeft).toBe(40);
  expect(scrollIntoView).not.toHaveBeenCalled();
  delete Element.prototype.scrollIntoView;
});

test('the history strip supports arrows, Home, End and paging from the keyboard', async () => {
  const records = Array.from({ length: 4 }, (_, i) =>
    sizedRecord(`r${i}`, 1152, 768),
  );
  openRoute('/', records);
  const section = await screen.findByRole('region', { name: 'Saved images' });
  const strip = section.firstElementChild;
  const thumb = (id) =>
    within(section).getByRole('button', { name: `Image ${id}` });
  thumb('r1').focus();
  fireEvent.keyDown(thumb('r1'), { key: 'ArrowRight' });
  expect(document.activeElement).toBe(thumb('r2'));
  fireEvent.keyDown(thumb('r2'), { key: 'ArrowLeft' });
  expect(document.activeElement).toBe(thumb('r1'));
  fireEvent.keyDown(thumb('r1'), { key: 'End' });
  expect(document.activeElement).toBe(thumb('r3'));
  fireEvent.keyDown(thumb('r3'), { key: 'ArrowRight' });
  expect(document.activeElement).toBe(thumb('r3'));
  fireEvent.keyDown(thumb('r3'), { key: 'Home' });
  expect(document.activeElement).toBe(thumb('r0'));
  strip.scrollBy = vi.fn();
  fireEvent.keyDown(thumb('r0'), { key: 'PageDown' });
  fireEvent.keyDown(thumb('r0'), { key: 'PageUp' });
  expect(strip.scrollBy).toHaveBeenCalledTimes(2);
  expect(strip.scrollBy.mock.calls[0][0].left).toBeGreaterThanOrEqual(0);
  expect(strip.scrollBy.mock.calls[1][0].left).toBeLessThanOrEqual(0);
});

// --- Library ---------------------------------------------------------------------

const imageRecords = (count) =>
  Array.from({ length: count }, (_, i) =>
    sizedRecord(`img${String(i).padStart(3, '0')}`, 1152, 768, {
      created_at: count - i,
    }),
  );
const cards = () => document.querySelectorAll('.cards .card');

test('the library lists newest first with canonical thumbnails and counts', async () => {
  openRoute('/print', [
    sizedRecord('newest', 1152, 768, { created_at: 2 }),
    sizedRecord('oldest', 768, 1152, { created_at: 1 }),
  ]);
  await screen.findByText('Image newest');
  expect(
    [...cards()].map((c) => c.querySelector('.card-title').textContent),
  ).toEqual(['Image newest', 'Image oldest']);
  expect(cards()[0].querySelector('img').getAttribute('src')).toBe(
    '/api/images/library/file/local-0/newest.png?variant=thumbnail&max_size=384',
  );
  expect(screen.getByText('2 images')).toBeTruthy();
});

test('search distinguishes an empty library from no matches and clears', async () => {
  openRoute('/print', [
    sizedRecord('a', 1152, 768),
    sizedRecord('b', 1152, 768),
  ]);
  await screen.findByText('Image a');
  fireEvent.change(screen.getByLabelText('Search'), {
    target: { value: 'zzz' },
  });
  expect(await screen.findByText(/No saved images match/)).toBeTruthy();
  expect(screen.queryByText('No saved images yet.')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Show all images' }));
  await screen.findByText('Image a');
  expect(cards()).toHaveLength(2);
  fireEvent.change(screen.getByLabelText('Search'), {
    target: { value: 'B.PNG' },
  });
  expect(await screen.findByText('1 image')).toBeTruthy();
  expect(cards()).toHaveLength(1);
  // Control values and identity are searchable.
  fireEvent.change(screen.getByLabelText('Search'), {
    target: { value: 'rounded edges' },
  });
  expect(await screen.findByText('2 images')).toBeTruthy();
  expect(cards()).toHaveLength(2);
  fireEvent.change(screen.getByLabelText('Search'), {
    target: { value: 'a.png' },
  });
  expect(await screen.findByText('1 image')).toBeTruthy();
  expect(cards()).toHaveLength(1);
});

test('an empty library says so instead of showing a search with no results', async () => {
  openRoute('/print', []);
  expect(await screen.findByText('No saved images yet.')).toBeTruthy();
  expect(screen.queryByLabelText('Search')).toBeNull();
});

test('page sizes are 24, 48 and 96 and the page clamps after the list shrinks', async () => {
  openRoute('/print', imageRecords(50));
  await screen.findByText('Image img000');
  const perPage = screen.getByLabelText('Per page');
  expect([...perPage.options].map((o) => Number(o.value))).toEqual([
    24, 48, 96,
  ]);
  expect(cards()).toHaveLength(24);
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  expect(await screen.findByText('25–48 of 50')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Last' }));
  await waitFor(() =>
    expect(api.calls.some((call) => call.key.includes('edge=last'))).toBe(true),
  );
  expect(await screen.findByText('27–50 of 50')).toBeTruthy();
  expect(cards()).toHaveLength(24);

  // Deleting the last page's images clamps to the new last page.
  for (const id of ['img048', 'img049']) {
    fireEvent.click(
      screen.getByRole('button', { name: new RegExp(`Image ${id}`) }),
    );
    await screen.findByRole('button', { name: 'Delete' });
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  }
  expect(await screen.findByText('25–48 of 48')).toBeTruthy();
  expect(cards()).toHaveLength(24);

  fireEvent.change(perPage, { target: { value: '96' } });
  await waitFor(() => expect(cards()).toHaveLength(48));
  expect(
    screen.getByRole('navigation', { name: 'Library pages' }),
  ).toBeTruthy();
});

test('density sets the grid columns and persists', async () => {
  openRoute('/print', imageRecords(3));
  await screen.findByText('Image img000');
  const slider = screen.getByRole('slider', { name: /Columns/ });
  expect(
    document.querySelector('.cards').style.getPropertyValue('--density'),
  ).toBe('6');
  fireEvent.change(slider, { target: { value: '0' } });
  expect(
    document.querySelector('.cards').style.getPropertyValue('--density'),
  ).toBe('3');
  expect(slider.getAttribute('aria-valuetext')).toBe('3 columns');
  expect(localStorage.getItem('imagedials-library-density')).toBe('3');
  cleanup();
  openRoute('/print', imageRecords(3));
  await screen.findByText('Image img000');
  expect(
    document.querySelector('.cards').style.getPropertyValue('--density'),
  ).toBe('3');
});

async function openDetail(title) {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(title) }));
  await screen.findByRole('button', { name: 'Edit in generator' });
  return screen.getByRole('dialog', { name: title });
}

test('the detail shows prompts, selections, provenance and the original download', async () => {
  const record = libraryRecord({ id: 'detail', title: 'Detail image' });
  openRoute('/print', [record]);
  await screen.findByText('Detail image');
  const dialog = await openDetail('Detail image');
  expect(within(dialog).getByText(record.original_prompt)).toBeTruthy();
  expect(
    within(dialog).getAllByText('Rounded edges', { exact: false }).length,
  ).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Final prompt' }));
  expect(within(dialog).getByText(record.final_prompt)).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Details' }));
  expect(within(dialog).getByText(record.sha256)).toBeTruthy();
  expect(
    within(dialog).getByRole('button', { name: 'Download original' }),
  ).toBeTruthy();
  expect(within(dialog).getByRole('img').getAttribute('src')).toBe(
    '/api/images/library/file/local-0/detail.png',
  );
  // Share and email stay absent; print and watermark actions are real (M4).
  expect(
    within(dialog).queryByRole('button', { name: /share|email/i }),
  ).toBeNull();
  expect(
    within(dialog).getByRole('button', { name: 'Download watermarked' }),
  ).toBeTruthy();
});

test('loading exact detail keeps one modal shell focused until full actions arrive', async () => {
  openRoute('/print', [libraryRecord({ id: 'focus', title: 'Focus image' })]);
  await screen.findByText('Focus image');
  fireEvent.click(screen.getByRole('button', { name: /Focus image/ }));
  const loadingDialog = screen.getByRole('dialog', { name: 'Focus image' });
  await screen.findByRole('button', { name: 'Edit in generator' });
  const readyDialog = screen.getByRole('dialog', { name: 'Focus image' });
  expect(readyDialog).toBe(loadingDialog);
  expect(readyDialog.contains(document.activeElement)).toBe(true);
});

test('original download is hidden when the server turns it off', async () => {
  const exports = { ...m1.capabilities.exports, download_enabled: false };
  openRoute('/print', [libraryRecord()], {
    'GET /api/app-capabilities': () => ({ ...m1.capabilities, exports }),
  });
  await screen.findByText(libraryRecord().title);
  await waitFor(() =>
    expect(api.called('GET /api/app-capabilities')).toHaveLength(1),
  );
  const dialog = await openDetail(libraryRecord().title);
  await waitFor(() =>
    expect(
      within(dialog).queryByRole('button', { name: 'Download original' }),
    ).toBeNull(),
  );
});

test('editing from the detail restores the record in the generator', async () => {
  const record = libraryRecord({ id: 'edit', title: 'Edit me' });
  openRoute('/print', [record]);
  await screen.findByText('Edit me');
  const dialog = await openDetail('Edit me');
  fireEvent.click(
    within(dialog).getByRole('button', { name: 'Edit in generator' }),
  );
  expect(window.location.pathname).toBe('/');
  await waitFor(() => expect(prompt().value).toBe(record.original_prompt));
  expect(screen.getByRole('radio', { name: '2:3' }).checked).toBe(true);
  expect(screen.getByText('future-control')).toBeTruthy();
});

test('delete is named, cancellable and keeps the image when it fails', async () => {
  const a = sizedRecord('a', 1152, 768);
  const b = sizedRecord('b', 1152, 768);
  let reject = true;
  openRoute('/print', [a, b], {
    [DELETE]: (body, n, init) =>
      reject
        ? respond(502, m2.errors.storage)
        : library.routes[DELETE](body, n, init),
  });
  await screen.findByText('Image a');
  const dialog = await openDetail('Image a');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
  const confirm = within(dialog).getByRole('group', { name: 'Delete Image a' });
  expect(confirm.textContent).toContain('Image a');
  expect(confirm.textContent).toContain('This cannot be undone');
  expect(document.activeElement).toBe(
    within(confirm).getByRole('button', { name: 'Cancel' }),
  );
  // Cancel changes nothing and sends nothing.
  fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
  expect(api.called(DELETE)).toHaveLength(0);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
  fireEvent.click(
    within(
      within(dialog).getByRole('group', { name: 'Delete Image a' }),
    ).getByRole('button', { name: 'Delete' }),
  );
  // A storage failure keeps the dialog, the image and the reason.
  expect(
    await within(dialog).findByText(m2.errors.storage.detail),
  ).toBeTruthy();
  expect(screen.getByRole('dialog')).toBeTruthy();
  expect(library.records.map((r) => r.id)).toEqual(['a', 'b']);
  expect(cards()).toHaveLength(2);

  reject = false;
  fireEvent.click(
    within(
      within(dialog).getByRole('group', { name: 'Delete Image a' }),
    ).getByRole('button', { name: 'Delete' }),
  );
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(api.called(DELETE).at(-1).body).toEqual({
    storage_id: 'local-0',
    filename: 'a.png',
  });
  // Only that identity is gone.
  expect(
    [...cards()].map((c) => c.querySelector('.card-title').textContent),
  ).toEqual(['Image b']);
  expect(library.records.map((r) => r.id)).toEqual(['b']);
});

test('closing the detail keeps the search, page and density', async () => {
  openRoute('/print', imageRecords(30));
  await screen.findByText('Image img000');
  fireEvent.change(screen.getByLabelText('Search'), {
    target: { value: 'img0' },
  });
  expect(await screen.findByText('30 images')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Last' }));
  expect(await screen.findByText('7–30 of 30')).toBeTruthy();
  fireEvent.change(screen.getByRole('slider', { name: /Columns/ }), {
    target: { value: '3' },
  });
  const opener = cards()[0];
  fireEvent.click(opener);
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(screen.getByLabelText('Search').value).toBe('img0');
  expect(screen.getByText('7–30 of 30')).toBeTruthy();
  expect(
    document.querySelector('.cards').style.getPropertyValue('--density'),
  ).toBe('8');
  await waitFor(() => expect(document.activeElement).toBe(opener));
});

test('revisiting a route sends the ETag and a 304 keeps the images shown', async () => {
  openRoute('/print', [sizedRecord('a', 1152, 768)]);
  await screen.findByText('Image a');
  nav('Gallery');
  await screen.findByRole('region', { name: 'Gallery controls' });
  nav('Library');
  await screen.findByText('Image a');
  const reads = api.calls.filter((call) =>
    call.key.startsWith('GET /api/images/library/page?'),
  );
  expect(reads.length).toBeGreaterThan(1);
  expect(reads.at(-1).headers['If-None-Match']).toMatch(/^"/);
  expect(screen.getAllByAltText('Image a').length).toBeGreaterThan(0);
});

test('a failed refresh keeps the shown images and offers a retry', async () => {
  let failing = false;
  openRoute('/print', [sizedRecord('a', 1152, 768)]);
  await screen.findByText('Image a');
  failing = true;
  const match = api.routes.match;
  api.routes.match = (key) =>
    key.startsWith('GET /api/images/library/page?') && failing
      ? () => respond(502, m2.errors.storage)
      : match?.(key);
  nav('Gallery');
  await screen.findByRole('region', { name: 'Gallery controls' });
  nav('Library');
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain(m2.errors.storage.detail);
  expect(screen.getAllByAltText('Image a').length).toBeGreaterThan(0);
  failing = false;
  fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
});

// --- Gallery -----------------------------------------------------------------------

const mixed = () => [
  sizedRecord('l1', 1152, 768),
  sizedRecord('p1', 768, 1152),
  sizedRecord('l2', 1152, 768),
  sizedRecord('s1', 1024, 1024),
  libraryRecord({
    id: 'u1',
    title: 'Image u1',
    width: null,
    height: null,
    dimensions: null,
  }),
];
const featured = () => document.querySelector('.gallery-img');
// The gallery shuffles with a seed drawn at mount; fixing it makes the play
// order the same on every run: every eligible image participates in the shuffle.
const SEED = 11;
const fixSeed = () =>
  vi.spyOn(Math, 'random').mockReturnValue(SEED / 0x100000000);
const cycle = (ids = ['l1', 'p1', 'l2', 's1', 'u1']) =>
  seededOrder(
    ids.map((id) => `local-0/${id}.png`),
    SEED,
  ).map((key) => `Image ${key.replace('local-0/', '').replace('.png', '')}`);
/** The featured picture has loaded: the interval may start. */
const loaded = () => act(() => void fireEvent.load(featured()));
const filmstrip = () => screen.getByRole('list', { name: 'Images' });
/** The selected image: the filmstrip's current thumbnail, else the details. */
const shownTitle = () =>
  document.querySelector('.strip [aria-current="true"]')?.ariaLabel ??
  within(
    screen.getByRole('complementary', { name: 'Image details' }),
  ).getByRole('heading').textContent;
/** Let session reads settle without moving a (possibly fake) clock. */
const flush = () =>
  act(async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  });
const FACETS = 'GET /api/images/library/event-facets';
/** The shared Gallery reads sessions, counts and details, never the full list. */
const noCompleteList = () => expect(api.called(LIST)).toEqual([]);

test('orientation filters show counts; a record with no size is counted as unknown', async () => {
  localStorage.setItem('imagedials-gallery-playing', 'false');
  openRoute('/gallery', mixed());
  const panel = await screen.findByRole('region', { name: 'Gallery controls' });
  const row = (name) =>
    within(panel)
      .getByRole('checkbox', { name: new RegExp(`^${name}`) })
      .closest('label');
  expect(row('Landscape').textContent).toContain('2');
  expect(row('Portrait').textContent).toContain('1');
  expect(row('Square').textContent).toContain('1');
  expect(row('Unknown size').textContent).toContain('1');
  // The all-filter still shows the image whose size is unknown.
  expect(within(panel).getByText('5 visible')).toBeTruthy();
  fireEvent.click(within(panel).getByRole('checkbox', { name: /^Landscape/ }));
  expect(within(panel).getByText('3 visible')).toBeTruthy();
  expect(within(panel).getByText('5 total')).toBeTruthy();
  await waitFor(() =>
    expect(within(filmstrip()).getAllByRole('button')).toHaveLength(3),
  );
  expect(library.created.at(-1).body.orientations).toEqual([
    'portrait',
    'square',
    'unknown',
  ]);
  noCompleteList();
});

// The shared library is filtered by the server, which classifies stored sizes:
// a size measured in this browser cannot move an image between the server's
// filters, so its counts and the session membership stay in agreement.
test('the server classifies an unsized shared image; a measured size does not change the counts', async () => {
  localStorage.setItem('imagedials-gallery-playing', 'false');
  vi.stubGlobal(
    'Image',
    class {
      naturalWidth = 600;
      naturalHeight = 1000;
      set src(url) {
        this.url = url;
        queueMicrotask(() => this.onload?.());
      }
    },
  );
  openRoute('/gallery', mixed());
  const panel = await screen.findByRole('region', { name: 'Gallery controls' });
  await flush();
  const count = (name) =>
    within(panel)
      .getByRole('checkbox', { name: new RegExp(`^${name}`) })
      .closest('label')
      .querySelector('.check-count').textContent;
  expect(count('Portrait')).toBe('1');
  expect(count('Unknown size')).toBe('1');
  expect(within(panel).getByText('5 visible')).toBeTruthy();
  noCompleteList();
});

test('zero matches is distinct from an empty library and keeps the controls', async () => {
  localStorage.setItem('imagedials-gallery-playing', 'false');
  openRoute('/gallery', mixed());
  const panel = await screen.findByRole('region', { name: 'Gallery controls' });
  for (const name of ['Portrait', 'Landscape', 'Square', 'Unknown size'])
    fireEvent.click(
      within(panel).getByRole('checkbox', { name: new RegExp(`^${name}`) }),
    );
  expect(
    screen.getByText('No images match the selected filters.'),
  ).toBeTruthy();
  expect(screen.queryByText('No saved images yet.')).toBeNull();
  expect(within(panel).getByText('0 visible')).toBeTruthy();
  expect(
    within(panel).getByRole('button', { name: 'Next image' }).disabled,
  ).toBe(true);
  fireEvent.click(within(panel).getByRole('checkbox', { name: /^Square/ }));
  await waitFor(() => expect(shownTitle()).toBe('Image s1'));
  noCompleteList();
});

test('an empty library shows the empty state, not the controls', async () => {
  openRoute('/gallery', []);
  expect(await screen.findByText('No saved images yet.')).toBeTruthy();
  expect(screen.queryByRole('region', { name: 'Gallery controls' })).toBeNull();
});

test('previous and next follow the play order, wrap, and keep the filmstrip selection in step', async () => {
  fixSeed();
  localStorage.setItem('imagedials-gallery-playing', 'false');
  openRoute('/gallery', mixed());
  await screen.findByRole('region', { name: 'Gallery controls' });
  const order = cycle();
  expect(shownTitle()).toBe(cycle()[0]);
  // An explicit thumbnail choice moves the cursor; arrows continue from it.
  fireEvent.click(within(filmstrip()).getByRole('button', { name: order[1] }));
  expect(shownTitle()).toBe(order[1]);
  expect(
    within(filmstrip())
      .getByRole('button', { name: order[1] })
      .getAttribute('aria-current'),
  ).toBe('true');
  expect(featured().getAttribute('src')).toContain(
    `/${order[1].replace('Image ', '')}.png`,
  );
  fireEvent.keyDown(document.body, { key: 'ArrowRight' });
  expect(shownTitle()).toBe(order[2]);
  fireEvent.keyDown(document.body, { key: 'ArrowLeft' });
  expect(shownTitle()).toBe(order[1]);

  // Back past the start wraps without reseeding; forward past the end starts a
  // new cycle that does not reopen on the image that ended the old one.
  fireEvent.click(within(filmstrip()).getByRole('button', { name: order[0] }));
  const sessions = library.created.length;
  fireEvent.click(screen.getByRole('button', { name: 'Previous image' }));
  expect(shownTitle()).toBe(order[4]);
  expect(library.created).toHaveLength(sessions);
  fireEvent.click(screen.getByRole('button', { name: 'Next image' }));
  await waitFor(() => expect(library.created).toHaveLength(sessions + 1));
  await waitFor(() => expect(shownTitle()).not.toBe(order[4]));
  // The new cycle is a fresh unanchored shuffle; the old session is released.
  expect(library.created.at(-1).body).not.toHaveProperty('first_image_id');
  expect(library.released).toContain(library.created.at(-2).id);
  noCompleteList();
});

/**
 * Fake timers start after the first load: Testing Library's async helpers wait
 * on real timers. Playback is off until the test presses Play.
 */
async function openPausedGallery() {
  fixSeed();
  localStorage.setItem('imagedials-gallery-playing', 'false');
  openRoute('/gallery', mixed());
  await screen.findByRole('region', { name: 'Gallery controls' });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
}
const press = (name) => fireEvent.click(screen.getByRole('button', { name }));

test('playback advances on the named speed, pauses, and clears its timer on leaving', async () => {
  await openPausedGallery();
  expect(shownTitle()).toBe(cycle()[0]);
  expect(vi.getTimerCount()).toBe(0);
  press('Play slideshow');
  expect(
    screen
      .getByRole('button', { name: 'Pause slideshow' })
      .getAttribute('aria-pressed'),
  ).toBe('true');

  // Nothing is timed until the featured picture has loaded.
  const order = cycle();
  expect(vi.getTimerCount()).toBe(0);
  loaded();
  // The default speed is five seconds.
  act(() => vi.advanceTimersByTime(4999));
  expect(shownTitle()).toBe(cycle()[0]);
  act(() => vi.advanceTimersByTime(1));
  expect(shownTitle()).toBe(order[1]);

  // A faster named step restarts the running interval.
  loaded();
  const speed = screen.getByRole('slider', { name: 'Speed' });
  fireEvent.change(speed, { target: { value: '0' } });
  expect(speed.getAttribute('aria-valuetext')).toBe('2 seconds per image');
  act(() => vi.advanceTimersByTime(2000));
  expect(shownTitle()).toBe(order[2]);
  expect(localStorage.getItem('imagedials-gallery-speed-seconds')).toBe('2');

  // Pausing clears the timer and stays paused.
  press('Pause slideshow');
  expect(vi.getTimerCount()).toBe(0);
  act(() => vi.advanceTimersByTime(60000));
  expect(shownTitle()).toBe(order[2]);
  expect(localStorage.getItem('imagedials-gallery-playing')).toBe('false');

  // Playing again, then leaving the route, leaves no timer behind.
  loaded();
  press('Play slideshow');
  expect(vi.getTimerCount()).toBe(1);
  nav('Create');
  expect(screen.queryByRole('region', { name: 'Gallery controls' })).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});

test('manual navigation restarts the interval and one eligible image cannot play', async () => {
  await openPausedGallery();
  const order = cycle();
  press('Play slideshow');
  loaded();
  act(() => vi.advanceTimersByTime(4000));
  press('Next image');
  expect(shownTitle()).toBe(order[1]);
  // The new image is timed from its own load, not from the click.
  act(() => vi.advanceTimersByTime(60000));
  expect(shownTitle()).toBe(order[1]);
  loaded();
  act(() => vi.advanceTimersByTime(4999));
  expect(shownTitle()).toBe(order[1]);
  act(() => vi.advanceTimersByTime(1));
  expect(shownTitle()).toBe(order[2]);

  const panel = screen.getByRole('region', { name: 'Gallery controls' });
  for (const name of [/^Portrait/, /^Landscape/, /^Unknown size/])
    fireEvent.click(within(panel).getByRole('checkbox', { name }));
  expect(within(panel).getByText('1 visible')).toBeTruthy();
  await flush();
  expect(shownTitle()).toBe('Image s1');
  expect(vi.getTimerCount()).toBe(0);
  expect(
    within(panel).getByRole('button', { name: 'Play slideshow' }).disabled,
  ).toBe(true);
});

test('controls and carousel can be hidden and restored from the keyboard', async () => {
  localStorage.setItem('imagedials-gallery-playing', 'false');
  openRoute('/gallery', mixed());
  await screen.findByRole('region', { name: 'Gallery controls' });
  fireEvent.keyDown(document.body, { key: 'c' });
  expect(screen.queryByRole('list', { name: 'Images' })).toBeNull();
  expect(localStorage.getItem('imagedials-gallery-filmstrip')).toBe('false');
  fireEvent.keyDown(document.body, { key: 'c' });
  expect(screen.getByRole('list', { name: 'Images' })).toBeTruthy();

  fireEvent.keyDown(document.body, { key: 'h' });
  expect(document.querySelector('.gallery').dataset.chrome).toBe('hidden');
  expect(screen.queryByRole('button', { name: 'Show controls' })).toBeNull();
  fireEvent.keyDown(document.activeElement, { key: 'h' });
  expect(document.querySelector('.gallery').dataset.chrome).toBe('shown');

  // Shortcuts do not fire from a slider, but still do after using a checkbox.
  const speed = screen.getByRole('slider', { name: 'Speed' });
  fireEvent.keyDown(speed, { key: 'h' });
  expect(document.querySelector('.gallery').dataset.chrome).toBe('shown');
  const portrait = screen.getByRole('checkbox', { name: /^Portrait/ });
  fireEvent.click(portrait);
  fireEvent.keyDown(portrait, { key: 'h' });
  expect(document.querySelector('.gallery').dataset.chrome).toBe('hidden');
});

test('a fresh gallery visit starts at the first fully shuffled eligible image', async () => {
  fixSeed();
  localStorage.setItem('imagedials-gallery-playing', 'false');
  openRoute('/gallery', mixed());
  await screen.findByRole('region', { name: 'Gallery controls' });
  expect(shownTitle()).toBe(cycle()[0]);
  library.records = [sizedRecord('new', 1152, 768), ...library.records];
  nav('Library');
  await screen.findByText('Image new');
  // The next visit's server shuffle: every eligible image, the newest included.
  const seed = library.sessionSeed;
  const next = seededOrder(
    library.records.map((record) => `local-0/${record.id}.png`),
    seed,
  ).map((key) => `Image ${key.replace('local-0/', '').replace('.png', '')}`);
  nav('Gallery');
  await screen.findByRole('region', { name: 'Gallery controls' });
  await waitFor(() => expect(shownTitle()).toBe(next[0]));
  // A fresh visit is not anchored on the image the previous visit showed.
  expect(library.created.at(-1).body).not.toHaveProperty('first_image_id');
  noCompleteList();
});

test('the gallery keeps the featured image when newer images arrive in place', async () => {
  localStorage.setItem('imagedials-gallery-playing', 'false');
  FakeEventSource.reset();
  vi.stubGlobal('EventSource', FakeEventSource);
  openRoute('/gallery', mixed());
  await screen.findByRole('region', { name: 'Gallery controls' });
  await flush();
  const before = shownTitle();
  // A refresh of the counts fails: the images stay, the failure is reported.
  const match = api.routes.match;
  let failing = true;
  api.routes.match = (key) =>
    failing && key.startsWith(FACETS)
      ? () => respond(502, m2.errors.storage)
      : match(key);
  const stream = FakeEventSource.all.find((s) =>
    s.url.endsWith('/images/library/events'),
  );
  act(() => stream.emit('changed', { action: 'saved' }));
  const alert = await screen.findByRole('alert');
  expect(shownTitle()).toBe(before);
  library.records = [sizedRecord('new', 1152, 768), ...library.records];
  failing = false;
  fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
  await waitFor(() =>
    expect(
      within(filmstrip()).getByRole('button', { name: 'Image new' }),
    ).toBeTruthy(),
  );
  // Paused: the arrival waits after the current image instead of replacing it.
  expect(shownTitle()).toBe(before);
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  noCompleteList();
});
