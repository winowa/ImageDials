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
import { PROVIDER_OVERRIDE_HEADER } from '../../src/data/api/api.js';
import { STORAGE_KEY } from '../../src/data/api/providerSettings.js';
import {
  completeStatus,
  fakeLibrary,
  fixtures,
  listedFromJob,
  installApi,
  networkFailure,
  respond,
} from '../helpers/testSupport.js';

vi.mock('../../src/features/controls/standardRandom.js', async (original) => ({
  ...(await original()),
  randomizeStandard: (entries) => entries,
}));

const { m1, browserSettings } = fixtures;
const DEFAULT_KEY_TEXT = 'example-default-secret';
const IDEA = 'An amber glass bird on a small wooden stand';
const DYNAMIC = 'POST /api/controls/dynamic';
const GENERATE = 'POST /api/generate-image';
const JOB = 'GET /api/generation-jobs/fixture-image-1';
const MODELS = 'GET /api/models';
const SUGGEST = 'GET /api/prompt-suggestions?generation_mode=standard';
const jobPolicy = { pollIntervalMs: 1, maxConsecutivePollFailures: 3 };
const ALTERNATE = browserSettings.provider_override_example;

let api;

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

function setup(overrides = {}) {
  const library = fakeLibrary([]);
  const complete = () => {
    const status = completeStatus();
    library.records = [listedFromJob(status.result)];
    return status;
  };
  api = installApi({
    [DYNAMIC]: () => m1.dynamic_response,
    [GENERATE]: () => respond(202, m1.accepted),
    [JOB]: complete,
    ...library.routes,
    ...overrides,
  });
}

const renderApp = () => render(<App jobPolicy={jobPolicy} />);
const ready = () => openStandardControls();
const prompt = () => screen.getByLabelText('Image idea');

async function openSettings() {
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
  const dialog = await screen.findByRole('dialog', { name: 'Settings' });
  await within(dialog).findByRole('group', { name: 'Language model' });
  return dialog;
}
const field = (dialog, group, label) =>
  within(within(dialog).getByRole('group', { name: group })).getByLabelText(
    new RegExp(`^${label}`),
  );
const type = (input, value) => fireEvent.change(input, { target: { value } });
const save = () =>
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

async function saveAlternate() {
  const dialog = await openSettings();
  type(
    field(dialog, 'Language model', 'Endpoint'),
    ALTERNATE.LLM_MODEL_ENDPOINT_1,
  );
  type(field(dialog, 'Language model', 'Model name'), ALTERNATE.LLM_MODEL_NAME);
  type(field(dialog, 'Language model', 'API key'), ALTERNATE.LLM_MODEL_KEY_1);
  save();
  await waitFor(() =>
    expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull(),
  );
}

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test('the gear is on every route and opens the panel at the server defaults', async () => {
  setup();
  renderApp();
  await ready();
  for (const route of ['Gallery', 'Library', 'Create']) {
    fireEvent.click(screen.getByRole('link', { name: route }));
    expect(screen.getByRole('button', { name: 'Settings' })).toBeTruthy();
  }
  const dialog = await openSettings();
  expect(field(dialog, 'Language model', 'Endpoint').value).toBe(
    browserSettings.defaults.providers.LLM_MODEL_ENDPOINT_1,
  );
  expect(field(dialog, 'Language model', 'Model name').value).toBe(
    browserSettings.defaults.providers.LLM_MODEL_NAME,
  );
  const key = field(dialog, 'Language model', 'API key');
  expect(key.type).toBe('password');
  expect(key.value).toBe('');
  expect(within(dialog).getByText('Server key in use.')).toBeTruthy();
  // Image protocol and model are read-only server facts.
  expect(within(dialog).getByText('mock-geometric-v1')).toBeTruthy();
  expect(dialog.querySelector('[title]')).toBeNull();
  expect(JSON.stringify(browserSettings.defaults)).not.toContain(
    DEFAULT_KEY_TEXT,
  );
});

test('Save stores a small versioned override and sends it only on provider requests', async () => {
  setup();
  renderApp();
  await ready();
  await saveAlternate();

  expect(JSON.parse(localStorage.getItem(STORAGE_KEY))).toEqual({
    v: 1,
    overrides: ALTERNATE,
  });
  // Models are read again for the new choice.
  await waitFor(() => expect(api.called(MODELS)).toHaveLength(2));
  expect(decode(api.called(MODELS)[0])).toBeNull();
  expect(decode(api.called(MODELS)[1])).toEqual(ALTERNATE);

  fireEvent.change(prompt(), { target: { value: IDEA } });
  fireEvent.keyDown(prompt(), { key: 'Enter' });
  await screen.findByRole('heading', { name: IDEA });
  expect(decode(api.called(DYNAMIC)[0])).toEqual(ALTERNATE);
  expect(decode(api.called(GENERATE)[0])).toEqual(ALTERNATE);

  // Nothing else carries the choice, and nothing is written to the server.
  for (const call of api.calls) {
    const sends = PROVIDER_OVERRIDE_HEADER in call.headers;
    const consumer = [MODELS, DYNAMIC, GENERATE, SUGGEST].includes(call.key);
    if (!consumer) expect(sends).toBe(false);
    expect(call.key).not.toMatch(/PUT|PATCH|settings\/(save|provider)/);
  }
  expect(api.called('POST /api/browser-settings/defaults')).toHaveLength(0);
});

test('a reload keeps the override and per-field reset removes it', async () => {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ v: 1, overrides: ALTERNATE }),
  );
  setup();
  renderApp();
  await ready();
  expect(decode(api.called(MODELS)[0])).toEqual(ALTERNATE);

  const dialog = await openSettings();
  expect(field(dialog, 'Language model', 'Endpoint').value).toBe(
    ALTERNATE.LLM_MODEL_ENDPOINT_1,
  );
  expect(
    within(dialog).getByText('Custom key, kept in this browser.'),
  ).toBeTruthy();
  for (const name of [
    /^Reset Language model endpoint/,
    /^Reset Language model model name/,
    /^Reset Language model api key/,
  ])
    fireEvent.click(within(dialog).getByRole('button', { name }));
  expect(field(dialog, 'Language model', 'Endpoint').value).toBe(
    browserSettings.defaults.providers.LLM_MODEL_ENDPOINT_1,
  );
  save();
  await waitFor(() => expect(localStorage.getItem(STORAGE_KEY)).toBeNull());
  await waitFor(() => expect(api.called(MODELS)).toHaveLength(2));
  expect(decode(api.called(MODELS)[1])).toBeNull();
});

test('a custom endpoint without a browser key gets no key, never the server key', async () => {
  setup();
  renderApp();
  await ready();
  const dialog = await openSettings();
  type(
    field(dialog, 'Language model', 'Endpoint'),
    'https://other.example.invalid/v1',
  );
  expect(
    within(dialog).getByText('No key is sent to this endpoint.'),
  ).toBeTruthy();
  save();
  await waitFor(() =>
    expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull(),
  );
  const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
  expect(stored.overrides).toEqual({
    LLM_MODEL_ENDPOINT_1: 'https://other.example.invalid/v1',
  });
  await waitFor(() => expect(api.called(MODELS)).toHaveLength(2));
  expect(decode(api.called(MODELS)[1])).toEqual(stored.overrides);
  expect(localStorage.getItem(STORAGE_KEY)).not.toContain(DEFAULT_KEY_TEXT);

  // Returning to the default endpoint restores the server key indicator.
  const again = await openSettings();
  fireEvent.click(
    within(again).getByRole('button', {
      name: /^Reset Language model endpoint/,
    }),
  );
  expect(within(again).getByText('Server key in use.')).toBeTruthy();
});

test('invalid values prevent commit without echoing them; Cancel and Escape discard edits', async () => {
  setup();
  renderApp();
  await ready();
  const dialog = await openSettings();
  const endpoint = field(dialog, 'Language model', 'Endpoint');
  type(
    endpoint,
    ['https://user:secret-pass', 'host.example.invalid/v1'].join('@'),
  );
  expect(within(dialog).getByRole('alert').textContent).not.toContain(
    'secret-pass',
  );
  save();
  expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy();
  expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  type(endpoint, 'ftp://host.example.invalid');
  expect(within(dialog).getByRole('alert')).toBeTruthy();
  type(field(dialog, 'Language model', 'Model name'), 'line\nbreak');
  save();
  expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy();
  expect(localStorage.getItem(STORAGE_KEY)).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull();
  expect(localStorage.getItem(STORAGE_KEY)).toBeNull();

  const second = await openSettings();
  type(field(second, 'Language model', 'Model name'), 'discarded-name');
  fireEvent.keyDown(second, { key: 'Escape' });
  expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull();
  expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  expect(api.called(MODELS)).toHaveLength(1);
});

test('denied storage still applies the choice to this page and says so', async () => {
  setup();
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('denied', 'QuotaExceededError');
  });
  renderApp();
  await ready();
  const dialog = await openSettings();
  type(field(dialog, 'Language model', 'Model name'), 'session-only-model');
  save();
  expect(
    await screen.findByText(
      'Applied to this page only. The browser would not store it.',
    ),
  ).toBeTruthy();
  await waitFor(() => expect(api.called(MODELS)).toHaveLength(2));
  expect(decode(api.called(MODELS)[1])).toEqual({
    LLM_MODEL_NAME: 'session-only-model',
  });
  vi.restoreAllMocks();
});

test('a provider change cancels stale controls work, keeps the draft and refetches', async () => {
  let release;
  let calls = 0;
  setup({
    [DYNAMIC]: (_body, _n, init) => {
      calls += 1;
      if (calls > 1) return m1.dynamic_response;
      // Like fetch, the first request fails when its signal aborts.
      return new Promise((resolve, reject) => {
        release = () => resolve(m1.dynamic_response);
        init.signal.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      });
    },
  });
  renderApp();
  await ready();
  const other = screen.getByRole('radio', { name: 'Watercolor' });
  fireEvent.click(other);
  fireEvent.change(prompt(), { target: { value: IDEA } });
  fireEvent.keyDown(prompt(), { key: 'Enter' });
  await waitFor(() => expect(api.called(DYNAMIC)).toHaveLength(1));

  await saveAlternate();
  await waitFor(() => expect(api.called(DYNAMIC)).toHaveLength(2));
  expect(decode(api.called(DYNAMIC)[0])).toBeNull();
  expect(decode(api.called(DYNAMIC)[1])).toEqual(ALTERNATE);
  // The earlier request was cancelled; a late answer changes nothing.
  release();
  await screen.findByRole('heading', { name: IDEA });
  expect(api.called(DYNAMIC)).toHaveLength(2);
  expect(prompt().value).toBe(IDEA);
  expect(screen.getByRole('radio', { name: 'Watercolor' }).checked).toBe(true);
  expect(api.called(GENERATE)).toHaveLength(1);
});

test('ideas are cached per provider and refetched after a change', async () => {
  setup();
  renderApp();
  await ready();
  fireEvent.click(screen.getByRole('button', { name: 'Prompt ideas' }));
  await waitFor(() => expect(api.called(SUGGEST)).toHaveLength(1));
  expect(decode(api.called(SUGGEST)[0])).toBeNull();
  await saveAlternate();
  // The ideas close when focus moves to the panel; showing them asks again.
  const trigger = screen.getByRole('button', { name: 'Prompt ideas' });
  if (trigger.getAttribute('aria-expanded') !== 'true')
    fireEvent.click(trigger);
  await waitFor(() => expect(api.called(SUGGEST)).toHaveLength(2));
  expect(decode(api.called(SUGGEST)[1])).toEqual(ALTERNATE);
});

test('a retried generation keeps the provider choice and key it first used', async () => {
  let attempt = 0;
  setup({
    [GENERATE]: () => {
      attempt += 1;
      return attempt === 1 ? networkFailure() : respond(202, m1.accepted);
    },
  });
  renderApp();
  await ready();
  fireEvent.change(prompt(), { target: { value: IDEA } });
  fireEvent.keyDown(prompt(), { key: 'Enter' });
  await screen.findByText('The API is unreachable.');
  await saveAlternate();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await screen.findByRole('heading', { name: IDEA });

  const [first, second] = api.called(GENERATE);
  expect(decode(first)).toBeNull();
  expect(decode(second)).toBeNull();
  expect(second.body.idempotency_key).toBe(first.body.idempotency_key);
  // Following the accepted job needs no provider header.
  expect(PROVIDER_OVERRIDE_HEADER in api.called(JOB)[0].headers).toBe(false);
});
