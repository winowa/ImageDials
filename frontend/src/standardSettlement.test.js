import { afterEach, expect, test, vi } from 'vitest';
import suggestions from '../../fixtures/api/standard-selections.json';
import provenance from '../../fixtures/api/selection-provenance.json';
import catalog from '../../fixtures/api/expanded-static-controls.json';
import {
  createEntries,
  GROUP,
  entriesFromRecord,
  setValue,
} from './controls.js';
import { markIntent, standardSummary } from './controlIntent.js';
import {
  pendingStandard,
  settleStandard,
  settleGenerated,
} from './standardSettlement.js';
import { explicitRecord, provenanceProblem } from './selectionProvenance.js';
import { serializeTextEntries } from './references.js';

const entries = () => createEntries(catalog.standard.controls, GROUP.base);
const pending = () => pendingStandard(entries());
afterEach(() => vi.restoreAllMocks());
test('catalog values stay pending, suggestions/null/empty settle without generated randomization', () => {
  const base = entries();
  const waiting = pendingStandard(base);
  expect(waiting.map((e) => e.wire)).toEqual(base.map((e) => e.wire));
  expect(standardSummary(waiting).pending).toBe(base.length);
  const suggestion = suggestions.cases.find(
    (item) => item.name === 'valid-mixed',
  );
  const settled = settleStandard(waiting, {
    suggestions: suggestion.expected_selections,
    textFlags: true,
    anchor: 'abc',
  });
  for (const entry of settled) {
    expect(entry.pending).toBeUndefined();
    const expected = suggestion.expected_selections[entry.wire.id];
    if (expected === null) {
      expect(entry.enabled).toBe(false);
      expect(entry.wire.value).toEqual(
        base.find((e) => e.key === entry.key).wire.value,
      );
      expect(entry.wire.selection_provenance.effect).toBe('model-decides');
    } else expect(entry.wire.value).toEqual(expected);
  }
  expect(
    settleStandard(settled, { suggestions: { style: ['watercolor'] } }),
  ).toEqual(settled);
});
test.each([
  undefined,
  null,
  'bad',
  {},
  { style: ['nonexistent'] },
  { style: 0 },
])('invalid/missing field uses fallback once: %j', (input) => {
  vi.spyOn(Math, 'random').mockReturnValue(0.99);
  const settled = settleStandard(pending(), { suggestions: input });
  expect(settled[0].wire.selection_provenance.source).toBe('fallback-random');
  expect(settleStandard(settled)).toEqual(settled);
});
test('null without capability falls back; valid [] never falls back; manual many values untouched', () => {
  const empty = settleStandard(pending(), { suggestions: { style: [] } })[0];
  expect(empty.wire.value).toEqual([]);
  expect(empty.wire.selection_provenance.source).toBe('suggested');
  const off = settleStandard(pending(), {
    suggestions: { style: null },
    textFlags: false,
  })[0];
  expect(off.enabled).toBe(true);
  expect(off.wire.selection_provenance.source).toBe('fallback-random');
  const manual = markIntent(
    setValue(pending()[0], ['photography', 'watercolor', 'cinematic']),
  );
  expect(settleStandard([manual], { suggestions: { style: [] } })[0]).toBe(
    manual,
  );
});
test('suggested-off is eligible next episode but manual-off stays disabled', () => {
  const suggested = settleStandard(pending(), {
    suggestions: { style: null },
    textFlags: true,
  })[0];
  expect(pendingStandard([suggested])[0].pending).toBe(true);
  const manual = markIntent(suggested);
  expect(pendingStandard([manual])[0].pending).toBeUndefined();
  expect(pendingStandard([manual])[0].enabled).toBe(false);
});
test('provenance fixtures validate and future/extra fields are lossless through restore/serialize', () => {
  for (const item of provenance.valid)
    expect(provenanceProblem(item.provenance ?? item)).toBeNull();
  for (const item of provenance.invalid)
    expect(provenanceProblem(item.provenance ?? item)).not.toBeNull();
  const wires = provenance.generate_request.controls;
  expect(
    serializeTextEntries(entriesFromRecord({ selected_controls: wires })),
  ).toEqual(wires);
  const future = { version: 2, source: 'future', unknown: [null, 0, false] };
  expect(explicitRecord(future)).toBe(future);
  expect(
    explicitRecord({
      version: 1,
      source: 'suggested',
      effect: 'value',
      anchor: 'abc',
      extra: { a: 0 },
    }),
  ).toEqual({ version: 1, source: 'explicit', anchor: 'abc', extra: { a: 0 } });
});

const freshMulti = (kind = 'multi-select', extra = {}) =>
  createEntries(
    [
      {
        id: 'generated_multi_wing',
        kind,
        label: 'Wing',
        options: { a: 'A', b: 'B', c: 'C' },
        value: [],
        ...extra,
      },
    ],
    GROUP.generated,
  )[0];

test.each(['multi-select', 'checkbox'])(
  'fresh %s defaults use the shared draw once and metadata refresh reuses it',
  (kind) => {
    const entry = freshMulti(kind);
    const random = vi
      .fn()
      .mockReturnValueOnce(0.9)
      .mockReturnValueOnce(0.49)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.4);
    const [sampled] = settleGenerated([entry], [], { random });
    expect(sampled.wire.value).toEqual(['c', 'a']);
    expect(sampled.initial).toEqual(['c', 'a']);
    expect(sampled.wire.selection_provenance.source).toBe('fallback-random');
    expect(random).toHaveBeenCalledTimes(4);
    const noDraw = () => {
      throw Error('A settled draw must not repeat');
    };
    expect(
      settleGenerated(
        [{ ...entry, wire: { ...entry.wire, description: 'New metadata' } }],
        [sampled],
        { random: noDraw },
      )[0].wire.value,
    ).toEqual(['c', 'a']);
    expect(entry.wire.value).toEqual([]);
  },
);

test('generated settlement preserves manual, restored, off, model-decides, retained, edit and other kinds', () => {
  const entry = freshMulti();
  const cases = [
    markIntent(setValue(entry, ['a', 'b', 'c'])),
    { ...entry, intentClass: 'legacy' },
    { ...entry, enabled: false },
    { ...entry, retained: { anchor: 'old' } },
    freshMulti('checkbox', {
      selection_provenance: {
        version: 1,
        source: 'suggested',
        effect: 'model-decides',
      },
    }),
    freshMulti('multi-select', {
      selection_provenance: { version: 2, source: 'future' },
    }),
    freshMulti('text-input', { value: 'Keep' }),
    { ...entry, group: GROUP.base },
  ];
  const random = () => {
    throw Error('Preserved intent must consume no randomness');
  };
  cases.forEach((item) =>
    expect(settleGenerated([item], [], { random })[0]).toBe(item),
  );
  expect(settleGenerated([entry], [], { editing: true, random })).toEqual([
    entry,
  ]);
  const empty = freshMulti('multi-select', { options: {} });
  expect(settleGenerated([empty], [], { random })[0]).toBe(empty);
});
