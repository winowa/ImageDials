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
  respond,
  sizedRecord,
} from './testSupport.js';

const jobPolicy = { pollIntervalMs: 1, maxConsecutivePollFailures: 3 };

let library;
let api;
let writes;

const record = (id) =>
  sizedRecord(id, 1152, 768, { original_prompt: `Prompt of ${id}` });
const records = () => ['one', 'two', 'three'].map(record);

function open(url, list = records(), extra = {}, props = {}) {
  window.history.replaceState(null, '', url);
  library = fakeLibrary(list);
  api = installApi({ ...library.routes, ...extra });
  return render(<App jobPolicy={jobPolicy} {...props} />);
}
const prompt = () => screen.getByLabelText('Image idea');
const strip = () => screen.getByRole('region', { name: 'Saved images' });
const thumb = (id) =>
  within(strip()).getByRole('button', { name: `Image ${id}` });
const pageReads = () =>
  api.calls.filter((c) => c.key.startsWith('GET /api/images/library/page'));
const recordRoute = (id) => `GET /api/images/library/record/${id}`;
const route = () => document.querySelector('main').dataset.route;
const libraryStream = () =>
  FakeEventSource.all.find((s) => s.url.includes('library/events'));
const refresh = async () => {
  await act(async () => libraryStream().open());
};

beforeEach(() => {
  localStorage.clear();
  FakeEventSource.reset();
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal('scrollTo', () => {});
  // Record every programmatic strip position.
  writes = [];
  Object.defineProperty(HTMLElement.prototype, 'scrollLeft', {
    configurable: true,
    get: () => 0,
    set: (value) => {
      writes.push(value);
    },
  });
});
afterEach(() => {
  cleanup();
  delete HTMLElement.prototype.scrollLeft;
  vi.unstubAllGlobals();
});

test('a deep link restores its image once and centers it once', async () => {
  open('/?edit=two');
  await waitFor(() => expect(prompt().value).toBe('Prompt of two'));
  await waitFor(() =>
    expect(thumb('two').getAttribute('aria-current')).toBe('true'),
  );
  await waitFor(() => expect(writes).toHaveLength(1));

  // The person edits, picks nothing, and the library refreshes with news.
  // Stay in this prompt episode: a substantially different idea deliberately
  // clears the selected stage after the configured reset debounce.
  fireEvent.change(prompt(), { target: { value: 'Prompt of two!' } });
  library.records = [record('four'), ...library.records];
  await refresh();
  await screen.findByRole('button', { name: 'Image four' });
  expect(prompt().value).toBe('Prompt of two!');
  expect(writes).toHaveLength(1);
  expect(thumb('two').getAttribute('aria-current')).toBe('true');
});

test('a refresh answered with 304 neither restores nor moves anything', async () => {
  open('/?edit=one');
  await waitFor(() => expect(prompt().value).toBe('Prompt of one'));
  await waitFor(() => expect(writes).toHaveLength(1));
  fireEvent.change(prompt(), { target: { value: 'edited' } });
  const before = pageReads().length;
  await refresh();
  await waitFor(() => expect(pageReads().length).toBeGreaterThan(before));
  expect(prompt().value).toBe('edited');
  expect(writes).toHaveLength(1);
});

test('manual selection afterwards restores that image and never recenters', async () => {
  open('/?edit=two');
  await waitFor(() => expect(writes).toHaveLength(1));
  fireEvent.click(thumb('three'));
  await waitFor(() => expect(prompt().value).toBe('Prompt of three'));
  await refresh();
  expect(prompt().value).toBe('Prompt of three');
  expect(writes).toHaveLength(1);
});

test('a slow library delays the link without consuming it', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  open('/?edit=three', records(), {
    [recordRoute('three')]: async () => {
      await gate;
      return library.records[2];
    },
  });
  await screen.findByLabelText('Image idea');
  expect(prompt().value).toBe('');
  expect(screen.queryByText(/not in the library/)).toBeNull();
  await act(async () => release());
  await waitFor(() => expect(prompt().value).toBe('Prompt of three'));
  expect(writes).toHaveLength(1);
});

test('a failed record read is reported, restores nothing and can be retried', async () => {
  let fail = true;
  open('/?edit=two', records(), {
    [recordRoute('two')]: () =>
      fail
        ? respond(500, { detail: 'Library unavailable' })
        : library.records[1],
  });
  await screen.findByText('That saved image could not be loaded.');
  expect(prompt().value).toBe('');
  expect(screen.queryByText(/not in the library/)).toBeNull();
  fail = false;
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(prompt().value).toBe('Prompt of two'));
  expect(writes).toHaveLength(1);
});

test('a missing image says so once and a later arrival does not restore', async () => {
  open('/?edit=ghost');
  expect(await screen.findByText(/not in the library/)).toBeTruthy();
  expect(prompt().value).toBe('');
  library.records = [record('ghost'), ...library.records];
  await refresh();
  await screen.findByRole('button', { name: 'Image ghost' });
  expect(prompt().value).toBe('');
  expect(writes).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss message' }));
  expect(screen.queryByText(/not in the library/)).toBeNull();
});

test('a draft edited before the library loads is not overwritten', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  open('/?edit=two', records(), {
    [recordRoute('two')]: async () => {
      await gate;
      return library.records[1];
    },
  });
  await screen.findByLabelText('Image idea');
  await waitFor(() => expect(api.called(recordRoute('two'))).toHaveLength(1));
  fireEvent.change(prompt(), { target: { value: 'typed first' } });
  await act(async () => release());
  expect(await screen.findByText(/draft changed/)).toBeTruthy();
  expect(prompt().value).toBe('typed first');
  expect(writes).toHaveLength(0);
});

test('Library Edit opens an encoded link; a second link restores again', async () => {
  open('/print');
  const edit = async (title) => {
    fireEvent.click(await screen.findByRole('button', { name: title }));
    await screen.findByRole('button', { name: 'Edit in generator' });
    const dialog = screen.getByRole('dialog');
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Edit in generator' }),
    );
  };
  await edit(/Image one/);
  await waitFor(() => expect(prompt().value).toBe('Prompt of one'));
  expect(window.location.pathname + window.location.search).toBe('/?edit=one');
  expect(route()).toBe('/');
  await waitFor(() => expect(writes).toHaveLength(1));

  fireEvent.click(screen.getByRole('link', { name: 'Library' }));
  await edit(/Image two/);
  await waitFor(() => expect(prompt().value).toBe('Prompt of two'));
  expect(window.location.search).toBe('?edit=two');
  await waitFor(() => expect(writes).toHaveLength(2));
});

test('back to a page without a link keeps the draft', async () => {
  open('/?edit=one');
  await waitFor(() => expect(writes).toHaveLength(1));
  fireEvent.change(prompt(), { target: { value: 'kept' } });
  window.history.pushState(null, '', '/');
  act(() => {
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await refresh();
  expect(prompt().value).toBe('kept');
  expect(writes).toHaveLength(1);
});

test('going back to an edit link is a new navigation that applies it again', async () => {
  open('/?edit=one');
  await waitFor(() => expect(writes).toHaveLength(1));
  fireEvent.click(screen.getByRole('link', { name: 'Gallery' }));
  window.history.replaceState(null, '', '/?edit=three');
  act(() => {
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await waitFor(() => expect(prompt().value).toBe('Prompt of three'));
  expect(writes).toHaveLength(2);
});
