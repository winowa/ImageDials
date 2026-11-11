import React, { useLayoutEffect } from 'react';
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
import Create from '../../src/features/create/Create.jsx';
import { useStudio } from '../../src/app/studio.js';
import {
  GROUP,
  serializeEntries,
} from '../../src/features/controls/controls.js';
import { serializeEditEntries } from '../../src/features/references/references.js';
import { normalizeClientPolicy } from '../../src/data/api/clientPolicy.js';
import {
  fakeLibrary,
  fixtures,
  installApi,
  sizedRecord,
} from '../helpers/testSupport.js';
import editing from '../../../fixtures/api/image-editing.json';
import editCatalog from '../../../fixtures/api/edit-controls.json';
import {
  capturePreset,
  applyPreset,
} from '../../src/features/controls/presets/controlPresets.js';
import { stageView } from '../../src/features/results/Viewer.jsx';

let current;
function Harness() {
  const studio = useStudio({
    clientPolicy: normalizeClientPolicy({
      controls: { debounce_ms: 60000, reset_debounce_ms: 60000 },
    }),
  });
  useLayoutEffect(() => {
    current = studio;
  });
  return <Create studio={studio} />;
}
function setup(routes = {}) {
  const api = installApi({
    ...fakeLibrary([]).routes,
    'GET /api/app-capabilities': () => ({
      ...fixtures.m1.capabilities,
      image_editing: editing.capabilities,
    }),
    ...routes,
  });
  const view = render(<Harness />);
  return { api, view };
}
const kind = (label) => screen.getByRole('radio', { name: label });
const base = () =>
  current.entries.filter((entry) => entry.group === GROUP.base);
const ready = () => waitFor(() => expect(current.base.status).toBe('ready'));
beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test.each(['Text to image', 'Edit image', 'Asset image for 3D'])(
  'mode preference reloads %s with empty stage, no analysis or generation',
  async (label) => {
    const { api, view } = setup();
    await ready();
    fireEvent.click(kind(label));
    await ready();
    act(() => current.setPrompt('An unsent idea'));
    act(() => current.newDraft());
    expect(kind(label).checked).toBe(true);
    expect(current.draft.prompt).toBe('');
    expect(current.current).toBeNull();
    view.unmount();
    render(<Harness />);
    await ready();
    expect(kind(label).checked).toBe(true);
    expect(current.current).toBeNull();
    expect(api.called('POST /api/images/reference-analysis')).toHaveLength(0);
    expect(api.called('POST /api/generate-image')).toHaveLength(0);
  },
);

test('open prompt help follows all modes and model reference labels without calls', async () => {
  const { api } = setup();
  await ready();
  fireEvent.click(screen.getByRole('button', { name: 'About the prompt' }));
  expect(
    screen.getByRole('dialog', { name: 'About the prompt' }).textContent,
  ).toContain('image you want');
  // Set mode through the connected owner to keep this same help popover open.
  act(() => current.setKind('edit'));
  expect(
    screen.getByRole('dialog', { name: 'About the prompt' }).textContent,
  ).toContain('change');
  expect(
    screen.getByRole('dialog', { name: 'About the prompt' }).textContent,
  ).toContain('base');
  act(() => current.setKind('asset'));
  expect(
    screen.getByRole('dialog', { name: 'About the prompt' }).textContent,
  ).toContain('one object');
  expect(
    screen.getByRole('dialog', { name: 'About the prompt' }).textContent,
  ).toContain('black, gray or white');
  act(() => current.setKind('text'));
  expect(
    screen.getByRole('dialog', { name: 'About the prompt' }).textContent,
  ).toContain('image you want');
  expect(api.calls.filter((call) => call.key.startsWith('POST '))).toHaveLength(
    0,
  );
});

test('fresh edit catalog is visible, empty and off; mode switches and Undo retain exact choices', async () => {
  setup();
  await ready();
  const text = serializeEntries(base());
  act(() => current.setKind('edit'));
  await ready();
  expect(base().map((entry) => entry.wire.id)).toEqual(
    editCatalog.controls.map((wire) => wire.id),
  );
  expect(
    serializeEditEntries(base()).every((wire) => wire.apply_to_edit === false),
  ).toBe(true);
  const panel = screen.getByRole('region', { name: 'Standard controls' });
  expect(
    within(panel).queryByRole('button', {
      name: /Style adjustments|Randomize/,
    }),
  ).toBeNull();
  const entry = base().find((e) => e.wire.id === 'edit-background-v1');
  act(() => current.setValue(entry.key, 'A plain gray wall'));
  const exact = serializeEditEntries(base());
  act(() => current.setKind('text'));
  await ready();
  expect(serializeEntries(base())).toEqual(text);
  act(() => current.setKind('edit'));
  await ready();
  expect(serializeEditEntries(base())).toEqual(exact);
  act(() => current.undoDraft());
  expect(current.kind).toBe('text');
  expect(serializeEntries(base())).toEqual(text);
});

test.each(['text', 'asset'])(
  'Randomize %s changes only Standard values in one Undo, keeping off flags',
  async (tool) => {
    setup();
    await ready();
    if (tool === 'asset') {
      act(() => current.setKind(tool));
      await ready();
    }
    const first = base()[0];
    act(() => current.setEnabled(first.key, false));
    const original = structuredClone(current.entries);
    const prompt = current.draft.prompt;
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    fireEvent.click(
      screen.getByRole('button', { name: 'Randomize standard controls' }),
    );
    expect(base()[0].enabled).toBe(false);
    expect(current.draft.prompt).toBe(prompt);
    expect(current.historyState.undoLabel).toBe('Randomize standard controls');
    expect(
      base().some(
        (entry, index) =>
          JSON.stringify(entry.wire.value) !==
          JSON.stringify(original[index].wire.value),
      ),
    ).toBe(true);
    act(() => current.undoDraft());
    expect(current.entries).toEqual(original);
  },
);

test('stage distinguishes portrait edit request from immutable earlier asset result', () => {
  const draft = { mode: 'asset-image', edit: true, aspect: '3:2' };
  const studio = {
    draft,
    references: { refs: [{ dimensions: { width: 4908, height: 6519 } }] },
    discovery: { models: { data: fixtures.m1.models } },
  };
  const requested = stageView(studio);
  expect(requested.modeLabel).toBe('Edit');
  expect(requested.aspect).toBe('2:3');
  expect(requested.requested).toBe(true);
  const result = sizedRecord('asset', 1152, 768, {
    mode: 'asset-image',
    generation_mode: 'trellis',
    aspect: '2:3',
  });
  const old = stageView({ ...studio, current: result });
  expect(old.modeLabel).toBe('Asset image');
  expect(old.size).toEqual({ width: 1152, height: 768 });
  expect(old.requested).toBe(false);
  expect(old.aspect).toBe('3:2');
});

test('an edit preset restores exact optional adjustments and off flags in one Undo', async () => {
  setup();
  await ready();
  act(() => current.setKind('edit'));
  await ready();
  const background = base().find(
    (entry) => entry.wire.id === 'edit-background-v1',
  );
  act(() => current.setValue(background.key, 'A plain gray wall'));
  act(() => current.setApplyToEdit(background.key, false));
  const { preset } = capturePreset({
    name: 'Quiet background',
    editing: true,
    mode: current.draft.mode,
    entries: current.entries,
  });
  act(() => current.setValue(background.key, 'A garden'));
  const before = structuredClone(current.entries);
  act(() =>
    current.applyControlEntries(
      'Apply Quiet background',
      (entries) =>
        applyPreset(preset, {
          mode: current.draft.mode,
          entries,
          editing: true,
        }).entries,
    ),
  );
  const restored = base().find((entry) => entry.key === background.key);
  expect(restored.wire.value).toBe('A plain gray wall');
  expect(restored.applyToEdit).toBe(false);
  expect(
    serializeEditEntries(base()).every((wire) => wire.apply_to_edit === false),
  ).toBe(true);
  act(() => current.undoDraft());
  expect(current.entries).toEqual(before);
});

test('edit framing sits below the prompt before references and distinguishes base pixels from requested size', async () => {
  const { api } = setup();
  await ready();
  act(() => current.setKind('edit'));
  await ready();
  URL.createObjectURL = vi.fn(() => 'blob:portrait-base');
  URL.revokeObjectURL = vi.fn();
  const descriptor = {
    id: 'portrait',
    sha256: 'a'.repeat(64),
    filename: 'portrait.png',
    description: 'Portrait base',
    dimensions: { width: 4908, height: 6519 },
  };
  act(() =>
    current.references.restoreDraft(
      [descriptor],
      null,
      new Map([
        [
          'portrait',
          {
            blob: new Blob(['synthetic'], { type: 'image/png' }),
            name: 'portrait.png',
            prepared: true,
          },
        ],
      ]),
    ),
  );
  const framing = screen.getByRole('group', { name: 'Framing' });
  expect(framing.textContent).toContain('Base');
  expect(framing.textContent).toContain('4908×6519');
  expect(framing.textContent).toContain('Requested');
  expect(framing.textContent).toContain('Portrait');
  expect(framing.textContent).toContain('768×1152');
  expect(
    framing.compareDocumentPosition(
      screen.getByRole('region', { name: 'References' }),
    ) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(screen.queryByRole('radio', { name: '3:2' })).toBeNull();
  expect(api.calls.filter((call) => call.key.startsWith('POST '))).toHaveLength(
    0,
  );
});

test('blocking inference constraint has local warning details, while loading and ordinary add-image guidance stay quiet', async () => {
  setup({
    'GET /api/models': () => ({
      ...fixtures.m1.models,
      inference_enabled: false,
    }),
  });
  await ready();
  const status = document.querySelector('.generate-status');
  expect(status.textContent).toContain('Inference is disabled on the server.');
  fireEvent.click(
    within(status).getByRole('button', { name: 'Warning details' }),
  );
  const details = screen.getByRole('dialog', { name: 'Warning details' });
  expect(details.textContent).toContain('Validation');
  expect(details.textContent).not.toContain('HTTP status');
  fireEvent.keyDown(details, { key: 'Escape' });
  expect(document.querySelector('.generate-btn').disabled).toBe(true);
});

test('empty Edit gives an ordinary add-image instruction without warning alert noise', async () => {
  setup();
  await ready();
  act(() => current.setKind('edit'));
  await ready();
  const status = document.querySelector('.generate-status');
  expect(status.textContent).toContain('Add the image to edit.');
  expect(
    within(status).queryByRole('button', { name: 'Warning details' }),
  ).toBeNull();
  expect(within(status).queryByRole('alert')).toBeNull();
});
