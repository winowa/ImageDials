import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import App from '../../src/app/App.jsx';
import { normalizeClientPolicy } from '../../src/data/api/clientPolicy.js';
import {
  clone,
  completeStatus,
  fakeLibrary,
  fixtures,
  installApi,
  listedFromJob,
  respond,
} from '../helpers/testSupport.js';

vi.mock('../../src/features/controls/standardRandom.js', async (original) => ({
  ...(await original()),
  randomizeStandard: (entries) => entries,
}));

const { m1, m3 } = fixtures;
const DYNAMIC = 'POST /api/controls/dynamic';
const GENERATE = 'POST /api/generate-image';
const IMPORT = 'POST /api/images/import-analysis';
const JOB = 'GET /api/generation-jobs/fixture-image-1';
const jobPolicy = { pollIntervalMs: 1, maxConsecutivePollFailures: 3 };
const DEBOUNCE = 900;
const CLEAR = 250;
const HOLD = 2000;
const ANCHOR = 'a quiet harbour at dawn with small boats';

let api;
let library;

/** Dynamic answers that a test settles by hand. */
function deferredDynamic() {
  const pending = [];
  const handler = () =>
    new Promise((resolve, reject) => pending.push({ resolve, reject }));
  return { handler, pending };
}

function setup(overrides = {}) {
  library = fakeLibrary([]);
  api = installApi({
    'GET /api/app-capabilities': () => m3.capabilities,
    [DYNAMIC]: () => m1.dynamic_response,
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

const renderApp = (clientPolicy) =>
  render(<App jobPolicy={jobPolicy} clientPolicy={clientPolicy} />);
const prompt = () => screen.getByLabelText('Image idea');
const type = (text) => fireEvent.change(prompt(), { target: { value: text } });
const enter = () => fireEvent.keyDown(prompt(), { key: 'Enter' });
const generatedPanel = () =>
  within(screen.getByRole('region', { name: 'Generated controls' }));
const generatedShown = () => generatedPanel().queryByText('Surface') !== null;
const advance = (ms) => act(() => vi.advanceTimersByTimeAsync(ms));
const settle = () => advance(0);

async function ready() {
  renderApp();
  await settle();
  fireEvent.click(
    within(screen.getByRole('region', { name: 'Standard controls' })).getByRole(
      'button',
      { name: 'Expand all' },
    ),
  );
  expect(screen.getByRole('radiogroup', { name: 'Style' })).toBeTruthy();
}
/** Type an idea and let the background request finish. */
async function generateBackground(text = ANCHOR) {
  type(text);
  await advance(DEBOUNCE);
  await settle();
}
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

test('controls are fetched in the background only after the idea has settled for 900 ms', async () => {
  setup();
  await ready();
  type('a harbour');
  await advance(DEBOUNCE - 100);
  type('a harbour at dawn');
  await advance(DEBOUNCE - 100);
  expect(api.called(DYNAMIC)).toHaveLength(0);
  await advance(100);
  await settle();
  expect(api.called(DYNAMIC)).toHaveLength(1);
  expect(api.called(DYNAMIC)[0].body.prompt).toBe('a harbour at dawn');
  // Nothing was submitted for an image.
  expect(api.called(GENERATE)).toHaveLength(0);
});

test('a blank idea and an unavailable inference service fetch nothing', async () => {
  setup({
    'GET /healthz': () => ({ ...m1.health, inference_enabled: false }),
  });
  await ready();
  type('   ');
  await advance(DEBOUNCE * 2);
  type('a harbour');
  await advance(DEBOUNCE * 2);
  expect(api.called(DYNAMIC)).toHaveLength(0);
});

test('submitting reuses a completed background request and sends its metadata', async () => {
  setup();
  await ready();
  await generateBackground();
  expect(api.called(DYNAMIC)).toHaveLength(1);
  enter();
  await settle();
  expect(api.called(DYNAMIC)).toHaveLength(1);
  expect(lastBody().prompt).toBe(ANCHOR);
  expect(lastBody().dynamic_controls_metadata).toEqual(
    m1.dynamic_response.dynamic_controls_metadata,
  );
  expect(lastBody().controls.length).toBeGreaterThan(
    m1.static_standard.controls.length,
  );
});

test('submitting reuses a request still in flight instead of starting another', async () => {
  const dynamic = deferredDynamic();
  setup({ [DYNAMIC]: dynamic.handler });
  await ready();
  type(ANCHOR);
  await advance(DEBOUNCE);
  expect(dynamic.pending).toHaveLength(1);
  enter();
  await settle();
  expect(api.called(GENERATE)).toHaveLength(0);
  await act(async () => dynamic.pending[0].resolve(m1.dynamic_response));
  await settle();
  expect(api.called(DYNAMIC)).toHaveLength(1);
  expect(api.called(GENERATE)).toHaveLength(1);
  expect(lastBody().dynamic_controls_metadata).toBeTruthy();
});

test('edits near the original idea keep the controls and metadata; submission uses the current prompt', async () => {
  setup();
  await ready();
  await generateBackground();
  expect(generatedShown()).toBe(true);
  const edited = `${ANCHOR}, soft light`;
  type(edited);
  await advance(DEBOUNCE + CLEAR);
  expect(generatedShown()).toBe(true);
  expect(api.called(DYNAMIC)).toHaveLength(1);
  enter();
  await settle();
  expect(api.called(DYNAMIC)).toHaveLength(1);
  expect(lastBody().prompt).toBe(edited);
  expect(lastBody().dynamic_controls_metadata).toBeTruthy();
});

test('case, spacing and accent-form edits never clear anything', async () => {
  setup();
  await ready();
  await generateBackground('Café by the sea');
  type('  CAFÉ   by  the SEA ');
  await advance(CLEAR + 50);
  expect(generatedShown()).toBe(true);
});

test('at half the idea or more edited the generated controls are cleared after 250 ms', async () => {
  setup();
  await ready();
  await generateBackground();
  // A standard control selection and a generated one are both made.
  fireEvent.click(screen.getByRole('radio', { name: 'Watercolor' }));
  type('an entirely different mountain scene');
  await advance(CLEAR - 50);
  expect(generatedShown()).toBe(true);
  await advance(60);
  expect(generatedShown()).toBe(false);
  // The metadata went with them.
  expect(screen.getByText('Options for your idea appear here.')).toBeTruthy();
});

test('a quick return above the threshold within 250 ms cancels the clear', async () => {
  setup();
  await ready();
  await generateBackground();
  type('an entirely different mountain scene');
  await advance(CLEAR - 100);
  type(ANCHOR);
  await advance(CLEAR * 2);
  expect(generatedShown()).toBe(true);
});

test('drift is measured from the original idea, not from the last edit', async () => {
  setup();
  await ready();
  await generateBackground('a quiet harbour at dawn');
  for (const step of [
    'a quiet harbour at dusk',
    'a quiet harbor at dusk',
    'a calm harbor at dusk',
    'a calm lake at dusk',
    'a calm lake at noon',
  ]) {
    type(step);
    await advance(CLEAR + 10);
  }
  expect(generatedShown()).toBe(false);
});

test('the first near step still keeps controls before the drift accumulates', async () => {
  setup();
  await ready();
  await generateBackground('a quiet harbour at dawn');
  type('a quiet harbour at dusk');
  await advance(CLEAR + 10);
  expect(generatedShown()).toBe(true);
});

test('generation below the threshold drops the old controls at once and fetches new ones', async () => {
  const dynamic = deferredDynamic();
  setup({ [DYNAMIC]: dynamic.handler });
  await ready();
  type(ANCHOR);
  await advance(DEBOUNCE);
  await act(async () => dynamic.pending[0].resolve(m1.dynamic_response));
  await settle();
  type('a red fox');
  enter(); // before the 250 ms clear
  await settle();
  expect(dynamic.pending).toHaveLength(2);
  expect(dynamic.pending[1]).toBeTruthy();
  await act(async () =>
    dynamic.pending[1].resolve({
      ...clone(m1.dynamic_response),
      dynamic_controls_metadata: { prompt: 'second' },
    }),
  );
  await settle();
  expect(lastBody().prompt).toBe('a red fox');
  expect(lastBody().dynamic_controls_metadata).toEqual({ prompt: 'second' });
});

test('a response for an idea the person has left is discarded and the new idea gets its own', async () => {
  const dynamic = deferredDynamic();
  setup({ [DYNAMIC]: dynamic.handler });
  await ready();
  type(ANCHOR);
  await advance(DEBOUNCE);
  expect(dynamic.pending).toHaveLength(1);
  type('a completely unrelated desert caravan');
  await advance(CLEAR + 10);
  // The stale request is cancelled by the clear check.
  await act(async () => dynamic.pending[0].resolve(m1.dynamic_response));
  await settle();
  expect(generatedShown()).toBe(false);
  await advance(DEBOUNCE);
  expect(dynamic.pending).toHaveLength(2);
  await act(async () => dynamic.pending[1].resolve(m1.dynamic_response));
  await settle();
  expect(generatedShown()).toBe(true);
});

test('a failed request is retried within the attempt bound and generation still proceeds', async () => {
  setup({
    [DYNAMIC]: () => respond(502, { detail: 'upstream down' }),
  });
  await ready();
  type(ANCHOR);
  await advance(DEBOUNCE);
  await settle();
  expect(api.called(DYNAMIC)).toHaveLength(2);
  enter();
  await settle();
  expect(api.called(DYNAMIC)).toHaveLength(4);
  expect(api.called(GENERATE)).toHaveLength(1);
  expect(lastBody().dynamic_controls_metadata).toBeNull();
  expect(lastBody().controls).toHaveLength(m1.static_standard.controls.length);
  expect(screen.getByText(/standard controls are used instead/)).toBeTruthy();
});

test('typing then switching mode cancels the pending background request for the old mode', async () => {
  setup();
  await ready();
  type(ANCHOR);
  await advance(DEBOUNCE - 100);
  fireEvent.click(screen.getByRole('radio', { name: 'Asset image for 3D' }));
  await advance(DEBOUNCE * 2);
  await settle();
  const modes = api.called(DYNAMIC).map((c) => c.body.generation_mode);
  expect(modes).not.toContain('standard');
});

test('a description import does not start background generation', async () => {
  setup({ [IMPORT]: () => m3.import_description });
  await ready();
  type('typed before the import');
  await advance(DEBOUNCE * 2);
  await settle();
  const dynamicBeforeImport = api.called(DYNAMIC).length;
  const generateBeforeImport = api.called(GENERATE).length;
  const bytes = Uint8Array.from(atob(m3.plain_png_base64), (c) =>
    c.charCodeAt(0),
  );
  const file = new File([bytes], 'plain.png', { type: 'image/png' });
  URL.createObjectURL = vi.fn(() => 'blob:local');
  URL.revokeObjectURL = vi.fn();
  fireEvent.change(document.querySelector('input[type="file"]'), {
    target: { files: [file] },
  });
  await advance(DEBOUNCE * 3);
  await settle();
  expect(api.called(GENERATE)).toHaveLength(generateBeforeImport);
  expect(api.called(DYNAMIC)).toHaveLength(dynamicBeforeImport);
});

test('generated controls are revealed about two seconds after loading began, without delaying submission', async () => {
  setup();
  await ready();
  type(ANCHOR);
  enter();
  await settle();
  // The request is already submitted with its controls...
  expect(api.called(GENERATE)).toHaveLength(1);
  expect(lastBody().dynamic_controls_metadata).toBeTruthy();
  // ...but the panel is still showing its loading state.
  expect(generatedShown()).toBe(false);
  await advance(HOLD - 100);
  expect(generatedShown()).toBe(false);
  await advance(150);
  expect(generatedShown()).toBe(true);
});

test('a background reveal is not held', async () => {
  setup();
  await ready();
  await generateBackground();
  expect(generatedShown()).toBe(true);
});

test('the reveal hold can be configured to none', async () => {
  setup();
  renderApp({ controls: { revealHoldMs: 0 } });
  await settle();
  type(ANCHOR);
  enter();
  await settle();
  expect(generatedShown()).toBe(true);
});

test('the reveal hold follows the published budget', async () => {
  setup();
  renderApp(normalizeClientPolicy({ controls: { reveal_hold_ms: 3500 } }));
  await settle();
  type(ANCHOR);
  enter();
  await settle();
  await advance(HOLD + 500);
  expect(generatedShown()).toBe(false);
  await advance(3500 - HOLD - 500 + 50);
  expect(generatedShown()).toBe(true);
});
