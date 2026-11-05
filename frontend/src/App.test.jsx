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

import App from './App.jsx';
import { isMultiChoice } from './controls.js';
import {
  completeStatus,
  fakeLibrary,
  fixtures,
  installApi,
  libraryRecord,
  listedFromJob,
  networkFailure,
  respond,
} from './testSupport.js';

vi.mock('./standardRandom.js', async (original) => {
  const actual = await original();
  return {
    ...actual,
    randomizeStandard: (entries) => entries,
    sampleMultiOptions: (options) =>
      actual.sampleMultiOptions(options, () => 0.9),
  };
});

const { m1 } = fixtures;
const IDEA = 'An amber glass bird on a small wooden stand';
const JOB = 'GET /api/generation-jobs/fixture-image-1';
const GENERATE = 'POST /api/generate-image';
const DYNAMIC = 'POST /api/controls/dynamic';
const jobPolicy = { pollIntervalMs: 1, maxConsecutivePollFailures: 3 };

let api;
let library;

/** Complete the fixture job and, like the server, list its record afterwards. */
function completeJob(overrides) {
  const status = completeStatus(overrides);
  library.records = [
    listedFromJob(status.result),
    ...library.records.filter((r) => r.filename !== status.result.filename),
  ];
  return status;
}

/** Routes for a working generator; `library` is the canonical in-memory list. */
function setup(overrides = {}, records = []) {
  library = fakeLibrary(records);
  api = installApi({
    [DYNAMIC]: () => m1.dynamic_response,
    [GENERATE]: () => respond(202, m1.accepted),
    [JOB]: () => completeJob(),
    ...library.routes,
    ...overrides,
  });
  return api;
}

const renderApp = () => render(<App jobPolicy={jobPolicy} />);
const prompt = () => screen.getByLabelText('Image idea');
const type = (text) => fireEvent.change(prompt(), { target: { value: text } });
const enter = (init = {}) =>
  fireEvent.keyDown(prompt(), { key: 'Enter', ...init });
const ready = () => openStandardControls();

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test('shows the title and uses no native titles', async () => {
  setup();
  renderApp();
  expect(screen.getByRole('heading', { name: 'ImageDials' })).toBeTruthy();
  await ready();
  expect(document.querySelector('[title]')).toBeNull();
});

test('links the project title area to its GitHub repository', async () => {
  setup();
  renderApp();
  const link = screen.getByRole('link', {
    name: 'ImageDials on GitHub (opens in a new tab)',
  });
  expect(link.closest('.app-brand')).toBeTruthy();
  expect(link.getAttribute('href')).toBe(
    'https://github.com/winowa/ImageDials',
  );
  expect(link.getAttribute('target')).toBe('_blank');
  expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  fireEvent.focus(link);
  expect(
    await screen.findByText('GitHub repository (opens in a new tab)'),
  ).toBeTruthy();
  fireEvent.keyDown(link, { key: 'Escape' });
  await waitFor(() =>
    expect(
      screen.queryByText('GitHub repository (opens in a new tab)'),
    ).toBeNull(),
  );
  await ready();
});

test('credits Promptions with an external link below the title', async () => {
  setup();
  renderApp();
  const link = screen.getByRole('link', {
    name: 'inspired by Promptions (opens in a new tab)',
  });
  expect(link.getAttribute('href')).toBe(
    'https://github.com/microsoft/Promptions',
  );
  expect(link.getAttribute('target')).toBe('_blank');
  expect(link.getAttribute('rel')).toContain('noopener');
  const brand = document.querySelector('.app-brand');
  const children = [...brand.children].map((n) => n.tagName);
  expect(children[0]).toBe('H1');
  expect(brand.lastElementChild.contains(link)).toBe(true);
  expect(screen.getByRole('heading', { name: 'ImageDials' })).toBe(
    brand.querySelector('h1'),
  );
  expect(brand.querySelector('h1 .app-accent').textContent).toBe('Dials');
  expect(link.querySelector('.app-accent').textContent).toBe('Promptions');
  expect(link.querySelectorAll('.app-accent')).toHaveLength(1);
  const icon = link.querySelector('[aria-hidden="true"]');
  expect(icon.textContent.trim()).toBe('↗');
  expect(link.lastElementChild).toBe(icon);
  await ready();
});

test('theme toggle is on every route, persists, and shows a styled tooltip on focus', async () => {
  setup();
  renderApp();
  await ready();
  const toggle = screen.getByRole('button', { name: 'Switch to light theme' });
  fireEvent.focus(toggle);
  expect(screen.getByRole('tooltip').textContent).toBe('Switch to light theme');
  fireEvent.keyDown(toggle, { key: 'Escape' });
  expect(screen.queryByRole('tooltip')).toBeNull();
  fireEvent.click(toggle);
  expect(document.documentElement.dataset.theme).toBe('light');
  expect(localStorage.getItem('imagedials-theme')).toBe('light');
  for (const route of ['Gallery', 'Library']) {
    fireEvent.click(screen.getByRole('link', { name: route }));
    expect(
      screen.getByRole('button', { name: 'Switch to dark theme' }),
    ).toBeTruthy();
  }
});

test('loads server base controls and sizes; landscape is the initial aspect', async () => {
  setup();
  renderApp();
  await ready();
  expect(
    api.called('GET /api/controls/static?generation_mode=standard'),
  ).toHaveLength(1);
  expect(screen.getByRole('radio', { name: '3:2' }).checked).toBe(true);
  await screen.findByText('1152×768', { selector: '.aspect-size' });
  expect(
    screen.getByText('768×1152', { selector: '.aspect-size' }),
  ).toBeTruthy();
  expect(screen.getByRole('combobox', { name: 'Composition' })).toBeTruthy();
  // Suggest idea waits for the real endpoint.
  expect(screen.queryByText(/Suggest idea/)).toBeNull();
});

test('one Enter fetches options, submits the canonical request and shows the saved image', async () => {
  setup();
  renderApp();
  await ready();
  type(IDEA);
  fireEvent.click(screen.getByRole('radio', { name: '2:3' }));
  enter();
  const title = await screen.findByRole('heading', { name: IDEA });
  expect(title).toBeTruthy();

  const [dynamic] = api.called(DYNAMIC);
  expect(dynamic.body).toEqual({
    prompt: IDEA,
    controls: [],
    // Value-free summaries of the current standard categories.
    categories: m1.static_standard.controls.map((c) => ({
      id: c.id,
      label: c.label,
      kind: c.kind,
      ...(c.description ? { description: c.description } : {}),
    })),
    prompt_history: [],
    generation_mode: 'standard',
  });
  const [generate] = api.called(GENERATE);
  expect(generate.body.prompt).toBe(IDEA);
  expect(generate.body.dimensions).toBe('768x1152');
  expect(generate.body.generation_mode).toBe('standard');
  expect(generate.body.idempotency_key).toBeTruthy();
  expect(generate.body.dynamic_controls_metadata).toEqual(
    m1.dynamic_response.dynamic_controls_metadata,
  );
  // Base controls first, then complete generated wires (unknown kinds too),
  // with provenance from fallback settlement and the provider response.
  expect(generate.body.controls).toEqual([
    ...m1.static_standard.controls.map((control) => ({
      ...control,
      selection_provenance: { version: 1, source: 'fallback-random' },
    })),
    ...m1.dynamic_response.controls.map((control) => ({
      ...control,
      ...(isMultiChoice(control.kind)
        ? {
            value: [Object.keys(control.options).at(-1)],
            selection_provenance: { version: 1, source: 'fallback-random' },
          }
        : {
            selection_provenance: {
              version: 1,
              source: 'suggested',
              effect: 'value',
            },
          }),
    })),
  ]);
  expect(api.called(JOB).length).toBeGreaterThan(0);
  const image = screen.getAllByAltText(IDEA)[0];
  expect(image.getAttribute('src')).toBe(
    '/api/images/library/file/local-0/fixture-image-1.png',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Prompts' }));
  expect(screen.getAllByText(/future-control/).length).toBeGreaterThan(0);
  expect(screen.getByRole('button', { name: 'Regenerate' })).toBeTruthy();
});

test('Shift+Enter, IME composition and a blank prompt do not submit', async () => {
  setup();
  renderApp();
  await ready();
  enter();
  type(IDEA);
  enter({ shiftKey: true });
  enter({ isComposing: true });
  enter({ keyCode: 229 });
  await new Promise((r) => setTimeout(r, 20));
  expect(api.called(GENERATE)).toHaveLength(0);
  expect(api.called(DYNAMIC)).toHaveLength(0);
  expect(
    screen
      .getAllByRole('button', { name: /Generate image/ })
      .every((b) => !b.disabled),
  ).toBe(true);
});

test('duplicate submissions while options and the job are pending create one job', async () => {
  let release;
  setup({
    [DYNAMIC]: () =>
      new Promise((resolve) => {
        release = () => resolve(m1.dynamic_response);
      }),
  });
  renderApp();
  await ready();
  type(IDEA);
  enter();
  enter();
  fireEvent.click(screen.getAllByRole('button', { name: /Preparing/ })[0]);
  await waitFor(() => expect(release).toBeTypeOf('function'));
  release();
  await screen.findByRole('heading', { name: IDEA });
  expect(api.called(DYNAMIC)).toHaveLength(1);
  expect(api.called(GENERATE)).toHaveLength(1);
});

test('a bounded options failure uses the standard controls with a notice', async () => {
  setup({ [DYNAMIC]: () => respond(502, { detail: 'Provider down' }) });
  renderApp();
  await ready();
  type(IDEA);
  enter();
  await screen.findByRole('heading', { name: IDEA });
  // 502 is retried once, then the standard controls are used.
  expect(api.called(DYNAMIC)).toHaveLength(2);
  expect(api.called(GENERATE)[0].body.controls).toEqual(
    m1.static_standard.controls.map((control) => ({
      ...control,
      selection_provenance: { version: 1, source: 'fallback-random' },
    })),
  );
  expect(screen.getByText(/standard controls are used instead/)).toBeTruthy();
  expect(screen.getByText(/Options failed: Provider down/)).toBeTruthy();
});

test('a rejected options request is not retried', async () => {
  setup({ [DYNAMIC]: () => respond(400, { detail: 'Bad prompt' }) });
  renderApp();
  await ready();
  type(IDEA);
  enter();
  await screen.findByRole('heading', { name: IDEA });
  expect(api.called(DYNAMIC)).toHaveLength(1);
});

test('no controls at all is a recoverable error and never a generation request', async () => {
  setup({
    'GET /api/controls/static?generation_mode=standard': () =>
      respond(503, '<html>down</html>'),
    [DYNAMIC]: () => respond(400, { detail: 'No' }),
  });
  renderApp();
  await screen.findByText(/Standard controls could not be loaded/);
  type(IDEA);
  enter();
  const alert = await screen.findByText(/No controls are available/);
  expect(alert).toBeTruthy();
  expect(api.called(GENERATE)).toHaveLength(0);
  expect(
    screen.getAllByRole('button', { name: /Generate image/ })[0].disabled,
  ).toBe(false);
  // Reloading the standard controls recovers.
  api.routes['GET /api/controls/static?generation_mode=standard'] = () =>
    m1.static_standard;
  fireEvent.click(
    screen.getByRole('button', { name: 'Load standard controls' }),
  );
  await ready();
});

test('invalid control values stop the submission and keep every selection', async () => {
  setup({
    'GET /api/controls/static?generation_mode=standard': () => ({
      controls: [
        {
          id: 'zoom',
          kind: 'slider',
          label: 'Zoom',
          min: 0,
          max: 10,
          value: 12,
        },
      ],
    }),
    [DYNAMIC]: () => ({ controls: [], dynamic_controls_metadata: null }),
  });
  renderApp();
  await openStandardControls();
  await screen.findByRole('slider', { name: 'Zoom' });
  type(IDEA);
  enter();
  await screen.findByText('Zoom must be between 0 and 10.');
  expect(api.called(GENERATE)).toHaveLength(0);
  expect(prompt().value).toBe(IDEA);
});

test('editing the idea while options load cancels that submission and drops stale options', async () => {
  let release;
  setup({
    [DYNAMIC]: () =>
      new Promise((resolve) => {
        release = () => resolve(m1.dynamic_response);
      }),
  });
  renderApp();
  await ready();
  type(IDEA);
  enter();
  await waitFor(() => expect(release).toBeTypeOf('function'));
  type('A different idea');
  release();
  await screen.findByText(/The idea changed while options were prepared/);
  expect(api.called(GENERATE)).toHaveLength(0);
  expect(screen.queryByRole('group', { name: 'Highlights' })).toBeNull();
  expect(prompt().value).toBe('A different idea');
});

test('selections persist when generated options are regenerated', async () => {
  setup();
  renderApp();
  await ready();
  type(IDEA);
  fireEvent.click(screen.getByRole('button', { name: 'Regenerate options' }));
  const red = await screen.findByRole('checkbox', { name: 'Red' });
  if (!red.checked) fireEvent.click(red);
  expect(red.checked).toBe(true);
  fireEvent.click(screen.getByRole('radio', { name: 'Watercolor' }));
  fireEvent.click(screen.getByRole('button', { name: 'Regenerate options' }));
  await waitFor(() => expect(api.called(DYNAMIC)).toHaveLength(2));
  await waitFor(() =>
    expect(screen.getByRole('checkbox', { name: 'Red' }).checked).toBe(true),
  );
  expect(screen.getByRole('radio', { name: 'Watercolor' }).checked).toBe(true);
});

test('a matching in-flight options request is reused by the submission', async () => {
  let release;
  setup({
    [DYNAMIC]: () =>
      new Promise((resolve) => {
        release = () => resolve(m1.dynamic_response);
      }),
  });
  renderApp();
  await ready();
  type(IDEA);
  fireEvent.click(screen.getByRole('button', { name: 'Regenerate options' }));
  await waitFor(() => expect(release).toBeTypeOf('function'));
  enter();
  release();
  await screen.findByRole('heading', { name: IDEA });
  expect(api.called(DYNAMIC)).toHaveLength(1);
  expect(api.called(GENERATE)).toHaveLength(1);
});

test('a failed job keeps the previous image and the draft, and retry uses a fresh key', async () => {
  let attempt = 0;
  setup(
    {
      [JOB]: () => {
        attempt += 1;
        return attempt === 1 ? m1.job_failed : completeJob();
      },
    },
    [libraryRecord({ id: 'older', title: 'Older image' })],
  );
  renderApp();
  fireEvent.click(await screen.findByRole('button', { name: 'Older image' }));
  await screen.findByRole('heading', { name: 'Older image' });
  type('another idea');
  enter();
  const alert = await screen.findByText(/Image provider unavailable/);
  // "another idea" is a new prompt episode: the unrelated older image left the
  // stage, so the failure does not claim it is still shown. It stays in history.
  expect(alert.textContent).not.toMatch(/previous image is still shown/);
  expect(screen.queryByRole('heading', { name: 'Older image' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Older image' })).toBeTruthy();
  expect(prompt().value).toBe('another idea');
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await screen.findByRole('heading', { name: IDEA });
  const keys = api.called(GENERATE).map((c) => c.body.idempotency_key);
  expect(keys).toHaveLength(2);
  expect(keys[0]).not.toBe(keys[1]);
});

test('retrying after a dropped connection reuses the idempotency key', async () => {
  let attempt = 0;
  setup({
    [GENERATE]: () => {
      attempt += 1;
      if (attempt === 1) return networkFailure();
      return respond(202, m1.accepted);
    },
  });
  renderApp();
  await ready();
  type(IDEA);
  enter();
  await screen.findByText('The API is unreachable.');
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await screen.findByRole('heading', { name: IDEA });
  const keys = api.called(GENERATE).map((c) => c.body.idempotency_key);
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
});

test('losing contact with an accepted job never resubmits it', async () => {
  let reads = 0;
  setup({
    [JOB]: () => {
      reads += 1;
      return reads <= 3 ? respond(503, 'unavailable') : completeJob();
    },
  });
  renderApp();
  await ready();
  type(IDEA);
  enter();
  const lost = await screen.findByText(/Lost contact with the job/);
  expect(lost).toBeTruthy();
  expect(api.called(GENERATE)).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
  await screen.findByRole('heading', { name: IDEA });
  expect(api.called(GENERATE)).toHaveLength(1);
});

test('a late result neither rewrites the draft nor the selection the person made', async () => {
  const older = libraryRecord({ id: 'older', title: 'Older image' });
  let release;
  setup(
    {
      [JOB]: () =>
        new Promise((resolve) => {
          release = () => resolve(completeJob());
        }),
    },
    [older],
  );
  renderApp();
  fireEvent.click(await screen.findByRole('button', { name: 'Older image' }));
  await screen.findByRole('heading', { name: 'Older image' });
  type(IDEA);
  enter();
  await waitFor(() => expect(release).toBeTypeOf('function'));
  type('edited meanwhile');
  fireEvent.click(screen.getByRole('button', { name: 'Older image' }));
  // Choosing a saved image restores it, replacing the draft with its prompt.
  expect(prompt().value).toBe(older.original_prompt);
  type('edited after choosing');
  release();
  const notice = await screen.findByText('A new image finished.');
  expect(notice).toBeTruthy();
  expect(prompt().value).toBe('edited after choosing');
  expect(screen.getByRole('heading', { name: 'Older image' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'View' }));
  expect(screen.getByRole('heading', { name: IDEA })).toBeTruthy();
});

test('Edit restores the full original snapshot, including false, zero and unknown kinds', async () => {
  const record = libraryRecord();
  const original = record.selected_controls;
  setup({}, [record]);
  renderApp();
  fireEvent.click(await screen.findByRole('button', { name: IDEA }));
  await screen.findByRole('heading', { name: IDEA });
  type('unrelated draft');
  fireEvent.click(screen.getByRole('button', { name: 'Reuse settings' }));
  expect(prompt().value).toBe(IDEA);
  expect(screen.getByRole('radio', { name: '2:3' }).checked).toBe(true);
  expect(
    screen
      .getByRole('switch', { name: 'Etched pattern' })
      .getAttribute('aria-checked'),
  ).toBe('false');
  expect(screen.getByRole('slider', { name: 'Head angle' }).value).toBe('0');
  expect(screen.getByRole('textbox', { name: 'Stand details' }).value).toBe(
    'Rounded edges',
  );
  expect(screen.getByText('future-control')).toBeTruthy();
  // Restored controls are submitted without another options request.
  enter();
  await waitFor(() => expect(api.called(GENERATE)).toHaveLength(1));
  expect(api.called(DYNAMIC)).toHaveLength(0);
  expect(api.called(GENERATE)[0].body.controls).toEqual(original);
  expect(api.called(GENERATE)[0].body.dynamic_controls_metadata).toEqual(
    record.dynamic_controls_metadata,
  );
});

test('records without selected controls restore through their saved categories', async () => {
  setup({}, [
    {
      id: 'old-1',
      storage_id: 'local-0',
      filename: 'old-1.png',
      title: 'Old record',
      prompt: 'old idea',
      final_prompt: 'old final',
      mode: 'image',
      aspect: '1:1',
      width: 1024,
      height: 1024,
      provider: 'mock',
      model: 'm',
      created_at: 1767225600,
      categories: [
        {
          id: 'style',
          label: 'Style',
          type: 'single',
          origin: 'fixed',
          options: [{ id: 'cinematic', label: 'Cinematic' }],
          value: 'cinematic',
        },
      ],
    },
  ]);
  renderApp();
  fireEvent.click(await screen.findByRole('button', { name: 'Old record' }));
  await screen.findByRole('heading', { name: 'Old record' });
  expect(screen.getByText('Cinematic', { selector: 'li' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Reuse settings' }));
  expect(screen.getByRole('radio', { name: '1:1' }).checked).toBe(true);
  await openStandardControls();
  expect(screen.getByRole('radio', { name: 'Cinematic' }).checked).toBe(true);
});

test('switching to asset mode loads its controls and clears prompt-specific ones', async () => {
  setup({
    [DYNAMIC]: (body) => ({
      ...m1.dynamic_response,
      // A real provider cannot reuse the fixed asset View category's ID.
      controls: m1.dynamic_response.controls.map((control) =>
        body.generation_mode === 'trellis' && control.id === 'view'
          ? { ...control, id: 'subject-view' }
          : control,
      ),
    }),
  });
  renderApp();
  await ready();
  type(IDEA);
  fireEvent.click(screen.getByRole('button', { name: 'Regenerate options' }));
  await screen.findByRole('checkbox', { name: 'Red' });
  fireEvent.click(screen.getByRole('radio', { name: 'Asset image for 3D' }));
  await openStandardControls();
  await screen.findByRole('radiogroup', { name: 'Material' });
  expect(screen.queryByRole('checkbox', { name: 'Red' })).toBeNull();
  expect(screen.getByRole('heading', { name: 'Asset controls' })).toBeTruthy();
  enter();
  await screen.findByRole('heading', { name: IDEA });
  expect(api.called(GENERATE)[0].body.generation_mode).toBe('trellis');
  expect(api.called(DYNAMIC)[1].body.generation_mode).toBe('trellis');
});

test('disabled inference and missing sizes block submission with a reason', async () => {
  setup({
    'GET /healthz': () => ({ status: 'ok', inference_enabled: false }),
  });
  renderApp();
  await ready();
  await screen.findByText('Inference is disabled on the server.');
  type(IDEA);
  expect(
    screen
      .getAllByRole('button', { name: /Generate image/ })
      .every((b) => b.disabled),
  ).toBe(true);
  cleanup();

  setup({ 'GET /api/models': () => respond(503, 'unavailable') });
  renderApp();
  await screen.findByText('Image sizes are unavailable.');
  api.routes['GET /api/models'] = () => m1.models;
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() =>
    expect(screen.queryByText('Image sizes are unavailable.')).toBeNull(),
  );
});

test('information popovers open on click, close on Escape, outside press and repeat press', async () => {
  setup();
  renderApp();
  await ready();
  const trigger = screen.getByRole('button', { name: 'About the prompt' });
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(trigger);
  const panel = screen.getByRole('dialog', { name: 'About the prompt' });
  expect(trigger.getAttribute('aria-expanded')).toBe('true');
  expect(within(panel).getAllByRole('listitem').length).toBeGreaterThan(1);
  fireEvent.keyDown(panel, { key: 'Escape' });
  expect(screen.queryByRole('dialog', { name: 'About the prompt' })).toBeNull();
  fireEvent.click(trigger);
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole('dialog', { name: 'About the prompt' })).toBeNull();
  fireEvent.click(trigger);
  fireEvent.click(trigger);
  expect(screen.queryByRole('dialog', { name: 'About the prompt' })).toBeNull();
  fireEvent.focus(trigger);
  expect(screen.getByRole('dialog', { name: 'About the prompt' })).toBeTruthy();
});

test('removing a generated control drops it from the next request; base controls cannot be removed', async () => {
  setup();
  renderApp();
  await ready();
  type(IDEA);
  fireEvent.click(screen.getByRole('button', { name: 'Regenerate options' }));
  await screen.findByRole('checkbox', { name: 'Red' });
  fireEvent.click(screen.getByRole('button', { name: 'Remove Highlights' }));
  await waitFor(() =>
    expect(screen.queryByRole('group', { name: 'Highlights' })).toBeNull(),
  );
  expect(screen.queryByRole('button', { name: 'Remove Style' })).toBeNull();
  enter();
  await screen.findByRole('heading', { name: IDEA });
  const labels = api.called(GENERATE)[0].body.controls.map((c) => c.label);
  expect(labels).not.toContain('Highlights');
  expect(labels).toContain('Details');
});
