import { openStandardControls } from './controlUiTestSupport.js';
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

import editing from '../../fixtures/api/image-editing.json';
import regionEditing from '../../fixtures/api/region-editing.json';
import App from './App.jsx';
import { PROVIDER_OVERRIDE_HEADER } from './api.js';
import { sha256Hex } from './privateThumbnail.js';
import {
  clone,
  fakeLibrary,
  fixtures,
  installApi,
  libraryRecord,
  listedFromJob,
  networkFailure,
  respond,
} from './testSupport.js';

vi.mock('./standardRandom.js', async (original) => ({
  ...(await original()),
  randomizeStandard: (entries) => entries,
}));

const { m1, browserSettings } = fixtures;
const PROMPT = 'POST /api/images/reference-prompt';
const ANALYZE = 'POST /api/images/reference-analysis';
const GENERATE = 'POST /api/generate-image';
const DYNAMIC = 'POST /api/controls/dynamic';
const EDIT_JOB = `GET /api/generation-jobs/${editing.generation.accepted.generation_job_id}`;
const TEXT_JOB = 'GET /api/generation-jobs/fixture-image-1';
const EDIT_TITLE = editing.generation.complete.result.title;
const jobPolicy = { pollIntervalMs: 1, maxConsecutivePollFailures: 3 };
const UPLOADS = {
  image_mime_types: ['image/png', 'image/jpeg', 'image/webp'],
  import_max_bytes: 33554432,
};
const ALTERNATE = browserSettings.provider_override_example;

let api;
let library;
let urlCount = 0;

const bytesOf = (base64) =>
  Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
/** The canonical fixture's original PNG files. */
const fixtureFile = (index) => {
  const item = editing.files[index];
  return new File([bytesOf(item.base64)], item.filename, {
    type: item.content_type,
  });
};
/** Distinct small files for count tests. */
const extraFile = (n) =>
  new File([new Uint8Array([137, 80, 78, 71, n, n + 1])], `extra-${n}.png`, {
    type: 'image/png',
  });

/**
 * The server's analysis: the fixture answer for the first or an additional
 * reference, with the uploaded bytes' own hash and the revision it was sent.
 */
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

function capabilities(imageEditing = editing.capabilities, region = null) {
  return {
    ...m1.capabilities,
    uploads: UPLOADS,
    ...(imageEditing ? { image_editing: imageEditing } : {}),
    ...(region ? { region_editing: region } : {}),
  };
}

function setup(overrides = {}, records = [], imageEditing, region) {
  library = fakeLibrary(records);
  const completeEdit = () => {
    const status = clone(editing.generation.complete);
    library.records = [
      listedFromJob(status.result),
      ...library.records.filter((r) => r.filename !== status.result.filename),
    ];
    return status;
  };
  api = installApi({
    'GET /api/app-capabilities': () => capabilities(imageEditing, region),
    [DYNAMIC]: () => m1.dynamic_response,
    [ANALYZE]: (form) => analysisFor(form),
    [PROMPT]: (form) => ({
      ...clone(editing.composition.response),
      revision: JSON.parse(form.get('context')).revision,
    }),
    [GENERATE]: () => respond(202, editing.generation.accepted),
    [EDIT_JOB]: completeEdit,
    ...library.routes,
    ...overrides,
  });
  return api;
}

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
const prompt = () => screen.getByLabelText('Image idea');
const type = (text) => fireEvent.change(prompt(), { target: { value: text } });
const referencesRegion = () =>
  screen.getByRole('region', { name: 'References' });
/** Choose Edit, as a person does before adding a reference. */
const chooseEdit = () => {
  const edit = screen.getByRole('radio', { name: /^Edit image/ });
  if (!edit.checked) fireEvent.click(edit);
};
const attach = (...files) => {
  chooseEdit();
  fireEvent.change(referencesRegion().querySelector('input[type="file"]'), {
    target: { files },
  });
};
/** A reference's own actions sit behind one menu button. */
const refAction = (n, name) => {
  fireEvent.click(
    screen.getByRole('button', { name: `Actions for reference ${n}` }),
  );
  fireEvent.click(screen.getByRole('menuitem', { name }));
};
const describing = () => screen.queryAllByText('Describing…');
const settled = () => waitFor(() => expect(describing()).toHaveLength(0));
/** The Generate bar (the round prompt button shares its name). */
const bar = (name = /Generate edit/) =>
  screen.getAllByRole('button', { name }).at(-1);
const generateEdit = () => fireEvent.click(bar());
const editRequest = (call) => JSON.parse(call.body.get('request'));
const decode = (call) => {
  const header = call.headers[PROVIDER_OVERRIDE_HEADER];
  return header
    ? JSON.parse(
        new TextDecoder().decode(
          Uint8Array.from(atob(header), (c) => c.charCodeAt(0)),
        ),
      )
    : null;
};

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  localStorage.clear();
  URL.createObjectURL = vi.fn(() => `blob:reference-${++urlCount}`);
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test('without the capability there is no reference control and text requests are unchanged', async () => {
  setup(
    {
      [GENERATE]: () => respond(202, m1.accepted),
      [TEXT_JOB]: () => clone(m1.job_complete),
    },
    [],
    null,
  );
  renderApp();
  await ready();
  expect(screen.queryByRole('region', { name: 'References' })).toBeNull();
  expect(
    screen.getByRole('button', { name: 'Load image', exact: true }),
  ).toBeTruthy();
  type('An amber glass bird');
  fireEvent.keyDown(prompt(), { key: 'Enter' });
  await waitFor(() => expect(api.called(GENERATE)).toHaveLength(1));
  const [call] = api.called(GENERATE);
  expect(call.body).not.toBeInstanceOf(FormData);
  expect(call.body).not.toHaveProperty('reference_images');
  expect(call.body.controls.some((c) => 'apply_to_edit' in c)).toBe(false);
  expect(api.called(DYNAMIC)[0].body).not.toHaveProperty('reference_context');
  expect(api.called(ANALYZE)).toHaveLength(0);
});

test('closing the loading region editor returns focus to its reference action', async () => {
  setup({}, [], undefined, regionEditing.capability);
  renderApp();
  await ready();
  attach(fixtureFile(0));
  await screen.findByText('Described color-1.png');
  refAction(1, 'Edit part of image');
  const dialog = await screen.findByRole('dialog', { name: 'Edit region' });
  expect(dialog.contains(document.activeElement)).toBe(true);
  fireEvent.keyDown(dialog, { key: 'Escape' });
  await waitFor(() =>
    expect(screen.queryByRole('dialog', { name: 'Edit region' })).toBeNull(),
  );
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Actions for reference 1' }),
    ),
  );
});

test('a region selection is one undoable draft value and is frozen into the edit request', async () => {
  setup({}, [], undefined, regionEditing.capability);
  renderApp();
  await ready();
  attach(fixtureFile(0));
  await screen.findByText('Described color-1.png');
  refAction(1, 'Edit part of image');
  const dialog = await screen.findByRole('dialog', { name: 'Edit region' });
  expect(document.activeElement).toBe(
    within(dialog).getByRole('button', { name: 'Close region editor' }),
  );
  const image = within(dialog).getByRole('img', {
    name: /base image for the region edit/i,
  });
  Object.defineProperty(image, 'naturalWidth', {
    configurable: true,
    value: 40,
  });
  Object.defineProperty(image, 'naturalHeight', {
    configurable: true,
    value: 24,
  });
  fireEvent.load(image);
  expect(dialog.contains(document.activeElement)).toBe(true);
  fireEvent.click(
    within(dialog).getByRole('button', { name: 'Enter coordinates' }),
  );
  for (const [field, value] of [
    ['X', '3'],
    ['Y', '4'],
    ['Width', '6'],
    ['Height', '4'],
  ])
    fireEvent.change(within(dialog).getByLabelText(field), {
      target: { value },
    });
  fireEvent.click(
    within(dialog).getByRole('button', { name: 'Add rectangle' }),
  );
  fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
  await screen.findByText('1 selected shape');
  fireEvent.click(screen.getByRole('button', { name: 'Draft actions' }));
  fireEvent.click(
    await screen.findByRole('menuitem', { name: /undo select image region/i }),
  );
  expect(screen.queryByText(/selected shape/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Draft actions' }));
  fireEvent.click(
    await screen.findByRole('menuitem', { name: /redo select image region/i }),
  );
  await screen.findByText('1 selected shape');

  type('Recolor the selected part');
  generateEdit();
  await waitFor(() => expect(api.called(GENERATE)).toHaveLength(1));
  const [call] = api.called(GENERATE);
  const body = editRequest(call);
  expect(body.region_edit).toMatchObject({
    version: 1,
    source_sha256: editing.files[0].sha256,
    width: 40,
    height: 24,
    shapes: [{ kind: 'rectangle', x: 3, y: 4, width: 6, height: 4 }],
  });
  expect(call.body.get('reference_1').name).toBe('color-1.png');
});

test('unsupported restored region is blocked until explicitly cleared', async () => {
  const record = clone(editing.generation.complete.result);
  record.region_edit = {
    ...clone(regionEditing.selection),
    source_sha256: editing.files[0].sha256,
    width: 40,
    height: 24,
  };
  record.id = 'saved-region-edit';
  record.image_id = record.id;
  setup({}, [record], editing.capabilities, null);
  renderSavedEdit(record);
  await ready();
  await screen.findByText(/region editing/i);
  expect(
    screen.getByText(/clear the region selection to continue/i),
  ).toBeTruthy();
  generateEdit();
  await screen.findByText(/clear the region selection to continue/i);
  expect(api.called(GENERATE)).toHaveLength(0);
  refAction(1, 'Clear region selection');
  expect(
    screen.queryByText(/clear the region selection to continue/i),
  ).toBeNull();
});

test('a restored selection remains bound to its first reference and clears on reorder', async () => {
  const record = clone(editing.generation.complete.result);
  record.region_edit = {
    ...clone(regionEditing.selection),
    source_sha256: editing.files[0].sha256,
    width: 40,
    height: 24,
  };
  record.id = 'saved-region-base-order';
  record.image_id = record.id;
  setup({}, [record], editing.capabilities, regionEditing.capability);
  renderSavedEdit(record);
  await ready();
  await screen.findByRole('listitem', { name: 'Reference 2: color-2.png' });
  expect(
    screen.getByText(/original base image is not ready yet/i),
  ).toBeTruthy();
  refAction(2, 'Move earlier');
  await screen.findByText(
    /base image changed, so the region selection was cleared/i,
  );
  expect(screen.queryByText(/selected shape/)).toBeNull();
});

test('a disabled capability shows Add reference as unavailable', async () => {
  setup({}, [], { ...editing.capabilities, enabled: false });
  renderApp();
  await ready();
  // Edit is offered but unavailable; Load image stays.
  const edit = screen.getByRole('radio', {
    name: /^Image editing is unavailable/,
  });
  expect(edit.disabled).toBe(true);
  fireEvent.click(edit);
  expect(screen.getByRole('radio', { name: 'Text to image' }).checked).toBe(
    true,
  );
  expect(screen.queryByRole('region', { name: 'References' })).toBeNull();
  expect(
    screen.getByRole('button', { name: 'Load image', exact: true }),
  ).toBeTruthy();
});

test('the first reference preserves an empty prompt without offering or generating', async () => {
  setup();
  renderApp();
  await ready();
  attach(fixtureFile(0));
  await screen.findByText('Described color-1.png');
  expect(prompt().value).toBe('');
  expect(api.called(PROMPT)).toHaveLength(0);
  expect(screen.queryByText(/Suggested prompt from/)).toBeNull();
  expect(api.called(GENERATE)).toHaveLength(0);

  const [call] = api.called(ANALYZE);
  expect(call.body.get('image').name).toBe('color-1.png');
  expect(await sha256Hex(call.body.get('image'))).toBe(editing.files[0].sha256);
  const context = JSON.parse(call.body.get('context'));
  expect(context).toMatchObject({
    prompt: '',
    generation_mode: 'standard',
    reference_images: [],
  });
  expect(Number.isInteger(context.revision)).toBe(true);
  // The pixels are analyzed; metadata import is a different action.
  expect(api.called('POST /api/images/import-analysis')).toHaveLength(0);

  const item = within(referencesRegion()).getByRole('listitem', {
    name: 'Base: color-1.png',
  });
  expect(within(item).getByText('Described color-1.png')).toBeTruthy();
  expect(within(item).getByText('40×24')).toBeTruthy();
  expect(
    screen.getByText(/Aspect and framing follow the base/).textContent,
  ).toMatch('Base image 40×24');
  expect(
    screen.getByRole('button', { name: 'Image editing prompt guidance' }),
  ).toBeTruthy();
  expect(
    screen.queryByRole('button', { name: 'Undo', exact: true }),
  ).toBeNull();
});

test('a later reference evolves the prompt; typing meanwhile turns it into an offer', async () => {
  let release;
  let second = 0;
  setup({
    [ANALYZE]: (form) => {
      second += 1;
      if (second === 1) return analysisFor(form);
      return new Promise((resolve) => {
        release = () => resolve(analysisFor(form));
      });
    },
  });
  renderApp();
  await ready();
  attach(fixtureFile(0));
  await screen.findByText('Described color-1.png');
  attach(fixtureFile(1));
  await waitFor(() => expect(release).toBeTypeOf('function'));

  const context = JSON.parse(api.called(ANALYZE)[1].body.get('context'));
  expect(context.prompt).toBe('');
  expect(context.reference_images).toEqual([
    {
      id: expect.stringMatching(/^upload:/),
      description: 'Described color-1.png',
      role: 'base',
    },
  ]);

  type('Keep my own words');
  release();
  await screen.findByText('Suggested prompt from reference 2');
  expect(prompt().value).toBe('Keep my own words');
  fireEvent.click(screen.getByRole('button', { name: 'Use' }));
  expect(prompt().value).toBe(editing.composition.response.suggested_prompt);
  fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
  expect(prompt().value).toBe('Keep my own words');
});

test('a reference removed during its analysis leaves no proposal behind', async () => {
  let release;
  let count = 0;
  setup({
    [ANALYZE]: (form) => {
      count += 1;
      if (count === 1) return analysisFor(form);
      return new Promise((resolve) => {
        release = () => resolve(analysisFor(form));
      });
    },
  });
  renderApp();
  await ready();
  attach(fixtureFile(0));
  await screen.findByText('Described color-1.png');
  const before = prompt().value;
  attach(fixtureFile(1));
  await waitFor(() => expect(release).toBeTypeOf('function'));
  refAction(2, /^Remove from draft/);
  release();
  await waitFor(() =>
    expect(within(referencesRegion()).getAllByRole('listitem')).toHaveLength(1),
  );
  await new Promise((r) => setTimeout(r, 20));
  expect(screen.queryByText(/Suggested prompt from reference 2/)).toBeNull();
  expect(prompt().value).toBe(before);
});

test('two ordered references send real multipart files, hashes and edit controls', async () => {
  setup();
  renderApp();
  await ready();
  attach(fixtureFile(0), fixtureFile(1));
  await settled();
  await waitFor(() => expect(api.called(ANALYZE)).toHaveLength(2));
  type(editing.generation.request.prompt);
  // A person's own choice applies; untouched standard values keep the source.
  await ready();
  fireEvent.change(screen.getByRole('textbox', { name: 'Appearance change' }), {
    target: { value: 'Watercolor rendering' },
  });
  expect(screen.getByText(/1 adjustment applied/)).toBeTruthy();
  const style = screen.getByRole('button', {
    name: 'Apply Appearance change to edit',
  });
  expect(style.getAttribute('aria-pressed')).toBe('true');
  expect(
    screen
      .getByRole('button', { name: 'Apply Background change to edit' })
      .getAttribute('aria-pressed'),
  ).toBe('false');
  generateEdit();
  await screen.findByRole('heading', { name: EDIT_TITLE });

  // Dynamic controls know the ordered references.
  const dynamic = api.called(DYNAMIC).at(-1).body;
  expect(dynamic.reference_context.map((r) => [r.description, r.role])).toEqual(
    [
      ['Described color-1.png', 'base'],
      ['Described color-2.png', 'reference'],
    ],
  );

  const [call] = api.called(GENERATE);
  expect(call.body).toBeInstanceOf(FormData);
  expect('Content-Type' in call.headers).toBe(false);
  expect([...call.body.keys()]).toEqual([
    'request',
    'reference_1',
    'reference_2',
  ]);
  const body = editRequest(call);
  expect(body.prompt).toBe(editing.generation.request.prompt);
  expect(body.idempotency_key).toEqual(expect.any(String));
  expect(
    body.reference_images.map((r) => [r.sha256, r.description, r.role]),
  ).toEqual([
    [editing.files[0].sha256, 'Described color-1.png', 'base'],
    [editing.files[1].sha256, 'Described color-2.png', 'reference'],
  ]);
  expect(await sha256Hex(call.body.get('reference_1'))).toBe(
    editing.files[0].sha256,
  );
  expect(await sha256Hex(call.body.get('reference_2'))).toBe(
    editing.files[1].sha256,
  );
  expect(call.body.get('reference_1').name).toBe('color-1.png');
  const applied = Object.fromEntries(
    body.controls.map((c) => [c.label, c.apply_to_edit]),
  );
  expect(applied).toMatchObject({
    'Appearance change': true,
    'Background change': false,
    'Preserve identity': false,
    'Preserve composition': false,
  });
  // Kept controls still carry their values for the snapshot.
  expect(body.controls.find((c) => c.label === 'Background change').value).toBe(
    '',
  );

  // The result names its sources; reopening it in this tab keeps exact bytes.
  const sources = screen.getByRole('list', { name: 'Edited from' });
  expect(within(sources).getAllByRole('listitem')).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: 'Reuse settings' }));
  await waitFor(() =>
    expect(within(referencesRegion()).getAllByRole('listitem')).toHaveLength(2),
  );
  expect(screen.queryByText('Original file needed to edit.')).toBeNull();
  expect(bar().disabled).toBe(false);
  expect(api.calls.some((c) => c.key.startsWith('DELETE'))).toBe(false);
});

test('adding a reference to a saved edit keeps the base attached by saved identity', async () => {
  const base = libraryRecord({
    id: 'saved-base',
    image_id: 'saved-base',
    storage_id: 'storage-base',
    filename: 'saved-base.png',
    content_type: 'image/png',
    width: 40,
    height: 24,
    dimensions: { width: 40, height: 24 },
    original_prompt: 'Saved base idea',
  });
  setup(
    {
      'GET /api/images/library/file/storage-base/saved-base.png': () =>
        new Blob([bytesOf(editing.files[0].base64)], { type: 'image/png' }),
    },
    [base],
  );
  renderSavedEdit(base);
  await ready();
  await waitFor(() => expect(prompt().value).toBe('Saved base idea'));
  attach(fixtureFile(1));
  await waitFor(() =>
    expect(within(referencesRegion()).getAllByRole('listitem')).toHaveLength(2),
  );
  await waitFor(() => expect(api.called(ANALYZE)).toHaveLength(2));
  const contexts = api
    .called(ANALYZE)
    .map((call) => JSON.parse(call.body.get('context')));
  expect(contexts[0].reference_images).toEqual([]);
  expect(contexts[1].reference_images[0]).toMatchObject({
    id: 'image:saved-base',
    description: expect.any(String),
    role: 'base',
  });
});

test('separate reference additions while the base is loading keep both uploads in order', async () => {
  const base = libraryRecord({
    id: 'queued-base',
    image_id: 'queued-base',
    storage_id: 'storage-queue',
    filename: 'queued-base.png',
    content_type: 'image/png',
    original_prompt: 'Queued base idea',
  });
  let release;
  setup(
    {
      'GET /api/images/library/file/storage-queue/queued-base.png': () =>
        new Promise((resolve) => {
          release = () =>
            resolve(
              new Blob([bytesOf(editing.files[0].base64)], {
                type: 'image/png',
              }),
            );
        }),
    },
    [base],
  );
  renderSavedEdit(base);
  await waitFor(() => expect(prompt().value).toBe('Queued base idea'));
  attach(fixtureFile(0));
  await waitFor(() => expect(release).toBeTypeOf('function'));
  attach(fixtureFile(1));
  release();
  await waitFor(() =>
    expect(within(referencesRegion()).getAllByRole('listitem')).toHaveLength(3),
  );
  const names = [...referencesRegion().querySelectorAll('.ref-name')].map(
    (n) => n.textContent,
  );
  expect(names).toEqual([
    'queued-base.png',
    editing.files[0].filename,
    editing.files[1].filename,
  ]);
  expect(api.called(GENERATE)).toHaveLength(0);
});

test('a saved base with empty MIME fields falls back to its filename', async () => {
  const base = libraryRecord({
    id: 'untyped-base',
    image_id: 'untyped-base',
    storage_id: 'storage-untyped',
    filename: 'untyped-base.png',
    content_type: '',
    original_prompt: 'Untyped base idea',
  });
  setup(
    {
      'GET /api/images/library/file/storage-untyped/untyped-base.png': () =>
        new Blob([bytesOf(editing.files[0].base64)]),
    },
    [base],
  );
  renderSavedEdit(base);
  await waitFor(() => expect(prompt().value).toBe('Untyped base idea'));
  attach(fixtureFile(1));
  await waitFor(() =>
    expect(within(referencesRegion()).getAllByRole('listitem')).toHaveLength(2),
  );
  await waitFor(() => expect(api.called(ANALYZE)).toHaveLength(2));
  expect(api.called(ANALYZE)[0].body.get('image').type).toBe('image/png');
});

test('a saved base read that finishes after New Draft is discarded', async () => {
  const base = libraryRecord({
    id: 'late-base',
    image_id: 'late-base',
    storage_id: 'storage-late',
    filename: 'late-base.png',
    content_type: 'image/png',
    original_prompt: 'Late base idea',
  });
  let release;
  setup(
    {
      'GET /api/images/library/file/storage-late/late-base.png': () =>
        new Promise((resolve) => {
          release = () =>
            resolve(
              new Blob([bytesOf(editing.files[0].base64)], {
                type: 'image/png',
              }),
            );
        }),
    },
    [base],
  );
  renderSavedEdit(base);
  await waitFor(() => expect(prompt().value).toBe('Late base idea'));
  attach(fixtureFile(1));
  await waitFor(() => expect(release).toBeTypeOf('function'));
  fireEvent.click(screen.getByRole('button', { name: 'New draft' }));
  release();
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(prompt().value).toBe('');
  // A new draft keeps the chosen mode (Edit) but holds no references.
  expect(screen.getByRole('radio', { name: 'Edit image' }).checked).toBe(true);
  expect(within(referencesRegion()).queryAllByRole('listitem')).toHaveLength(0);
  expect(api.called(ANALYZE)).toHaveLength(0);
});

test('a refused upload does not leave the saved base attached by itself', async () => {
  const base = libraryRecord({
    id: 'refused-base',
    image_id: 'refused-base',
    storage_id: 'storage-refused',
    filename: 'refused-base.png',
    content_type: 'image/png',
    original_prompt: 'Refused base idea',
  });
  setup(
    {
      'GET /api/images/library/file/storage-refused/refused-base.png': () =>
        new Blob([bytesOf(editing.files[0].base64)], { type: 'image/png' }),
    },
    [base],
  );
  renderSavedEdit(base);
  await waitFor(() => expect(prompt().value).toBe('Refused base idea'));
  attach(new File(['bad'], 'bad.txt', { type: 'text/plain' }));
  await screen.findByText(/not a PNG, JPEG or WebP image/);
  expect(within(referencesRegion()).queryAllByRole('listitem')).toHaveLength(0);
  expect(api.called(ANALYZE)).toHaveLength(0);
});

test('reordering swaps the base, descriptors and file order', async () => {
  setup();
  renderApp();
  await ready();
  attach(fixtureFile(0), fixtureFile(1));
  await settled();
  await waitFor(() => expect(api.called(ANALYZE)).toHaveLength(2));
  refAction(2, /^Move earlier/);
  expect(
    within(referencesRegion()).getByRole('listitem', {
      name: 'Base: color-2.png',
    }),
  ).toBeTruthy();
  type('Use the first as the color');
  generateEdit();
  await waitFor(() => expect(api.called(GENERATE)).toHaveLength(1));
  const [call] = api.called(GENERATE);
  const body = editRequest(call);
  expect(body.reference_images.map((r) => [r.sha256, r.role])).toEqual([
    [editing.files[1].sha256, 'base'],
    [editing.files[0].sha256, 'reference'],
  ]);
  expect(await sha256Hex(call.body.get('reference_1'))).toBe(
    editing.files[1].sha256,
  );
  // An edit may apply no controls at all.
  expect(body.controls.every((c) => c.apply_to_edit === false)).toBe(true);
});

test('legacy four-reference server: one sends one file; four is its limit and keeps order', async () => {
  // A server from before model-aware limits states a fixed limit of four.
  setup({}, [], editing.legacy_capabilities);
  renderApp();
  await ready();
  attach(extraFile(1));
  await settled();
  type('Make it brighter');
  generateEdit();
  await waitFor(() => expect(api.called(GENERATE)).toHaveLength(1));
  let call = api.called(GENERATE)[0];
  expect([...call.body.keys()]).toEqual(['request', 'reference_1']);
  expect(editRequest(call).reference_images).toHaveLength(1);
  expect(editRequest(call).reference_images[0].role).toBe('base');
  await screen.findByRole('heading', { name: EDIT_TITLE });

  attach(extraFile(2), extraFile(3), extraFile(4), extraFile(5));
  expect(
    await screen.findByText(
      '4 files not added. Qwen-Image-2.1 accepts up to 4 references here.',
    ),
  ).toBeTruthy();
  await settled();
  // An over-limit gesture is refused whole; no chosen file is silently lost.
  expect(within(referencesRegion()).getAllByRole('listitem')).toHaveLength(1);
  expect(api.called(ANALYZE)).toHaveLength(1);
  attach(extraFile(2), extraFile(3), extraFile(4));
  await settled();
  expect(within(referencesRegion()).getAllByRole('listitem')).toHaveLength(4);
  generateEdit();
  await waitFor(() => expect(api.called(GENERATE)).toHaveLength(2));
  call = api.called(GENERATE)[1];
  expect([...call.body.keys()]).toEqual([
    'request',
    'reference_1',
    'reference_2',
    'reference_3',
    'reference_4',
  ]);
  const names = [1, 2, 3, 4].map((n) => call.body.get(`reference_${n}`).name);
  expect(names).toEqual([
    'extra-1.png',
    'extra-2.png',
    'extra-3.png',
    'extra-4.png',
  ]);
});

test('a retry after a lost answer resends the frozen files, key and providers', async () => {
  let attempt = 0;
  setup({
    [GENERATE]: () => {
      attempt += 1;
      return attempt === 1
        ? networkFailure()
        : respond(202, editing.generation.accepted);
    },
  });
  renderApp();
  await ready();
  attach(fixtureFile(0), fixtureFile(1));
  await settled();
  await waitFor(() => expect(api.called(ANALYZE)).toHaveLength(2));
  type('Change only the color');
  generateEdit();
  await screen.findByText('The API is unreachable.');

  // Settings and references change before the retry.
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
  const dialog = await screen.findByRole('dialog', { name: 'Settings' });
  const group = await within(dialog).findByRole('group', {
    name: 'Language model',
  });
  fireEvent.change(within(group).getByLabelText(/^Endpoint/), {
    target: { value: ALTERNATE.LLM_MODEL_ENDPOINT_1 },
  });
  fireEvent.change(within(group).getByLabelText(/^Model name/), {
    target: { value: ALTERNATE.LLM_MODEL_NAME },
  });
  fireEvent.change(within(group).getByLabelText(/^API key/), {
    target: { value: ALTERNATE.LLM_MODEL_KEY_1 },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() =>
    expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull(),
  );
  refAction(2, /^Remove from draft/);

  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await screen.findByRole('heading', { name: EDIT_TITLE });
  const [first, second] = api.called(GENERATE);
  expect(decode(first)).toBeNull();
  expect(decode(second)).toBeNull();
  const a = editRequest(first);
  const b = editRequest(second);
  expect(b.idempotency_key).toBe(a.idempotency_key);
  expect(b.reference_images).toEqual(a.reference_images);
  expect([...second.body.keys()]).toEqual([
    'request',
    'reference_1',
    'reference_2',
  ]);
  expect(await sha256Hex(second.body.get('reference_2'))).toBe(
    editing.files[1].sha256,
  );
});

test('a saved edit whose sources are not here asks for the originals and blocks editing', async () => {
  const saved = listedFromJob(clone(editing.generation.complete.result));
  setup({}, [saved]);
  renderSavedEdit(saved);
  await screen.findByRole('button', {
    name: 'Attach original for reference 1',
  });
  expect(screen.getAllByText('Original file needed to edit.')).toHaveLength(2);
  const submit = bar();
  expect(submit.disabled).toBe(true);
  expect(screen.getByText('Attach reference 1 again to edit.')).toBeTruthy();
  // Restoring never re-describes the saved references.
  expect(api.called(ANALYZE)).toHaveLength(0);

  const slot = (n) =>
    within(referencesRegion())
      .getAllByRole('listitem')
      [n].querySelector('input[type="file"]');
  fireEvent.change(slot(0), { target: { files: [fixtureFile(1)] } });
  await screen.findByText('color-2.png is not the original reference image.');
  fireEvent.change(slot(0), { target: { files: [fixtureFile(0)] } });
  await waitFor(() =>
    expect(screen.getAllByText('Original file needed to edit.')).toHaveLength(
      1,
    ),
  );
  fireEvent.change(slot(1), { target: { files: [fixtureFile(1)] } });
  await waitFor(() => expect(submit.disabled).toBe(false));

  generateEdit();
  await waitFor(() => expect(api.called(GENERATE)).toHaveLength(1));
  const [call] = api.called(GENERATE);
  // The saved descriptors, roles and descriptions are the provenance.
  expect(editRequest(call).reference_images).toEqual(
    editing.generation.request.reference_images,
  );
  expect(await sha256Hex(call.body.get('reference_1'))).toBe(
    editing.files[0].sha256,
  );
  expect(api.called(ANALYZE)).toHaveLength(0);
  expect(api.calls.some((c) => c.key.startsWith('DELETE'))).toBe(false);
});

const INSPECT = 'POST /api/images/reference-analysis?inspect_only=true';
/** The browser cannot hash here (plain HTTP): only random ids remain. */
const withoutSubtleCrypto = () =>
  vi.stubGlobal('crypto', { randomUUID: () => `k-${++urlCount}` });
const checksumFor = (form) => {
  const image = form.get('image');
  const item = editing.files.find((f) => f.filename === image.name);
  return {
    source_sha256: item?.sha256 ?? 'f'.repeat(64),
    dimensions: editing.inspection.response.dimensions,
    metadata: editing.inspection.response.metadata,
  };
};

test('without browser hashing a restored edit verifies originals by server checksum', async () => {
  withoutSubtleCrypto();
  const saved = listedFromJob(clone(editing.generation.complete.result));
  setup({ [INSPECT]: (form) => checksumFor(form) }, [saved]);
  renderSavedEdit(saved);
  await screen.findByRole('button', {
    name: 'Attach original for reference 1',
  });
  const slot = (n) =>
    within(referencesRegion())
      .getAllByRole('listitem')
      [n].querySelector('input[type="file"]');

  fireEvent.change(slot(0), { target: { files: [fixtureFile(1)] } });
  await screen.findByText('color-2.png is not the original reference image.');
  expect(screen.queryAllByText('Original file needed to edit.')).toHaveLength(
    2,
  );

  fireEvent.change(slot(0), { target: { files: [fixtureFile(0)] } });
  await waitFor(() =>
    expect(screen.getAllByText('Original file needed to edit.')).toHaveLength(
      1,
    ),
  );
  fireEvent.change(slot(1), { target: { files: [fixtureFile(1)] } });
  await waitFor(() => expect(bar().disabled).toBe(false));

  expect(api.called(INSPECT)).toHaveLength(3);
  // Checksum-only work never describes, proposes or generates.
  expect(api.called(ANALYZE)).toHaveLength(0);
  expect(api.called(GENERATE)).toHaveLength(0);
  expect(prompt().value).toBe(editing.generation.request.prompt);
  expect(api.calls.some((c) => c.key.startsWith('DELETE'))).toBe(false);
});

test('a checksum answer that arrives after the reference was removed changes nothing', async () => {
  withoutSubtleCrypto();
  const saved = listedFromJob(clone(editing.generation.complete.result));
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  setup(
    {
      [INSPECT]: async (form) => {
        await gate;
        return checksumFor(form);
      },
    },
    [saved],
  );
  renderSavedEdit(saved);
  await screen.findByRole('button', {
    name: 'Attach original for reference 1',
  });
  const item = () => within(referencesRegion()).getAllByRole('listitem')[0];
  fireEvent.change(item().querySelector('input[type="file"]'), {
    target: { files: [fixtureFile(0)] },
  });
  await screen.findByText('Checking file…');
  refAction(1, /^Remove from draft/);
  release();
  await waitFor(() =>
    expect(within(referencesRegion()).getAllByRole('listitem')).toHaveLength(1),
  );
  expect(screen.queryByText('Checking file…')).toBeNull();
  expect(within(referencesRegion()).queryByText('color-1.png')).toBeNull();
});

test('a failed checksum names the file and the original can be attached again', async () => {
  withoutSubtleCrypto();
  const saved = listedFromJob(clone(editing.generation.complete.result));
  let fail = true;
  setup(
    {
      [INSPECT]: (form) =>
        fail
          ? respond(503, { detail: 'Checksum unavailable.' })
          : checksumFor(form),
    },
    [saved],
  );
  renderSavedEdit(saved);
  const button = await screen.findByRole('button', {
    name: 'Attach original for reference 1',
  });
  const input = () =>
    within(referencesRegion())
      .getAllByRole('listitem')[0]
      .querySelector('input[type="file"]');
  fireEvent.change(input(), { target: { files: [fixtureFile(0)] } });
  await screen.findByText(/color-1\.png could not be checked/);
  expect(button.isConnected).toBe(true);
  fail = false;
  fireEvent.change(input(), { target: { files: [fixtureFile(0)] } });
  await waitFor(() =>
    expect(screen.getAllByText('Original file needed to edit.')).toHaveLength(
      1,
    ),
  );
});

test('a saved edit on a server without editing is never sent as text', async () => {
  const saved = listedFromJob(clone(editing.generation.complete.result));
  setup({}, [saved], null);
  renderSavedEdit(saved);
  await screen.findByText(
    'This server cannot edit images. Choose Text to image to generate from text.',
  );
  expect(bar().disabled).toBe(true);
  // Removing every reference keeps Edit chosen: still blocked, never text.
  refAction(1, /^Remove from draft/);
  refAction(1, /^Remove from draft/);
  await waitFor(() =>
    expect(
      screen.queryAllByRole('button', { name: /^Actions for reference/ }),
    ).toHaveLength(0),
  );
  expect(bar().disabled).toBe(true);
  fireEvent.click(screen.getByRole('radio', { name: 'Text to image' }));
  await waitFor(() =>
    expect(bar(/Generate image|Regenerate/).disabled).toBe(false),
  );
  expect(api.called(GENERATE)).toHaveLength(0);
});

test('arranging by keyboard keeps focus on the moved reference', async () => {
  setup();
  renderApp();
  await ready();
  attach(fixtureFile(0), fixtureFile(1));
  await settled();
  const trigger = screen.getByRole('button', {
    name: 'Actions for reference 2',
  });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  const earlier = await screen.findByRole('menuitem', {
    name: /^Move earlier/,
  });
  fireEvent.click(earlier);
  // The moved image is now first: its own actions button keeps focus.
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Actions for reference 1' }),
    ),
  );
  expect(document.activeElement.closest('li').getAttribute('aria-label')).toBe(
    'Base: color-2.png',
  );
  expect(document.querySelector('[title]')).toBeNull();
});

test('removing a reference moves focus to a neighbouring reference, never the page', async () => {
  setup();
  renderApp();
  await ready();
  attach(fixtureFile(0), fixtureFile(1));
  await settled();
  refAction(1, /^Remove from draft/);
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Actions for reference 1' }),
    ),
  );
  expect(document.activeElement.closest('li').getAttribute('aria-label')).toBe(
    'Base: color-2.png',
  );
  refAction(1, /^Remove from draft/);
  await waitFor(() =>
    expect(document.activeElement).toBe(
      within(referencesRegion()).getByRole('button', { name: /Add reference/ }),
    ),
  );
});

const NEW_IDEA = 'A lighthouse above a stormy sea at dusk, oil painting';
const appearanceInput = () =>
  screen.getByRole('textbox', { name: 'Appearance change' });
const chooseAppearance = () =>
  fireEvent.change(appearanceInput(), {
    target: { value: 'Watercolor rendering' },
  });
const requestControl = (label) =>
  editRequest(api.called(GENERATE).at(-1)).controls.find(
    (c) => c.label === label,
  );

test('a genuinely new typed idea returns earlier manual choices to the preserved source', async () => {
  setup();
  renderApp();
  await ready();
  attach(fixtureFile(0));
  await screen.findByText('Described color-1.png');
  type('Make the photo warmer with a golden sky');
  await ready();
  chooseAppearance();
  expect(screen.getByText(/1 adjustment applied/)).toBeTruthy();

  type(NEW_IDEA);
  await waitFor(() => expect(appearanceInput().value).toBe(''));
  expect(
    screen
      .getByRole('button', { name: 'Apply Appearance change to edit' })
      .getAttribute('aria-pressed'),
  ).toBe('false');
  generateEdit();
  await waitFor(() => expect(api.called(GENERATE)).toHaveLength(1));
  const body = editRequest(api.called(GENERATE)[0]);
  expect(body.prompt).toBe(NEW_IDEA);
  expect(body.controls.length).toBeGreaterThan(0);
  expect(
    body.controls.filter((c) => c.id === 'edit-appearance-v1'),
  ).not.toHaveLength(0);
  for (const label of [
    'Appearance change',
    'Background change',
    'Preserve pose',
    'Preserve composition',
  ])
    expect(requestControl(label).apply_to_edit).toBe(false);
  // Source files stay attached.
  expect(within(referencesRegion()).getAllByRole('listitem')).toHaveLength(1);
});

test('a near-anchor edit keeps the manual choice of an edit', async () => {
  setup();
  renderApp();
  await ready();
  attach(fixtureFile(0));
  await screen.findByText('Described color-1.png');
  type('Make the photo warmer with a golden sky');
  await ready();
  chooseAppearance();
  type('Make the photo warmer with a golden sunset');
  await new Promise((resolve) => setTimeout(resolve, 600));
  expect(appearanceInput().value).toBe('Watercolor rendering');
  generateEdit();
  await waitFor(() => expect(api.called(GENERATE)).toHaveLength(1));
  expect(requestControl('Appearance change').apply_to_edit).toBe(true);
});

test('Undo of a reference proposal keeps the manual choice', async () => {
  setup();
  renderApp();
  await ready();
  attach(fixtureFile(0), fixtureFile(1));
  await screen.findByText('Prompt updated from reference 2.');
  await ready();
  chooseAppearance();
  fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
  expect(prompt().value).toBe('');
  await new Promise((resolve) => setTimeout(resolve, 600));
  expect(appearanceInput().value).toBe('Watercolor rendering');
  expect(
    screen
      .getByRole('button', { name: 'Apply Appearance change to edit' })
      .getAttribute('aria-pressed'),
  ).toBe('true');
});

// --- Generation modes: Text to image, Edit image, Asset image -------------

const modeRadio = (name) => screen.getByRole('radio', { name });
const editRadio = () => screen.getByRole('radio', { name: /^Edit image/ });
const listed = () =>
  screen.queryByRole('region', { name: 'References' })
    ? within(referencesRegion())
        .queryAllByRole('listitem')
        .map((row) => row.textContent)
    : [];
const undoKey = () =>
  fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
const redoKey = () =>
  fireEvent.keyDown(document.body, { key: 'y', ctrlKey: true });
const pause = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

test('Text to image is the default; Edit chosen before any reference is blocked and never sent as text', async () => {
  setup();
  renderApp();
  await ready();
  expect(modeRadio('Text to image').checked).toBe(true);
  expect(screen.queryByRole('region', { name: 'References' })).toBeNull();
  type('A lantern on a pier');
  fireEvent.click(editRadio());
  expect(editRadio().checked).toBe(true);
  // Edit offers Add reference; every image is a reference, so Load image
  // is not offered here.
  expect(
    within(referencesRegion()).getByRole('button', { name: /Add reference/ })
      .disabled,
  ).toBe(false);
  expect(
    screen.queryByRole('button', { name: 'Load image', exact: true }),
  ).toBeNull();
  expect(screen.getByText('Add the image to edit.')).toBeTruthy();
  expect(bar().disabled).toBe(true);
  fireEvent.keyDown(prompt(), { key: 'Enter' });
  await pause();
  expect(api.called(GENERATE)).toHaveLength(0);

  attach(fixtureFile(0));
  await settled();
  await waitFor(() => expect(bar().disabled).toBe(false));
  expect(screen.queryByText('Add the image to edit.')).toBeNull();
});

test('Text to image parks the references, never sends them, and Edit brings the same ones back', async () => {
  setup();
  renderApp();
  await ready();
  attach(fixtureFile(0), fixtureFile(1));
  await settled();
  await waitFor(() => expect(api.called(ANALYZE)).toHaveLength(2));
  const before = listed();
  expect(before).toHaveLength(2);

  fireEvent.click(modeRadio('Text to image'));
  expect(screen.queryByRole('region', { name: 'References' })).toBeNull();
  expect(
    screen.getByRole('radio', { name: 'Edit image (2 references kept)' }),
  ).toBeTruthy();
  type('A lantern on a pier');
  fireEvent.keyDown(prompt(), { key: 'Enter' });
  await waitFor(() => expect(api.called(GENERATE)).toHaveLength(1));
  const [text] = api.called(GENERATE);
  expect(text.body).not.toBeInstanceOf(FormData);
  expect(text.body).not.toHaveProperty('reference_images');
  expect(text.body).not.toHaveProperty('region_edit');
  expect(text.body.controls.some((c) => 'apply_to_edit' in c)).toBe(false);
  await waitFor(() =>
    expect(bar(/Regenerate|Generate image/).disabled).toBe(false),
  );

  fireEvent.click(editRadio());
  await waitFor(() => expect(listed()).toEqual(before));
  // Exact bytes come back from this tab; nothing is described again.
  await pause();
  expect(api.called(ANALYZE)).toHaveLength(2);
  await waitFor(() => expect(bar().disabled).toBe(false));
  generateEdit();
  await waitFor(() => expect(api.called(GENERATE)).toHaveLength(2));
  const edit = api.called(GENERATE)[1];
  expect(edit.body).toBeInstanceOf(FormData);
  expect(editRequest(edit).reference_images.map((r) => r.sha256)).toEqual([
    editing.files[0].sha256,
    editing.files[1].sha256,
  ]);
  expect(await sha256Hex(edit.body.get('reference_2'))).toBe(
    editing.files[1].sha256,
  );
});

test('undo and redo restore the mode choice with its references', async () => {
  setup();
  renderApp();
  await ready();
  attach(fixtureFile(0));
  await settled();
  const before = listed();
  fireEvent.click(modeRadio('Text to image'));
  expect(listed()).toEqual([]);
  undoKey();
  await waitFor(() => expect(editRadio().checked).toBe(true));
  await waitFor(() => expect(listed()).toEqual(before));
  redoKey();
  await waitFor(() => expect(modeRadio('Text to image').checked).toBe(true));
  expect(listed()).toEqual([]);
  // The parked references are still there to come back.
  fireEvent.click(editRadio());
  await waitFor(() => expect(listed()).toEqual(before));
  expect(api.called(ANALYZE)).toHaveLength(1);
});

test('Asset image never carries parked references', async () => {
  setup();
  renderApp();
  await ready();
  attach(fixtureFile(0));
  await settled();
  fireEvent.click(modeRadio('Asset image for 3D'));
  expect(screen.queryByRole('region', { name: 'References' })).toBeNull();
  type('A ceramic vase');
  await openStandardControls();
  await screen.findByRole('radiogroup', { name: 'Material' });
  fireEvent.keyDown(prompt(), { key: 'Enter' });
  await waitFor(() => expect(api.called(GENERATE)).toHaveLength(1));
  const [call] = api.called(GENERATE);
  expect(call.body).not.toBeInstanceOf(FormData);
  expect(call.body.generation_mode).toBe('trellis');
  expect(call.body).not.toHaveProperty('reference_images');
  fireEvent.click(editRadio());
  await waitFor(() => expect(listed()).toHaveLength(1));
});

test('New draft returns to Text to image, drops parked references and keeps the chosen aspect', async () => {
  setup();
  renderApp();
  await ready();
  fireEvent.click(screen.getByRole('radio', { name: '1:1' }));
  attach(fixtureFile(0));
  await settled();
  fireEvent.click(modeRadio('Text to image'));
  expect(
    screen.getByRole('radio', { name: 'Edit image (1 reference kept)' }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'New draft' }));
  await waitFor(() => expect(modeRadio('Text to image').checked).toBe(true));
  expect(screen.getByRole('radio', { name: 'Edit image' })).toBeTruthy();
  expect(screen.getByRole('radio', { name: '1:1' }).checked).toBe(true);
  fireEvent.click(editRadio());
  expect(listed()).toEqual([]);
  expect(screen.getByText('Add the image to edit.')).toBeTruthy();
});

test('a restored saved edit selects Edit', async () => {
  const saved = listedFromJob(clone(editing.generation.complete.result));
  setup({}, [saved]);
  renderSavedEdit(saved);
  await waitFor(() => expect(editRadio().checked).toBe(true));
  await waitFor(() => expect(listed()).toHaveLength(2));
});

test('Use as reference selects Edit with the reference in one undo step', async () => {
  const base = libraryRecord({
    id: 'use-base',
    image_id: 'use-base',
    storage_id: 'storage-use',
    filename: 'use-base.png',
    content_type: 'image/png',
    original_prompt: 'Use base idea',
  });
  setup(
    {
      'GET /api/images/library/file/storage-use/use-base.png': () =>
        new Blob([bytesOf(editing.files[0].base64)], { type: 'image/png' }),
    },
    [base],
  );
  renderSavedEdit(base);
  await waitFor(() => expect(prompt().value).toBe('Use base idea'));
  expect(modeRadio('Text to image').checked).toBe(true);
  fireEvent.click(await screen.findByRole('button', { name: 'Edit image' }));
  await waitFor(() => expect(editRadio().checked).toBe(true));
  await waitFor(() => expect(listed()).toHaveLength(1));
  undoKey();
  await waitFor(() => expect(modeRadio('Text to image').checked).toBe(true));
  expect(listed()).toEqual([]);
});

test('a reference parked before its checksum arrived comes back with its exact bytes', async () => {
  setup();
  renderApp();
  await ready();
  // The first mode switch happens before the browser finished hashing.
  attach(fixtureFile(0));
  fireEvent.click(modeRadio('Text to image'));
  await pause(60);
  fireEvent.click(editRadio());
  await waitFor(() => expect(listed()).toHaveLength(1));
  await waitFor(() =>
    expect(
      screen.queryAllByText(/Attach reference 1 again|could not be read/),
    ).toHaveLength(0),
  );
  type('Brighten the sky');
  await waitFor(() => expect(bar().disabled).toBe(false));
  generateEdit();
  await waitFor(() => expect(api.called(GENERATE)).toHaveLength(1));
  const [call] = api.called(GENERATE);
  expect(editRequest(call).reference_images[0].sha256).toBe(
    editing.files[0].sha256,
  );
  expect(await sha256Hex(call.body.get('reference_1'))).toBe(
    editing.files[0].sha256,
  );
});

test('choosing Text to image while an edit is prepared sends nothing', async () => {
  const waiting = [];
  let held = false;
  setup({
    [DYNAMIC]: () =>
      held
        ? new Promise((resolve) =>
            waiting.push(() => resolve(m1.dynamic_response)),
          )
        : m1.dynamic_response,
  });
  renderApp();
  await ready();
  attach(fixtureFile(0));
  await settled();
  type('Brighten the sky over the pier');
  await waitFor(() => expect(bar().disabled).toBe(false));
  held = true;
  type('Brighten the sky over the old pier');
  generateEdit();
  await waitFor(() => expect(waiting.length).toBeGreaterThan(0));
  fireEvent.click(modeRadio('Text to image'));
  held = false;
  for (let round = 0; round < 5; round += 1) {
    while (waiting.length) waiting.shift()();
    await pause(30);
  }
  await screen.findByText(
    'The mode changed while options were prepared. Submit again to use it.',
  );
  expect(api.called(GENERATE)).toHaveLength(0);
});

test('the one Generate button docks at the top while its place has scrolled off and keeps focus', async () => {
  setup();
  let viewportTop = 0;
  let headerBottom = 0;
  const viewportDescriptor = Object.getOwnPropertyDescriptor(
    window,
    'visualViewport',
  );
  const viewport = new EventTarget();
  Object.defineProperties(viewport, {
    offsetTop: { get: () => viewportTop },
    height: { value: 300 },
    scale: { value: 1 },
  });
  Object.defineProperty(window, 'visualViewport', {
    configurable: true,
    value: viewport,
  });
  renderApp();
  await ready();
  type('A lantern on a pier');
  const button = bar(/Generate image/);
  expect(document.querySelectorAll('.generate-btn')).toHaveLength(1);
  button.focus();
  let away = false;
  let belowFold = true;
  let columnGone = false;
  const original = Element.prototype.getBoundingClientRect;
  const rect = (top, height, left = 0, width = 800) => ({
    top,
    bottom: top + height,
    left,
    right: left + width,
    width,
    height,
    x: left,
    y: top,
  });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
    function box() {
      if (this.classList?.contains('app-header')) return rect(0, headerBottom);
      if (this.classList?.contains('generate-slot'))
        return away
          ? rect(-300, 44, 700, 80)
          : rect(belowFold ? 1600 : 200, 44, 700, 80);
      if (this.classList?.contains('studio-main'))
        return columnGone
          ? rect(-3500, 3000)
          : away
            ? rect(-600, 3000)
            : rect(0, 3000);
      return original.call(this);
    },
  );
  try {
    fireEvent.scroll(window);
    await act(() => pause(60));
    expect(document.querySelector('.generate-dock[data-docked]')).toBeNull();
    belowFold = false;
    fireEvent.scroll(window);
    await act(() => pause(60));
    expect(document.querySelector('.generate-dock[data-docked]')).toBeNull();
    away = true;
    fireEvent.scroll(window);
    await waitFor(() =>
      expect(
        document.querySelector('.generate-dock[data-docked]'),
      ).toBeTruthy(),
    );
    // The same element moved; focus and the tab stop did not.
    expect(bar(/Generate image/)).toBe(button);
    expect(document.activeElement).toBe(button);
    // Pinned to the top edge, never the bottom; focused controls stop below it.
    const dock = document.querySelector('.generate-dock[data-docked]');
    expect(dock.style.getPropertyValue('--dock-top')).toBe('12px');
    expect(dock.style.getPropertyValue('--dock-bottom')).toBe('');
    viewportTop = 50;
    viewport.dispatchEvent(new Event('scroll'));
    await waitFor(() =>
      expect(dock.style.getPropertyValue('--dock-top')).toBe('62px'),
    );
    headerBottom = 90;
    fireEvent.resize(window);
    await waitFor(() =>
      expect(dock.style.getPropertyValue('--dock-top')).toBe('102px'),
    );
    viewportTop = 0;
    headerBottom = 0;
    const column = document.querySelector('.studio-main');
    expect(column.style.getPropertyValue('--generate-dock-block')).not.toBe(
      '0px',
    );
    // In stacked layouts the result and history follow the controls. The
    // action must stay reachable even after the controls column ends.
    columnGone = true;
    fireEvent.scroll(window);
    await act(() => pause(60));
    await waitFor(() =>
      expect(
        document.querySelector('.generate-dock[data-docked]'),
      ).toBeTruthy(),
    );
    expect(bar(/Generate image/)).toBe(button);
    columnGone = false;
    fireEvent.click(editRadio());
    await waitFor(() =>
      expect(document.querySelector('.generate-reason')?.textContent).toBe(
        'Add the image to edit.',
      ),
    );
    away = false;
    fireEvent.scroll(window);
    await waitFor(() =>
      expect(document.querySelector('.generate-dock[data-docked]')).toBeNull(),
    );
    expect(document.querySelector('.generate-reason')).toBeNull();
    expect(screen.getByText('Add the image to edit.')).toBeTruthy();
    expect(column.style.getPropertyValue('--generate-dock-block')).toBe('0px');
    // Docking is position only: nothing was generated.
    expect(api.called(GENERATE)).toHaveLength(0);
  } finally {
    if (viewportDescriptor)
      Object.defineProperty(window, 'visualViewport', viewportDescriptor);
    else delete window.visualViewport;
    vi.restoreAllMocks();
  }
});

test('a control focused behind the top-docked Generate scrolls clear of it', async () => {
  setup();
  renderApp();
  await ready();
  const original = Element.prototype.getBoundingClientRect;
  const rect = (top, height, left, width) => ({
    top,
    bottom: top + height,
    left,
    right: left + width,
    width,
    height,
    x: left,
    y: top,
  });
  let fieldTop = 30;
  let dockHeight = 52;
  const scrollBy = vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
    function box() {
      if (this.classList?.contains('generate-slot'))
        return rect(-300, 44, 700, 80);
      if (this.classList?.contains('studio-main'))
        return rect(-600, 3000, 0, 800);
      if (this.classList?.contains('generate-dock'))
        return rect(12, dockHeight, 700, 80);
      if (this.id === 'idea-area' || this.tagName === 'TEXTAREA')
        return rect(fieldTop, 80, 0, 800);
      return original.call(this);
    },
  );
  try {
    fireEvent.scroll(window);
    await waitFor(() =>
      expect(
        document.querySelector('.generate-dock[data-docked]'),
      ).toBeTruthy(),
    );
    const area = document.querySelector('.prompt-card textarea');
    act(() => area.focus());
    // Hidden behind the pill: moved up by the overlap plus the gap.
    await waitFor(() => expect(scrollBy).toHaveBeenCalledTimes(1));
    expect(scrollBy).toHaveBeenCalledWith(0, 30 - (64 + 12));
    // A taller warning must use the measured height, never a fixed 52px.
    dockHeight = 88;
    act(() => area.blur());
    act(() => area.focus());
    await waitFor(() => expect(scrollBy).toHaveBeenCalledTimes(2));
    expect(scrollBy).toHaveBeenLastCalledWith(0, 30 - (100 + 12));
    // Clear of it: focus does not scroll the page.
    fieldTop = 300;
    act(() => area.blur());
    act(() => area.focus());
    await act(() => pause(60));
    expect(scrollBy).toHaveBeenCalledTimes(2);
    expect(api.called(GENERATE)).toHaveLength(0);
  } finally {
    vi.restoreAllMocks();
  }
});

test('in Edit a file dropped on the prompt is a reference; in Text it loads settings', async () => {
  setup();
  renderApp();
  await ready();
  const card = () => screen.getByRole('region', { name: 'Prompt' });
  const dropFiles = (...files) => {
    fireEvent.dragEnter(card(), { dataTransfer: { types: ['Files'] } });
    fireEvent.drop(card(), { dataTransfer: { types: ['Files'], files } });
  };
  fireEvent.click(editRadio());
  dropFiles(fixtureFile(0), fixtureFile(1));
  await waitFor(() =>
    expect(within(referencesRegion()).getAllByRole('listitem')).toHaveLength(2),
  );
  await settled();
  expect(api.called('POST /api/images/import-analysis')).toHaveLength(0);
  // Back in Text, Load image returns and the references are set aside.
  fireEvent.click(modeRadio('Text to image'));
  expect(
    screen.getByRole('button', { name: 'Load image', exact: true }),
  ).toBeTruthy();
  expect(listed()).toEqual([]);
});
