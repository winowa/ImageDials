import { expect, test } from 'vitest';

import { GROUP, createEntries } from './controls.js';
import {
  PHOTOGRAPHY_PROBABILITY,
  MULTI_CONTINUATION_PROBABILITIES,
  randomizeEntry,
  sampleMultiOptions,
  randomizeStandard,
} from './standardRandom.js';

const style = () =>
  createEntries(
    [
      {
        id: 'style',
        kind: 'single-select',
        label: 'Style',
        value: 'illustration',
        options: {
          photography: 'Photography',
          watercolor: 'Watercolor',
          illustration: 'Illustration',
          oil: 'Oil painting',
        },
      },
    ],
    GROUP.base,
  )[0];
const fixed = (...values) => {
  const queue = [...values];
  return () => queue.shift() ?? 0;
};

test('style picks Photography below 0.7, otherwise another style uniformly', () => {
  expect(PHOTOGRAPHY_PROBABILITY).toBe(0.7);
  expect(randomizeEntry(style(), fixed(0)).wire.value).toBe('photography');
  expect(randomizeEntry(style(), fixed(0.6999)).wire.value).toBe('photography');
  // 0.7 and above: uniform over the three others.
  expect(randomizeEntry(style(), fixed(0.7, 0)).wire.value).toBe('watercolor');
  expect(randomizeEntry(style(), fixed(0.7, 0.5)).wire.value).toBe(
    'illustration',
  );
  expect(randomizeEntry(style(), fixed(0.99, 0.99)).wire.value).toBe('oil');
});

test('style frequency is near 0.7 over many samples', () => {
  let seed = 1;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  let photo = 0;
  for (let i = 0; i < 4000; i += 1)
    if (randomizeEntry(style(), random).wire.value === 'photography')
      photo += 1;
  expect(photo / 4000).toBeGreaterThan(0.66);
  expect(photo / 4000).toBeLessThan(0.74);
});

test.each(['multi-select', 'checkbox'])(
  '%s Style starts with one weighted choice while retaining its multi-select kind',
  (kind) => {
    const original = style();
    const entry = {
      ...original,
      wire: { ...original.wire, kind, value: ['watercolor', 'oil'] },
    };
    const picks = Array.from({ length: 10 }, (_, index) =>
      randomizeEntry(
        entry,
        index < 7 ? fixed(index / 10, 0.99) : fixed(index / 10, 0, 0.99),
      ),
    );
    expect(picks.slice(0, 7).map((pick) => pick.wire.value)).toEqual(
      Array.from({ length: 7 }, () => ['photography']),
    );
    expect(picks.slice(7).map((pick) => pick.wire.value)).toEqual(
      Array.from({ length: 3 }, () => ['watercolor']),
    );
    expect(picks.every((pick) => pick.wire.kind === kind)).toBe(true);
    expect(
      picks.every((pick) => pick.wire.options === entry.wire.options),
    ).toBe(true);
    expect(entry.wire.value).toEqual(['watercolor', 'oil']);
  },
);

test.each(['multi-select', 'checkbox'])(
  '%s samples without replacement, deciding continuation before each new pick',
  (kind) => {
    const [entry] = createEntries(
      [
        {
          kind,
          label: 'Palette',
          value: [],
          options: { a: 'A', b: 'B', c: 'C', d: 'D', e: 'E', f: 'F', g: 'G' },
        },
      ],
      GROUP.base,
    );
    expect(MULTI_CONTINUATION_PROBABILITIES).toEqual([
      0.5, 0.4, 0.3, 0.2, 0.1, 0,
    ]);
    for (let stop = 0; stop < 5; stop += 1) {
      const draws = [
        0,
        ...Array.from({ length: stop }, () => [0, 0]).flat(),
        MULTI_CONTINUATION_PROBABILITIES[stop],
      ];
      let calls = 0;
      const out = randomizeEntry(entry, () => {
        expect(calls).toBeLessThan(draws.length);
        return draws[calls++];
      });
      expect(out.wire.value).toEqual(
        ['a', 'b', 'c', 'd', 'e'].slice(0, stop + 1),
      );
      expect(calls).toBe(draws.length);
      const accepted = [
        0,
        ...Array.from({ length: stop }, () => [0, 0]).flat(),
        MULTI_CONTINUATION_PROBABILITIES[stop] - 1e-8,
        0,
      ];
      if (stop < 4) accepted.push(MULTI_CONTINUATION_PROBABILITIES[stop + 1]);
      let acceptedCalls = 0;
      const below = randomizeEntry(entry, () => {
        expect(acceptedCalls).toBeLessThan(accepted.length);
        return accepted[acceptedCalls++];
      });
      expect(below.wire.value).toEqual(
        ['a', 'b', 'c', 'd', 'e', 'f'].slice(0, stop + 2),
      );
      expect(acceptedCalls).toBe(accepted.length);
    }
    let calls = 0;
    expect(
      randomizeEntry(entry, () => {
        calls++;
        return 0;
      }).wire.value,
    ).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(calls).toBe(11);
    expect(entry.wire.value).toEqual([]);
  },
);

test('the shared multi picker samples the remaining pool only after an accepted continuation', () => {
  const options = ['a', 'b', 'c', 'd'].map((key) => ({ key }));
  const draws = [0.99, 0.49, 0.99, 0.39, 0.99, 0.3];
  let calls = 0;
  expect(sampleMultiOptions(options, () => draws[calls++])).toEqual([
    'd',
    'c',
    'b',
  ]);
  expect(calls).toBe(6);
  expect(options.map((o) => o.key)).toEqual(['a', 'b', 'c', 'd']);
  expect(
    sampleMultiOptions([], () => {
      throw Error('No options must consume no randomness');
    }),
  ).toEqual([]);
  let oneCalls = 0;
  expect(
    sampleMultiOptions([{ key: 'only' }], () => {
      oneCalls++;
      return 0;
    }),
  ).toEqual(['only']);
  expect(oneCalls).toBe(1);
});

test('multi-selects stay nonempty and usually contain one or two choices', () => {
  const [entry] = createEntries(
    [
      {
        kind: 'multi-select',
        label: 'Lighting',
        options: { a: 'A', b: 'B', c: 'C', d: 'D', e: 'E', f: 'F' },
        value: [],
      },
    ],
    GROUP.base,
  );
  let seed = 7;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  const lengths = Array.from(
    { length: 10000 },
    () => randomizeEntry(entry, random).wire.value.length,
  );
  expect(Math.min(...lengths)).toBe(1);
  expect(Math.max(...lengths)).toBe(6);
  expect(lengths.filter((n) => n <= 2).length / lengths.length).toBeGreaterThan(
    0.73,
  );
});

test('other kinds sample valid values and text clears and unknown kinds stay', () => {
  const [single, multi, slider, binary, text, future, empty] = createEntries(
    [
      {
        kind: 'dropdown',
        label: 'Color',
        value: 'a',
        options: { a: 'A', b: 'B' },
      },
      {
        kind: 'multi-select',
        label: 'M',
        value: [],
        options: { x: 'X', y: 'Y' },
      },
      { kind: 'slider', label: 'S', value: 0, min: 0, max: 10, step: 5 },
      { kind: 'binary', label: 'B', value: false },
      { kind: 'text-input', label: 'T', value: 'keep' },
      { kind: 'future', label: 'F', value: { n: 1 }, extra: true },
      { kind: 'radio', label: 'E', value: null },
    ],
    GROUP.base,
  );
  expect(randomizeEntry(single, fixed(0.9)).wire.value).toBe('b');
  expect(randomizeEntry(multi, fixed(0.1, 0.9)).wire.value).toEqual(['x']);
  expect(randomizeEntry(slider, fixed(0.99)).wire.value).toBe(10);
  expect(randomizeEntry(slider, fixed(0.4)).wire.value).toBe(5);
  expect(randomizeEntry(binary, fixed(0.2)).wire.value).toBe(true);
  expect(randomizeEntry(text, fixed(0.2)).wire.value).toBe('');
  expect(randomizeEntry(future, fixed(0.2))).toBe(future);
  expect(randomizeEntry(empty, fixed(0.2))).toBe(empty);
});

test('only standard entries change and options survive', () => {
  const [base] = createEntries(
    [{ kind: 'dropdown', label: 'C', value: 'a', options: { a: 'A', b: 'B' } }],
    GROUP.base,
  );
  const [generated] = createEntries(
    [{ kind: 'dropdown', label: 'G', value: 'a', options: { a: 'A', b: 'B' } }],
    GROUP.generated,
  );
  const out = randomizeStandard([base, generated], fixed(0.9));
  expect(out[0].wire.value).toBe('b');
  expect(out[0].wire.options).toEqual(base.wire.options);
  expect(out[1]).toBe(generated);
  expect(base.wire.value).toBe('a');
});
