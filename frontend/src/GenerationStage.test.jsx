import { openStandardControls } from './controlUiTestSupport.js';
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
import { PHRASES, resetSharedPhraseBag } from './generationPhrases.js';
import {
  completeStatus,
  fakeLibrary,
  FakeEventSource,
  fixtures,
  installApi,
  listedFromJob,
  respond,
  sizedRecord,
} from './testSupport.js';

const { m1 } = fixtures;
const GENERATE = 'POST /api/generate-image';
const DYNAMIC = 'POST /api/controls/dynamic';
const JOB = 'GET /api/generation-jobs/fixture-image-1';
const jobPolicy = { pollIntervalMs: 1, maxConsecutivePollFailures: 3 };
const IDEA = 'A tiny glass fox';
const PREVIOUS = 'Previous saved result';

let library;
let api;
let gates;

/** A promise a test resolves when the server should answer. */
const gate = () => {
  let open;
  const promise = new Promise((resolve) => {
    open = resolve;
  });
  return { promise, open };
};

function setup(extra = {}) {
  library = fakeLibrary([
    sizedRecord('one', 1152, 768, { title: PREVIOUS }),
    sizedRecord('two', 768, 1152, { title: 'Second saved result' }),
  ]);
  gates = { dynamic: gate(), accept: gate() };
  api = installApi({
    ...library.routes,
    [DYNAMIC]: async () => {
      await gates.dynamic.promise;
      return m1.dynamic_response;
    },
    [GENERATE]: async () => {
      await gates.accept.promise;
      return respond(202, m1.accepted);
    },
    [JOB]: () => ({ ...m1.job_running }),
    ...extra,
  });
}
const prompt = () => screen.getByLabelText('Image idea');
const strip = () => screen.getByRole('region', { name: 'Saved images' });
const stage = () => document.querySelector('.stage');
const stageImage = () => stage().querySelector('.stage-img');
const phrase = () =>
  stage().querySelector('.stage-phrase[data-state="current"]')?.textContent;
const jobStream = () =>
  FakeEventSource.all.find((s) => s.url.includes('generation-jobs'));
const advance = (ms) => act(() => vi.advanceTimersByTime(ms));

async function start() {
  render(<App jobPolicy={jobPolicy} />);
  await openStandardControls();
  // Explicitly select the saved image used as the previous result.
  fireEvent.click(await screen.findByRole('button', { name: PREVIOUS }));
  await waitFor(() =>
    expect(prompt().value).toBe(sizedRecord('one', 1, 1).original_prompt),
  );
  await screen.findByRole('heading', { name: PREVIOUS });
  expect(stageImage()).toBeTruthy();
  fireEvent.keyDown(prompt(), { key: 'Enter' });
}

async function accepted() {
  gates.dynamic.open();
  gates.accept.open();
  await waitFor(() => expect(jobStream()).toBeTruthy());
}

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  localStorage.clear();
  resetSharedPhraseBag();
  FakeEventSource.reset();
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal('scrollTo', () => {});
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('the earlier image leaves the stage the moment generation starts, before the job is accepted', async () => {
  setup();
  await start();
  // The request is sent but the server has not accepted it yet.
  expect(api.called(GENERATE)).toHaveLength(1);
  expect(jobStream()).toBeUndefined();
  expect(stageImage()).toBeNull();
  expect(screen.queryByRole('heading', { name: PREVIOUS })).toBeNull();
  expect(PHRASES).toContain(phrase());
  // The saved history is untouched.
  expect(within(strip()).getByRole('button', { name: PREVIOUS })).toBeTruthy();
  expect(library.records).toHaveLength(2);
  expect(api.calls.some((c) => c.key.startsWith('DELETE'))).toBe(false);
  await accepted();
  expect(stageImage()).toBeNull();
  expect(PHRASES).toContain(phrase());
});

test('the stage pills describe the request being made, not the earlier image', async () => {
  setup();
  render(<App jobPolicy={jobPolicy} />);
  fireEvent.click(await screen.findByRole('button', { name: PREVIOUS }));
  await screen.findByRole('heading', { name: PREVIOUS });
  await waitFor(() => expect(prompt().value).not.toBe(''));
  const pills = () => document.querySelector('.stage-pills').textContent;
  expect(pills()).toContain('1152×768');
  fireEvent.click(screen.getByRole('radio', { name: '2:3' }));
  fireEvent.keyDown(prompt(), { key: 'Enter' });
  expect(pills()).toContain('768×1152');
  expect(pills()).not.toContain('1152×768');
  await accepted();
  // Editing the draft aspect now does not relabel the request in progress.
  fireEvent.click(screen.getByRole('radio', { name: '1:1' }));
  expect(pills()).toContain('768×1152');
});

test('lines change every 4 seconds in a shuffled order while real progress stays separate', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  setup();
  await start();
  await accepted();
  const seen = [phrase()];
  for (let i = 0; i < 47; i += 1) {
    advance(4000);
    seen.push(phrase());
  }
  expect(new Set(seen).size).toBe(48);
  advance(4000);
  expect(phrase()).not.toBe(seen[47]);
  // The truthful step list is its own element, and the jokes are not in it.
  const progress = stage().querySelector('.progress');
  expect(within(progress).getByRole('status').textContent).toContain(
    'Generating:',
  );
  expect(
    within(progress).getByRole('list', { name: 'Generation progress' }),
  ).toBeTruthy();
  expect(progress.textContent).not.toContain(phrase());
  expect(stage().querySelector('[aria-live] .stage-phrase')).toBeNull();
});

test('the next generation continues the same shuffled bag', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  setup();
  await start();
  await accepted();
  const first = [phrase()];
  advance(4000);
  first.push(phrase());
  jobStream().emit('failed', { error: 'No luck' });
  await screen.findByText(/No luck/);
  expect(phrase()).toBeUndefined();

  gates = { dynamic: gate(), accept: gate() };
  FakeEventSource.reset();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  const second = [phrase()];
  advance(4000);
  second.push(phrase());
  expect(new Set([...first, ...second]).size).toBe(4);
});

test('a preview ends the lines and shows the preview, but is not a finished result', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  setup();
  await start();
  await accepted();
  jobStream().emit('image-ready', m1.job_preview.latest_event.data);
  await waitFor(() => expect(screen.getByAltText('Preview')).toBeTruthy());
  expect(phrase()).toBeUndefined();
  expect(stageImage()).toBeNull();
  expect(screen.queryByRole('heading', { name: PREVIOUS })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Reuse settings' })).toBeNull();
  advance(10_000);
  expect(phrase()).toBeUndefined();
});

test('completion shows the new image and no lines', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  setup();
  await start();
  await accepted();
  const complete = completeStatus();
  library.records = [listedFromJob(complete.result), ...library.records];
  jobStream().emit('complete', complete.result);
  await screen.findByRole('heading', { name: complete.result.title });
  expect(phrase()).toBeUndefined();
  expect(stageImage()).toBeTruthy();
  expect(screen.queryByRole('heading', { name: PREVIOUS })).toBeNull();
});

test('a failure keeps the draft and brings the previous result back', async () => {
  setup();
  await start();
  await accepted();
  jobStream().emit('failed', { error: 'No luck' });
  await screen.findByText(/No luck/);
  expect(phrase()).toBeUndefined();
  expect(prompt().value).not.toBe('');
  expect(screen.getByRole('heading', { name: PREVIOUS })).toBeTruthy();
  expect(stageImage()).toBeTruthy();
  expect(screen.getByText(/previous image is still shown/)).toBeTruthy();
});

test('a failure before the job is accepted also restores the shown result', async () => {
  setup({ [GENERATE]: () => respond(500, { detail: 'Provider down' }) });
  await start();
  gates.dynamic.open();
  gates.accept.open();
  await screen.findAllByText(/Provider down/);
  expect(screen.getByRole('heading', { name: PREVIOUS })).toBeTruthy();
  expect(phrase()).toBeUndefined();
});

test('choosing another saved image meanwhile shows it and keeps the late result from taking over', async () => {
  setup();
  await start();
  await accepted();
  fireEvent.click(
    within(strip()).getByRole('button', { name: 'Second saved result' }),
  );
  await screen.findByRole('heading', { name: 'Second saved result' });
  expect(stageImage()).toBeTruthy();
  const complete = completeStatus();
  library.records = [listedFromJob(complete.result), ...library.records];
  jobStream().emit('complete', complete.result);
  await screen.findByText('A new image finished.');
  expect(
    screen.getByRole('heading', { name: 'Second saved result' }),
  ).toBeTruthy();
});

test('choosing the pending item shows the waiting lines, never the earlier image', async () => {
  setup();
  await start();
  await accepted();
  const pending = await within(strip())
    .findByRole('button', {
      name: `Generating: ${IDEA}`,
    })
    .catch(() => within(strip()).getAllByRole('button')[0]);
  fireEvent.click(pending);
  expect(stageImage()).toBeNull();
  expect(screen.queryByRole('heading', { name: PREVIOUS })).toBeNull();
  expect(PHRASES).toContain(phrase());
});

test('leaving the route ends the rotation and returning keeps waiting', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  setup();
  await start();
  await accepted();
  expect(phrase()).toBeTruthy();
  fireEvent.click(screen.getByRole('link', { name: 'Library' }));
  expect(document.querySelector('.stage-phrase')).toBeNull();
  advance(5000);
  fireEvent.click(screen.getByRole('link', { name: 'Create' }));
  expect(stageImage()).toBeNull();
  expect(PHRASES).toContain(phrase());
});
