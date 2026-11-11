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
import expanded from '../../../fixtures/api/expanded-static-controls.json';
import context from '../../../fixtures/api/control-context.json';
import {
  categorySummaries,
  createEntries,
  expansionRequest,
  GROUP,
  serializeEntries,
  upgradeFixedEntries,
} from '../../src/features/controls/controls.js';
import {
  clone,
  fakeLibrary,
  FakeEventSource,
  installApi,
  sizedRecord,
} from '../helpers/testSupport.js';

const STATIC = 'GET /api/controls/static?generation_mode=standard';
const catalog = expanded.standard.controls;

/** Controls as an earlier release saved them: single choices, no Wide shot. */
const legacyControls = () => [
  {
    id: 'color',
    kind: 'single-select',
    label: 'Color',
    origin: 'fixed',
    value: 'warm',
    options: { warm: 'Warm', cool: 'Cool', custom_hue: 'Teal' },
    future_field: { keep: 0 },
  },
  {
    id: 'composition',
    kind: 'dropdown',
    label: 'Composition',
    origin: 'fixed',
    value: null,
    options: { balanced: 'Balanced' },
  },
  {
    id: 'camera-angle',
    kind: 'single-select',
    label: 'Camera angle',
    origin: 'fixed',
    value: 'low-angle',
    options: { 'low-angle': 'Low angle', 'eye-level': 'Eye level' },
  },
  {
    id: 'generated-color',
    kind: 'single-select',
    label: 'Color',
    origin: 'generated',
    value: 'red',
    options: { red: 'Red' },
  },
];

test('upgradeFixedEntries converts known fixed controls and merges options without mutating', () => {
  const wires = legacyControls();
  const frozen = clone(wires);
  const entries = createEntries(wires, GROUP.base);
  const upgraded = upgradeFixedEntries(entries, catalog);

  const [color, composition, camera, generated] = upgraded.map((e) => e.wire);
  expect(color.kind).toBe('multi-select');
  expect(color.value).toEqual(['warm']);
  expect(upgraded[0].initial).toEqual(['warm']);
  // Existing options keep their order and the custom one; new ones follow.
  expect(Object.keys(color.options).slice(0, 3)).toEqual([
    'warm',
    'cool',
    'custom_hue',
  ]);
  expect(color.options.monochrome).toBe('Monochrome');
  expect(color.future_field).toEqual({ keep: 0 });
  expect(composition.kind).toBe('multi-select');
  expect(composition.value).toEqual([]);
  // Wide shot is merged into a control that stays single-select.
  expect(camera.kind).toBe('single-select');
  expect(camera.value).toBe('low-angle');
  expect(camera.options['wide-shot']).toBeTruthy();
  // A control is matched by id and origin, never by its label.
  expect(generated).toBe(entries[3].wire);
  // The input records are untouched.
  expect(wires).toEqual(frozen);
});

test('an unknown kind and an unknown id are left as they were', () => {
  const entries = createEntries(
    [
      { id: 'color', kind: 'future-kind', label: 'Color', origin: 'fixed' },
      {
        id: 'not-in-catalog',
        kind: 'single-select',
        label: 'X',
        origin: 'fixed',
        value: 'a',
        options: { a: 'A' },
      },
      {
        kind: 'single-select',
        label: 'Color',
        origin: 'fixed',
        value: 'a',
        options: { a: 'A' },
      },
    ],
    GROUP.base,
  );
  expect(upgradeFixedEntries(entries, catalog)).toEqual(entries);
});

test('context summaries carry label, kind, id and description only', () => {
  const entries = createEntries(
    [
      {
        id: 'cloth',
        kind: 'multi-select',
        label: 'Cloth detail',
        description: 'Details of the fabric.',
        value: ['woven'],
        options: { woven: 'Woven' },
        origin: 'generated',
        independent_extension: { zero: 0 },
      },
      { kind: 'binary', label: 'Fog', value: false },
    ],
    GROUP.generated,
  );
  expect(categorySummaries(entries)).toEqual([
    {
      id: 'cloth',
      label: 'Cloth detail',
      kind: 'multi-select',
      description: 'Details of the fabric.',
    },
    { label: 'Fog', kind: 'binary' },
  ]);
  const body = expansionRequest(entries[0], entries);
  expect(body.control).toEqual(entries[0].wire);
  expect(body.control.independent_extension).toEqual({ zero: 0 });
  // The shape the server fixture was captured with.
  expect(Object.keys(body).sort()).toEqual(
    Object.keys(context.expansion.request).sort(),
  );
  expect(categorySummaries(entries.concat(entries.map(clone))).length).toBe(4);
});

// --- connected restore -------------------------------------------------------

let library;
const open = (records, extra = {}) => {
  window.history.replaceState(null, '', '/');
  library = fakeLibrary(records);
  installApi({
    [STATIC]: () => expanded.standard,
    ...library.routes,
    ...extra,
  });
  return render(<App />);
};

beforeEach(() => {
  localStorage.clear();
  FakeEventSource.reset();
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal('scrollTo', () => {});
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test('a restored old record can select Warm and Cool, and the saved record is unchanged', async () => {
  const record = sizedRecord('old', 1152, 768, {
    original_prompt: 'An old image',
    selected_controls: legacyControls(),
    original_selected_controls: undefined,
  });
  const before = JSON.stringify(record);
  open([record]);
  fireEvent.click(await screen.findByRole('button', { name: 'Image old' }));
  const panel = await screen.findByRole('region', {
    name: 'Standard controls',
  });
  await openStandardControls();
  const group = await within(panel).findByRole('group', { name: 'Color' });
  // Wait for the upgrade: Warm is selected and the group is a checkbox set.
  const warm = await within(group).findByRole('checkbox', { name: 'Warm' });
  await waitFor(() => expect(warm.checked).toBe(true));
  fireEvent.click(within(group).getByRole('checkbox', { name: 'Cool' }));
  expect(
    within(group)
      .getAllByRole('checkbox', { checked: true })
      .map((box) => box.parentElement.textContent),
  ).toEqual(['Warm', 'Cool']);
  // Composition is chips; Wide shot reached the single-choice Camera angle.
  expect(
    within(panel).queryByRole('combobox', { name: 'Composition' }),
  ).toBeNull();
  expect(
    within(
      within(panel).getByRole('radiogroup', { name: 'Camera angle' }),
    ).getByRole('radio', { name: 'Wide shot' }),
  ).toBeTruthy();
  expect(JSON.stringify(record)).toBe(before);
  expect(JSON.stringify(library.records[0])).toBe(before);
});

test('New draft empties the stage and keeps history; later records do not refill it', async () => {
  open([
    sizedRecord('one', 1152, 768, { original_prompt: 'Prompt of one' }),
    sizedRecord('two', 1152, 768, { original_prompt: 'Prompt of two' }),
  ]);
  fireEvent.click(await screen.findByRole('button', { name: 'Image one' }));
  await waitFor(() =>
    expect(screen.getByLabelText('Image idea').value).toBe('Prompt of one'),
  );
  expect(document.querySelector('.stage-img')).not.toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'New draft' }));
  expect(screen.getByLabelText('Image idea').value).toBe('');
  expect(document.querySelector('.stage-img')).toBeNull();
  const strip = screen.getByRole('region', { name: 'Saved images' });
  expect(within(strip).getByRole('button', { name: 'Image one' })).toBeTruthy();
  expect(within(strip).getByRole('button', { name: 'Image two' })).toBeTruthy();
  expect(library.records).toHaveLength(2);
  // Choosing an image shows it again.
  fireEvent.click(within(strip).getByRole('button', { name: 'Image two' }));
  await waitFor(() =>
    expect(document.querySelector('.stage-img')).not.toBeNull(),
  );
  expect(screen.getByLabelText('Image idea').value).toBe('Prompt of two');
});

test('serialization keeps both selected values after an upgrade', () => {
  const entries = upgradeFixedEntries(
    createEntries(legacyControls(), GROUP.base),
    catalog,
  );
  const colored = entries.map((e) =>
    e.wire.id === 'color' && e.group === GROUP.base
      ? { ...e, wire: { ...e.wire, value: ['warm', 'cool'] } }
      : e,
  );
  expect(serializeEntries(colored)[0].value).toEqual(['warm', 'cool']);
});
