import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import App from './App.jsx';
import {
  fakeLibrary,
  FakeEventSource,
  installApi,
  sizedRecord,
} from './testSupport.js';

const BASE = '/studio/v1';
const jobPolicy = { pollIntervalMs: 1, maxConsecutivePollFailures: 3 };
let api;

function open(url, base = BASE) {
  window.history.replaceState(null, '', url);
  const library = fakeLibrary([
    sizedRecord('one', 1152, 768, { original_prompt: 'Prompt of one' }),
  ]);
  api = installApi(library.routes);
  return render(<App jobPolicy={jobPolicy} basePath={base} />);
}
const route = () => document.querySelector('main').dataset.route;
const link = (name) => screen.getByRole('link', { name });
const where = () => window.location.pathname + window.location.search;

beforeEach(() => {
  localStorage.clear();
  FakeEventSource.reset();
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal('scrollTo', () => {});
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test.each([
  ['/studio/v1', '/'],
  ['/studio/v1/', '/'],
  ['/studio/v1/gallery', '/gallery'],
  ['/studio/v1/print/', '/print'],
  ['/studio/v1/unknown', '/'],
  ['/gallery', '/'],
])('a fresh load of %s shows %s', async (url, expected) => {
  open(url);
  await waitFor(() => expect(route()).toBe(expected));
});

test('navigation links carry the prefix and stay inside it', async () => {
  open('/studio/v1/');
  expect(link('Create').getAttribute('href')).toBe('/studio/v1/');
  expect(link('Gallery').getAttribute('href')).toBe('/studio/v1/gallery');
  expect(link('Library').getAttribute('href')).toBe('/studio/v1/print');

  fireEvent.click(link('Gallery'));
  expect(where()).toBe('/studio/v1/gallery');
  expect(route()).toBe('/gallery');
  expect(link('Gallery').getAttribute('aria-current')).toBe('page');
  fireEvent.click(link('Library'));
  expect(where()).toBe('/studio/v1/print');
  fireEvent.click(link('Create'));
  expect(where()).toBe('/studio/v1/');
  expect(route()).toBe('/');
});

test('modified clicks are left to the browser', () => {
  open('/studio/v1/');
  for (const modifier of [
    { ctrlKey: true },
    { metaKey: true },
    { shiftKey: true },
    { altKey: true },
    { button: 1 },
  ]) {
    const proceeded = fireEvent.click(link('Gallery'), modifier);
    expect(proceeded).toBe(true);
    expect(where()).toBe('/studio/v1/');
    expect(route()).toBe('/');
  }
});

test('back and forward follow the prefixed history', async () => {
  open('/studio/v1/');
  fireEvent.click(link('Gallery'));
  window.history.pushState(null, '', '/studio/v1/print');
  act(() => {
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  expect(route()).toBe('/print');
  window.history.replaceState(null, '', '/studio/v1/gallery');
  act(() => {
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  expect(route()).toBe('/gallery');
});

test('API and media requests stay at the origin root', async () => {
  open('/studio/v1/print');
  await screen.findByRole('button', { name: /Image one/ });
  const urls = api.calls.map((c) => c.key.split(' ')[1]);
  expect(urls.length).toBeGreaterThan(0);
  expect(
    urls.every((url) => url.startsWith('/api/') || url === '/healthz'),
  ).toBe(true);
  const sources = [...document.querySelectorAll('img')].map((i) =>
    i.getAttribute('src'),
  );
  expect(sources.every((src) => src.startsWith('/api/'))).toBe(true);
});

test('Edit from the library stays inside the prefix and restores once', async () => {
  open('/studio/v1/print');
  fireEvent.click(await screen.findByRole('button', { name: /Image one/ }));
  await screen.findByRole('button', { name: 'Edit in generator' });
  const dialog = screen.getByRole('dialog');
  await waitFor(() =>
    expect(
      api.calls.some((call) =>
        call.key.startsWith('GET /api/images/library/record/'),
      ),
    ).toBe(true),
  );
  fireEvent.click(
    within(dialog).getByRole('button', {
      name: 'Edit in generator',
    }),
  );
  expect(where()).toBe('/studio/v1/?edit=one');
  await waitFor(() =>
    expect(screen.getByLabelText('Image idea').value).toBe('Prompt of one'),
  );
});

test('the origin root works without a prefix', async () => {
  open('/gallery', '');
  await waitFor(() => expect(route()).toBe('/gallery'));
  expect(link('Library').getAttribute('href')).toBe('/print');
});
