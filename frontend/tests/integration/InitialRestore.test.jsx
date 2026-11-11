import { openStandardControls } from '../helpers/controlUiTestSupport.js';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import React, { StrictMode } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import App from '../../src/app/App.jsx';
import { DEFAULT_CLIENT_POLICY } from '../../src/data/api/clientPolicy.js';
import { createCacheStore } from '../../src/data/storage/cacheStore.js';
import { memoryDb } from '../helpers/cacheTestSupport.js';
import {
  completeStatus,
  fakeLibrary,
  FakeEventSource,
  fixtures,
  installApi,
  respond,
  sizedRecord,
} from '../helpers/testSupport.js';

const harness = vi.hoisted(() => ({ cache: null }));
vi.mock('../../src/data/storage/useCacheStore.js', () => ({
  useCacheStore: () => harness.cache ?? { store: null, ready: true },
}));

const { m1 } = fixtures;
const LIST = 'GET /api/images/library';
const MODELS = 'GET /api/models';
const DYNAMIC = 'POST /api/controls/dynamic';
const jobPolicy = { pollIntervalMs: 1, maxConsecutivePollFailures: 3 };

let library;
let api;
let writes;

const record = (id, extra = {}) =>
  sizedRecord(id, 1152, 768, { original_prompt: `Prompt of ${id}`, ...extra });
const gate = () => {
  let open;
  const promise = new Promise((resolve) => {
    open = resolve;
  });
  return { promise, open };
};
function open(url = '/', list = [record('one'), record('two')], extra = {}) {
  window.history.replaceState(null, '', url);
  library = fakeLibrary(list);
  api = installApi({
    ...library.routes,
    [DYNAMIC]: () => m1.dynamic_response,
    ...extra,
  });
  return render(<App jobPolicy={jobPolicy} />);
}
const prompt = () => screen.getByLabelText('Image idea');
const strip = () => screen.getByRole('region', { name: 'Saved images' });
const thumb = (id) =>
  within(strip()).getByRole('button', { name: `Image ${id}` });
const libraryStream = () =>
  FakeEventSource.all.find((s) => s.url.includes('library/events'));
beforeEach(() => {
  harness.cache = null;
  localStorage.clear();
  FakeEventSource.reset();
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal('scrollTo', () => {});
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

test('refresh starts with a blank draft while explicit edit links restore', async () => {
  open('/', [
    record('one', { aspect: '3:2' }),
    record('two', { original_prompt: 'Other', width: 768, height: 1152 }),
  ]);
  await screen.findByRole('button', { name: 'Image one' });
  expect(prompt().value).toBe('');
  expect(document.querySelector('.stage-img')).toBeNull();
  expect(thumb('one').getAttribute('aria-current')).not.toBe('true');
  await waitFor(() =>
    expect(screen.getByRole('radio', { name: '3:2' }).checked).toBe(true),
  );
  cleanup();
  open('/?edit=one', [record('one', { aspect: '3:2' }), record('two')]);
  await waitFor(() => expect(prompt().value).toBe('Prompt of one'));
  // Hydration alone never asks the model for options or an image.
  expect(api.called(DYNAMIC)).toHaveLength(0);
  expect(api.called('POST /api/generate-image')).toHaveLength(0);
  // Ordinary history is not re-centered.
  await waitFor(() => expect(writes).toHaveLength(1));
});

test('portrait edit links restore their nearest valid aspect', async () => {
  open('/?edit=tall', [
    sizedRecord('tall', 768, 1152, { original_prompt: 'A tall one' }),
  ]);
  await waitFor(() => expect(prompt().value).toBe('A tall one'));
  expect(screen.getByRole('radio', { name: '2:3' }).checked).toBe(true);
});

test('the latest aspect choice survives refresh and New Draft', async () => {
  const square = sizedRecord('square', 1024, 1024, {
    original_prompt: 'Prompt of square',
  });
  const first = open('/', [square]);
  await screen.findByRole('radio', { name: '2:3' });
  fireEvent.click(screen.getByRole('radio', { name: '2:3' }));
  expect(screen.getByRole('radio', { name: '2:3' }).checked).toBe(true);
  first.unmount();

  open('/', [square]);
  await screen.findByRole('button', { name: 'Image square' });
  expect(prompt().value).toBe('');
  expect(screen.getByRole('radio', { name: '2:3' }).checked).toBe(true);
  fireEvent.click(thumb('square'));
  await waitFor(() => expect(prompt().value).toBe('Prompt of square'));
  expect(screen.getByRole('radio', { name: '1:1' }).checked).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'New draft' }));
  expect(prompt().value).toBe('');
  expect(screen.getByRole('radio', { name: '2:3' }).checked).toBe(true);
});

test('New Draft clears an edit link and refresh remains blank at the preferred aspect', async () => {
  open('/?edit=one', [record('one', { aspect: '3:2' })]);
  await waitFor(() => expect(prompt().value).toBe('Prompt of one'));
  fireEvent.click(screen.getByRole('radio', { name: '2:3' }));
  fireEvent.click(screen.getByRole('button', { name: 'New draft' }));
  expect(window.location.search).toBe('');
  expect(prompt().value).toBe('');
  expect(screen.getByRole('radio', { name: '2:3' }).checked).toBe(true);

  cleanup();
  render(<App jobPolicy={jobPolicy} />);
  await openStandardControls();
  expect(prompt().value).toBe('');
  expect(screen.getByRole('radio', { name: '2:3' }).checked).toBe(true);
  expect(document.querySelector('.stage-img')).toBeNull();
});

test('slow history and model discovery leave the new draft blank', async () => {
  const list = gate();
  const models = gate();
  open('/', [record('one')], {
    [LIST]: async (...args) => {
      await list.promise;
      return library.routes[LIST](...args);
    },
    [MODELS]: async () => {
      await models.promise;
      return m1.models;
    },
  });
  await openStandardControls();
  expect(prompt().value).toBe('');
  await act(async () => list.open());
  await screen.findByRole('button', { name: 'Image one' });
  expect(prompt().value).toBe('');
  fireEvent.change(prompt(), { target: { value: 'my draft' } });
  await act(async () => models.open());
  expect(prompt().value).toBe('my draft');
});

test('failed model discovery does not auto-select the newest image', async () => {
  open('/', [record('one')], {
    [MODELS]: () => respond(503, { detail: 'Model discovery unavailable' }),
  });
  await waitFor(() => expect(prompt().value).toBe(''));
  expect(document.querySelector('.stage-img')).toBeNull();
  expect(api.called(DYNAMIC)).toHaveLength(0);
  expect(api.called('POST /api/generate-image')).toHaveLength(0);
});

test.each(['pending', 'failed'])(
  'an explicit history pick restores its prompt and controls while models are %s',
  async (state) => {
    const models = gate();
    const controls = [
      {
        id: 'surface-amount',
        origin: 'generated',
        kind: 'slider',
        label: 'Surface amount',
        value: 0,
        min: 0,
        max: 100,
        step: 1,
      },
      {
        id: 'style',
        origin: 'fixed',
        kind: 'single-select',
        label: 'Style',
        options: { photography: 'Photography', watercolor: 'Watercolor' },
        value: 'watercolor',
      },
    ];
    open(
      '/',
      [
        record('one', {
          selected_controls: controls,
          original_selected_controls: controls,
        }),
      ],
      {
        [MODELS]: async () => {
          if (state === 'pending') await models.promise;
          return state === 'failed'
            ? respond(503, { error: 'Model discovery unavailable' })
            : m1.models;
        },
      },
    );
    await screen.findByRole('button', { name: 'Image one' });
    fireEvent.click(thumb('one'));
    await waitFor(() => expect(prompt().value).toBe('Prompt of one'));
    expect(screen.getByRole('slider', { name: 'Surface amount' }).value).toBe(
      '0',
    );
    await openStandardControls();
    expect(screen.getByRole('radio', { name: 'Watercolor' }).checked).toBe(
      true,
    );
    expect(document.querySelector('.stage-img')).not.toBeNull();
    expect(api.called('POST /api/generate-image')).toHaveLength(0);
    if (state === 'pending') {
      await act(async () => models.open());
      expect(prompt().value).toBe('Prompt of one');
    }
  },
);

test('an early edit is never overwritten when the history arrives', async () => {
  const list = gate();
  open('/', [record('one')], {
    [LIST]: async (...args) => {
      await list.promise;
      return library.routes[LIST](...args);
    },
  });
  await openStandardControls();
  fireEvent.change(prompt(), { target: { value: 'my own idea' } });
  await act(async () => list.open());
  await screen.findByRole('button', { name: 'Image one' });
  await act(async () => {});
  expect(prompt().value).toBe('my own idea');
});

test('an explicit edit link wins, including under StrictMode', async () => {
  window.history.replaceState(null, '', '/?edit=two');
  library = fakeLibrary([record('one'), record('two')]);
  api = installApi({ ...library.routes, [DYNAMIC]: () => m1.dynamic_response });
  render(
    <StrictMode>
      <App jobPolicy={jobPolicy} />
    </StrictMode>,
  );
  await waitFor(() => expect(prompt().value).toBe('Prompt of two'));
  await act(async () => {});
  expect(prompt().value).toBe('Prompt of two');
  await waitFor(() =>
    expect(thumb('two').getAttribute('aria-current')).toBe('true'),
  );
});

test('a link to a missing image leaves the draft untouched rather than restoring the newest', async () => {
  open('/?edit=nope');
  await screen.findByText(/not in the library/);
  expect(prompt().value).toBe('');
});

test('library refresh leaves the current fresh draft blank', async () => {
  open('/');
  await screen.findByRole('button', { name: 'Image one' });
  expect(prompt().value).toBe('');
  library.records = [record('three'), ...library.records];
  await act(async () => libraryStream().open());
  await screen.findByRole('button', { name: 'Image three' });
  expect(prompt().value).toBe('');
  library.records = [record('four'), ...library.records];
  await act(async () => libraryStream().open());
  await screen.findByRole('button', { name: 'Image four' });
  expect(prompt().value).toBe('');
  expect(writes).toHaveLength(0);
});

test('a manual choice made before the history was ready is not undone', async () => {
  open('/');
  fireEvent.click(await screen.findByRole('button', { name: 'Image two' }));
  await waitFor(() => expect(prompt().value).toBe('Prompt of two'));
  library.records = [record('five'), ...library.records];
  await act(async () => libraryStream().open());
  await screen.findByRole('button', { name: 'Image five' });
  expect(prompt().value).toBe('Prompt of two');
});

test('an empty library leaves a blank draft with no image', async () => {
  open('/', []);
  await openStandardControls();
  await act(async () => {});
  expect(prompt().value).toBe('');
  expect(document.querySelector('.stage-img')).toBeNull();
});

test('opening Create from another page starts a fresh blank draft', async () => {
  open('/gallery');
  await screen.findByRole('link', { name: 'Create' });
  await act(async () => {});
  fireEvent.click(screen.getByRole('link', { name: 'Create' }));
  await waitFor(() => expect(prompt().value).toBe(''));
});

test('a private result in this browser does not auto-restore on load', async () => {
  vi.stubGlobal('EventSource', undefined);
  harness.cache = {
    store: createCacheStore(memoryDb(), DEFAULT_CLIENT_POLICY.cache),
    ready: true,
  };
  let next = 0;
  URL.createObjectURL = vi.fn(() => `blob:p-${(next += 1)}`);
  URL.revokeObjectURL = vi.fn();
  const idea = 'An amber glass bird on a small wooden stand';
  const status = {
    ...completeStatus(),
    result: {
      ...completeStatus().result,
      visibility: 'private',
      sha256: undefined,
    },
  };
  api = installApi({
    'GET /api/app-capabilities': () => m1.capabilities_private,
    [DYNAMIC]: () => m1.dynamic_response,
    'POST /api/generate-image': () => respond(202, m1.accepted),
    'GET /api/generation-jobs/fixture-image-1': () => status,
    'GET /api/images/fixture-image-1/content': () =>
      respond(200, 'png-bytes', { 'Content-Type': 'image/png' }),
    ...fakeLibrary([]).routes,
  });
  window.history.replaceState(null, '', '/');
  const first = render(<App jobPolicy={jobPolicy} />);
  await openStandardControls();
  fireEvent.change(prompt(), { target: { value: idea } });
  fireEvent.click(screen.getAllByRole('button', { name: /Generate image/ })[0]);
  await screen.findByRole('button', { name: status.result.title });
  first.unmount();
  const before = api.calls.length;

  render(<App jobPolicy={jobPolicy} />);
  await waitFor(() => expect(prompt().value).toBe(''));
  expect(document.querySelector('.stage-img')).toBeNull();
  expect(api.calls.slice(before).map((c) => c.key)).not.toContain(DYNAMIC);
});
