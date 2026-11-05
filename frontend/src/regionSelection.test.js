import { expect, test } from 'vitest';

import fixture from '../../fixtures/api/region-editing.json';
import {
  buildSelection,
  clientToSource,
  commitShapes,
  containBox,
  createHistory,
  extendStroke,
  loadSelection,
  parseRectangleFields,
  readRegionCapability,
  REGION_HISTORY_LIMIT,
  rectFromDrag,
  redoShapes,
  selectionMatchesBase,
  startStroke,
  undoShapes,
} from './regionSelection.js';

const base = (overrides = {}) => ({
  sha256: 'a'.repeat(64),
  dimensions: { width: 16, height: 12 },
  ...overrides,
});

test('maps letterboxed image points into oriented source pixels', () => {
  const rect = { left: 0, top: 0, width: 200, height: 200 };
  expect(containBox(rect, { width: 16, height: 12 })).toEqual({
    left: 0,
    top: 25,
    width: 200,
    height: 150,
  });
  expect(
    clientToSource({ x: 100, y: 25 }, rect, { width: 16, height: 12 }),
  ).toEqual({
    x: 8,
    y: 0,
    inside: true,
  });
  expect(
    clientToSource({ x: 100, y: 24 }, rect, { width: 16, height: 12 }).inside,
  ).toBe(false);
  expect(
    clientToSource({ x: 200, y: 175 }, rect, { width: 16, height: 12 }).inside,
  ).toBe(false);
});

test('fixture rectangle uses an inclusive origin and exclusive right and bottom edges', () => {
  const { capability, selection, expected_mask: expected } = fixture;
  const cap = readRegionCapability(capability);
  expect(cap.ok).toBe(true);
  const built = buildSelection(
    {
      sha256: selection.source_sha256,
      dimensions: { width: selection.width, height: selection.height },
    },
    selection.shapes,
    selection.feather,
    cap.limits,
  );
  expect(built).toEqual({ ok: true, value: selection });

  const shape = selection.shapes[0];
  const pixels = [];
  for (let y = 0; y < selection.height; y += 1)
    for (let x = 0; x < selection.width; x += 1)
      if (
        x >= shape.x &&
        x < shape.x + shape.width &&
        y >= shape.y &&
        y < shape.y + shape.height
      )
        pixels.push([x, y]);
  expect(pixels).toHaveLength(expected.selected_pixels);
  expect(pixels[0]).toEqual([shape.x, shape.y]);
  expect(pixels.at(-1)).toEqual([
    shape.x + shape.width - 1,
    shape.y + shape.height - 1,
  ]);
  expect(
    pixels.some(
      ([x, y]) => x === shape.x + shape.width || y === shape.y + shape.height,
    ),
  ).toBe(false);
});

test('refuses a native mask or a capability with missing or changed limits', () => {
  expect(
    readRegionCapability({ ...fixture.capability, native_mask: true }).ok,
  ).toBe(false);
  expect(
    readRegionCapability({ ...fixture.capability, provider_fit: 'stretch' }).ok,
  ).toBe(false);
  const { max_points: _ignored, ...missing } = fixture.capability;
  expect(readRegionCapability(missing).ok).toBe(false);
});

test('does not load a selection onto a different source hash or oriented size', () => {
  const other = base({ sha256: 'b'.repeat(64) });
  expect(
    loadSelection(
      fixture.selection,
      other,
      readRegionCapability(fixture.capability).limits,
    ),
  ).toMatchObject({
    shapes: [],
    notice: expect.stringContaining('different image'),
  });
  expect(
    selectionMatchesBase(
      fixture.selection,
      base({ dimensions: { width: 15, height: 12 } }),
    ),
  ).toBe(false);
});

test('keeps rectangles within bounds and parses keyboard coordinates exactly', () => {
  expect(
    rectFromDrag(
      { x: 15.4, y: 11.2 },
      { x: 4.1, y: 2.8 },
      { width: 16, height: 12 },
    ),
  ).toEqual({
    kind: 'rectangle',
    x: 4,
    y: 2,
    width: 12,
    height: 10,
  });
  expect(
    parseRectangleFields(
      { x: '3', y: '4', width: '6', height: '4' },
      { width: 16, height: 12 },
    ),
  ).toEqual({
    shape: { kind: 'rectangle', x: 3, y: 4, width: 6, height: 4 },
  });
  expect(
    parseRectangleFields(
      { x: '14', y: '0', width: '4', height: '1' },
      { width: 16, height: 12 },
    ).field,
  ).toBe('width');
});

test('a point-budget refusal preserves the original stroke and selection history', () => {
  const size = { width: 100, height: 80 };
  const first = startStroke({ x: 10, y: 10 }, 2, size);
  const extended = extendStroke(first, { x: 20, y: 10 }, size, 1);
  expect(extended.limited).toBe(true);
  expect(extended.stroke).toBe(first);
  const old = [{ kind: 'rectangle', x: 1, y: 2, width: 3, height: 4 }];
  let history = commitShapes(createHistory(), old);
  history = undoShapes(history);
  expect(history.present).toEqual([]);
  history = redoShapes(history);
  expect(history.present).toEqual(old);
});

test('selection undo history is bounded', () => {
  let history = createHistory();
  for (let i = 0; i < REGION_HISTORY_LIMIT + 9; i += 1)
    history = commitShapes(history, [
      { kind: 'rectangle', x: i, y: 0, width: 1, height: 1 },
    ]);
  expect(history.past).toHaveLength(REGION_HISTORY_LIMIT);
});

test('an empty selection is represented by null, never an empty wire object', () => {
  expect(
    buildSelection(
      base(),
      [],
      0,
      readRegionCapability(fixture.capability).limits,
    ),
  ).toEqual({
    ok: true,
    value: null,
  });
  expect(
    buildSelection(
      base(),
      [null],
      0,
      readRegionCapability(fixture.capability).limits,
    ),
  ).toMatchObject({ ok: false, error: expect.stringContaining('malformed') });
});
