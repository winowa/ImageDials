import { openStandardControls } from './controlUiTestSupport.js';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import editing from '../../fixtures/api/image-editing.json';
import App from './App.jsx';
import { createCacheStore } from './cacheStore.js';
import { memoryDb } from './cacheTestSupport.js';
import { DEFAULT_CLIENT_POLICY } from './clientPolicy.js';
import { sha256Hex } from './privateThumbnail.js';
import {
  clone,
  fakeLibrary,
  fixtures,
  installApi,
  listedFromJob,
  respond,
} from './testSupport.js';

const appHarness = vi.hoisted(() => ({ cache: { store: null, ready: true } }));
vi.mock('./useCacheStore.js', () => ({
  useCacheStore: () => appHarness.cache,
}));
vi.mock('./standardRandom.js', async (original) => ({
  ...(await original()),
  randomizeStandard: (entries) => entries,
}));

const { m1 } = fixtures;
const ANALYZE = 'POST /api/images/reference-analysis';
const INSPECT = 'POST /api/images/reference-analysis?inspect_only=true';
const GENERATE = 'POST /api/generate-image';
const DYNAMIC = 'POST /api/controls/dynamic';
const EDIT_JOB = `GET /api/generation-jobs/${editing.generation.accepted.generation_job_id}`;
const jobPolicy = { pollIntervalMs: 1, maxConsecutivePollFailures: 3 };
const UPLOADS = {
  image_mime_types: ['image/png', 'image/jpeg', 'image/webp'],
  import_max_bytes: 33554432,
};
const LIMITS = DEFAULT_CLIENT_POLICY.cache;

let api;
let db;
let store;
let urlCount;
let revoked;

const bytesOf = (base64) =>
  Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
const fixtureFile = (index) => {
  const item = editing.files[index];
  return new File([bytesOf(item.base64)], item.filename, {
    type: item.content_type,
  });
};
const SHA = (index) => editing.files[index].sha256;

async function analysisFor(form) {
  const image = form.get('image');
  const context = JSON.parse(form.get('context'));
  const base =
    context.reference_images.length === 0
      ? editing.analysis.first.response
      : editing.analysis.additional.response;
  return {
    ...clone(base),
    source_sha256: await sha256Hex(image),
    description: `Described ${image.name}`,
    reference_index: context.reference_images.length + 1,
    revision: context.revision,
  };
}

function setup(records = [], overrides = {}) {
  const library = fakeLibrary(records);
  api = installApi({
    'GET /api/app-capabilities': () => ({
      ...m1.capabilities,
      uploads: UPLOADS,
      image_editing: editing.capabilities,
    }),
    [DYNAMIC]: () => m1.dynamic_response,
    [ANALYZE]: (form) => analysisFor(form),
    [GENERATE]: () => respond(202, editing.generation.accepted),
    [EDIT_JOB]: () => clone(editing.generation.complete),
    ...library.routes,
    ...overrides,
  });
  return library;
}

/** A page load over the same browser database. */
const openPage = (next = createCacheStore(db, LIMITS)) => {
  store = next;
  appHarness.cache = { store, ready: true };
  return store;
};
const renderApp = () => render(<App jobPolicy={jobPolicy} />);
const renderSavedEdit = (record) => {
  window.history.replaceState(
    null,
    '',
    `/?edit=${encodeURIComponent(record.id)}`,
  );
  return renderApp();
};
const ready = () => openStandardControls();
const references = () => screen.getByRole('region', { name: 'References' });
const rows = () =>
  screen.queryByRole('region', { name: 'References' })
    ? within(references()).queryAllByRole('listitem')
    : [];
/** Choose Edit, where references and kept files are offered. */
const chooseEdit = async () => {
  const edit = await screen.findByRole('radio', { name: /^Edit image/ });
  await waitFor(() => expect(edit.disabled).toBe(false));
  if (!edit.checked) fireEvent.click(edit);
};
/** Attach files once the server's editing capability has been read. */
const attach = async (...files) => {
  await chooseEdit();
  await waitFor(() =>
    expect(
      within(references()).getByRole('button', { name: /Add reference/ })
        .disabled,
    ).toBe(false),
  );
  fireEvent.change(references().querySelector('input[type="file"]'), {
    target: { files },
  });
};
const settled = () =>
  waitFor(() => expect(screen.queryAllByText('Describing…')).toHaveLength(0));
const bar = (name = /Generate edit/) =>
  screen.getAllByRole('button', { name }).at(-1);
const refAction = (n, name) => {
  fireEvent.click(
    screen.getByRole('button', { name: `Actions for reference ${n}` }),
  );
  fireEvent.click(screen.getByRole('menuitem', { name }));
};
const keepFirst = async () => {
  refAction(1, /^Keep in this browser/);
  await screen.findByText('Kept in this browser');
};
const openSettings = () => {
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
  const dialog = screen.getByRole('dialog', { name: 'Settings' });
  fireEvent.click(within(dialog).getByRole('tab', { name: 'Files' }));
  return dialog;
};
const savedEdit = () =>
  listedFromJob(clone(editing.generation.complete.result));
const modelCalls = () =>
  api.calls.filter(
    (c) =>
      c.key === ANALYZE ||
      c.key === INSPECT ||
      c.key === GENERATE ||
      c.key === DYNAMIC,
  );

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  localStorage.clear();
  sessionStorage.clear();
  urlCount = 0;
  revoked = [];
  URL.createObjectURL = vi.fn(() => `blob:kept-${(urlCount += 1)}`);
  URL.revokeObjectURL = vi.fn((url) => revoked.push(url));
  db = memoryDb();
  openPage();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test('Keep is an explicit item in the reference actions; nothing is kept by attaching', async () => {
  setup();
  renderApp();
  await ready();
  await attach(fixtureFile(0));
  await settled();
  expect((await store.referenceAssets.list()).items).toEqual([]);
  expect(screen.queryByText('Kept in this browser')).toBeNull();
  // No permanent per-row button row: reorder and removal sit in the menu.
  expect(
    within(rows()[0]).queryByRole('button', {
      name: /Move reference|Remove reference/,
    }),
  ).toBeNull();
  expect(
    within(rows()[0]).getAllByRole('button', { name: /^Actions for/ }),
  ).toHaveLength(1);
  expect(screen.queryByRole('button', { name: /^Kept references/ })).toBeNull();

  fireEvent.click(
    screen.getByRole('button', { name: 'Actions for reference 1' }),
  );
  expect(
    screen
      .getAllByRole('menuitem')
      .map((item) => item.textContent.replace(/\s+/g, ' ')),
  ).toEqual(['Keep in this browser', 'Remove from draft']);
  fireEvent.click(
    screen.getByRole('menuitem', { name: /^Keep in this browser/ }),
  );
  await screen.findByText('Kept in this browser');

  const { items, usage } = await store.referenceAssets.list();
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({
    sha256: SHA(0),
    name: 'color-1.png',
    description: 'Described color-1.png',
  });
  expect(usage).toMatchObject({ count: 1, maxRecords: 32 });
  // Bytes live in IndexedDB only; never in web storage.
  const web = JSON.stringify([
    ...Object.entries(localStorage),
    ...Object.entries(sessionStorage),
  ]);
  expect(web).not.toContain(editing.files[0].base64.slice(0, 24));
  // Once kept, the item becomes removal of the kept copy, not a second keep.
  fireEvent.click(
    screen.getByRole('button', { name: 'Actions for reference 1' }),
  );
  expect(
    screen.queryByRole('menuitem', { name: /^Keep in this browser/ }),
  ).toBeNull();
  expect(
    screen.getByRole('menuitem', { name: /^Remove kept copy/ }),
  ).toBeTruthy();
  // The "Kept" shortcut appears only now that something is kept.
  fireEvent.keyDown(document.activeElement, { key: 'Escape' });
  expect(
    screen.getByRole('button', { name: 'Kept references (1)' }),
  ).toBeTruthy();
});

test('removing a reference from the draft leaves its kept copy', async () => {
  setup();
  renderApp();
  await ready();
  await attach(fixtureFile(0));
  await settled();
  await keepFirst();
  refAction(1, /^Remove from draft/);
  await waitFor(() => expect(rows()).toHaveLength(0));
  expect((await store.referenceAssets.list()).items).toHaveLength(1);
  expect(
    screen.getByRole('button', { name: 'Kept references (1)' }),
  ).toBeTruthy();
});

test('a reload restores a saved edit from kept originals with no model call', async () => {
  const saved = savedEdit();
  setup([saved]);
  renderApp();
  await ready();
  await attach(fixtureFile(0), fixtureFile(1));
  await settled();
  await keepFirst();
  refAction(2, /^Keep in this browser/);
  await waitFor(() =>
    expect(screen.getAllByText('Kept in this browser')).toHaveLength(2),
  );
  cleanup();

  // Fresh page: new store owner, new memory, same browser database.
  api.calls.splice(0);
  openPage(createCacheStore(db, LIMITS));
  renderSavedEdit(saved);
  await ready();
  await waitFor(() => expect(bar().disabled).toBe(false));
  expect(screen.queryByText('Original file needed to edit.')).toBeNull();
  expect(screen.queryByRole('button', { name: /Attach original/ })).toBeNull();
  const names = [...references().querySelectorAll('.ref-name')].map(
    (n) => n.textContent,
  );
  expect(names).toEqual(['color-1.png', 'color-2.png']);
  // The saved descriptions are the restored ones.
  expect(within(references()).getByText('A red color sample')).toBeTruthy();
  expect(
    [...references().querySelectorAll('img')].every((img) =>
      img.getAttribute('src')?.startsWith('blob:'),
    ),
  ).toBe(true);
  // No description, proposal, checksum or generation request was made.
  expect(modelCalls().map((c) => c.key)).not.toContain(ANALYZE);
  expect(api.called(ANALYZE)).toHaveLength(0);
  expect(api.called(INSPECT)).toHaveLength(0);
  expect(api.called(GENERATE)).toHaveLength(0);
  expect(screen.queryByText(/Prompt updated from reference/)).toBeNull();
});

test('only the kept slot is restored; the other still asks for its original', async () => {
  const saved = savedEdit();
  setup([saved]);
  renderApp();
  await ready();
  await attach(fixtureFile(0));
  await settled();
  await keepFirst();
  cleanup();

  api.calls.splice(0);
  openPage(createCacheStore(db, LIMITS));
  renderSavedEdit(saved);
  await ready();
  await screen.findByRole('button', {
    name: 'Attach original for reference 2',
  });
  expect(
    screen.queryByRole('button', { name: 'Attach original for reference 1' }),
  ).toBeNull();
  expect(bar().disabled).toBe(true);
  expect(api.called(ANALYZE)).toHaveLength(0);
});

test('a fresh page and New draft start blank though files are kept', async () => {
  setup();
  renderApp();
  await ready();
  await attach(fixtureFile(0));
  await settled();
  await keepFirst();
  cleanup();

  api.calls.splice(0);
  openPage(createCacheStore(db, LIMITS));
  renderApp();
  await ready();
  await chooseEdit();
  const shortcut = await screen.findByRole('button', {
    name: 'Kept references (1)',
  });
  expect(rows()).toHaveLength(0);
  expect(api.calls.filter((c) => c.key === ANALYZE)).toHaveLength(0);

  // Choose the kept file, then New draft empties the list and re-attaches nothing.
  fireEvent.click(shortcut);
  const dialog = screen.getByRole('dialog', { name: 'Kept references' });
  fireEvent.click(
    within(dialog).getByRole('button', {
      name: 'Add color-1.png to the draft',
    }),
  );
  await waitFor(() => expect(rows()).toHaveLength(1));
  fireEvent.click(screen.getByRole('button', { name: /New draft/ }));
  await waitFor(() => expect(rows()).toHaveLength(0));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(rows()).toHaveLength(0);
});

test('choosing a kept file adds it without an upload, description or model call', async () => {
  setup();
  renderApp();
  await ready();
  await attach(fixtureFile(0));
  await settled();
  await keepFirst();
  cleanup();

  api.calls.splice(0);
  const next = openPage(createCacheStore(db, LIMITS));
  const read = vi.spyOn(next.referenceAssets, 'read');
  renderApp();
  await ready();
  await chooseEdit();
  const shortcut = await screen.findByRole('button', {
    name: 'Kept references (1)',
  });
  // Listing the kept files read no bytes.
  expect(read).not.toHaveBeenCalled();
  fireEvent.click(shortcut);
  const dialog = screen.getByRole('dialog', { name: 'Kept references' });
  expect(read).not.toHaveBeenCalled();
  expect(within(dialog).getByText(/^1 of 32 files · /)).toBeTruthy();
  fireEvent.click(
    within(dialog).getByRole('button', {
      name: 'Add color-1.png to the draft',
    }),
  );
  await waitFor(() => expect(rows()).toHaveLength(1));
  expect(screen.queryByRole('dialog', { name: 'Kept references' })).toBeNull();
  expect(read).toHaveBeenCalledTimes(1);
  // The prompt stays the person's own: nothing was proposed.
  expect(screen.getByLabelText('Image idea').value).toBe('');
  const row = rows()[0];
  expect(within(row).getByText('Described color-1.png')).toBeTruthy();
  expect(within(row).getByText('Kept in this browser')).toBeTruthy();
  expect(api.called(ANALYZE)).toHaveLength(0);
  expect(api.called(INSPECT)).toHaveLength(0);
  fireEvent.change(screen.getByLabelText('Image idea'), {
    target: { value: 'Make it warmer' },
  });
  await waitFor(() => expect(bar().disabled).toBe(false));
  // The shortcut gets focus back after the dialog closes.
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Kept references (1)' }),
    ),
  );
});

test('Settings shows usage and removes one kept copy only after confirmation', async () => {
  setup();
  renderApp();
  await ready();
  await attach(fixtureFile(0));
  await settled();
  await keepFirst();
  const refImage = rows()[0].querySelector('img').getAttribute('src');
  const read = vi.spyOn(store.referenceAssets, 'read');
  const gear = screen.getByRole('button', { name: 'Settings' });
  const settings = openSettings();
  const group = within(settings).getByRole('group', {
    name: 'Kept references',
  });
  expect(
    within(group).getByText(/^1 of 32 files · 98 B of 256 MiB$/),
  ).toBeTruthy();
  const manage = within(group).getByRole('button', { name: 'Manage' });
  fireEvent.click(manage);
  const dialog = screen.getByRole('dialog', { name: 'Kept references' });

  // Bytes are read only when a preview is asked for.
  expect(read).not.toHaveBeenCalled();
  const toggle = within(dialog).getByRole('button', {
    name: 'color-1.png, preview',
  });
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(toggle);
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  const preview = await within(dialog).findByAltText('Preview of color-1.png');
  expect(read).toHaveBeenCalledTimes(1);
  const previewUrl = preview.getAttribute('src');
  fireEvent.click(toggle);
  await waitFor(() => expect(revoked).toContain(previewUrl));

  // Removal asks first; Cancel changes nothing.
  fireEvent.click(
    within(dialog).getByRole('button', {
      name: 'Remove color-1.png from this browser',
    }),
  );
  const confirm = within(dialog).getByRole('group', {
    name: 'Remove kept copy of color-1.png',
  });
  expect(confirm.textContent).toMatch(/cannot be undone/);
  expect(confirm.textContent).toMatch(/attached to the draft stays attached/);
  expect(document.activeElement).toBe(
    within(confirm).getByRole('button', { name: 'Cancel' }),
  );
  fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
  expect((await store.referenceAssets.list()).items).toHaveLength(1);

  fireEvent.click(
    within(dialog).getByRole('button', {
      name: 'Remove color-1.png from this browser',
    }),
  );
  fireEvent.click(
    within(dialog).getByRole('button', { name: 'Remove kept copy' }),
  );
  await within(dialog).findByText('No files kept.');
  expect((await store.referenceAssets.list()).items).toEqual([]);

  // The reference attached in the draft is untouched.
  expect(rows()).toHaveLength(1);
  expect(rows()[0].querySelector('img').getAttribute('src')).toBe(refImage);
  expect(revoked).not.toContain(refImage);
  expect(within(references()).queryByText('Kept in this browser')).toBeNull();

  // Escape closes the dialog and returns to Settings' own control.
  fireEvent.keyDown(dialog, { key: 'Escape' });
  expect(screen.queryByRole('dialog', { name: 'Kept references' })).toBeNull();
  // Nothing is left to manage, so focus returns to the Settings dialog.
  await waitFor(() => expect(document.activeElement).toBe(settings));
  expect(manage.disabled).toBe(true);
  expect(
    within(settings).getByText(/^None kept · up to 32 files/),
  ).toBeTruthy();
  expect(gear).toBeTruthy();
});

test('storage that is full or refused keeps the file in the draft and says it was not kept', async () => {
  setup();
  renderApp();
  await ready();
  await attach(fixtureFile(0));
  await settled();
  fireEvent.change(screen.getByLabelText('Image idea'), {
    target: { value: 'Recolor the base' },
  });
  const keep = vi
    .spyOn(store.referenceAssets, 'keep')
    .mockResolvedValueOnce({ persisted: false, reason: 'quota' });
  refAction(1, /^Keep in this browser/);
  const alert = await screen.findByText(/^Not kept: the browser has no room/);
  expect(alert.textContent).toMatch(/still in this draft/);
  expect(screen.queryByText('Kept in this browser')).toBeNull();
  // The draft is intact and usable.
  expect(rows()).toHaveLength(1);
  expect(rows()[0].querySelector('img').getAttribute('src')).toMatch(/^blob:/);
  expect(bar().disabled).toBe(false);
  expect(revoked).toEqual([]);
  fireEvent.click(
    screen.getByRole('button', { name: 'Retry keeping color-1.png' }),
  );
  await screen.findByText('Kept in this browser');
  expect(keep).toHaveBeenCalledTimes(2);
  expect(screen.queryByText(/Not kept/)).toBeNull();
});

test('a full set of kept files points at removing one, and never evicts', async () => {
  setup();
  renderApp();
  await ready();
  await attach(fixtureFile(0));
  await settled();
  vi.spyOn(store.referenceAssets, 'keep').mockResolvedValueOnce({
    persisted: false,
    reason: 'record-limit',
  });
  refAction(1, /^Keep in this browser/);
  await screen.findByText(/^Not kept: 32 kept files are in use/);
  expect(
    screen.queryByRole('button', { name: 'Retry keeping color-1.png' }),
  ).toBeNull();
  expect(screen.getByRole('button', { name: 'Kept files' })).toBeTruthy();
  fireEvent.click(
    screen.getByRole('button', { name: 'Dismiss message for color-1.png' }),
  );
  expect(screen.queryByText(/Not kept/)).toBeNull();
});

test('without browser storage the Keep action says why it is unavailable', async () => {
  openPage(createCacheStore(null, LIMITS));
  setup();
  renderApp();
  await ready();
  await attach(fixtureFile(0));
  await settled();
  fireEvent.click(
    screen.getByRole('button', { name: 'Actions for reference 1' }),
  );
  const item = screen.getByRole('menuitem', { name: /Keep in this browser/ });
  expect(item.getAttribute('aria-disabled')).toBe('true');
  expect(item.textContent).toContain('Browser storage unavailable');
  fireEvent.keyDown(item, { key: 'Escape' });
  const settings = openSettings();
  expect(
    within(
      within(settings).getByRole('group', { name: 'Kept references' }),
    ).getByText('This browser is not storing files here.'),
  ).toBeTruthy();
  expect(screen.queryByRole('button', { name: /^Kept references/ })).toBeNull();
});

test('kept files changed in another tab show up when the page is visible again', async () => {
  setup();
  renderApp();
  await ready();
  await attach(fixtureFile(0));
  await settled();
  expect(screen.queryByRole('button', { name: /^Kept references/ })).toBeNull();
  const other = createCacheStore(db, LIMITS);
  const ticket = await other.referenceAssets.beginKeep();
  await other.referenceAssets.keep(ticket, {
    sha256: SHA(1),
    blob: fixtureFile(1),
    name: 'color-2.png',
    description: 'Elsewhere',
  });
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => 'visible',
  });
  document.dispatchEvent(new Event('visibilitychange'));
  await screen.findByRole('button', { name: 'Kept references (1)' });
  delete document.visibilityState;
  // Nothing was attached by the other tab's save.
  expect(rows()).toHaveLength(1);
});

test('Compare still offers the recorded sources after their references leave the draft', async () => {
  const saved = savedEdit();
  setup([saved]);
  // Both originals are kept in this browser; the draft starts without them.
  for (const [index, file] of [fixtureFile(0), fixtureFile(1)].entries()) {
    const ticket = await store.referenceAssets.beginKeep();
    await store.referenceAssets.keep(ticket, {
      sha256: SHA(index),
      blob: file,
      name: file.name,
      description: `Kept ${index}`,
    });
  }
  const next = openPage(createCacheStore(db, LIMITS));
  const read = vi.spyOn(next.referenceAssets, 'read');
  renderApp();
  await ready();
  expect(rows()).toHaveLength(0);
  const strip = await screen.findByRole('region', { name: 'Saved images' });
  const item = within(strip)
    .getAllByRole('button')
    .find((b) => b.getAttribute('aria-label') === saved.title);
  api.calls.splice(0);
  fireEvent.click(item);
  // Choosing the saved edit restores its slots from the kept originals.
  await waitFor(() => expect(bar().disabled).toBe(false));
  expect(rows()).toHaveLength(2);
  const restoreReads = read.mock.calls.length;
  // Drop both from the draft (the kept copies stay).
  refAction(1, /^Remove from draft/);
  await waitFor(() => expect(rows()).toHaveLength(1));
  refAction(1, /^Remove from draft/);
  await waitFor(() => expect(rows()).toHaveLength(0));
  expect((await store.referenceAssets.list()).items).toHaveLength(2);

  const more = await screen.findByRole('button', { name: 'More actions' });
  fireEvent.click(more);
  const compare = screen.getByRole('menuitem', { name: /Compare/ });
  expect(compare.textContent).toContain('With source color-1.png (+1)');
  fireEvent.click(compare);
  const dialog = await screen.findByRole('dialog', { name: 'Compare' });
  const before = within(dialog).getByAltText('Source: color-1.png');
  await waitFor(() => expect(before.getAttribute('src')).toMatch(/^blob:/));
  // Nothing was attached, asked of a model, or re-read to compare.
  expect(rows()).toHaveLength(0);
  expect(modelCalls()).toEqual([]);
  expect(read).toHaveBeenCalledTimes(restoreReads);
  const source = before.getAttribute('src');
  fireEvent.click(within(dialog).getByRole('button', { name: /Close/ }));
  expect(revoked).toContain(source);
  expect(document.activeElement).toBe(
    screen.getByRole('button', { name: 'More actions' }),
  );
});
