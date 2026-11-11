import { openStandardControls } from '../helpers/controlUiTestSupport.js';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import groups from '../../../fixtures/api/generation-groups.json';
import App from '../../src/app/App.jsx';
import { DEFAULT_CLIENT_POLICY } from '../../src/data/api/clientPolicy.js';
import { createCacheStore } from '../../src/data/storage/cacheStore.js';
import { memoryDb } from '../helpers/cacheTestSupport.js';
import {
  clone,
  fakeLibrary,
  fixtures,
  installApi,
  respond,
} from '../helpers/testSupport.js';

vi.mock('../../src/features/controls/standardRandom.js', async (original) => ({
  ...(await original()),
  randomizeStandard: (entries) => entries,
}));
const harness = vi.hoisted(() => ({ cache: { store: null, ready: true } }));
vi.mock('../../src/data/storage/useCacheStore.js', () => ({
  useCacheStore: () => harness.cache,
}));

const { m1 } = fixtures;
const GENERATE = 'POST /api/generate-image';
const GROUP_ID = groups.accepted.variation_group.id;
const STATUS = `GET /api/generation-groups/${GROUP_ID}`;
const IDEA = 'A small teal ceramic sphere on felt';
const jobPolicy = { pollIntervalMs: 1, maxConsecutivePollFailures: 3 };
// Durable storage refuses every original, so each result holds a place in
// the tab's bounded pool of unstored images.
const pool = (limit) => ({
  cache: {
    ...DEFAULT_CLIENT_POLICY.cache,
    privateRecordLimit: 0,
    privateVolatileRecordLimit: limit,
  },
});

/** Both original children complete, as private results. */
function completePrivate() {
  const status = clone(groups.complete);
  const second = status.jobs[1];
  second.generation_job_id =
    groups.accepted.variation_group.jobs[1].generation_job_id;
  second.attempt = 0;
  for (const job of status.jobs) {
    job.result = {
      ...job.result,
      title: `Private sphere ${job.index + 1}`,
      visibility: 'private',
      sha256: undefined,
      generation_job_id: job.generation_job_id,
    };
    job.events = [];
    job.latest_event = null;
  }
  return status;
}

let api;

function setup() {
  harness.cache = {
    store: createCacheStore(memoryDb(), pool(3).cache),
    ready: true,
  };
  api = installApi({
    ...fakeLibrary([]).routes,
    'GET /api/app-capabilities': () => ({
      ...clone(m1.capabilities_private),
      variations: clone(groups.capability),
    }),
    'POST /api/controls/dynamic': () => m1.dynamic_response,
    [GENERATE]: () => respond(202, groups.accepted),
    [STATUS]: () => completePrivate(),
    match: (key) =>
      key.endsWith('/content')
        ? () => respond(200, 'png-bytes', { 'Content-Type': 'image/png' })
        : undefined,
  });
}

const options = () => screen.getByRole('button', { name: 'Generate options' });
const item = (name) =>
  screen
    .getAllByRole('menuitemradio', { hidden: true })
    .find((option) => option.textContent.includes(name));
const wide = (name) =>
  screen
    .getAllByRole('button', { name })
    .find((b) => b.classList.contains('generate-btn'));

async function ready(limit) {
  render(<App jobPolicy={jobPolicy} clientPolicy={pool(limit)} />);
  await openStandardControls();
  fireEvent.change(screen.getByLabelText('Image idea'), {
    target: { value: IDEA },
  });
}

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  localStorage.clear();
  sessionStorage.clear();
  let next = 0;
  URL.createObjectURL = vi.fn(() => `blob:v-${(next += 1)}`);
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test('counts that this browser cannot keep are refused before anything is sent', async () => {
  setup();
  await ready(1);
  fireEvent.click(options());
  expect(item('1 image').getAttribute('aria-disabled')).toBeNull();
  for (const name of ['2 images', '3 images', '4 images']) {
    expect(item(name).getAttribute('aria-disabled')).toBe('true');
    expect(item(name).textContent).toContain('Not enough room in this browser');
  }
  fireEvent.click(item('2 images'));
  expect(wide('Generate image')).toBeTruthy();
  expect(api.called(GENERATE)).toHaveLength(0);
});

test('a group reserves a place per image; the next group is refused visibly, with no provider request', async () => {
  setup();
  await ready(3);
  fireEvent.click(options());
  fireEvent.click(item('2 images'));
  fireEvent.click(wide('Generate 2 images'));
  await waitFor(() => expect(api.called(GENERATE)).toHaveLength(1));
  expect(api.called(GENERATE)[0].body.variation_count).toBe(2);
  await screen.findByRole('button', { name: 'Private sphere 2' });
  await screen.findByRole('heading', { name: 'Private sphere 1' });

  // Two of three places are now held: two more images do not fit.
  await screen.findByText(
    /Only 1 of the 2 images can be kept until this browser stores them/,
  );
  expect(wide('Generate 2 images').disabled).toBe(true);
  const dynamicCalls = api.called('POST /api/controls/dynamic').length;
  fireEvent.keyDown(screen.getByLabelText('Image idea'), { key: 'Enter' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(api.called(GENERATE)).toHaveLength(1);
  expect(api.called('POST /api/controls/dynamic')).toHaveLength(dynamicCalls);
  // Nothing held was evicted to make room.
  expect(screen.getByRole('button', { name: 'Private sphere 1' })).toBeTruthy();

  fireEvent.click(options());
  expect(item('3 images').getAttribute('aria-disabled')).toBe('true');
  fireEvent.click(item('1 image'));
  expect(wide('Regenerate').disabled).toBe(false);
});
