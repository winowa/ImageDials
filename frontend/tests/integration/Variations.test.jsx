import { openStandardControls } from '../helpers/controlUiTestSupport.js';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import groups from '../../../fixtures/api/generation-groups.json';
import App from '../../src/app/App.jsx';
import { RECOVERY_KEY } from '../../src/features/results/variationGroups.js';
import {
  clone,
  fakeLibrary,
  FakeEventSource,
  fixtures,
  installApi,
  listedFromJob,
  networkFailure,
  respond,
  sizedRecord,
  withBoundedGallery,
} from '../helpers/testSupport.js';

// The same draft must make the same request in both renders.
vi.mock('../../src/features/controls/standardRandom.js', async (original) => {
  const actual = await original();
  return {
    ...actual,
    randomizeStandard: (entries) => entries,
    sampleMultiOptions: (options) =>
      actual.sampleMultiOptions(options, () => 0.9),
  };
});

const { m1 } = fixtures;
const GENERATE = 'POST /api/generate-image';
const GROUP_ID = groups.accepted.variation_group.id;
const STATUS = `GET /api/generation-groups/${GROUP_ID}`;
const [ID1, ID2] = groups.accepted.variation_group.jobs.map(
  (j) => j.generation_job_id,
);
const ID3 = groups.retry_accepted.variation_group.jobs[0].generation_job_id;
const TITLES = ['Teal sphere one', 'Teal sphere two'];
const IDEA = 'A small teal ceramic sphere on felt';
const jobPolicy = { pollIntervalMs: 1, maxConsecutivePollFailures: 3 };

const capabilities = (variations = groups.capability) => ({
  ...withBoundedGallery(m1.capabilities),
  watermark: { transient_analysis_enabled: true },
  ...(variations ? { variations: clone(variations) } : {}),
});

/** The fixture's status with a distinct title per child. */
function titled(status) {
  const next = clone(status);
  for (const job of next.jobs) {
    if (!job.result?.id) continue;
    const title = TITLES[job.index];
    job.result.title = title;
    for (const event of [...job.events, job.latest_event])
      if (event?.data?.id) event.data.title = title;
  }
  return next;
}

const running = () => ({
  generation_group_id: GROUP_ID,
  variation_count: 2,
  status: 'running',
  jobs: [
    { ...clone(m1.job_running), generation_job_id: ID1, index: 0, attempt: 0 },
    {
      generation_job_id: ID2,
      events: [],
      latest_event: null,
      status: 'queued',
      result: null,
      index: 1,
      attempt: 0,
    },
  ],
});

/** Both original children complete, with no retry. */
function completeOriginal() {
  const status = titled(groups.complete);
  const second = status.jobs[1];
  second.generation_job_id = ID2;
  second.attempt = 0;
  second.result.generation_job_id = ID2;
  second.result.variation.attempt = 0;
  return status;
}

let api;
let library;
let state;

function setup({ variations, extra = {}, records = [] } = {}) {
  state = { status: running() };
  library = fakeLibrary(records);
  api = installApi({
    ...library.routes,
    'GET /api/app-capabilities': () => capabilities(variations),
    'POST /api/controls/dynamic': () => m1.dynamic_response,
    [GENERATE]: (body) =>
      body?.retry_variations
        ? respond(202, groups.retry_accepted)
        : body?.variation_count
          ? respond(202, groups.accepted)
          : respond(202, m1.accepted),
    'GET /api/generation-jobs/fixture-image-1': () => ({ ...m1.job_running }),
    [STATUS]: () => state.status,
    ...extra,
  });
}

/** List what a status completed, as the server's library does. */
function list(status) {
  for (const job of status.jobs)
    if (job.status === 'complete' && job.result?.id)
      library.records = [
        listedFromJob(job.result),
        ...library.records.filter((r) => r.id !== job.result.id),
      ];
}
const show = (status) => {
  list(status);
  state.status = status;
};

const prompt = () => screen.getByLabelText('Image idea');
const generateButton = (name) =>
  screen
    .getAllByRole('button', { name })
    .find((b) => b.classList.contains('generate-btn'));
const strip = () => screen.getByRole('region', { name: 'Variations' });
const posts = () => api.called(GENERATE);
const statusReads = () => api.called(STATUS).length;
const savedNames = () =>
  within(screen.getByRole('region', { name: 'Saved images' }))
    .getAllByRole('button')
    .map((b) => b.getAttribute('aria-label'));

async function ready() {
  render(<App jobPolicy={jobPolicy} />);
  await openStandardControls();
  fireEvent.change(prompt(), { target: { value: IDEA } });
}

function chooseCount(label) {
  fireEvent.click(screen.getByRole('button', { name: 'Generate options' }));
  fireEvent.click(screen.getByRole('menuitemradio', { name: label }));
}

async function submitGroup() {
  await ready();
  chooseCount('2 images');
  fireEvent.click(generateButton('Generate 2 images'));
  await waitFor(() => expect(posts()).toHaveLength(1));
}

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  localStorage.clear();
  sessionStorage.clear();
  FakeEventSource.reset();
  vi.stubGlobal('EventSource', FakeEventSource);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test('an older server keeps the single-image action and request unchanged', async () => {
  setup({ variations: null });
  await ready();
  expect(screen.queryByRole('button', { name: 'Generate options' })).toBeNull();
  fireEvent.click(generateButton('Generate image'));
  await waitFor(() => expect(posts()).toHaveLength(1));
  const older = posts()[0].body;
  expect(older).not.toHaveProperty('variation_count');
  cleanup();

  // With the capability and the default count, the request is the same.
  setup();
  await ready();
  const options = screen.getByRole('button', { name: 'Generate options' });
  fireEvent.click(options);
  expect(
    screen
      .getByRole('menuitemradio', { name: '1 image' })
      .getAttribute('aria-checked'),
  ).toBe('true');
  expect(screen.getAllByRole('menuitemradio')).toHaveLength(4);
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
  await waitFor(() => expect(document.activeElement).toBe(options));
  fireEvent.click(generateButton('Generate image'));
  await waitFor(() => expect(posts()).toHaveLength(1));
  const { idempotency_key: _a, ...now } = posts()[0].body;
  const { idempotency_key: _b, ...before } = older;
  expect(now).toEqual(before);
  expect(statusReads()).toBe(0);
});

test('a group follows its accepted children, retries only the failed slot with the frozen request, and keeps siblings and selection', async () => {
  setup();
  await submitGroup();
  const original = posts()[0].body;
  expect(original.variation_count).toBe(2);
  expect(original.prompt).toBe(IDEA);
  // Progress is bounded to the group; nothing else is sent while it runs.
  await screen.findByText('Image 1 of 2');
  expect(generateButton('Generating image 1 of 2…').disabled).toBe(true);
  await waitFor(() =>
    expect(savedNames().filter((n) => n.startsWith('Generating'))).toHaveLength(
      2,
    ),
  );

  show(titled(groups.partial));
  await screen.findByRole('heading', { name: TITLES[0] });
  await waitFor(() =>
    expect(within(strip()).getByRole('status').textContent).toContain(
      '1 of 2 ready · 1 failed',
    ),
  );
  expect(within(strip()).getByRole('alert').textContent).toContain(
    'Synthetic second variation failed',
  );
  expect(savedNames()).toContain(`Failed: ${IDEA}`);
  expect(screen.getByText('Variation 1 of 2')).toBeTruthy();
  expect(posts()).toHaveLength(1);

  // The draft changes; the retry still sends the original request.
  fireEvent.change(prompt(), { target: { value: 'A different idea' } });
  fireEvent.click(
    within(strip()).getByRole('button', { name: 'Retry 1 failed' }),
  );
  await waitFor(() => expect(posts()).toHaveLength(2));
  const retried = posts()[1].body;
  const { idempotency_key: originalKey, ...frozen } = original;
  expect(retried).toEqual({
    ...frozen,
    idempotency_key: retried.idempotency_key,
    variation_count: 1,
    retry_variations: { group_id: GROUP_ID, indices: [1] },
  });
  expect(retried.idempotency_key).not.toBe(originalKey);
  // The failed item is replaced by its new attempt.
  await waitFor(() => expect(savedNames()).not.toContain(`Failed: ${IDEA}`));

  show(titled(groups.complete));
  await waitFor(() =>
    expect(within(strip()).getByRole('status').textContent).toContain(
      '2 of 2 ready',
    ),
  );
  await waitFor(() => expect(savedNames()).toContain(TITLES[1]));
  expect(savedNames()).toContain(TITLES[0]);
  // The late sibling neither took the stage nor replaced the edit.
  expect(screen.getByRole('heading', { name: TITLES[0] })).toBeTruthy();
  expect(prompt().value).toBe('A different idea');
  expect(posts()).toHaveLength(2);

  // Choosing a sibling only changes what is shown.
  fireEvent.click(
    within(strip()).getByRole('button', { name: 'Variation 2 of 2, ready' }),
  );
  await screen.findByRole('heading', { name: TITLES[1] });
  expect(
    within(strip())
      .getByRole('button', { name: 'Variation 2 of 2, ready' })
      .getAttribute('aria-pressed'),
  ).toBe('true');
  expect(prompt().value).toBe('A different idea');
  expect(screen.getByText('Variation 2 of 2')).toBeTruthy();
  expect(sessionStorage.getItem(RECOVERY_KEY)).toBeNull();
});

test('an ambiguous initial group submission retries the frozen count and key after draft changes', async () => {
  let first = true;
  setup({
    extra: {
      [GENERATE]: (body) => {
        if (first) {
          first = false;
          return networkFailure();
        }
        return respond(
          202,
          body?.retry_variations ? groups.retry_accepted : groups.accepted,
        );
      },
    },
  });
  await ready();
  chooseCount('2 images');
  fireEvent.click(generateButton('Generate 2 images'));
  await screen.findByRole('button', { name: 'Retry' });
  expect(posts()).toHaveLength(1);

  fireEvent.change(prompt(), { target: { value: 'A new draft idea' } });
  chooseCount('3 images');
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(posts()).toHaveLength(2));
  expect(posts()[1].body).toEqual(posts()[0].body);
  await screen.findByText('Image 1 of 2');
  expect(prompt().value).toBe('A new draft idea');
  expect(statusReads()).toBeGreaterThan(0);
});

test('an image chosen while the group runs is not taken over', async () => {
  setup({ records: [sizedRecord('one', 1152, 768)] });
  await submitGroup();
  await screen.findByText('Image 1 of 2');
  fireEvent.click(
    within(screen.getByRole('region', { name: 'Saved images' })).getByRole(
      'button',
      { name: 'Image one' },
    ),
  );
  await screen.findByRole('heading', { name: 'Image one' });
  show(completeOriginal());
  await screen.findByText('2 new images finished.');
  expect(screen.getByRole('heading', { name: 'Image one' })).toBeTruthy();
  await waitFor(() => expect(savedNames()).toContain(TITLES[1]));
  fireEvent.click(screen.getByRole('button', { name: 'View' }));
  await screen.findByRole('heading', { name: TITLES[0] });
  expect(posts()).toHaveLength(1);
});

test('New draft during a group keeps the results out of the new draft and asks for one image again', async () => {
  setup();
  await submitGroup();
  await screen.findByText('Image 1 of 2');
  fireEvent.click(screen.getByRole('button', { name: 'New draft' }));
  expect(prompt().value).toBe('');
  show(completeOriginal());
  await waitFor(() => expect(savedNames()).toContain(TITLES[0]));
  await screen.findByText('2 new images finished.');
  expect(screen.queryByRole('heading', { name: TITLES[0] })).toBeNull();
  expect(generateButton('Generate image')).toBeTruthy();
});

test('a refused group starts nothing and is not followed', async () => {
  setup({
    extra: {
      [GENERATE]: () =>
        respond(429, {
          detail: 'Generation queue lacks room for these variations',
        }),
    },
  });
  await submitGroup();
  await screen.findByText(
    'Generation queue lacks room for these variations None of the 2 images were started.',
  );
  expect(statusReads()).toBe(0);
  expect(screen.queryByRole('region', { name: 'Variations' })).toBeNull();
  expect(
    within(
      screen.queryByRole('region', { name: 'Saved images' }) ?? document.body,
    )
      .queryAllByRole('button')
      .filter((b) => /Generating/.test(b.getAttribute('aria-label') ?? '')),
  ).toHaveLength(0);
});

test('a retry whose answer was lost is sent again with the same key, never a new one', async () => {
  let fail = true;
  setup({
    extra: {
      [GENERATE]: (body) => {
        if (!body?.retry_variations) return respond(202, groups.accepted);
        if (fail) return networkFailure();
        return respond(202, groups.retry_accepted);
      },
    },
  });
  await submitGroup();
  show(titled(groups.partial));
  const retry = await within(strip()).findByRole('button', {
    name: 'Retry 1 failed',
  });
  const readsBefore = statusReads();
  fireEvent.click(retry);
  await within(strip()).findByText(/Retry sends the same request again/);
  fireEvent.click(
    within(strip()).getAllByRole('button', { name: 'Error details' }).at(-1),
  );
  const diagnostic = screen.getByRole('dialog', { name: 'Error details' });
  expect(diagnostic.textContent).toContain('No HTTP response was received.');
  expect(diagnostic.textContent).not.toContain('HTTP status');
  fireEvent.keyDown(diagnostic, { key: 'Escape' });
  // Status was checked once in case the server accepted it.
  await waitFor(() => expect(statusReads()).toBeGreaterThan(readsBefore));
  const firstKey = posts()[1].body.idempotency_key;
  fail = false;
  fireEvent.click(
    within(strip()).getByRole('button', { name: 'Retry 1 failed' }),
  );
  await waitFor(() => expect(posts()).toHaveLength(3));
  expect(posts()[2].body.idempotency_key).toBe(firstKey);
  expect(posts()[2].body.retry_variations).toEqual({
    group_id: GROUP_ID,
    indices: [1],
  });
});

test('a retry accepted before its answer was lost is found by status, not sent again', async () => {
  setup({
    extra: {
      [GENERATE]: (body) => {
        if (!body?.retry_variations) return respond(202, groups.accepted);
        // Accepted on the server, then the connection dropped.
        show(titled(groups.complete));
        return networkFailure();
      },
    },
  });
  await submitGroup();
  show(titled(groups.partial));
  fireEvent.click(
    await within(strip()).findByRole('button', { name: 'Retry 1 failed' }),
  );
  await waitFor(() =>
    expect(within(strip()).getByRole('status').textContent).toContain(
      '2 of 2 ready',
    ),
  );
  await waitFor(() => expect(savedNames()).toContain(TITLES[1]));
  expect(savedNames()).not.toContain(`Failed: ${IDEA}`);
  expect(posts()).toHaveLength(2);
  expect(api.calls.some((c) => c.key.includes(`/generation-jobs/${ID3}`))).toBe(
    false,
  );
});

test('status lost keeps the group, and checking again only reads status', async () => {
  let down = false;
  setup({
    extra: {
      [STATUS]: () => (down ? networkFailure() : state.status),
    },
  });
  await submitGroup();
  await screen.findByText('Image 1 of 2');
  down = true;
  await within(strip()).findByText(/Lost contact with the variations/);
  // Not a failure: no retry is offered and the action is free again.
  expect(within(strip()).queryByRole('button', { name: /Retry/ })).toBeNull();
  down = false;
  show(completeOriginal());
  fireEvent.click(within(strip()).getByRole('button', { name: 'Check again' }));
  await waitFor(() =>
    expect(within(strip()).getByRole('status').textContent).toContain(
      '2 of 2 ready',
    ),
  );
  expect(posts()).toHaveLength(1);
});

test('after a reload, an unfinished group is followed by status only, without a retry', async () => {
  setup();
  sessionStorage.setItem(
    RECOVERY_KEY,
    JSON.stringify({
      id: GROUP_ID,
      count: 2,
      source: 'shared',
      statusUrl: '/api/generation-groups/{group_id}',
      jobs: [
        { jobId: ID1, index: 0, attempt: 0 },
        { jobId: ID2, index: 1, attempt: 0 },
      ],
      delivered: [],
    }),
  );
  show(titled(groups.partial));
  render(<App jobPolicy={jobPolicy} />);
  await openStandardControls();
  await waitFor(() => expect(statusReads()).toBeGreaterThan(0));
  await waitFor(() => expect(savedNames()).toContain(TITLES[0]));
  expect(posts()).toHaveLength(0);
  await waitFor(() => expect(sessionStorage.getItem(RECOVERY_KEY)).toBeNull());
  // Choosing the recovered image shows its group, with no retry to offer.
  fireEvent.click(
    within(screen.getByRole('region', { name: 'Saved images' })).getByRole(
      'button',
      { name: TITLES[0] },
    ),
  );
  await screen.findByRole('heading', { name: TITLES[0] });
  expect(within(strip()).getByRole('status').textContent).toContain(
    '1 of 2 ready · 1 failed',
  );
  expect(within(strip()).queryByRole('button', { name: /Retry/ })).toBeNull();
  expect(within(strip()).getByRole('alert').textContent).toContain(
    'not kept after a reload',
  );
});
