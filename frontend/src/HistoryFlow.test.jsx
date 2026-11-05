import { openStandardControls } from './controlUiTestSupport.js';
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

import App from './App.jsx';
import {
  completeStatus,
  fakeLibrary,
  FakeEventSource,
  fixtures,
  clone,
  installApi,
  listedFromJob,
  respond,
  sizedRecord,
} from './testSupport.js';

const { m1 } = fixtures;
const GENERATE = 'POST /api/generate-image';
const JOB = 'GET /api/generation-jobs/fixture-image-1';
const jobPolicy = { pollIntervalMs: 1, maxConsecutivePollFailures: 3 };
const IDEA = 'A tiny glass fox';

let library;
let api;

function setup(records = [sizedRecord('one', 1152, 768)], extra = {}) {
  library = fakeLibrary(records);
  api = installApi({
    ...library.routes,
    'POST /api/controls/dynamic': () => m1.dynamic_response,
    [GENERATE]: () => respond(202, m1.accepted),
    [JOB]: () => ({ ...m1.job_running }),
    ...extra,
  });
}
const prompt = () => screen.getByLabelText('Image idea');
const strip = () => screen.getByRole('region', { name: 'Saved images' });
const items = () => within(strip()).getAllByRole('button');
const jobStream = () =>
  FakeEventSource.all.find((s) => s.url.includes('generation-jobs'));
const names = () => items().map((b) => b.getAttribute('aria-label'));

async function submit() {
  render(<App jobPolicy={jobPolicy} />);
  await openStandardControls();
  fireEvent.change(prompt(), { target: { value: IDEA } });
  fireEvent.keyDown(prompt(), { key: 'Enter' });
  await waitFor(() => expect(jobStream()).toBeTruthy());
}

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  localStorage.clear();
  FakeEventSource.reset();
  vi.stubGlobal('EventSource', FakeEventSource);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test('an accepted job appears in the strip at once, labelled, and is never saved', async () => {
  setup();
  await submit();
  await waitFor(() => expect(names()[0]).toBe(`Generating: ${IDEA}`));
  expect(names()).toHaveLength(2);
  expect(api.called(GENERATE)).toHaveLength(1);
  // Nothing is stored for it: the saved list and the library are untouched.
  expect(library.records).toHaveLength(1);
  expect(api.calls.some((c) => c.key.startsWith('DELETE'))).toBe(false);
});

test('the item is updated through preview, then replaced by the saved image in place', async () => {
  setup();
  await submit();
  await waitFor(() => expect(names()[0]).toBe(`Generating: ${IDEA}`));
  const pendingNode = items()[0].closest('li');
  jobStream().emit('image-ready', m1.job_preview.latest_event.data);
  await waitFor(() => expect(names()[0]).toBe(`Preview ready: ${IDEA}`));
  expect(names()).toHaveLength(2);

  const complete = completeStatus();
  // The authoritative list does not carry the job id.
  const { generation_job_id: _id, ...saved } = listedFromJob(complete.result);
  library.records = [saved, ...library.records];
  jobStream().emit('complete', complete.result);
  await screen.findByRole('heading', { name: complete.result.title });
  await waitFor(() => expect(names()[0]).toBe(complete.result.title));
  // One item for the job, not two; the same list entry kept its place.
  expect(names().filter((n) => n === complete.result.title)).toHaveLength(1);
  expect(names()).toHaveLength(2);
  expect(items()[0].closest('li')).toBe(pendingNode);
  expect(items()[0].getAttribute('aria-current')).toBe('true');
});

test('a failure after a preview stays failed and keeps its item', async () => {
  setup();
  await submit();
  jobStream().emit('image-ready', m1.job_preview.latest_event.data);
  jobStream().emit('failed', { error: 'Enrichment unavailable' });
  await waitFor(() => expect(names()[0]).toBe(`Failed: ${IDEA}`));
  jobStream().emit('complete', completeStatus().result);
  expect(names()[0]).toBe(`Failed: ${IDEA}`);
  expect(names()).toHaveLength(2);
  expect(library.records).toHaveLength(1);
});

test('a delayed result does not replace a New Draft', async () => {
  setup();
  await submit();
  await waitFor(() => expect(names()[0]).toBe(`Generating: ${IDEA}`));
  fireEvent.click(screen.getByRole('button', { name: 'New draft' }));
  const complete = completeStatus();
  library.records = [listedFromJob(complete.result), ...library.records];
  jobStream().emit('complete', complete.result);
  await waitFor(() => expect(names()[0]).toBe(complete.result.title));
  expect(prompt().value).toBe('');
  expect(items()[0].getAttribute('aria-current')).not.toBe('true');
});

test('choosing the pending item restores the exact submitted request, then follows it to the saved image', async () => {
  setup();
  await submit();
  const sent = api.called(GENERATE)[0].body;
  await waitFor(() => expect(names()[0]).toBe(`Generating: ${IDEA}`));
  fireEvent.change(prompt(), { target: { value: 'something else' } });
  fireEvent.click(items()[0]);
  expect(prompt().value).toBe(IDEA);
  expect(sent.controls.length).toBeGreaterThan(0);
  const complete = completeStatus();
  library.records = [listedFromJob(complete.result), ...library.records];
  jobStream().emit('complete', complete.result);
  // The pending item was the selection: it becomes the saved image quietly.
  await waitFor(() => expect(names()[0]).toBe(complete.result.title));
  expect(items()[0].getAttribute('aria-current')).toBe('true');
  expect(screen.queryByText('A new image finished.')).toBeNull();
});

test('restoring a saved image preserves its required terms in the regenerate request', async () => {
  const terms = clone(fixtures.generation.must_have_terms);
  const source = sizedRecord('terms-source', 1152, 768, {
    title: 'Terms source',
    original_prompt: 'A glass bird by a lake',
    prompt: 'A glass bird by a lake',
    must_have_terms: terms,
  });
  setup([source]);
  render(<App jobPolicy={jobPolicy} />);

  await screen.findByRole('region', { name: 'Saved images' });
  fireEvent.click(
    within(strip()).getByRole('button', { name: 'Terms source' }),
  );
  await waitFor(() => expect(prompt().value).toBe(source.original_prompt));
  fireEvent.click(
    screen.getByRole('button', { name: 'Regenerate', exact: true }),
  );
  await waitFor(() => expect(api.called(GENERATE)).toHaveLength(1));

  expect(api.called(GENERATE)[0].body.must_have_terms).toEqual(terms);
  expect(source.must_have_terms).toEqual(terms);
});

test('a failed item is dismissed without any library call', async () => {
  setup();
  await submit();
  jobStream().emit('failed', { error: 'Enrichment unavailable' });
  await waitFor(() => expect(names()[0]).toBe(`Failed: ${IDEA}`));
  fireEvent.click(items()[0]);
  fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
  await waitFor(() => expect(names()).toHaveLength(1));
  expect(api.calls.some((c) => c.key.startsWith('DELETE'))).toBe(false);
});
