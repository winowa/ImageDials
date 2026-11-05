import { expect, test } from 'vitest';

import {
  addCustomOption,
  applyExpansion,
  clearSelection,
  createEntries,
  createEntry,
  describeControl,
  entriesFromRecord,
  GROUP,
  mergeGenerated,
  optionEntries,
  parseControlList,
  recordControls,
  resetEntry,
  selectionSummary,
  serializeEntries,
  setValue,
  toggleOption,
  validateEntries,
  wireFromCategory,
} from './controls.js';
import { clone, completedRecord, fixtures } from './testSupport.js';

const dynamic = () => clone(fixtures.m1.dynamic_response.controls);
const entryFor = (entries, id) =>
  entries.find((e) => e.key === `generated:${id}`);

test('all eight kinds and unknown fields and kinds survive an entry round-trip', () => {
  const wires = dynamic();
  const entries = createEntries(wires, GROUP.generated);
  expect(serializeEntries(entries)).toEqual(
    fixtures.m1.dynamic_response.controls,
  );
  expect(new Set(wires.map((w) => w.kind))).toEqual(
    new Set([
      'single-select',
      'slider',
      'binary',
      'text-input',
      'future-control',
      'dropdown',
      'radio',
      'multi-select',
      'checkbox',
    ]),
  );
});

test('option maps accept strings and objects without losing either form', () => {
  const entries = createEntries(dynamic(), GROUP.generated);
  expect(optionEntries(entryFor(entries, 'surface').wire)).toEqual([
    { key: 'smooth', label: 'smooth glass', description: 'Even surface' },
  ]);
  expect(optionEntries(entryFor(entries, 'setting').wire)).toEqual([
    { key: 'studio', label: 'Studio', description: null },
    { key: 'shelf', label: 'Wooden shelf', description: 'Plain background' },
  ]);
  // Editing a value never rewrites the option map.
  const picked = toggleOption(entryFor(entries, 'setting'), 'shelf');
  expect(picked.wire.options).toEqual(
    entryFor(entries, 'setting').wire.options,
  );
});

test('false, zero and text are values, not absences', () => {
  const entries = createEntries(dynamic(), GROUP.generated);
  expect(describeControl(entryFor(entries, 'pattern').wire)).toBe('No');
  expect(describeControl(entryFor(entries, 'angle').wire)).toBe('0');
  expect(describeControl(entryFor(entries, 'notes').wire)).toBe(
    'Rounded edges',
  );
  expect(describeControl(entryFor(entries, 'colors').wire)).toBe('Gold');
  expect(describeControl(entryFor(entries, 'parts').wire)).toBeNull();
  expect(describeControl(entryFor(entries, 'future').wire)).toBeNull();
  const on = setValue(entryFor(entries, 'pattern'), true);
  expect(describeControl(on.wire)).toBe('Yes');
  expect(describeControl(resetEntry(on).wire)).toBe('No');
  expect(
    describeControl(setValue(entryFor(entries, 'notes'), '').wire),
  ).toBeNull();
});

test('single choices deselect to null; multiple choices add and remove keys', () => {
  const entries = createEntries(dynamic(), GROUP.generated);
  const cleared = toggleOption(entryFor(entries, 'surface'), 'smooth');
  expect(cleared.wire.value).toBeNull();
  expect(toggleOption(cleared, 'smooth').wire.value).toBe('smooth');
  const both = toggleOption(entryFor(entries, 'colors'), 'red');
  expect(both.wire.value).toEqual(['gold', 'red']);
  expect(toggleOption(both, 'gold').wire.value).toEqual(['red']);
});

test('custom options are added once, selected, and keep other option forms', () => {
  const entries = createEntries(dynamic(), GROUP.generated);
  const setting = entryFor(entries, 'setting');
  const added = addCustomOption(setting, '  Rooftop  ');
  expect(added.wire.options.Rooftop).toBe('Rooftop');
  expect(added.wire.options.shelf).toEqual(setting.wire.options.shelf);
  expect(added.wire.value).toBe('Rooftop');
  expect(added.custom).toEqual(['Rooftop']);
  // An existing label is selected instead of duplicated.
  const reused = addCustomOption(setting, 'Wooden shelf');
  expect(reused.wire.value).toBe('shelf');
  expect(Object.keys(reused.wire.options)).toEqual(['studio', 'shelf']);
  const multi = addCustomOption(entryFor(entries, 'colors'), 'Teal');
  expect(multi.wire.value).toEqual(['gold', 'Teal']);
  const slider = entryFor(entries, 'angle');
  expect(addCustomOption(slider, 'x')).toBe(slider);
});

test('validation covers known kinds and lets unknown kinds through', () => {
  const entries = createEntries(dynamic(), GROUP.generated);
  expect(validateEntries(entries)).toEqual([]);
  const broken = [
    setValue(entryFor(entries, 'angle'), 91),
    setValue(entryFor(entries, 'pattern'), 'no'),
    setValue(entryFor(entries, 'notes'), 3),
    setValue(entryFor(entries, 'colors'), 'gold'),
    setValue(entryFor(entries, 'view'), 4),
    entryFor(entries, 'future'),
  ];
  expect(validateEntries(broken).map((p) => p.label)).toEqual([
    'Head angle',
    'Etched pattern',
    'Stand details',
    'Highlights',
    'View',
  ]);
  const flat = createEntries(
    [{ kind: 'slider', label: 'Flat', min: 5, max: 5, value: 5 }],
    GROUP.base,
  );
  expect(validateEntries(flat)[0].message).toMatch(/bounds/);
});

test('regenerated controls keep valid selections and custom options, and drop invalid ones', () => {
  const before = createEntries(dynamic(), GROUP.generated);
  const edited = before.map((e) => {
    if (e.key === 'generated:setting') return addCustomOption(e, 'Rooftop');
    if (e.key === 'generated:colors') return toggleOption(e, 'red');
    if (e.key === 'generated:notes') return setValue(e, 'Matte');
    if (e.key === 'generated:angle') return setValue(e, 45);
    if (e.key === 'generated:view') return toggleOption(e, 'front');
    return e;
  });
  const incoming = dynamic().map((w) => {
    if (w.id === 'colors') return { ...w, options: { red: 'Red' }, value: [] };
    if (w.id === 'angle') return { ...w, max: 30 };
    return w;
  });
  const merged = mergeGenerated(edited, incoming);
  const get = (id) => entryFor(merged, id).wire;
  expect(get('setting').value).toBe('Rooftop');
  expect(get('setting').options.Rooftop).toBe('Rooftop');
  expect(get('colors').value).toEqual(['red']);
  expect(get('notes').value).toBe('Matte');
  expect(get('angle').value).toBe(0);
  expect(get('view').value).toBeNull();
});

test('generated controls never share a key with base controls', () => {
  const base = createEntries(
    [
      {
        id: 'view',
        kind: 'dropdown',
        label: 'View',
        options: { a: 'A' },
        value: 'a',
      },
    ],
    GROUP.base,
  );
  const merged = mergeGenerated(base, dynamic());
  expect(base[0].key).toBe('base:view');
  expect(entryFor(merged, 'view').group).toBe(GROUP.generated);
});

test('controls without ids get unique label-based keys', () => {
  const entries = createEntries(
    [
      { kind: 'binary', label: 'Glow', value: true },
      { kind: 'binary', label: 'Glow', value: false },
    ],
    GROUP.generated,
  );
  expect(entries.map((e) => e.key)).toEqual([
    'generated:binary:Glow',
    'generated:binary:Glow#2',
  ]);
});

test('malformed control lists are rejected', () => {
  expect(() => parseControlList(null)).toThrow();
  expect(() => parseControlList([{ kind: 'slider' }])).toThrow();
  expect(parseControlList([])).toEqual([]);
});

test('a completed record exposes original controls; resolved ones stay separate', () => {
  const record = completedRecord();
  expect(record.selected_controls[0]).toEqual({
    kind: 'single-select',
    label: 'Surface',
    value: 'smooth glass',
  });
  expect(recordControls(record)).toEqual(fixtures.generation.controls);
  expect(selectionSummary(record).map((s) => [s.label, s.value])).toEqual([
    ['Surface', 'smooth glass'],
    ['Head angle', '0'],
    ['Etched pattern', 'No'],
    ['Stand details', 'Rounded edges'],
  ]);
});

test('library records keep originals in selected_controls', () => {
  const record = { selected_controls: fixtures.generation.controls };
  expect(recordControls(record)).toEqual(fixtures.generation.controls);
});

test('legacy categories become wire controls without losing fields', () => {
  const category = {
    id: 'tone',
    label: 'Tone',
    description: 'Mood',
    type: 'select',
    origin: 'fixed',
    options: [
      { id: 'warm', label: 'Warm' },
      { id: 'cool', label: 'Cool' },
    ],
    value: 'cool',
    vendor_extension: { keep: 0 },
  };
  expect(wireFromCategory(category)).toEqual({
    id: 'tone',
    label: 'Tone',
    description: 'Mood',
    kind: 'dropdown',
    origin: 'fixed',
    options: { warm: 'Warm', cool: 'Cool' },
    value: 'cool',
    vendor_extension: { keep: 0 },
  });
  expect(
    wireFromCategory({
      id: 'glow',
      label: 'Glow',
      type: 'binary',
      value: false,
      true_label: 'Lit',
      false_label: 'Dark',
    }),
  ).toMatchObject({
    kind: 'binary',
    value: false,
    trueLabel: 'Lit',
    falseLabel: 'Dark',
  });
  const restored = entriesFromRecord({ categories: [category] });
  expect(restored[0]).toMatchObject({ group: GROUP.base, key: 'base:tone' });
  expect(describeControl(restored[0].wire)).toBe('Cool');
});

test('restored entries split fixed controls from generated ones', () => {
  const record = {
    original_selected_controls: [
      { id: 'a', origin: 'fixed', kind: 'binary', label: 'A', value: false },
      { id: 'b', kind: 'slider', label: 'B', value: 0, min: 0, max: 3 },
    ],
  };
  expect(entriesFromRecord(record).map((e) => e.group)).toEqual([
    GROUP.base,
    GROUP.generated,
  ]);
});

// --- Option expansion and cleared selections ------------------------------------

const surfaceEntry = () =>
  createEntry(
    {
      id: 'surface',
      kind: 'single-select',
      label: 'Surface',
      options: { smooth: { value: 'smooth glass' }, mine: 'Mine' },
      value: 'mine',
      extension: { retained: true },
    },
    GROUP.generated,
  );

test('expansion adds only new options and keeps the current value and unknown fields', () => {
  const entry = { ...surfaceEntry(), custom: ['mine'] };
  const { entry: merged, added } = applyExpansion(entry, {
    id: 'surface',
    kind: 'single-select',
    label: 'Surface',
    options: {
      smooth: 'overwritten?',
      other: 'Other',
      renamed: 'Mine',
    },
    value: 'smooth',
    server_field: 7,
  });
  expect(added).toBe(1);
  expect(Object.keys(merged.wire.options)).toEqual(['smooth', 'mine', 'other']);
  expect(merged.wire.options.smooth).toEqual({ value: 'smooth glass' });
  expect(merged.wire.value).toBe('mine');
  expect(merged.wire.extension).toEqual({ retained: true });
  expect(merged.wire.server_field).toBe(7);
  expect(merged.custom).toEqual(['mine']);
  expect(entry.wire.options.other).toBeUndefined();
});

test('an expansion that adds nothing returns the same entry; a mismatched answer is rejected', () => {
  const entry = surfaceEntry();
  expect(
    applyExpansion(entry, {
      ...entry.wire,
      options: { ...entry.wire.options },
    }),
  ).toEqual({ entry, added: 0 });
  for (const bad of [
    null,
    { ...entry.wire, kind: 'dropdown' },
    { ...entry.wire, id: 'other' },
    { ...entry.wire, options: [] },
  ])
    expect(() => applyExpansion(entry, bad)).toThrow(/malformed/);
});

test('clearing selections keeps values that have no unset state and allows reset', () => {
  const choose = (wire) => clearSelection(createEntry(wire, GROUP.base));
  expect(
    choose({ kind: 'single-select', label: 'A', options: {}, value: 'x' }).wire
      .value,
  ).toBeNull();
  expect(
    choose({ kind: 'multi-select', label: 'B', options: {}, value: ['x'] }).wire
      .value,
  ).toEqual([]);
  expect(
    choose({ kind: 'text-input', label: 'C', value: 'hi' }).wire.value,
  ).toBe('');
  expect(choose({ kind: 'binary', label: 'D', value: false }).wire.value).toBe(
    false,
  );
  expect(
    choose({ kind: 'slider', label: 'E', min: 0, max: 5, value: 0 }).wire.value,
  ).toBe(0);
  const cleared = choose({
    kind: 'single-select',
    label: 'A',
    options: {},
    value: 'x',
  });
  expect(resetEntry(cleared).wire.value).toBe('x');
});

test('a record that names its originals never restores resolved values', () => {
  const resolved = [{ id: 'r', kind: 'text', label: 'R', value: 'resolved' }];
  expect(
    entriesFromRecord({
      original_selected_controls: [],
      selected_controls: resolved,
    }),
  ).toEqual([]);
});

test('saved text controls left to the model never claim their dormant default was selected', () => {
  const wire = {
    id: 'style',
    label: 'Style',
    kind: 'single-select',
    value: 'photography',
    options: { photography: 'Photography' },
    apply_to_generation: false,
  };
  const record = { selected_controls: [wire] };
  expect(selectionSummary(record).map((s) => [s.label, s.value])).toEqual([
    ['Style', 'Model decides'],
  ]);
  expect(record.selected_controls[0]).toEqual(wire);
});
