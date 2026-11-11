import { openStandardControls } from '../helpers/controlUiTestSupport.js';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import App from '../../src/app/App.jsx';
import { DEFAULT_CLIENT_POLICY } from '../../src/data/api/clientPolicy.js';
import { createCacheStore } from '../../src/data/storage/cacheStore.js';
import { imageBlob, memoryDb } from '../helpers/cacheTestSupport.js';
import {
  clone,
  completeStatus,
  fakeLibrary,
  fixtures,
  installApi,
  libraryRecord,
  respond,
} from '../helpers/testSupport.js';

vi.mock('../../src/features/controls/standardRandom.js', async (original) => ({
  ...(await original()),
  randomizeStandard: (entries) => entries,
}));

const harness = vi.hoisted(() => ({ cache: { store: null, ready: true } }));
vi.mock('../../src/data/storage/useCacheStore.js', () => ({
  useCacheStore: () => harness.cache,
}));
const thumbnailMock = vi.hoisted(() => ({ render: null }));
vi.mock('../../src/data/media/privateThumbnail.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    makeThumbnail: (blob) =>
      thumbnailMock.render?.(blob) ?? actual.makeThumbnail(blob),
  };
});

const { m1, m3 } = fixtures;
const IDEA = 'An amber glass bird on a small wooden stand';
const JOB = 'GET /api/generation-jobs/fixture-image-1';
const GENERATE = 'POST /api/generate-image';
const DYNAMIC = 'POST /api/controls/dynamic';
const CONTENT = 'GET /api/images/fixture-image-1/content';
const IMPORT = 'POST /api/images/import-analysis';
const jobPolicy = { pollIntervalMs: 1, maxConsecutivePollFailures: 3 };
const TITLE = completeStatus().result.title;

let api;
let db;
let made;

const openStore = (cache = DEFAULT_CLIENT_POLICY.cache) => {
  harness.cache = { store: createCacheStore(db, cache), ready: true };
};
const renderApp = (clientPolicy) =>
  render(<App jobPolicy={jobPolicy} clientPolicy={clientPolicy} />);
// A store that refuses every new original, and a pool with one slot.
const FULL_STORE = { ...DEFAULT_CLIENT_POLICY.cache, privateRecordLimit: 0 };
const ONE_SLOT = {
  cache: { ...FULL_STORE, privateVolatileRecordLimit: 1 },
};
const privateResult = () => ({
  ...completeStatus().result,
  visibility: 'private',
  sha256: undefined,
});
const sharedCalls = () =>
  api.calls.filter(
    (call) =>
      call.key.includes('/api/images/library') || call.key.includes('/events'),
  );
const png = () => imageBlob(30, 'image/png');

function setup(
  overrides = {},
  { capabilities = m1.capabilities_private, records } = {},
) {
  const library = fakeLibrary(records ?? []);
  api = installApi({
    'GET /api/app-capabilities': () => capabilities,
    [DYNAMIC]: () => m1.dynamic_response,
    [GENERATE]: () => respond(202, m1.accepted),
    [JOB]: () => ({ ...completeStatus(), result: privateResult() }),
    [CONTENT]: () => respond(200, 'png-bytes', { 'Content-Type': 'image/png' }),
    ...library.routes,
    ...overrides,
  });
  return library;
}

async function generate() {
  await openStandardControls();
  fireEvent.change(screen.getByLabelText('Image idea'), {
    target: { value: IDEA },
  });
  fireEvent.click(screen.getAllByRole('button', { name: /Generate image/ })[0]);
  await screen.findByRole('button', { name: TITLE });
}
const privateRows = () => db.data.get('private') ?? new Map();
const goTo = (name) => fireEvent.click(screen.getByRole('link', { name }));

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  localStorage.clear();
  db = memoryDb();
  openStore();
  let next = 0;
  made = { created: [], revoked: [] };
  URL.createObjectURL = vi.fn(() => {
    next += 1;
    made.created.push(`blob:p-${next}`);
    return `blob:p-${next}`;
  });
  URL.revokeObjectURL = vi.fn((url) => made.revoked.push(url));
});
afterEach(() => {
  cleanup();
  thumbnailMock.render = null;
  vi.unstubAllGlobals();
});

test('a private result is listed once, stored, and shown in gallery and library with no shared request', async () => {
  setup();
  renderApp();
  await generate();
  expect(screen.getAllByRole('button', { name: TITLE })).toHaveLength(1);
  expect(
    screen.queryByRole('button', { name: /Delete|Remove from browser/ }),
  ).toBeNull();
  await waitFor(() => expect(privateRows().size).toBe(1));
  await waitFor(() =>
    expect(db.data.get('privateMedia')?.size).toBeGreaterThan(0),
  );
  const [row] = privateRows().values();
  expect(row.origin).toBe('generated');
  expect(row.record.visibility).toBe('private');
  expect(row.record).not.toHaveProperty('local_origin');

  goTo('Library');
  await screen.findByText('1 image');
  expect(
    screen.getAllByRole('button', { name: new RegExp(TITLE) }),
  ).toHaveLength(1);
  goTo('Gallery');
  await waitFor(() =>
    expect(document.querySelectorAll('main img').length).toBeGreaterThan(0),
  );
  expect(sharedCalls()).toEqual([]);
  expect(api.calls.some((c) => c.key.startsWith('DELETE'))).toBe(false);
});

test('removing a private result is local only, survives reload and offers no watermark actions', async () => {
  setup();
  renderApp();
  await generate();
  await waitFor(() =>
    expect(db.data.get('privateMedia')?.size).toBeGreaterThan(0),
  );
  goTo('Library');
  fireEvent.click(
    await screen.findByRole('button', { name: new RegExp(TITLE) }),
  );
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).queryByRole('group', { name: 'Watermark' })).toBeNull();
  expect(screen.queryByRole('group', { name: 'Watermarks' })).toBeNull();
  fireEvent.click(
    within(dialog).getByRole('button', { name: 'Remove from browser' }),
  );
  expect(
    within(dialog).getByText(/nothing is deleted on the server/),
  ).toBeTruthy();
  fireEvent.click(
    within(within(dialog).getByRole('group', { name: /^Remove/ })).getByRole(
      'button',
      {
        name: 'Remove from browser',
      },
    ),
  );
  await waitFor(() => expect(privateRows().size).toBe(0));
  expect(api.calls.some((c) => c.key.startsWith('DELETE'))).toBe(false);

  cleanup();
  openStore();
  window.history.replaceState(null, '', '/print');
  renderApp();
  await screen.findByText('No saved images yet.');
  expect(sharedCalls()).toEqual([]);
});

test('after a reload the stored image is shown from its stored bytes, not the network', async () => {
  thumbnailMock.render = async () => imageBlob(8, 'image/jpeg');
  setup();
  renderApp();
  await generate();
  await waitFor(() =>
    expect(db.data.get('privateMedia')?.size).toBeGreaterThan(0),
  );
  cleanup();
  openStore();
  const readPrivateMedia = vi.spyOn(harness.cache.store, 'readPrivateMedia');
  const contentCalls = api.called(CONTENT).length;
  renderApp();
  const thumb = await screen.findByRole('button', { name: TITLE });
  await waitFor(() =>
    expect(thumb.querySelector('img').getAttribute('src')).toMatch(/^blob:/),
  );
  fireEvent.click(thumb);
  expect(api.called(CONTENT)).toHaveLength(contentCalls);
  await waitFor(() =>
    expect(
      readPrivateMedia.mock.calls.some(([, , kind]) => kind === 'full'),
    ).toBe(true),
  );
  await waitFor(() =>
    expect(document.querySelector('.stage-img')?.getAttribute('src')).toMatch(
      /^blob:/,
    ),
  );
  expect(api.called(CONTENT)).toHaveLength(contentCalls);
});

test('a shared source keeps imports in the browser history and never lists earlier private results', async () => {
  // A private result stored earlier, while the library was private.
  const earlier = createCacheStore(db, DEFAULT_CLIENT_POLICY.cache);
  const stale = {
    ...privateResult(),
    id: 'older',
    title: 'Earlier private result',
    filename: 'older.png',
  };
  await earlier.admitPrivate({
    record: stale,
    origin: 'generated',
    addedAt: 5,
  });
  const saved = libraryRecord({ id: 'shared-1', title: 'Shared image' });
  setup(
    { [IMPORT]: () => m3.import_metadata },
    { capabilities: m3.capabilities, records: [saved] },
  );
  renderApp();
  await screen.findByRole('button', { name: 'Shared image' });
  expect(
    screen.queryByRole('button', { name: 'Earlier private result' }),
  ).toBeNull();

  const file = new File([png()], 'bird.png', { type: 'image/png' });
  fireEvent.change(document.querySelector('input[type="file"]'), {
    target: { files: [file] },
  });
  await screen.findByText(/listed in this browser only/);
  await waitFor(() => expect(privateRows().size).toBe(2));
  const imported = [...privateRows().values()].find(
    (row) => row.origin === 'imported',
  );
  // The wire snapshot is stored unchanged; the file is the stored original.
  expect(imported.record).toEqual(m3.import_metadata.image);
  await waitFor(() =>
    expect(db.data.get('privateMedia')?.size).toBeGreaterThan(0),
  );
  const importedKey = [...privateRows()].find(
    ([, row]) => row.origin === 'imported',
  )[0];
  expect(db.data.get('privateMedia').get(`${importedKey}|full`).blob).toBe(
    file,
  );
  // No library write happened for the import.
  expect(
    api.calls.some((c) => c.key.startsWith('POST /api/images/library')),
  ).toBe(false);
  expect(api.calls.some((c) => c.key.startsWith('DELETE'))).toBe(false);
});

test('a storage failure leaves the result usable and says it was not stored', async () => {
  setup({ [CONTENT]: () => respond(500, 'broken') });
  renderApp();
  await generate();
  const media = await screen.findByText(/Not stored in this browser/);
  expect(media).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Retry storing' })).toBeTruthy();
  expect(screen.getAllByRole('button', { name: TITLE })).toHaveLength(1);
  expect(document.querySelector('.stage-img')?.getAttribute('src')).toBe(
    '/api/images/fixture-image-1/content',
  );
  expect(clone(privateRows().size)).toBe(1);
});

const IDEA_B = 'A second idea that must wait';

async function fillThePool() {
  setup();
  openStore(FULL_STORE);
  renderApp(ONE_SLOT);
  await generate();
  await screen.findByText(/held in this tab only/i);
}

test('a full pool blocks private generation before any provider call, and a confirmed removal frees the slot', async () => {
  await fillThePool();
  expect(privateRows().size).toBe(0);
  expect(api.called(GENERATE)).toHaveLength(1);
  const dynamic = api.called(DYNAMIC).length;
  fireEvent.change(screen.getByLabelText('Image idea'), {
    target: { value: IDEA_B },
  });
  const status = await screen.findByText(
    /1 images are not stored in this browser/,
  );
  expect(status.textContent).toMatch(/before generating/);
  const generateButton = screen.getAllByRole('button', {
    name: /Generate image|Regenerate/,
  })[0];
  expect(generateButton.disabled).toBe(true);
  fireEvent.click(generateButton);
  fireEvent.keyDown(screen.getByLabelText('Image idea'), { key: 'Enter' });
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(api.called(GENERATE)).toHaveLength(1);
  expect(api.called(DYNAMIC)).toHaveLength(dynamic);

  // The only way out is Library's removal, which names the consequence.
  goTo('Library');
  fireEvent.click(
    await screen.findByRole('button', { name: new RegExp(TITLE) }),
  );
  const dialog = screen.getByRole('dialog');
  fireEvent.click(
    within(dialog).getByRole('button', { name: 'Remove from browser' }),
  );
  const confirm = within(dialog).getByRole('group', { name: /^Remove/ });
  expect(confirm.textContent).toMatch(/nothing is deleted on the server/);
  expect(confirm.textContent).toMatch(/copy held in this tab is lost/);
  expect(document.activeElement.textContent).toBe('Cancel');
  fireEvent.click(
    within(confirm).getByRole('button', { name: 'Remove from browser' }),
  );
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  goTo('Create');
  await waitFor(() =>
    expect(
      screen.queryByText(/1 images are not stored in this browser/),
    ).toBeNull(),
  );
  expect(api.called(DYNAMIC)).toHaveLength(dynamic);
});

test('a full pool refuses an import before the file is uploaded and changes nothing', async () => {
  await fillThePool();
  const before = api.calls.length;
  const file = new File([png()], 'bird.png', { type: 'image/png' });
  fireEvent.change(document.querySelector('input[type="file"]'), {
    target: { files: [file] },
  });
  await screen.findByText(/1 images are not stored in this browser/);
  expect(api.called(IMPORT)).toHaveLength(0);
  expect(api.called(GENERATE)).toHaveLength(1);
  expect(api.calls.slice(before).map((c) => c.key)).not.toContainEqual(
    expect.stringMatching(/import|generate/),
  );
  expect(screen.getByLabelText('Image idea').value).toBe(IDEA);
  expect(privateRows().size).toBe(0);
});

test('Download is offered for a held private original and never frees its slot', async () => {
  await fillThePool();
  const link = screen.getByRole('link', { name: /Download/ });
  fireEvent.click(link);
  expect(screen.getByText(/held in this tab only/i)).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Image idea'), {
    target: { value: IDEA_B },
  });
  await screen.findByText(/1 images are not stored in this browser/);
});

test('a held import is retried from its file once the store has room', async () => {
  setup(
    { [IMPORT]: () => m3.import_metadata },
    { capabilities: m3.capabilities },
  );
  openStore(FULL_STORE);
  renderApp();
  await openStandardControls();
  const file = new File([png()], 'bird.png', { type: 'image/png' });
  fireEvent.change(document.querySelector('input[type="file"]'), {
    target: { files: [file] },
  });
  await screen.findByText(/listed in this browser only/);
  await screen.findByText(/held in this tab only/i);
  expect(privateRows().size).toBe(0);
  harness.cache.store.setLimits(DEFAULT_CLIENT_POLICY.cache);
  fireEvent.click(screen.getByRole('button', { name: 'Retry storing' }));
  await screen.findByText('Stored in this browser');
  const [row] = [...(db.data.get('privateMedia') ?? new Map()).values()];
  expect(row.blob).toBe(file);
});
