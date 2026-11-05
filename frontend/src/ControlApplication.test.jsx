import { openStandardControls } from './controlUiTestSupport.js';
/**
 * Optional Standard controls in text requests (apply_to_generation) and the
 * optional editing instructions, through App with the shared
 * control-application fixture.
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

import application from '../../fixtures/api/control-application.json';
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
  libraryRecord,
  respond,
} from './testSupport.js';

const harness = vi.hoisted(() => ({
  cache: { store: null, ready: true },
  // The episode's random draw; identity unless a test sets one.
  draw: (entries) => entries,
}));
vi.mock('./useCacheStore.js', () => ({ useCacheStore: () => harness.cache }));
vi.mock('./standardRandom.js', async (original) => ({
  ...(await original()),
  randomizeStandard: (entries) => harness.draw(entries),
}));

const { m1 } = fixtures;
const GENERATE = 'POST /api/generate-image';
const DYNAMIC = 'POST /api/controls/dynamic';
const ANALYZE = 'POST /api/images/reference-analysis';
const TEXT_JOB = 'GET /api/generation-jobs/fixture-image-1';
const jobPolicy = { pollIntervalMs: 1, maxConsecutivePollFailures: 3 };
const UPLOADS = {
  image_mime_types: ['image/png', 'image/jpeg', 'image/webp'],
  import_max_bytes: 33554432,
};

let api;

function setup({ supported = true, edits = false, records = [] } = {}) {
  harness.cache = {
    store: createCacheStore(memoryDb(), DEFAULT_CLIENT_POLICY.cache, {
      openChannel: () => null,
    }),
    ready: true,
  };
  api = installApi({
    'GET /api/app-capabilities': () => ({
      ...m1.capabilities,
      uploads: UPLOADS,
      client_policy: { controls: { debounce_ms: 20, reset_debounce_ms: 20 } },
      ...(supported ? { control_application: application.capability } : {}),
      ...(edits ? { image_editing: editing.capabilities } : {}),
    }),
    [DYNAMIC]: () => m1.dynamic_response,
    [GENERATE]: () => respond(202, m1.accepted),
    [TEXT_JOB]: () => clone(m1.job_complete),
    [ANALYZE]: async (form) => ({
      ...clone(editing.analysis.first.response),
      source_sha256: await sha256Hex(form.get('image')),
      description: 'Described',
      reference_index: 1,
      revision: JSON.parse(form.get('context')).revision,
    }),
    ...fakeLibrary(records).routes,
  });
}

const renderApp = () => render(<App jobPolicy={jobPolicy} />);
const ready = () => openStandardControls();
const prompt = () => screen.getByLabelText('Image idea');
const type = (text) => fireEvent.change(prompt(), { target: { value: text } });
// The shared Apply toggle: on sends the value, off leaves it to the model.
const useBox = (label) =>
  screen.queryByRole('button', { name: `Apply ${label}`, exact: true });
const isOn = (element) => element.getAttribute('aria-pressed') === 'true';
const undo = () =>
  fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
const redo = () =>
  fireEvent.keyDown(document.body, { key: 'y', ctrlKey: true });
const generate = () => fireEvent.keyDown(prompt(), { key: 'Enter' });
const sent = (n = 0) => api.called(GENERATE)[n].body;
const control = (body, id) => body.controls.find((c) => c.id === id);
const bytesOf = (base64) =>
  Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
const fixtureFile = () => {
  const item = editing.files[0];
  return new File([bytesOf(item.base64)], item.filename, {
    type: item.content_type,
  });
};

beforeEach(() => {
  harness.draw = (entries) => entries;
  window.history.replaceState(null, '', '/');
  localStorage.clear();
  URL.createObjectURL = vi.fn(() => 'blob:application');
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test('an older server offers no off state and requests carry no text flag', async () => {
  setup({ supported: false });
  renderApp();
  await ready();
  expect(useBox('Lighting')).toBeNull();
  type('A glass heron');
  generate();
  await waitFor(() => expect(api.called(GENERATE)).toHaveLength(1));
  expect(JSON.stringify(sent())).not.toContain('apply_to_generation');
});

test('a control left to the model keeps its value, is flagged off, and the rest are unchanged', async () => {
  setup();
  renderApp();
  await ready();
  const box = useBox('Lighting');
  expect(isOn(box)).toBe(true);
  fireEvent.click(
    within(screen.getByRole('radiogroup', { name: 'Lighting' })).getByRole(
      'radio',
      { name: 'Golden hour' },
    ),
  );
  fireEvent.click(box);
  expect(isOn(useBox('Lighting'))).toBe(false);
  const lighting = screen
    .getByRole('radiogroup', { name: 'Lighting' })
    .closest('.control');
  expect(lighting.dataset.enabled).toBe('false');
  expect(
    within(lighting).getByText('Model decides', {
      selector: '.category-summary',
    }),
  ).toBeTruthy();

  type('A glass heron');
  generate();
  await waitFor(() => expect(api.called(GENERATE)).toHaveLength(1));
  const body = sent();
  expect(control(body, 'lighting')).toMatchObject({
    value: 'golden-hour',
    apply_to_generation: false,
  });
  for (const id of ['style', 'color', 'composition'])
    expect(control(body, id)).not.toHaveProperty('apply_to_generation');
});

test('enabled controls send exactly the legacy request', async () => {
  setup();
  renderApp();
  await ready();
  type('A glass heron');
  generate();
  await waitFor(() => expect(api.called(GENERATE)).toHaveLength(1));
  expect(JSON.stringify(sent())).not.toContain('apply_to_generation');
});

test('turning a control off and on is an undo step, and a choice turns it back on', async () => {
  setup();
  renderApp();
  await ready();
  fireEvent.click(useBox('Color'));
  expect(isOn(useBox('Color'))).toBe(false);
  undo();
  await waitFor(() => expect(isOn(useBox('Color'))).toBe(true));
  redo();
  await waitFor(() => expect(isOn(useBox('Color'))).toBe(false));
  fireEvent.click(
    within(screen.getByRole('radiogroup', { name: 'Color' })).getByRole(
      'radio',
      { name: 'Cool' },
    ),
  );
  expect(isOn(useBox('Color'))).toBe(true);
  // Choosing while off is one step: undo returns the value and the off state.
  undo();
  await waitFor(() => expect(isOn(useBox('Color'))).toBe(false));
});

test('an off control stays off with its value across a new idea, and Reset restores defaults', async () => {
  // A visible draw: every enabled Style and Color changes when an idea starts.
  const drawn = { style: 'oil-painting', color: 'monochrome' };
  harness.draw = (entries) =>
    entries.map((e) =>
      e.group === 'base' && drawn[e.wire.id]
        ? { ...e, wire: { ...e.wire, value: drawn[e.wire.id] } }
        : e,
    );
  const checkedIn = (group, name) =>
    within(screen.getByRole('radiogroup', { name: group })).getByRole('radio', {
      name,
    }).checked;
  setup();
  renderApp();
  await ready();
  type('A brass lantern');
  await waitFor(() => expect(checkedIn('Color', 'Monochrome')).toBe(true));
  fireEvent.click(
    within(screen.getByRole('radiogroup', { name: 'Style' })).getByRole(
      'radio',
      { name: 'Watercolor' },
    ),
  );
  fireEvent.click(
    within(screen.getByRole('radiogroup', { name: 'Color' })).getByRole(
      'radio',
      { name: 'Cool' },
    ),
  );
  fireEvent.click(useBox('Style'));
  type('An entirely different subject: snowy owls at night');
  // The new idea drew again for the enabled control...
  await waitFor(() => expect(checkedIn('Color', 'Monochrome')).toBe(true));
  // ...and left the off control's value and state alone.
  expect(isOn(useBox('Style'))).toBe(false);
  expect(checkedIn('Style', 'Watercolor')).toBe(true);
  fireEvent.click(
    screen.getByRole('button', { name: 'Reset standard controls' }),
  );
  expect(isOn(useBox('Style'))).toBe(true);
});

test('a restored text record brings back its off state', async () => {
  const controls = m1.static_standard.controls.map((wire) => ({
    ...clone(wire),
    origin: 'fixed',
    ...(wire.id === 'lighting'
      ? { value: 'dramatic', apply_to_generation: false }
      : {}),
  }));
  const record = libraryRecord({
    id: 'flagged',
    original_prompt: 'Flagged idea',
    original_selected_controls: controls,
  });
  setup({ records: [record] });
  window.history.replaceState(null, '', '/?edit=flagged');
  renderApp();
  await waitFor(() => expect(prompt().value).toBe('Flagged idea'));
  await waitFor(() => expect(isOn(useBox('Lighting'))).toBe(false));
  expect(isOn(useBox('Style'))).toBe(true);
  generate();
  await waitFor(() => expect(api.called(GENERATE)).toHaveLength(1));
  expect(control(sent(), 'lighting')).toMatchObject({
    value: 'dramatic',
    apply_to_generation: false,
  });
});

test('an off state the server cannot honour blocks generation until turned back on', async () => {
  const controls = m1.static_standard.controls.map((wire) => ({
    ...clone(wire),
    origin: 'fixed',
    ...(wire.id === 'color' ? { apply_to_generation: false } : {}),
  }));
  const record = libraryRecord({
    id: 'older',
    original_prompt: 'Older server idea',
    original_selected_controls: controls,
  });
  setup({ supported: false, records: [record] });
  window.history.replaceState(null, '', '/?edit=older');
  renderApp();
  await waitFor(() => expect(prompt().value).toBe('Older server idea'));
  const box = await waitFor(() => {
    const found = useBox('Color');
    expect(isOn(found)).toBe(false);
    return found;
  });
  // Only the off control can be switched; the others offer nothing new.
  expect(useBox('Style')).toBeNull();
  await screen.findByText(
    'This server uses every control. Turn Color back on to generate.',
  );
  fireEvent.click(box);
  expect(useBox('Color')).toBeNull();
  generate();
  await waitFor(() => expect(api.called(GENERATE)).toHaveLength(1));
  expect(JSON.stringify(sent())).not.toContain('apply_to_generation');
});

test('an edit shows Standard categories without an outer collapse and sends only opt-in adjustments', async () => {
  setup({ edits: true });
  renderApp();
  await ready();
  fireEvent.click(useBox('Lighting'));
  fireEvent.click(screen.getByRole('radio', { name: 'Edit image' }));
  await ready();
  const section = screen.getByRole('region', { name: 'Standard controls' });
  expect(
    within(section).queryByRole('button', { name: /Style adjustments/ }),
  ).toBeNull();
  expect(
    within(section).queryByRole('button', {
      name: 'Randomize standard controls',
    }),
  ).toBeNull();
  const toggles = within(section).getAllByRole('button', { name: /^Apply / });
  expect(toggles).toHaveLength(6);
  expect(toggles.every((toggle) => !isOn(toggle))).toBe(true);
  fireEvent.change(
    screen
      .getByRole('region', { name: 'References' })
      .querySelector('input[type="file"]'),
    { target: { files: [fixtureFile()] } },
  );
  await waitFor(() => expect(api.called(ANALYZE)).toHaveLength(1));
  type('Make it brighter');
  await new Promise((resolve) => setTimeout(resolve, 100));
  fireEvent.change(screen.getByRole('textbox', { name: 'Appearance change' }), {
    target: { value: 'Softer lighting' },
  });
  expect(
    isOn(
      screen.getByRole('button', { name: 'Apply Appearance change to edit' }),
    ),
  ).toBe(true);
  fireEvent.click(
    screen.getAllByRole('button', { name: /Generate edit/ }).at(-1),
  );
  await waitFor(() => expect(api.called(GENERATE)).toHaveLength(1));
  const request = JSON.parse(api.called(GENERATE)[0].body.get('request'));
  expect(JSON.stringify(request)).not.toContain('apply_to_generation');
  expect(control(request, 'edit-appearance-v1').apply_to_edit).toBe(true);
  expect(control(request, 'edit-identity-v1').apply_to_edit).toBe(false);
});

test('a preset keeps the off state and applying it brings it back', async () => {
  setup();
  renderApp();
  await ready();
  fireEvent.click(useBox('Composition'));
  fireEvent.click(screen.getByRole('button', { name: 'Presets' }));
  fireEvent.click(screen.getByRole('menuitem', { name: /Save as preset/ }));
  const dialog = await screen.findByRole('dialog', { name: 'Save preset' });
  fireEvent.change(within(dialog).getByLabelText('Preset name'), {
    target: { value: 'Free framing' },
  });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  await screen.findByText('Saved Free framing.');
  fireEvent.click(useBox('Composition'));
  expect(isOn(useBox('Composition'))).toBe(true);

  fireEvent.click(screen.getByRole('button', { name: 'Presets' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Apply Free framing' }));
  expect(isOn(useBox('Composition'))).toBe(false);
  undo();
  await waitFor(() => expect(isOn(useBox('Composition'))).toBe(true));
});
