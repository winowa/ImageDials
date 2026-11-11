import { openStandardControls } from '../helpers/controlUiTestSupport.js';
/**
 * Undo and redo against work that is still in flight: frozen requests, late
 * reads, reference changes, controls still loading and notices undo does not
 * own. Connected through App with the canonical fixtures.
 */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import editing from '../../../fixtures/api/image-editing.json';
import App from '../../src/app/App.jsx';
import { PROVIDER_OVERRIDE_HEADER } from '../../src/data/api/api.js';
import { sha256Hex } from '../../src/data/media/privateThumbnail.js';
import {
  clone,
  fakeLibrary,
  fixtures,
  installApi,
  libraryRecord,
  networkFailure,
  respond,
} from '../helpers/testSupport.js';

vi.mock('../../src/features/controls/standardRandom.js', async (original) => ({
  ...(await original()),
  randomizeStandard: (entries) => entries,
}));

const { m1 } = fixtures;
const ANALYZE = 'POST /api/images/reference-analysis';
const GENERATE = 'POST /api/generate-image';
const DYNAMIC = 'POST /api/controls/dynamic';
const TRELLIS = 'GET /api/controls/static?generation_mode=trellis';
const EDIT_JOB = `GET /api/generation-jobs/${editing.generation.accepted.generation_job_id}`;
const TEXT_JOB = 'GET /api/generation-jobs/fixture-image-1';
const jobPolicy = { pollIntervalMs: 1, maxConsecutivePollFailures: 3 };
const UPLOADS = {
  image_mime_types: ['image/png', 'image/jpeg', 'image/webp'],
  import_max_bytes: 33554432,
};
// Short debounces so a wrongly scheduled background request shows quickly.
const QUICK = 20;
const QUIET_MS = 150;

let api;
let urlCount = 0;

const bytesOf = (base64) =>
  Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
const fixtureFile = (index) => {
  const item = editing.files[index];
  return new File([bytesOf(item.base64)], item.filename, {
    type: item.content_type,
  });
};
const fixtureBlob = () =>
  new Blob([bytesOf(editing.files[0].base64)], { type: 'image/png' });

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

function setup(overrides = {}, { records = [], edits = true } = {}) {
  const library = fakeLibrary(records);
  api = installApi({
    'GET /api/app-capabilities': () => ({
      ...m1.capabilities,
      uploads: UPLOADS,
      client_policy: {
        controls: { debounce_ms: QUICK, reset_debounce_ms: QUICK },
      },
      ...(edits ? { image_editing: editing.capabilities } : {}),
    }),
    [DYNAMIC]: () => m1.dynamic_response,
    [ANALYZE]: (form) => analysisFor(form),
    [GENERATE]: () => respond(202, editing.generation.accepted),
    [EDIT_JOB]: () => clone(editing.generation.complete),
    ...library.routes,
    ...overrides,
  });
  return api;
}

/** A route whose answers wait until the test settles them, one per call. */
function heldRoute() {
  const pending = [];
  const handler = () =>
    new Promise((resolve) => {
      pending.push(resolve);
    });
  return {
    handler,
    pending,
    settleAll: (value) =>
      pending.splice(0).forEach((resolve) => resolve(value())),
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
const undo = () =>
  fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
const redo = () =>
  fireEvent.keyDown(document.body, { key: 'y', ctrlKey: true });
const referencesRegion = () =>
  screen.getByRole('region', { name: 'References' });
const referenceItems = () =>
  screen.queryByRole('region', { name: 'References' })
    ? within(referencesRegion()).queryAllByRole('listitem')
    : [];
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
const refAction = (n, name) => {
  fireEvent.click(
    screen.getByRole('button', { name: `Actions for reference ${n}` }),
  );
  fireEvent.click(screen.getByRole('menuitem', { name }));
};
const settled = () =>
  waitFor(() => expect(screen.queryAllByText('Describing…')).toHaveLength(0));
const bar = (name = /Generate edit/) =>
  screen.getAllByRole('button', { name }).at(-1);
const editRequest = (call) => JSON.parse(call.body.get('request'));

function savedBase(name) {
  return libraryRecord({
    id: name,
    image_id: name,
    storage_id: `storage-${name}`,
    filename: `${name}.png`,
    content_type: 'image/png',
    original_prompt: `${name} idea`,
  });
}
const fileRoute = (record) =>
  `GET /api/images/library/file/${record.storage_id}/${record.filename}`;

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  localStorage.clear();
  URL.createObjectURL = vi.fn(() => `blob:undo-${++urlCount}`);
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test('the same text draft after undo and redo resubmits with its frozen key', async () => {
  let attempt = 0;
  setup(
    {
      [GENERATE]: () =>
        ++attempt === 1 ? networkFailure() : respond(202, m1.accepted),
      [TEXT_JOB]: () => clone(m1.job_complete),
    },
    { edits: false },
  );
  renderApp();
  await ready();
  type('An amber glass bird');
  fireEvent.keyDown(prompt(), { key: 'Enter' });
  await screen.findByText('The API is unreachable.');

  fireEvent.click(screen.getByRole('radio', { name: '1:1' }));
  undo();
  redo();
  undo();
  await waitFor(() =>
    expect(screen.getByRole('radio', { name: '3:2' }).checked).toBe(true),
  );
  fireEvent.keyDown(prompt(), { key: 'Enter' });
  await waitFor(() => expect(api.called(GENERATE)).toHaveLength(2));
  const [first, second] = api.called(GENERATE);
  expect(second.body).toEqual(first.body);
  expect(second.body.idempotency_key).toBe(first.body.idempotency_key);
  expect(second.headers[PROVIDER_OVERRIDE_HEADER]).toBe(
    first.headers[PROVIDER_OVERRIDE_HEADER],
  );
});

test('an edit returned to by undo and redo resubmits its frozen key, files and providers', async () => {
  let attempt = 0;
  setup({
    [GENERATE]: () =>
      ++attempt === 1
        ? networkFailure()
        : respond(202, editing.generation.accepted),
  });
  renderApp();
  await ready();
  attach(fixtureFile(0), fixtureFile(1));
  await settled();
  await waitFor(() => expect(api.called(ANALYZE)).toHaveLength(2));
  type('Change only the color');
  fireEvent.click(bar());
  await screen.findByText('The API is unreachable.');

  refAction(2, /^Move earlier/);
  undo();
  redo();
  undo();
  await waitFor(() =>
    expect(
      within(referencesRegion()).getByRole('listitem', {
        name: `Base: ${editing.files[0].filename}`,
      }),
    ).toBeTruthy(),
  );
  fireEvent.click(bar());
  await waitFor(() => expect(api.called(GENERATE)).toHaveLength(2));
  const [first, second] = api.called(GENERATE);
  const a = editRequest(first);
  const b = editRequest(second);
  expect(b).toEqual(a);
  expect(b.idempotency_key).toBe(a.idempotency_key);
  expect([...second.body.keys()]).toEqual([...first.body.keys()]);
  for (const name of ['reference_1', 'reference_2'])
    expect(await sha256Hex(second.body.get(name))).toBe(
      await sha256Hex(first.body.get(name)),
    );
  expect(second.headers[PROVIDER_OVERRIDE_HEADER]).toBe(
    first.headers[PROVIDER_OVERRIDE_HEADER],
  );
});

test('a Use as reference read that finishes after undo adds nothing and releases the action', async () => {
  const base = savedBase('late-use');
  const read = heldRoute();
  setup({ [fileRoute(base)]: read.handler }, { records: [base] });
  renderSavedEdit(base);
  await waitFor(() => expect(prompt().value).toBe('late-use idea'));
  type('late-use idea, brighter');
  fireEvent.click(await screen.findByRole('button', { name: 'Edit image' }));
  await waitFor(() => expect(read.pending.length).toBeGreaterThan(0));

  undo();
  await waitFor(() => expect(prompt().value).toBe('late-use idea'));
  // The busy state belonged to the replaced draft.
  expect(
    screen
      .getByRole('button', { name: 'Edit image' })
      .getAttribute('aria-disabled'),
  ).not.toBe('true');
  fireEvent.keyDown(document.activeElement, { key: 'Escape' });

  read.settleAll(fixtureBlob);
  await sleep(QUIET_MS);
  expect(referenceItems()).toHaveLength(0);
  expect(api.called(ANALYZE)).toHaveLength(0);
});

test('a Use as reference read that fails after undo shows no stale error', async () => {
  const base = savedBase('late-fail');
  const read = heldRoute();
  setup({ [fileRoute(base)]: read.handler }, { records: [base] });
  renderSavedEdit(base);
  await waitFor(() => expect(prompt().value).toBe('late-fail idea'));
  type('late-fail idea, darker');
  fireEvent.click(await screen.findByRole('button', { name: 'Edit image' }));
  await waitFor(() => expect(read.pending.length).toBeGreaterThan(0));
  undo();
  await waitFor(() => expect(prompt().value).toBe('late-fail idea'));
  read.settleAll(() => respond(500, { detail: 'Disk unavailable' }));
  await sleep(QUIET_MS);
  expect(screen.queryByText(/original image could not be read/)).toBeNull();
  expect(referenceItems()).toHaveLength(0);
});

test('a base read that fails after undo shows no stale error', async () => {
  const base = savedBase('late-base');
  const read = heldRoute();
  setup({ [fileRoute(base)]: read.handler }, { records: [base] });
  renderSavedEdit(base);
  await waitFor(() => expect(prompt().value).toBe('late-base idea'));
  type('late-base idea, warmer');
  attach(fixtureFile(1));
  await waitFor(() => expect(read.pending.length).toBeGreaterThan(0));
  // Undo takes back the choice of Edit; the typed prompt stays.
  undo();
  await waitFor(() =>
    expect(screen.getByRole('radio', { name: 'Text to image' }).checked).toBe(
      true,
    ),
  );
  expect(prompt().value).toBe('late-base idea, warmer');
  read.settleAll(() => respond(500, { detail: 'Disk unavailable' }));
  await sleep(QUIET_MS);
  expect(screen.queryByText(/could not be added as the base reference/)).toBe(
    null,
  );
  expect(referenceItems()).toHaveLength(0);
  expect(api.called(ANALYZE)).toHaveLength(0);
});

test('a base read still pending when Text to image is chosen adds nothing to either mode', async () => {
  const base = savedBase('late-mode');
  const read = heldRoute();
  setup({ [fileRoute(base)]: read.handler }, { records: [base] });
  renderSavedEdit(base);
  await waitFor(() => expect(prompt().value).toBe('late-mode idea'));
  attach(fixtureFile(1));
  await waitFor(() => expect(read.pending.length).toBeGreaterThan(0));
  fireEvent.click(screen.getByRole('radio', { name: 'Text to image' }));
  read.settleAll(fixtureBlob);
  await sleep(QUIET_MS);
  expect(referenceItems()).toHaveLength(0);
  expect(screen.getByRole('radio', { name: 'Text to image' }).checked).toBe(
    true,
  );
  fireEvent.click(screen.getByRole('radio', { name: 'Edit image' }));
  await sleep(QUIET_MS);
  expect(referenceItems()).toHaveLength(0);
  expect(api.called(ANALYZE)).toHaveLength(0);
});

test('a Use as reference read that finishes after New draft adds nothing', async () => {
  const base = savedBase('late-new');
  const read = heldRoute();
  setup({ [fileRoute(base)]: read.handler }, { records: [base] });
  renderSavedEdit(base);
  await waitFor(() => expect(prompt().value).toBe('late-new idea'));
  fireEvent.click(await screen.findByRole('button', { name: 'Edit image' }));
  await waitFor(() => expect(read.pending.length).toBeGreaterThan(0));
  fireEvent.click(screen.getByRole('button', { name: 'New draft' }));
  read.settleAll(fixtureBlob);
  await sleep(QUIET_MS);
  expect(referenceItems()).toHaveLength(0);
  expect(screen.getByRole('radio', { name: 'Text to image' }).checked).toBe(
    true,
  );
  expect(api.called(ANALYZE)).toHaveLength(0);
});

test('undoing and redoing a reference change asks for no new controls', async () => {
  setup({ [DYNAMIC]: () => respond(500, { detail: 'Controls unavailable' }) });
  renderApp();
  await ready();
  type('Paint the fence blue');
  await waitFor(() => expect(api.called(DYNAMIC).length).toBeGreaterThan(0));
  attach(fixtureFile(0));
  await settled();
  await waitFor(() => expect(api.called(ANALYZE)).toHaveLength(1));
  await sleep(QUIET_MS);
  const before = api.called(DYNAMIC).length;

  undo();
  await waitFor(() => expect(referenceItems()).toHaveLength(0));
  await sleep(QUIET_MS);
  expect(api.called(DYNAMIC)).toHaveLength(before);

  // Redo finds the bytes again by checksum; still no controls request.
  redo();
  await waitFor(() => expect(referenceItems()).toHaveLength(1));
  await sleep(QUIET_MS);
  expect(api.called(DYNAMIC)).toHaveLength(before);
  expect(api.called(ANALYZE)).toHaveLength(1);
});

test('a snapshot taken while asset controls loaded gets its catalog back without prompt work', async () => {
  const trellis = heldRoute();
  setup({ [TRELLIS]: trellis.handler }, { edits: false });
  renderApp();
  await ready();
  type('A ceramic vase');
  await waitFor(() => expect(api.called(DYNAMIC)).toHaveLength(1));
  fireEvent.click(screen.getByRole('radio', { name: 'Asset image for 3D' }));
  await waitFor(() => expect(trellis.pending).toHaveLength(1));
  // Recorded while the asset catalog is still loading: no Standard controls.
  fireEvent.click(screen.getByRole('radio', { name: '1:1' }));
  trellis.settleAll(() => m1.static_trellis);
  await openStandardControls();
  await screen.findByRole('radiogroup', { name: 'Material' });
  await waitFor(() => expect(api.called(DYNAMIC)).toHaveLength(2));
  await sleep(QUIET_MS);

  undo();
  await waitFor(() =>
    expect(screen.getByRole('radio', { name: '3:2' }).checked).toBe(true),
  );
  expect(prompt().value).toBe('A ceramic vase');
  await openStandardControls();
  await screen.findByRole('radiogroup', { name: 'Material' });
  await sleep(QUIET_MS);
  expect(api.called(DYNAMIC)).toHaveLength(2);
  expect(api.called(TRELLIS)).toHaveLength(1);
});

test('undo during an asset catalog load reads that catalog again, guarded by the newest load', async () => {
  const trellis = heldRoute();
  setup({ [TRELLIS]: trellis.handler }, { edits: false });
  renderApp();
  await ready();
  fireEvent.click(screen.getByRole('radio', { name: 'Asset image for 3D' }));
  await waitFor(() => expect(trellis.pending).toHaveLength(1));
  fireEvent.click(screen.getByRole('radio', { name: '1:1' }));
  undo();
  await waitFor(() =>
    expect(screen.getByRole('radio', { name: '3:2' }).checked).toBe(true),
  );
  await waitFor(() => expect(trellis.pending).toHaveLength(2));
  trellis.settleAll(() => m1.static_trellis);
  await openStandardControls();
  expect(
    await screen.findAllByRole('radiogroup', { name: 'Material' }),
  ).toHaveLength(1);
  expect(screen.queryByRole('radiogroup', { name: 'Style' })).toBeNull();

  // Undoing the mode switch while nothing loads restores Standard at once.
  undo();
  await openStandardControls();
  expect(screen.queryByRole('radiogroup', { name: 'Material' })).toBeNull();
});

test('undo keeps job notices and clears only what described the replaced draft', async () => {
  setup(
    {
      [DYNAMIC]: () => respond(500, { detail: 'Controls unavailable' }),
      [GENERATE]: () => respond(202, m1.accepted),
      [TEXT_JOB]: () => clone(m1.job_complete),
    },
    { edits: false },
  );
  renderApp();
  await ready();
  type('A lantern at dusk');
  fireEvent.keyDown(prompt(), { key: 'Enter' });
  const fallback = /Options for this idea could not be generated/;
  await screen.findByText(fallback);
  await waitFor(() => expect(api.called(TEXT_JOB).length).toBeGreaterThan(0));
  fireEvent.click(screen.getByRole('radio', { name: '1:1' }));
  undo();
  await waitFor(() =>
    expect(screen.getByRole('radio', { name: '3:2' }).checked).toBe(true),
  );
  expect(screen.getByText(fallback)).toBeTruthy();
});

test('a file refusal for the replaced draft clears on undo', async () => {
  const base = savedBase('refusal');
  const read = heldRoute();
  setup({ [fileRoute(base)]: read.handler }, { records: [base] });
  renderSavedEdit(base);
  await waitFor(() => expect(prompt().value).toBe('refusal idea'));
  type('refusal idea, sharper');
  attach(fixtureFile(1));
  await waitFor(() => expect(read.pending.length).toBeGreaterThan(0));
  // A second gesture joins the pending base read and is refused.
  attach(new File(['bad'], 'bad.txt', { type: 'text/plain' }));
  await screen.findByText(/not a PNG, JPEG or WebP image/);
  // Undo takes back the choice of Edit; the typed prompt stays.
  undo();
  await waitFor(() =>
    expect(screen.getByRole('radio', { name: 'Text to image' }).checked).toBe(
      true,
    ),
  );
  expect(prompt().value).toBe('refusal idea, sharper');
  await waitFor(() =>
    expect(screen.queryByText(/not a PNG, JPEG or WebP image/)).toBeNull(),
  );
  read.settleAll(fixtureBlob);
  await sleep(QUIET_MS);
  expect(referenceItems()).toHaveLength(0);
});
