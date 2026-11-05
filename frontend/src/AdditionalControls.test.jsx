import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import additional from '../../fixtures/api/additional-controls.json';
import App from './App.jsx';
import {
  clone,
  completeStatus,
  fakeLibrary,
  fixtures,
  installApi,
  listedFromJob,
  respond,
  sizedRecord,
} from './testSupport.js';

// These tests exercise additive controls, not randomized episode defaults.
vi.mock('./standardRandom.js', async (original) => ({
  ...(await original()),
  randomizeStandard: (entries) => entries,
}));

const { m1, m3 } = fixtures;
const ADDITIONAL = 'POST /api/controls/additional';
const DYNAMIC = 'POST /api/controls/dynamic';
const GENERATE = 'POST /api/generate-image';
const JOB = 'GET /api/generation-jobs/fixture-image-1';
const jobPolicy = { pollIntervalMs: 1, maxConsecutivePollFailures: 3 };
const DEBOUNCE = 900;
const ANCHOR = 'a quiet harbour at dawn with small boats';
const MAX_CONTROLS = 30;

let api;
let library;

const capabilities = (controlGeneration = {}) => ({
  ...m3.capabilities,
  control_generation: {
    max_controls: MAX_CONTROLS,
    additional_controls: { enabled: true, default_count: 3, max_count: 5 },
    ...controlGeneration,
  },
});

function setup(overrides = {}, caps = capabilities()) {
  library = fakeLibrary([]);
  api = installApi({
    'GET /api/app-capabilities': () => caps,
    [DYNAMIC]: () => m1.dynamic_response,
    [ADDITIONAL]: () => additional.first.response,
    [GENERATE]: () => respond(202, m1.accepted),
    [JOB]: () => {
      const status = completeStatus();
      library.records = [listedFromJob(status.result), ...library.records];
      return status;
    },
    ...library.routes,
    ...overrides,
  });
}

/** Settled by hand so a test can change the draft while the request waits. */
function deferred() {
  const pending = [];
  const handler = () =>
    new Promise((resolve, reject) => pending.push({ resolve, reject }));
  return { handler, pending };
}

const prompt = () => screen.getByLabelText('Image idea');
const type = (text) => fireEvent.change(prompt(), { target: { value: text } });
const panel = () =>
  within(screen.getByRole('region', { name: 'Generated controls' }));
const more = () =>
  panel().queryByRole('button', { name: /more controls|adding controls/i });
const advance = (ms) => act(() => vi.advanceTimersByTimeAsync(ms));
const settle = () => advance(0);
const click = async (element) => {
  fireEvent.click(element);
  await settle();
};

async function generated(text = ANCHOR) {
  render(<App jobPolicy={jobPolicy} />);
  await settle();
  type(text);
  await advance(DEBOUNCE);
  await settle();
  expect(panel().getByText('Surface')).toBeTruthy();
}
const labelsInPanel = () =>
  panel()
    .getAllByRole('heading', { level: 3 })
    .map((h) => h.getAttribute('aria-label'));
const lastBody = () => api.called(GENERATE).at(-1).body;

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  localStorage.clear();
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'Date',
    ],
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('More controls posts descriptors only and appends the answer without generating an image', async () => {
  setup();
  await generated();
  const before = labelsInPanel();
  await click(
    within(screen.getByRole('region', { name: 'Standard controls' })).getByRole(
      'button',
      { name: 'Expand all' },
    ),
  );
  fireEvent.click(screen.getByRole('radio', { name: 'Watercolor' }));
  await click(more());

  const [call] = api.called(ADDITIONAL);
  expect(call.body.prompt).toBe(ANCHOR);
  expect(call.body.generation_mode).toBe('standard');
  expect(call.body).not.toHaveProperty('count');
  const sent = call.body.categories;
  const current = [
    ...m1.static_standard.controls,
    ...m1.dynamic_response.controls,
  ];
  expect(sent.map((c) => c.label)).toEqual(current.map((c) => c.label));
  sent.forEach((c) => {
    expect(
      Object.keys(c).every((k) =>
        ['id', 'label', 'description', 'kind'].includes(k),
      ),
    ).toBe(true);
  });
  expect(api.called(GENERATE)).toHaveLength(0);

  const added = additional.first.response.controls.map((c) => c.label);
  expect(labelsInPanel()).toEqual([...before, ...added]);
  expect(panel().getByText('Added 3 controls.')).toBeTruthy();
});

test('selections made while waiting survive and existing options stay intact', async () => {
  const wait = deferred();
  setup({ [ADDITIONAL]: wait.handler });
  await generated();
  await click(more());
  expect(more().disabled).toBe(true);
  expect(more().getAttribute('aria-busy')).toBe('true');
  await click(
    within(screen.getByRole('region', { name: 'Standard controls' })).getByRole(
      'button',
      { name: 'Expand all' },
    ),
  );
  fireEvent.click(screen.getByRole('radio', { name: 'Watercolor' }));
  expect(screen.getByRole('radio', { name: 'Watercolor' }).checked).toBe(true);
  // A second equivalent request is not started while one is pending.
  await click(more());
  expect(wait.pending).toHaveLength(1);
  await act(async () =>
    wait.pending[0].resolve(clone(additional.first.response)),
  );
  await settle();
  expect(screen.getByRole('radio', { name: 'Watercolor' }).checked).toBe(true);
  expect(panel().getByText('Surface accent 1')).toBeTruthy();
});

test('repeated batches append, and submission carries both lists of metadata verbatim', async () => {
  setup();
  await generated();
  await click(more());
  api.routes[ADDITIONAL] = () => additional.second.response;
  await click(more());
  expect(api.called(ADDITIONAL)).toHaveLength(2);
  // The second request describes the first batch's controls too.
  expect(api.called(ADDITIONAL)[1].body.categories.map((c) => c.id)).toEqual(
    expect.arrayContaining(['surface-accent-1', 'surface-accent-3']),
  );
  fireEvent.keyDown(prompt(), { key: 'Enter' });
  await settle();
  expect(lastBody().additional_controls_metadata).toEqual([
    additional.first.response.additional_controls_metadata,
    additional.second.response.additional_controls_metadata,
  ]);
  expect(lastBody().dynamic_controls_metadata).toEqual(
    m1.dynamic_response.dynamic_controls_metadata,
  );
  const ids = lastBody().controls.map((c) => c.id);
  expect(ids.slice(-6)).toEqual([
    'surface-accent-1',
    'surface-accent-2',
    'surface-accent-3',
    'surface-accent-4',
    'surface-accent-5',
    'surface-accent-6',
  ]);
});

test('a submission without additions omits the field', async () => {
  setup();
  await generated();
  fireEvent.keyDown(prompt(), { key: 'Enter' });
  await settle();
  expect(lastBody()).not.toHaveProperty('additional_controls_metadata');
});

test('an answer for a changed idea is discarded and the busy state clears', async () => {
  const wait = deferred();
  setup({ [ADDITIONAL]: wait.handler });
  await generated();
  await click(more());
  type(`${ANCHOR}, soft light`);
  await settle();
  expect(more().disabled).toBe(false);
  await act(async () =>
    wait.pending[0].resolve(clone(additional.first.response)),
  );
  await settle();
  expect(panel().queryByText('Surface accent 1')).toBeNull();
  fireEvent.keyDown(prompt(), { key: 'Enter' });
  await settle();
  expect(lastBody()).not.toHaveProperty('additional_controls_metadata');
});

test('removing a control while waiting supersedes the batch', async () => {
  const wait = deferred();
  setup({ [ADDITIONAL]: wait.handler });
  await generated();
  await click(more());
  fireEvent.click(panel().getByRole('button', { name: 'Remove Surface' }));
  await advance(300);
  await act(async () =>
    wait.pending[0].resolve(clone(additional.first.response)),
  );
  await settle();
  expect(panel().queryByText('Surface')).toBeNull();
  expect(panel().queryByText('Surface accent 1')).toBeNull();
});

test('regenerating options replaces additions and their metadata', async () => {
  setup();
  await generated();
  await click(more());
  expect(panel().getByText('Surface accent 1')).toBeTruthy();
  await click(screen.getByRole('button', { name: 'Regenerate options' }));
  expect(panel().queryByText('Surface accent 1')).toBeNull();
  fireEvent.keyDown(prompt(), { key: 'Enter' });
  await settle();
  expect(lastBody()).not.toHaveProperty('additional_controls_metadata');
});

test('an upstream failure shows the error and Retry appends on success', async () => {
  let attempt = 0;
  setup({
    [ADDITIONAL]: () =>
      (attempt += 1) === 1
        ? respond(502, additional.upstream_failure.response)
        : additional.first.response,
  });
  await generated();
  const before = labelsInPanel();
  await click(more());
  const alert = panel().getByRole('alert');
  expect(alert.textContent).toContain(
    additional.upstream_failure.response.detail,
  );
  expect(labelsInPanel()).toEqual(before);
  await click(within(alert).getByRole('button', { name: 'Retry' }));
  expect(api.called(ADDITIONAL)).toHaveLength(2);
  expect(panel().getByText('Surface accent 3')).toBeTruthy();
  expect(panel().queryByRole('alert')).toBeNull();
});

test('a malformed answer is refused whole', async () => {
  setup({
    [ADDITIONAL]: () => ({ controls: [], additional_controls_metadata: {} }),
  });
  await generated();
  const before = labelsInPanel();
  await click(more());
  expect(panel().getByRole('alert')).toBeTruthy();
  expect(labelsInPanel()).toEqual(before);
});

test('a repeated existing control is refused whole', async () => {
  const repeat = clone(additional.first.response);
  repeat.controls[0].label = 'Surface';
  setup({ [ADDITIONAL]: () => repeat });
  await generated();
  const before = labelsInPanel();
  await click(more());
  expect(panel().getByRole('alert')).toBeTruthy();
  expect(labelsInPanel()).toEqual(before);
});

test('the action is blocked at the published control limit', async () => {
  const total =
    m1.static_standard.controls.length + m1.dynamic_response.controls.length;
  setup({}, capabilities({ max_controls: total }));
  await generated();
  expect(more().disabled).toBe(true);
  expect(panel().getByText('The control limit is reached.')).toBeTruthy();
  await click(more());
  expect(api.called(ADDITIONAL)).toHaveLength(0);
});

test('the action is blocked when additional controls are disabled by capabilities', async () => {
  setup({}, capabilities({ additional_controls: { enabled: false } }));
  await generated();
  expect(more().disabled).toBe(true);
});

test('an asset-mode request names the trellis mode', async () => {
  setup({
    [ADDITIONAL]: () => additional.asset.response,
    [DYNAMIC]: () => ({
      ...m1.dynamic_response,
      // Keep the generated fixture distinct from the fixed asset View ID.
      controls: m1.dynamic_response.controls.map((control) =>
        control.id === 'view' ? { ...control, id: 'subject-view' } : control,
      ),
    }),
  });
  render(<App jobPolicy={jobPolicy} />);
  await settle();
  fireEvent.click(screen.getByRole('radio', { name: 'Asset image for 3D' }));
  await settle();
  type(ANCHOR);
  await advance(DEBOUNCE);
  await settle();
  await click(more());
  expect(api.called(ADDITIONAL)[0].body.generation_mode).toBe('trellis');
});

test('restoring a saved image keeps its additive metadata for the next submission', async () => {
  vi.useRealTimers();
  const stored = additional.first.response.additional_controls_metadata;
  const controls = [
    ...clone(m1.static_standard.controls),
    ...clone(m1.dynamic_response.controls),
    ...clone(additional.first.response.controls),
  ];
  const record = {
    ...sizedRecord('restored', 1152, 768, {
      original_prompt: ANCHOR,
      selected_controls: controls,
      dynamic_controls_metadata: m1.dynamic_response.dynamic_controls_metadata,
      additional_controls_metadata: [stored, { unknown: false, zero: 0 }],
    }),
  };
  library = fakeLibrary([record]);
  api = installApi({
    'GET /api/app-capabilities': () => capabilities(),
    [GENERATE]: () => respond(202, m1.accepted),
    ...library.routes,
  });
  render(<App jobPolicy={jobPolicy} />);
  fireEvent.click(
    await screen.findByRole('button', { name: 'Image restored' }),
  );
  await screen.findByRole('heading', { name: 'Image restored' });
  await waitFor(() => expect(prompt().value).toBe(ANCHOR));
  await waitFor(() =>
    expect(panel().getByText('Surface accent 1')).toBeTruthy(),
  );
  fireEvent.keyDown(prompt(), { key: 'Enter' });
  await waitFor(() => expect(lastBody()).toBeTruthy());
  expect(lastBody().additional_controls_metadata).toEqual([
    stored,
    { unknown: false, zero: 0 },
  ]);
  expect(lastBody().dynamic_controls_metadata).toEqual(
    m1.dynamic_response.dynamic_controls_metadata,
  );
  expect(api.called(ADDITIONAL)).toHaveLength(0);
});
