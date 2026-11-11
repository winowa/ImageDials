import { expect, test } from 'vitest';

import { placePopover } from './popoverPlacement.js';

const viewport = { width: 400, height: 600 };
const rect = (left, top, width = 100, height = 44) => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
});
const inside = (pos, box) =>
  pos.left >= 8 &&
  pos.left + box.width <= viewport.width - 8 &&
  pos.top >= 8 &&
  pos.top + Math.min(box.height, pos.maxHeight) <= viewport.height - 8;

test('opens below its trigger when there is room', () => {
  const pos = placePopover(
    rect(20, 100),
    { width: 300, height: 200 },
    viewport,
  );
  expect(pos.top).toBe(152);
  expect(pos.left).toBe(20);
  expect(inside(pos, { width: 300, height: 200 })).toBe(true);
});

test('flips above near the bottom edge and shifts in from the right edge', () => {
  const box = { width: 300, height: 200 };
  const pos = placePopover(rect(350, 520), box, viewport);
  expect(pos.top).toBe(520 - 8 - 200);
  expect(pos.left).toBe(400 - 300 - 8);
  expect(inside(pos, box)).toBe(true);
});

test('a panel taller than either side is limited and kept on screen', () => {
  const box = { width: 300, height: 900 };
  const pos = placePopover(rect(10, 300), box, viewport);
  expect(inside(pos, box)).toBe(true);
  expect(pos.maxHeight).toBeGreaterThanOrEqual(96);
});

test('a panel wider than the viewport starts at the edge margin', () => {
  const pos = placePopover(
    rect(300, 100),
    { width: 900, height: 100 },
    viewport,
  );
  expect(pos.left).toBe(8);
});
