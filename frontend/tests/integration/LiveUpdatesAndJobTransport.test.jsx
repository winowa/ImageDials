import { openStandardControls } from '../helpers/controlUiTestSupport.js';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import React, { StrictMode } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import privateGeneration from '../../../fixtures/api/private-generation.json';
import App from '../../src/app/App.jsx';
import { DEFAULT_CLIENT_POLICY } from '../../src/data/api/clientPolicy.js';
import {
  clone,
  completeStatus,
  fakeLibrary,
  FakeEventSource,
  fixtures,
  installApi,
  listedFromJob,
  respond,
  sizedRecord,
} from '../helpers/testSupport.js';

const { m1 } = fixtures;
const { transport } = DEFAULT_CLIENT_POLICY;
const LIBRARY = 'GET /api/images/library';
const LIBRARY_PAGE = 'GET /api/images/library/page?';
const GENERATE = 'POST /api/generate-image';
const JOB = 'GET /api/generation-jobs/fixture-image-1';
const jobPolicy = { pollIntervalMs: 1, maxConsecutivePollFailures: 3 };

let library;
let api;

function setup(overrides = {}, records = [sizedRecord('one', 1152, 768)]) {
  library = fakeLibrary(records);
  api = installApi({
    ...library.routes,
    'POST /api/controls/dynamic': () => m1.dynamic_response,
    ...overrides,
  });
}
const libraryReads = () =>
  api.calls.filter(
    (call) => call.key === LIBRARY || call.key.startsWith(LIBRARY_PAGE),
  );
/** The shared Gallery's change check: the head page of its event counts. */
const galleryChecks = () =>
  api.calls.filter((call) =>
    call.key.startsWith('GET /api/images/library/event-facets?limit=100'),
  );
const completeListReads = () => api.called(LIBRARY);
const eventSources = (suffix) =>
  FakeEventSource.all.filter((s) => s.url.endsWith(suffix));
const libraryStreams = () => eventSources('/images/library/events');
const goto = (path) => {
  window.history.replaceState(null, '', path);
};

beforeEach(() => {
  goto('/');
  localStorage.clear();
  FakeEventSource.reset();
  vi.stubGlobal('EventSource', FakeEventSource);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Fake timers for the clock only; promises and React keep running. */
const fakeClock = () =>
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'Date',
    ],
  });
const advance = (ms) => act(() => vi.advanceTimersByTimeAsync(ms));
const settle = () => act(() => vi.advanceTimersByTimeAsync(0));

// --- Library stream ---------------------------------------------------------------

test('the gallery opens the stream, refreshes on open, and keeps images on 304', async () => {
  goto('/gallery');
  setup();
  fakeClock();
  render(<App jobPolicy={jobPolicy} />);
  await settle();
  expect(libraryStreams()).toHaveLength(1);
  expect(galleryChecks().length).toBeGreaterThanOrEqual(1);
  const before = galleryChecks().length;
  const sessions = library.created.length;
  libraryStreams()[0].open();
  await settle();
  const reads = galleryChecks();
  expect(reads).toHaveLength(before + 1);
  // The last ETag is sent, the 304 changes nothing that is shown.
  expect(reads.at(-1).headers['If-None-Match']).toMatch(/^"/);
  expect(library.created).toHaveLength(sessions);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getAllByRole('img').length).toBeGreaterThan(0);
  expect(completeListReads()).toEqual([]);
});

test('a change event reloads the list once after the debounce and shows the new image', async () => {
  goto('/gallery');
  setup();
  fakeClock();
  render(<App jobPolicy={jobPolicy} />);
  await settle();
  libraryStreams()[0].open();
  await settle();
  const before = galleryChecks().length;
  const sessions = library.created.length;
  library.records = [sizedRecord('two', 768, 1152), ...library.records];
  libraryStreams()[0].emit('changed', { action: 'saved' });
  libraryStreams()[0].emit('changed', { action: 'saved' });
  await advance(transport.libraryChangeDebounceMs + 10);
  expect(galleryChecks()).toHaveLength(before + 1);
  expect(galleryChecks().at(-1).headers['If-None-Match']).toBeTruthy();
  await settle();
  // The new image joins the open session without another shuffle.
  expect(screen.getAllByRole('button', { name: 'Image two' }).length).toBe(1);
  expect(library.created).toHaveLength(sessions);
  expect(completeListReads()).toEqual([]);
});

test('a failed refresh keeps the shown images and reports beside them', async () => {
  goto('/print');
  setup();
  fakeClock();
  render(<App jobPolicy={jobPolicy} />);
  await settle();
  libraryStreams()[0].open();
  await settle();
  expect(screen.getByText('Image one')).toBeTruthy();
  const match = api.routes.match;
  api.routes.match = (key) =>
    key.startsWith(LIBRARY_PAGE)
      ? () => respond(502, { detail: 'bad gateway' })
      : match?.(key);
  libraryStreams()[0].emit('changed', {});
  await advance(transport.libraryChangeDebounceMs + 10);
  expect(screen.getByText('Image one')).toBeTruthy();
  expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
});

test('while the stream is down the gallery polls every 5 seconds and the library every 10', async () => {
  goto('/gallery');
  setup();
  fakeClock();
  render(<App jobPolicy={jobPolicy} />);
  await settle();
  libraryStreams()[0].fail();
  const checks = galleryChecks().length;
  await advance(transport.galleryPollIntervalMs);
  expect(galleryChecks()).toHaveLength(checks + 1);
  expect(completeListReads()).toEqual([]);
  // Moving to the library changes the interval to 10 seconds.
  fireEvent.click(screen.getByRole('link', { name: 'Library' }));
  await settle();
  const before = libraryReads().length;
  await advance(transport.libraryPollIntervalMs - 1000);
  expect(libraryReads()).toHaveLength(before);
  await advance(1000);
  expect(libraryReads()).toHaveLength(before + 1);
});

test('the generator never polls, even when the stream is down', async () => {
  setup();
  fakeClock();
  render(<App jobPolicy={jobPolicy} />);
  await settle();
  libraryStreams()[0].fail();
  const before = libraryReads().length;
  await advance(60000);
  expect(libraryReads()).toHaveLength(before);
});

test('leaving a polled screen stops its timer; a reconnect refreshes again', async () => {
  goto('/gallery');
  setup();
  fakeClock();
  render(<App jobPolicy={jobPolicy} />);
  await settle();
  libraryStreams()[0].fail();
  fireEvent.click(screen.getByRole('link', { name: 'Create' }));
  await settle();
  const before = libraryReads().length;
  await advance(60000);
  expect(libraryReads()).toHaveLength(before);
  const reconnected = libraryStreams().at(-1);
  expect(reconnected.closed).toBe(false);
  reconnected.open();
  await settle();
  expect(libraryReads()).toHaveLength(before + 1);
});

test('the library holds refreshes while the pointer moves and applies them when idle', async () => {
  goto('/print');
  setup();
  fakeClock();
  render(<App jobPolicy={jobPolicy} />);
  await settle();
  libraryStreams()[0].open();
  await settle();
  const before = libraryReads().length;
  fireEvent.pointerMove(window);
  library.records = [sizedRecord('two', 768, 1152), ...library.records];
  libraryStreams()[0].emit('changed', {});
  await advance(transport.libraryChangeDebounceMs + 100);
  expect(libraryReads()).toHaveLength(before);
  expect(screen.queryByText('Image two')).toBeNull();
  await advance(transport.libraryPointerIdleMs);
  expect(libraryReads()).toHaveLength(before + 1);
  expect(screen.getByText('Image two')).toBeTruthy();
});

test('a shared library that is disabled never connects or polls', async () => {
  goto('/gallery');
  const capabilities = clone(m1.capabilities);
  capabilities.shared_library.enabled = false;
  setup({ 'GET /api/app-capabilities': () => capabilities });
  fakeClock();
  render(<App jobPolicy={jobPolicy} />);
  await settle();
  const before = libraryReads().length;
  await advance(60000);
  expect(libraryStreams()).toHaveLength(0);
  expect(libraryReads()).toHaveLength(before);
});

test('unmounting closes the stream and leaves no timers; StrictMode does not duplicate it', async () => {
  goto('/gallery');
  setup();
  fakeClock();
  const view = render(
    <StrictMode>
      <App jobPolicy={jobPolicy} />
    </StrictMode>,
  );
  await settle();
  expect(libraryStreams().filter((s) => !s.closed)).toHaveLength(1);
  libraryStreams().at(-1).open();
  await settle();
  view.unmount();
  expect(libraryStreams().every((s) => s.closed)).toBe(true);
  const before = libraryReads().length;
  await advance(120000);
  expect(libraryReads()).toHaveLength(before);
});

// --- Job stream ---------------------------------------------------------------------

const IDEA = 'A tiny glass fox';
const prompt = () => screen.getByLabelText('Image idea');
const enter = () => fireEvent.keyDown(prompt(), { key: 'Enter' });

function jobSetup(extra = {}) {
  setup({
    [GENERATE]: () => respond(202, m1.accepted),
    [JOB]: () => ({ ...m1.job_running }),
    ...extra,
  });
}
const jobStreams = () =>
  eventSources('/events').filter((s) => s.url.includes('generation-jobs'));

test('an accepted job is followed on its canonical event stream and completes there', async () => {
  jobSetup();
  render(<App jobPolicy={jobPolicy} />);
  await openStandardControls();
  fireEvent.change(prompt(), { target: { value: IDEA } });
  enter();
  await waitFor(() => expect(jobStreams()).toHaveLength(1));
  const stream = jobStreams()[0];
  expect(stream.url).toBe('/api/generation-jobs/fixture-image-1/events');
  stream.emit('progress', {
    message: 'rendering',
    enrichment: { status: 'running' },
  });
  const complete = completeStatus();
  library.records = [listedFromJob(complete.result), ...library.records];
  stream.emit('complete', complete.result);
  await screen.findByRole('heading', { name: complete.result.title });
  expect(stream.closed).toBe(true);
  // The stream delivered everything: the status endpoint was never polled.
  expect(api.called(JOB)).toHaveLength(0);
  expect(api.called(GENERATE)).toHaveLength(1);
});

test('a dropped job stream falls back to polling and never resubmits', async () => {
  const status = completeStatus();
  jobSetup({
    [JOB]: () => {
      library.records = [listedFromJob(status.result), ...library.records];
      return status;
    },
  });
  render(<App jobPolicy={jobPolicy} />);
  await openStandardControls();
  fireEvent.change(prompt(), { target: { value: IDEA } });
  enter();
  await waitFor(() => expect(jobStreams()).toHaveLength(1));
  jobStreams()[0].fail();
  await screen.findByRole('heading', { name: status.result.title });
  expect(api.called(JOB).length).toBeGreaterThanOrEqual(1);
  expect(api.called(GENERATE)).toHaveLength(1);
  expect(jobStreams()).toHaveLength(1);
});

test('a failure after a preview stays failed and keeps the saved images', async () => {
  jobSetup();
  render(<App jobPolicy={jobPolicy} />);
  await openStandardControls();
  fireEvent.change(prompt(), { target: { value: IDEA } });
  enter();
  await waitFor(() => expect(jobStreams()).toHaveLength(1));
  const stream = jobStreams()[0];
  stream.emit('image-ready', {
    ...m1.job_preview.latest_event.data,
    image_url: m1.job_preview.latest_event.data.image_url,
  });
  stream.emit('failed', { error: 'Enrichment unavailable' });
  await screen.findByText(/Enrichment unavailable/);
  stream.emit('complete', completeStatus().result);
  expect(
    screen.queryByRole('heading', { name: completeStatus().result.title }),
  ).toBeNull();
});

test('a private result is shown from its returned URL and never requests forbidden shared media', async () => {
  const forbidden = respond(403, { detail: 'Shared library is disabled' });
  const { accepted, complete_poll: poll } = privateGeneration;
  const JOB_PRIVATE = `GET /api/generation-jobs/${accepted.generation_job_id}`;
  setup({
    'GET /api/app-capabilities': () => privateGeneration.capabilities,
    [LIBRARY]: () => forbidden,
    [GENERATE]: () => respond(202, accepted),
    [JOB_PRIVATE]: () => poll,
  });
  render(<App jobPolicy={jobPolicy} />);
  await openStandardControls();
  fireEvent.change(prompt(), { target: { value: IDEA } });
  enter();
  await waitFor(() => expect(jobStreams()).toHaveLength(1));
  jobStreams()[0].emit('complete', poll.result);
  await screen.findByRole('heading', { name: poll.result.title });
  const stage = document.querySelector('.stage-img');
  expect(stage.getAttribute('src')).toBe(poll.result.image_url);
  expect(document.querySelectorAll('img').length).toBeGreaterThan(0);
  for (const img of document.querySelectorAll('img'))
    expect(img.getAttribute('src')).not.toContain('/library/files/');
  expect(api.calls.some((c) => c.key.includes('/library/files/'))).toBe(false);
});
