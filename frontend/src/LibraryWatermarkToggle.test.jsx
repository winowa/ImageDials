import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import App from './App.jsx';
import {
  fakeLibrary,
  FakeEventSource,
  installApi,
  libraryRecord,
} from './testSupport.js';
import { markFor } from './watermarkRenderer.js';
import previewFixture from '../../fixtures/api/watermark-preview.json';

vi.mock('./watermarkRenderer.js', async (importOriginal) => ({
  ...(await importOriginal()),
  markFor: vi.fn(),
}));

const jobPolicy = { pollIntervalMs: 1, maxConsecutivePollFailures: 3 };
const analyzed = (id, extra = {}) =>
  libraryRecord({
    id,
    title: `Card ${id}`,
    width: 300,
    height: 200,
    dimensions: { width: 300, height: 200 },
    print_watermark: structuredClone(previewFixture.summary.print_watermark),
    print_watermark_key: `key-${id}`,
    ...extra,
  });

let library;
let api;
let drawn;

/** jsdom has no layout: give every image a box so the mark can be placed. */
function stubLayout() {
  for (const [name, value] of [
    ['offsetWidth', 300],
    ['offsetHeight', 200],
    ['offsetLeft', 0],
    ['offsetTop', 0],
    ['complete', true],
  ])
    Object.defineProperty(HTMLImageElement.prototype, name, {
      value,
      configurable: true,
    });
  const context = { clearRect: vi.fn(), drawImage: vi.fn(() => drawn++) };
  HTMLCanvasElement.prototype.getContext = vi.fn(() => context);
}

const toggle = () => screen.getByRole('checkbox', { name: 'Watermarks' });
const overlays = () => document.querySelectorAll('.card canvas.wm-mark');
const flush = () => act(async () => {});

beforeEach(() => {
  window.history.replaceState(null, '', '/print');
  localStorage.clear();
  drawn = 0;
  FakeEventSource.reset();
  vi.stubGlobal('EventSource', FakeEventSource);
  stubLayout();
  markFor.mockReset();
  markFor.mockImplementation(async () => ({
    mark: document.createElement('canvas'),
  }));
  library = fakeLibrary([
    analyzed('one'),
    analyzed('two'),
    analyzed('baked', { derivative_type: 'watermarked' }),
    libraryRecord({ id: 'plain', title: 'Card plain' }),
  ]);
  api = installApi(library.routes);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const mounted = async () => {
  render(<App jobPolicy={jobPolicy} />);
  await waitFor(() => expect(overlays()).toHaveLength(2));
};

test('unchecking removes every separable overlay; checking restores current marks and retries only the missing row', async () => {
  await mounted();
  const calls = api.calls.length;
  const paints = markFor.mock.calls.length;

  fireEvent.click(toggle());
  expect(toggle().checked).toBe(false);
  expect(overlays()).toHaveLength(0);
  expect(JSON.parse(localStorage.getItem('imagedials-watermark-visible'))).toBe(
    false,
  );
  // The pictures themselves are untouched and still listed.
  expect(document.querySelectorAll('.card img')).toHaveLength(4);

  fireEvent.click(toggle());
  await waitFor(() => expect(overlays()).toHaveLength(2));
  // Only the already-analysed, not-baked cards carry an overlay.
  expect(markFor.mock.calls.length).toBeGreaterThan(paints);
  await waitFor(() => expect(api.calls.length).toBeGreaterThan(calls));
  expect(
    api.calls
      .slice(calls)
      .every((call) => call.key === 'POST /api/images/library/watermark'),
  ).toBe(true);
});

test('the toggle keeps the search, the focused control and the list', async () => {
  await mounted();
  const search = screen.getByRole('searchbox');
  fireEvent.change(search, { target: { value: 'Card one' } });
  await waitFor(() => expect(overlays()).toHaveLength(1));
  toggle().focus();
  fireEvent.click(toggle());
  expect(overlays()).toHaveLength(0);
  expect(search.value).toBe('Card one');
  expect(document.activeElement).toBe(toggle());
  expect(screen.getAllByRole('button', { name: /Card one/ })).toHaveLength(1);
  fireEvent.click(toggle());
  await waitFor(() => expect(overlays()).toHaveLength(1));
  expect(search.value).toBe('Card one');
  expect(document.activeElement).toBe(toggle());
});

test('a mark that finishes after the box was switched off is never painted; switching on paints it', async () => {
  let finish;
  markFor.mockImplementation(
    () => new Promise((resolve) => (finish = resolve)),
  );
  render(<App jobPolicy={jobPolicy} />);
  await waitFor(() => expect(markFor).toHaveBeenCalled());
  await waitFor(() => expect(overlays()).toHaveLength(2));
  fireEvent.click(toggle());
  expect(overlays()).toHaveLength(0);
  await act(async () => finish({ mark: document.createElement('canvas') }));
  expect(overlays()).toHaveLength(0);
  expect(drawn).toBe(0);

  markFor.mockImplementation(async () => ({
    mark: document.createElement('canvas'),
  }));
  fireEvent.click(toggle());
  await waitFor(() => expect(overlays()).toHaveLength(2));
  await waitFor(() => expect(drawn).toBeGreaterThan(0));
});

test('analysis that arrives while the marks are off stays hidden until they are switched on', async () => {
  const records = [analyzed('one')];
  library.records = [
    libraryRecord({ id: 'one', title: 'Card one', width: 300, height: 200 }),
  ];
  render(<App jobPolicy={jobPolicy} />);
  await screen.findByText('Card one');
  expect(overlays()).toHaveLength(0);
  fireEvent.click(toggle());
  // The library answers a later listing with the analysis attached.
  library.records = records;
  const events = FakeEventSource.all.find((s) => s.url.includes('events'));
  const pageReads = () =>
    api.calls.filter((call) =>
      call.key.startsWith('GET /api/images/library/page?'),
    ).length;
  const listings = pageReads();
  await act(async () => events.emit('changed', {}));
  await waitFor(() => expect(pageReads()).toBeGreaterThan(listings));
  await flush();
  expect(document.querySelectorAll('.card img')).toHaveLength(1);
  expect(overlays()).toHaveLength(0);
  fireEvent.click(toggle());
  await waitFor(() => expect(overlays()).toHaveLength(1));
});
