import { act, cleanup, render } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import GenerationPhrase from './GenerationPhrase.jsx';
import { createPhraseBag, PHRASE_LEAVE_MS } from './generationPhrases.js';

const LINES = Array.from({ length: 6 }, (_, i) => `Line ${i + 1}`);
const current = (view) =>
  view.container.querySelector('[data-state="current"]')?.textContent;
const leaving = (view) =>
  view.container.querySelector('[data-state="leaving"]')?.textContent;

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('shows a line at once and a different one exactly every interval', () => {
  const bag = createPhraseBag(LINES, () => 0);
  const view = render(<GenerationPhrase bag={bag} intervalMs={2500} />);
  const first = current(view);
  expect(first).toBeTruthy();
  act(() => vi.advanceTimersByTime(2499));
  expect(current(view)).toBe(first);
  act(() => vi.advanceTimersByTime(1));
  const second = current(view);
  expect(second).not.toBe(first);
  expect(leaving(view)).toBe(first);
  act(() => vi.advanceTimersByTime(PHRASE_LEAVE_MS));
  expect(leaving(view)).toBeUndefined();
  act(() => vi.advanceTimersByTime(2500));
  expect(current(view)).not.toBe(second);
});

test('the outgoing line is hidden from assistive technology and nothing is live', () => {
  const view = render(
    <GenerationPhrase bag={createPhraseBag(LINES)} intervalMs={2500} />,
  );
  act(() => vi.advanceTimersByTime(2500));
  expect(
    view.container
      .querySelector('[data-state="leaving"]')
      .getAttribute('aria-hidden'),
  ).toBe('true');
  expect(
    view.container.querySelector('[aria-live],[role="status"],[role="alert"]'),
  ).toBeNull();
});

test('reduced motion still changes the line, with no outgoing copy', () => {
  vi.stubGlobal('matchMedia', (query) => ({
    matches: query.includes('reduce'),
    addEventListener() {},
    removeEventListener() {},
  }));
  const view = render(
    <GenerationPhrase bag={createPhraseBag(LINES)} intervalMs={2500} />,
  );
  const first = current(view);
  act(() => vi.advanceTimersByTime(2500));
  expect(current(view)).not.toBe(first);
  expect(leaving(view)).toBeUndefined();
});

test('unmounting stops the rotation and its pending timers', () => {
  const bag = createPhraseBag(LINES);
  const next = vi.spyOn(bag, 'next');
  const view = render(<GenerationPhrase bag={bag} intervalMs={2500} />);
  act(() => vi.advanceTimersByTime(2500));
  const calls = next.mock.calls.length;
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
  act(() => vi.advanceTimersByTime(10_000));
  expect(next.mock.calls.length).toBe(calls);
});
