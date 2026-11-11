import { expect, test } from 'vitest';

import { achievable, revealDelta } from './stageScroll.js';

const view = { top: 0, bottom: 800 };
const box = (top, height) => ({ top, bottom: top + height, height });

test('a frame already inside the view does not move', () => {
  expect(revealDelta(box(100, 300), view)).toBe(0);
});

test('a frame below the fold scrolls by the least amount', () => {
  expect(revealDelta(box(600, 300), view)).toBe(108);
});

test('a frame above the view is aligned to its top edge', () => {
  expect(revealDelta(box(-200, 300), view)).toBe(-208);
});

test('a frame taller than the view is aligned to its top edge', () => {
  expect(revealDelta(box(300, 900), view)).toBe(292);
});

const pane = (scrollTop, scrollHeight, clientHeight) => ({
  scrollTop,
  scrollHeight,
  clientHeight,
});

test('an exhausted pane moves by what it can still scroll, not the request', () => {
  expect(achievable(pane(100, 600, 500), 80)).toBe(0);
  expect(achievable(pane(90, 600, 500), 80)).toBe(10);
  expect(achievable(pane(0, 600, 500), -50)).toBe(0);
  expect(achievable(pane(30, 600, 500), -50)).toBe(-30);
  expect(achievable(pane(30, 600, 500), 40)).toBe(40);
});
