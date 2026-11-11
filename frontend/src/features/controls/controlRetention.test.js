import { describe, expect, test } from 'vitest';
import {
  appendAdditional,
  createEntries,
  createEntry,
  effectiveControlLimit,
  entriesFromRecord,
  GROUP,
  hasControlCapacity,
  setValue,
} from './controls.js';
import { intentClassOf, markIntent } from './controlIntent.js';
import { losslessWire, planRetention } from './controlRetention.js';
import {
  serializeEditEntries,
  serializeTextEntries,
  withRecordedEdit,
} from '../references/references.js';

const text = (id, extra = {}) => ({
  id,
  kind: 'text-input',
  label: id,
  value: 'chosen',
  ...extra,
});
const entry = (wire) => createEntry(wire, GROUP.generated);
const manual = (wire) => markIntent(entry(wire));
const plan = (old, incoming, limit = 30) =>
  planRetention(old, incoming, {
    limit,
    origin: { anchor: 'original', refs: 'r' },
  });

test.each([undefined, null, '30', 0, -1, 31, 1e9, 1.5])(
  'effective limit never becomes unbounded for %s',
  (published) => {
    expect(effectiveControlLimit(published)).toBe(30);
    const list = Array.from({ length: 30 }, (_, i) => entry(text(`x${i}`)));
    expect(hasControlCapacity(list, published)).toBe(false);
    expect(() =>
      appendAdditional(
        list,
        { controls: [text('new')], additional_controls_metadata: {} },
        published,
      ),
    ).toThrow(/limit/);
  },
);
test('valid published narrow limit and all entries count', () => {
  expect(effectiveControlLimit(12)).toBe(12);
  for (const count of [29, 30, 31]) {
    const old = Array.from({ length: count }, (_, i) => ({
      ...manual(text(`x${i}`)),
      enabled: false,
    }));
    const result = plan(old, []);
    expect(result.ok).toBe(count <= 30);
    if (!result.ok)
      expect(result).toMatchObject({ refused: 'capacity', count, limit: 30 });
  }
});
test('8 base + 8 incoming + 15 retained refuses whole immutable candidate', () => {
  const old = [
    ...createEntries(
      Array.from({ length: 8 }, (_, i) => text(`b${i}`)),
      GROUP.base,
    ),
    ...Array.from({ length: 15 }, (_, i) => manual(text(`old${i}`))),
  ];
  const before = structuredClone(old);
  expect(
    plan(
      old,
      Array.from({ length: 8 }, (_, i) => text(`new${i}`)),
    ),
  ).toEqual({ ok: false, refused: 'capacity', count: 31, limit: 30 });
  expect(old).toEqual(before);
});
test('reject duplicate and base collision before any suffix', () => {
  const base = createEntries([text('base')], GROUP.base);
  for (const incoming of [[text('x'), text('x')], [text('base')]])
    expect(plan(base, incoming)).toMatchObject({
      ok: false,
      refused: 'identity',
    });
});
test('incoming relevance then old retained order; conflict old wins; repeated merge is idempotent', () => {
  const old = [manual(text('a')), manual(text('b')), entry(text('untouched'))];
  const incoming = [text('b', { kind: 'binary', value: false }), text('new')];
  const first = plan(old, incoming);
  expect(first.entries.map((e) => e.wire.id)).toEqual(['new', 'a', 'b']);
  expect(first.entries[1]).toMatchObject({
    wire: old[0].wire,
    retained: { anchor: 'original' },
  });
  const second = plan(first.entries, incoming);
  expect(second.entries).toEqual(first.entries);
  expect(new Set(second.entries.map((e) => e.key)).size).toBe(3);
  expect(second.retained).toEqual(['generated:a', 'generated:b']);
});
test('lossless option objects, custom objects, manual multi order and provenance survive', () => {
  const options = {
    warm: { label: 'Warm', value: 'amber', extra: [0, false] },
    cool: { label: 'Cool', value: 'blue' },
    custom: { label: 'Custom', value: { nested: null } },
  };
  const old = {
    ...manual({
      id: 'color',
      kind: 'multi-select',
      label: 'Color',
      options,
      value: ['cool', 'warm', 'custom'],
      opaque: { a: 0 },
    }),
    custom: ['custom'],
    enabled: false,
    applyToEdit: false,
    retained: { anchor: 'old' },
  };
  const result = plan(
    [old],
    [{ ...old.wire, options: { warm: options.warm, cool: options.cool } }],
  );
  expect(result.entries[0].wire).toEqual(old.wire);
  expect(result.entries[0]).toMatchObject({
    custom: ['custom'],
    enabled: false,
    applyToEdit: false,
    intentClass: 'manual',
  });
  expect(result.entries[0].retained).toBeUndefined();
  const changed = plan(
    [old],
    [
      {
        ...old.wire,
        options: { ...options, warm: { label: 'Warm', value: 'different' } },
      },
    ],
  );
  expect(changed.entries[0].wire).toBe(old.wire);
  expect(changed.entries[0].retained).toBe(old.retained);
});
describe('lossless value matrix', () => {
  test.each([
    [{ kind: 'single-select', options: { a: 'A' }, value: null }, {}],
    [{ kind: 'multi-select', options: { a: 'A' }, value: [] }, {}],
    [{ kind: 'text-input', value: '' }, {}],
    [{ kind: 'binary', value: false }, {}],
    [{ kind: 'slider', value: 0, min: 0, max: 5, step: 1 }, { max: 10 }],
  ])('keeps exact %j', (wire, incoming) => {
    const old = manual(text('x', wire));
    const result = plan([old], [{ ...old.wire, ...incoming }]);
    expect(result.entries[0].wire.value).toEqual(wire.value);
    expect(result.entries[0].retained).toBeUndefined();
  });
  test.each([{ min: 2 }, { max: NaN }, { step: 0 }, { kind: 'future' }])(
    'invalid or unproven adapter retains old: %j',
    (change) => {
      const old = manual(
        text('x', { kind: 'slider', value: 0, min: 0, max: 5, step: 1 }),
      );
      expect(losslessWire(old, entry({ ...old.wire, ...change }))).toBeNull();
      expect(plan([old], [{ ...old.wire, ...change }]).entries[0].wire).toBe(
        old.wire,
      );
    },
  );
});
test.each([true, false, undefined])(
  'saved edit flag %s is legacy, retained unknown across unchanged saves',
  (apply) => {
    const [old] = withRecordedEdit(
      entriesFromRecord({
        selected_controls: [
          text('old', apply === undefined ? {} : { apply_to_edit: apply }),
        ],
      }),
    );
    expect(intentClassOf(old)).toBe('legacy');
    const [kept] = plan([old], []).entries;
    expect(intentClassOf(kept)).toBe('legacy');
    expect(
      serializeEditEntries([kept])[0].selection_provenance,
    ).toBeUndefined();
    const [restored] = entriesFromRecord({
      selected_controls: serializeEditEntries([kept]),
    });
    expect(intentClassOf(restored)).toBe('legacy');
    expect(intentClassOf(markIntent(kept))).toBe('manual');
    expect(markIntent(kept).wire.selection_provenance.source).toBe('explicit');
  },
);
test('legacy off text and future wires preserve flags and never acquire provenance', () => {
  const [old] = entriesFromRecord({
    selected_controls: [text('old', { apply_to_generation: false })],
  });
  expect(intentClassOf(old)).toBe('legacy');
  expect(serializeTextEntries(plan([old], []).entries)).toEqual([
    text('old', { apply_to_generation: false }),
  ]);
});
test('automatic false/off is replaceable; a click promotes it durably', () => {
  const old = { ...entry(text('x')), enabled: false, applyToEdit: false };
  expect(plan([old], []).entries).toEqual([]);
  const changed = markIntent(setValue(old, 'different'));
  expect(plan([changed], []).entries[0].wire).toBe(changed.wire);
});
