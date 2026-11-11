import editControls from '../../../../../fixtures/api/edit-controls.json';
import { expect, test } from 'vitest';
import {
  capturePreset,
  applyPreset,
  normalizePreset,
} from './controlPresets.js';
import { createEntries, GROUP } from '../controls.js';

const entries = () => [
  ...createEntries(
    [
      {
        id: 'color',
        label: 'Color',
        kind: 'multi-select',
        options: { warm: 'Warm', cool: 'Cool' },
        value: ['warm'],
        opaque: { kept: false },
      },
      {
        id: 'amount',
        label: 'Amount',
        kind: 'slider',
        min: 0,
        max: 10,
        value: 0,
      },
      { id: 'flag', label: 'Flag', kind: 'binary', value: false },
    ],
    GROUP.base,
  ),
  ...createEntries(
    [
      {
        id: 'subject',
        label: 'Subject',
        kind: 'text-input',
        value: 'Do not capture',
      },
    ],
    GROUP.generated,
  ),
];
const capture = (list = entries()) =>
  capturePreset({ name: 'Warm scene', mode: 'image', entries: list }).preset;

test('capture excludes generated controls, provenance and unrecognized fields while preserving false and zero', () => {
  const list = entries();
  list[0].providerHeader = 'not-saved';
  const preset = capture(list);
  expect(preset.controls).toEqual([
    {
      id: 'color',
      kind: 'multi-select',
      value: ['warm'],
      custom: [],
      enabled: true,
    },
    { id: 'amount', kind: 'slider', value: 0, custom: [], enabled: true },
    { id: 'flag', kind: 'binary', value: false, custom: [], enabled: true },
  ]);
  list[0].wire.value.push('cool');
  expect(preset.controls[0].value).toEqual(['warm']);
});

test('applying changes only stable matching base entries and leaves immutable input and opaque fields intact', () => {
  const preset = capture();
  const list = entries();
  list[0].wire.value = ['cool'];
  const before = JSON.stringify(list);
  const result = applyPreset(preset, { mode: 'image', entries: list });
  expect(result.applied).toBe(3);
  expect(result.entries[0].wire.value).toEqual(['warm']);
  expect(result.entries[0].wire.opaque).toEqual({ kept: false });
  expect(result.entries[0]).toMatchObject({
    explicit: true,
    applyToEdit: true,
  });
  expect(result.entries[3]).toBe(list[3]);
  expect(JSON.stringify(list)).toBe(before);
});

test('mode mismatch applies nothing', () => {
  const list = entries();
  expect(
    applyPreset(capture(), { mode: 'asset-image', entries: list }),
  ).toMatchObject({ entries: list, applied: 0, reason: 'mode' });
});

test('capture skips controls lacking stable IDs or with unsupported kinds', () => {
  const list = entries();
  delete list[1].wire.id;
  list[2].wire.kind = 'future-control';
  expect(
    capturePreset({ name: 'Known', mode: 'image', entries: list }).skipped,
  ).toEqual(['Amount', 'Flag']);
});

test('custom choices are restored without replacing current options or defaults', () => {
  const list = entries();
  list[0].custom = ['custom'];
  list[0].wire.options.custom = 'Luminous';
  list[0].wire.value = ['custom'];
  list[0].applyToEdit = false;
  const result = applyPreset(capture(list), {
    mode: 'image',
    entries: entries(),
  });
  expect(result.entries[0]).toMatchObject({
    custom: ['custom'],
    initial: ['warm'],
    applyToEdit: false,
    wire: {
      options: { warm: 'Warm', cool: 'Cool', custom: 'Luminous' },
      value: ['custom'],
    },
  });
});

test('presets retain disabled Standard categories and keep them inactive for an edit', () => {
  const list = entries();
  list[0].enabled = false;
  const preset = capture(list);
  expect(preset.controls[0].enabled).toBe(false);
  expect(
    applyPreset(preset, { mode: 'image', entries: entries() }).entries[0],
  ).toMatchObject({ enabled: false, wire: { value: ['warm'] } });
  expect(
    applyPreset(preset, { mode: 'image', entries: entries(), editing: true })
      .entries[0],
  ).toMatchObject({ enabled: false, applyToEdit: false });
  preset.controls[0].applyToEdit = true;
  expect(
    applyPreset(preset, { mode: 'image', entries: entries(), editing: true })
      .entries[0].applyToEdit,
  ).toBe(true);
});

test('old presets default to enabled and restored wire flags are captured', () => {
  const preset = capture();
  delete preset.controls[0].enabled;
  expect(
    applyPreset(preset, { mode: 'image', entries: entries() }).entries[0]
      .enabled,
  ).toBe(true);
  const list = entries();
  list[0].wire.apply_to_generation = false;
  expect(capture(list).controls[0].enabled).toBe(false);
});

test('conflicting custom keys and missing choices leave the whole target control unchanged', () => {
  const preset = capture();
  preset.controls[0].custom = [{ key: 'warm', label: 'Different meaning' }];
  const list = entries();
  expect(applyPreset(preset, { mode: 'image', entries: list }).entries[0]).toBe(
    list[0],
  );
  preset.controls[0].custom = [];
  preset.controls[0].value = ['removed'];
  const result = applyPreset(preset, { mode: 'image', entries: list });
  expect(result.entries[0]).toBe(list[0]);
  expect(result.skipped).toContainEqual({ id: 'color', reason: 'choice' });
});

test('catalog migrations allow a single choice to become multi but never discard multiple selections', () => {
  const preset = capture();
  preset.controls[0].kind = 'single-select';
  preset.controls[0].value = 'warm';
  expect(
    applyPreset(preset, { mode: 'image', entries: entries() }).entries[0].wire
      .value,
  ).toEqual(['warm']);
  const list = entries();
  list[0].wire.kind = 'radio';
  const multi = capture();
  multi.controls[0].value = ['warm', 'cool'];
  expect(applyPreset(multi, { mode: 'image', entries: list }).entries[0]).toBe(
    list[0],
  );
});

test('changed numeric bounds and missing category IDs are reported without coercing values', () => {
  const preset = capture();
  preset.controls[1].value = 9;
  const list = entries();
  list[1].wire.max = 5;
  list.splice(2, 1);
  const result = applyPreset(preset, { mode: 'image', entries: list });
  expect(result.skipped).toEqual([
    { id: 'amount', reason: 'value' },
    { id: 'flag', reason: 'missing' },
  ]);
  expect(result.entries[1].wire.value).toBe(0);
});

test('reapplying a preset with identical values and application flags adds no undo work', () => {
  const preset = capture();
  const first = applyPreset(preset, { mode: 'image', entries: entries() });
  const second = applyPreset(preset, {
    mode: 'image',
    entries: first.entries,
  });
  expect(second.applied).toBe(first.applied);
  expect(second.entries).toBe(first.entries);
  expect(second.skipped).toEqual([]);
});

test.each([
  { name: '' },
  { mode: 'unknown' },
  { controls: [] },
  { controls: [{ id: 'x', kind: 'binary', value: {}, custom: [] }] },
  { controls: [{ id: 'x', kind: 'slider', value: Infinity, custom: [] }] },
])('malformed preset is refused: %j', (patch) => {
  expect(() => normalizePreset({ ...capture(), ...patch })).toThrow();
});

test('capturing all six fresh edit defaults records preserve-source defaults as off', () => {
  const list = createEntries(editControls.controls, GROUP.base);
  const before = JSON.stringify(list);
  const { preset } = capturePreset({
    name: 'Preserve source',
    mode: 'image',
    entries: list,
    editing: true,
  });
  expect(preset.controls).toHaveLength(6);
  expect(JSON.stringify(list)).toBe(before);
  expect(
    preset.controls.every((control) => control.applyToEdit === false),
  ).toBe(true);
  const applied = applyPreset(preset, {
    mode: 'image',
    entries: list,
    editing: true,
  });
  expect(
    applied.entries
      .filter((entry) => entry.group === GROUP.base)
      .every((entry) => entry.applyToEdit === false),
  ).toBe(true);
});
