import { expect, test } from 'vitest';

import {
  FILTER_ORIENTATIONS,
  filterByOrientation,
  GALLERY_DEFAULT_SPEED_SECONDS,
  GALLERY_SPEEDS_SECONDS,
  orientationCounts,
  paginate,
  searchImages,
  stepIndex,
  validSpeedSeconds,
} from './browse.js';
import { imageKey } from './imageRecord.js';
import { libraryRecord, sizedRecord } from './testSupport.js';

const shaped = sizedRecord;

test('orientation counts and filters; a record without size is unknown, not landscape', () => {
  const images = [
    shaped('p', 768, 1152),
    shaped('l', 1152, 768),
    shaped('s', 1024, 1024),
    libraryRecord({ id: 'u', width: null, height: null, dimensions: null }),
  ];
  expect(orientationCounts(images)).toEqual({
    portrait: 1,
    landscape: 1,
    square: 1,
    unknown: 1,
  });
  const only = (...names) =>
    filterByOrientation(images, new Set(names)).map((i) => i.id);
  expect(only('landscape')).toEqual(['l']);
  expect(only('portrait', 'square')).toEqual(['p', 's']);
  expect(only(...FILTER_ORIENTATIONS)).toEqual(['p', 'l', 's', 'u']);
  expect(only()).toEqual([]);
});

test('a size measured from the loaded original classifies without touching the wire', () => {
  const unsized = libraryRecord({
    id: 'u',
    width: null,
    height: null,
    dimensions: null,
  });
  const before = JSON.stringify(unsized);
  const measured = new Map([[imageKey(unsized), { width: 600, height: 1000 }]]);
  expect(orientationCounts([unsized], measured).portrait).toBe(1);
  expect(orientationCounts([unsized], measured).unknown).toBe(0);
  expect(
    filterByOrientation([unsized], new Set(['portrait']), measured),
  ).toHaveLength(1);
  expect(JSON.stringify(unsized)).toBe(before);
});

test('speed policy: named steps, default 5 seconds, unknown values fall back', () => {
  expect(GALLERY_DEFAULT_SPEED_SECONDS).toBe(5);
  expect(GALLERY_SPEEDS_SECONDS).toEqual([
    2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 30,
  ]);
  expect(validSpeedSeconds(15)).toBe(15);
  expect(validSpeedSeconds(7)).toBe(5);
  expect(validSpeedSeconds('5')).toBe(5);
});

test('stepping wraps in both directions and tolerates an empty list', () => {
  expect(stepIndex(3, 2, 1)).toBe(0);
  expect(stepIndex(3, 0, -1)).toBe(2);
  expect(stepIndex(0, 0, 1)).toBe(0);
});

test('search is case-insensitive over prompts, controls, identity and size', () => {
  const images = [
    shaped('alpha', 768, 1152),
    shaped('beta', 1152, 768, {
      title: 'Lighthouse at dusk',
      original_prompt: 'A lighthouse',
      prompt: 'A lighthouse',
      final_prompt: 'Brass windows glowing',
      alt_text: 'Tower by the sea',
      selected_controls: [],
      resolved_controls: [
        { kind: 'single-select', label: 'Mood', value: 'Calm' },
      ],
    }),
  ];
  const ids = (q) => searchImages(images, q).map((i) => i.id);
  expect(ids('')).toEqual(['alpha', 'beta']);
  expect(ids('   ')).toEqual(['alpha', 'beta']);
  expect(ids('LIGHTHOUSE')).toEqual(['beta']);
  expect(ids('brass windows')).toEqual(['beta']);
  expect(ids('tower sea')).toEqual(['beta']);
  expect(ids('mood')).toEqual(['beta']);
  expect(ids('beta.png')).toEqual(['beta']);
  expect(ids('768x1152')).toEqual(['alpha']);
  // Selected control values are searchable too (zero and false included).
  expect(ids('rounded edges')).toEqual(['alpha']);
  expect(ids('no such thing')).toEqual([]);
});

test('search covers every readable wire value, nested unknown metadata included', () => {
  const nested = libraryRecord({
    id: 'deep',
    description: 'Harbour at dusk',
    event_name: 'Spring Showcase',
    storage_id: 'vault-7',
    image_id: 'img-4242',
    extra: {
      flags: { cropped: false, rating: 0 },
      list: [{ camera: 'Pinhole' }],
      blob: new Blob(['hidden-bytes']),
      bytes: new Uint8Array([1, 2]),
      inline: 'data:image/png;base64,SECRETPAYLOAD',
    },
  });
  nested.extra.self = nested.extra;
  const plain = libraryRecord({ id: 'plain', title: 'Other' });
  const images = [nested, plain];
  const ids = (q) => searchImages(images, q).map((i) => i.id);
  expect(ids('harbour')).toEqual(['deep']);
  expect(ids('SPRING showcase')).toEqual(['deep']);
  expect(ids('vault-7')).toEqual(['deep']);
  expect(ids('img-4242')).toEqual(['deep']);
  expect(ids('pinhole')).toEqual(['deep']);
  expect(ids('false')).toContain('deep');
  expect(ids('0')).toContain('deep');
  expect(ids('hidden-bytes')).toEqual([]);
  expect(ids('secretpayload')).toEqual([]);
  // The wire record is untouched.
  expect(Object.keys(nested.extra)).toContain('self');
});

test('pagination clamps into range and keeps at least one page', () => {
  const items = Array.from({ length: 50 }, (_, i) => i);
  expect(paginate(items, 1, 24)).toMatchObject({ page: 1, pageCount: 3 });
  expect(paginate(items, 3, 24).items).toHaveLength(2);
  expect(paginate(items, 9, 24).page).toBe(3);
  expect(paginate(items, 0, 24).page).toBe(1);
  expect(paginate(items, Number.NaN, 24).page).toBe(1);
  expect(paginate(items.slice(0, 5), 3, 24)).toMatchObject({
    page: 1,
    pageCount: 1,
  });
  expect(paginate([], 4, 24)).toEqual({ page: 1, pageCount: 1, items: [] });
  expect(paginate(items, 3, 48).page).toBe(2);
});
