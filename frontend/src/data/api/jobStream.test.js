import { beforeEach, expect, test, vi } from 'vitest';

import m5 from '../../../../fixtures/api/m5.json';
import { ApiError } from './api.js';
import { acceptedJob, applyEvent, applyStatus, PHASE } from './jobs.js';
import { observeJob } from './jobStream.js';
import { clone, FakeEventSource } from '../../../tests/helpers/testSupport.js';

const { complete_poll, late_failure_poll, unknown_job_stream } = m5;
const events = complete_poll.events;
const policy = { pollIntervalMs: 5, maxConsecutivePollFailures: 3 };
const job = () => acceptedJob(complete_poll.generation_job_id);
const named = (name) => events.filter((e) => e.event === name);
const [preview] = named('image-ready');
const [finished] = named('complete');

beforeEach(() => FakeEventSource.reset());

function observe(extra = {}) {
  const updates = [];
  const controller = new AbortController();
  const promise = observeJob({
    job: job(),
    fetchStatus: vi.fn(() => Promise.reject(new Error('no polling expected'))),
    onUpdate: (next) => updates.push(next),
    isCurrent: () => true,
    signal: controller.signal,
    wait: () => Promise.resolve(),
    policy,
    EventSourceImpl: FakeEventSource,
    ...extra,
  });
  return { promise, updates, controller, source: () => FakeEventSource.all[0] };
}

// --- the shared reducer ---------------------------------------------------------

test('a replayed history changes nothing; distinct progress is preserved', () => {
  const history = events.slice(0, 5);
  let state = history.reduce(applyEvent, job());
  expect(state.phase).toBe(PHASE.preview);
  // Each exact repeat of the latest event is ignored outright...
  expect(applyEvent(state, history[4])).toBe(state);
  expect(applyEvent(state, preview)).toBe(state);
  // ...and a polled replay of the whole history leaves the same object.
  const status = { ...clone(complete_poll), status: 'running', result: null };
  status.events = history;
  status.latest_event = history[4];
  const polled = applyStatus(state, status);
  expect(polled).toBe(state);
  // A different message or enrichment is new information, not a duplicate.
  const next = applyEvent(state, {
    event: 'progress',
    data: {
      message: 'enriching again',
      enrichment: { status: 'running', step: 2 },
    },
  });
  expect(next).not.toBe(state);
  expect(next.stage).toBe('enriching again');
  expect(next.enrichment).toEqual({ status: 'running', step: 2 });
  expect(next.phase).toBe(PHASE.preview);
});

test('stream history and a polled status reach the same state', () => {
  const streamed = events.reduce(applyEvent, job());
  const polled = applyStatus(job(), complete_poll);
  expect(streamed.phase).toBe(PHASE.complete);
  expect(polled.phase).toBe(PHASE.complete);
  expect(polled.result).toEqual(streamed.result);
  expect(polled.preview).toEqual(streamed.preview);
  const late = clone(late_failure_poll);
  expect(applyStatus(job(), late).phase).toBe(PHASE.failed);
  expect(late.events.reduce(applyEvent, job()).error).toBe(
    applyStatus(job(), late).error,
  );
});

test('an event after a terminal one cannot reopen or alter the job', () => {
  const done = events.reduce(applyEvent, job());
  expect(applyEvent(done, preview)).toBe(done);
  expect(applyEvent(done, { event: 'failed', data: { error: 'late' } })).toBe(
    done,
  );
  expect(applyEvent(done, named('progress')[0])).toBe(done);
});

// --- the event stream -------------------------------------------------------------

test('every named event is listened for on the actual canonical endpoint', async () => {
  const { promise, source } = observe();
  const es = source();
  expect(es.url).toBe(
    `/api/generation-jobs/${complete_poll.generation_job_id}/events`,
  );
  for (const name of ['progress', 'image-ready', 'complete', 'failed', 'error'])
    expect(es.count(name)).toBe(1);
  for (const event of events) es.emit(event.event, event.data);
  const final = await promise;
  expect(final.phase).toBe(PHASE.complete);
  expect(final.result.image_id).toBe(complete_poll.generation_job_id);
  expect(es.closed).toBe(true);
});

test('stream updates are published once each; replayed duplicates are ignored', async () => {
  const { promise, updates, source } = observe();
  const es = source();
  es.emit('progress', events[0].data);
  es.emit('progress', events[0].data);
  es.emit('image-ready', preview.data);
  es.emit('image-ready', preview.data);
  es.emit('complete', finished.data);
  es.emit('complete', finished.data);
  await promise;
  expect(updates.map((u) => u.phase)).toEqual([
    PHASE.running,
    PHASE.preview,
    PHASE.complete,
  ]);
});

test('failure after a preview stays failed and keeps the preview', async () => {
  const { promise, source } = observe();
  const es = source();
  const history = late_failure_poll.events;
  for (const event of history) es.emit(event.event, event.data);
  const final = await promise;
  expect(final.phase).toBe(PHASE.failed);
  expect(final.preview).toBeTruthy();
  expect(es.closed).toBe(true);
});

test('an unknown job answers with a failed event', async () => {
  const body = /data: (.*)/.exec(unknown_job_stream)[1];
  const { promise, source } = observe();
  source().emit('failed', null, body);
  const final = await promise;
  expect(final.phase).toBe(PHASE.failed);
  expect(final.error).toBe('Generation job not found');
});

test('a dropped stream falls back to polling the same job without failing it', async () => {
  const fetchStatus = vi
    .fn()
    .mockRejectedValueOnce(new ApiError('bad gateway', { status: 502 }))
    .mockResolvedValue(complete_poll);
  const { promise, updates, source } = observe({ fetchStatus });
  const es = source();
  es.emit('progress', events[0].data);
  es.fail();
  expect(es.closed).toBe(true);
  const final = await promise;
  expect(final.phase).toBe(PHASE.complete);
  // The first poll failed (502), which is a transport failure and not a job failure.
  expect(fetchStatus).toHaveBeenCalledTimes(2);
  expect(updates.map((u) => u.phase)).not.toContain(PHASE.failed);
  expect(FakeEventSource.all).toHaveLength(1);
});

test('an unreadable event falls back to polling', async () => {
  const fetchStatus = vi.fn().mockResolvedValue(complete_poll);
  const { promise, source } = observe({ fetchStatus });
  source().emit('progress', null, '{not json');
  expect((await promise).phase).toBe(PHASE.complete);
  expect(fetchStatus).toHaveBeenCalledTimes(1);
});

test('without EventSource the job is polled and a 404 means the job is unknown', async () => {
  const fetchStatus = vi
    .fn()
    .mockRejectedValue(new ApiError('missing', { status: 404 }));
  const { promise } = observe({ EventSourceImpl: null, fetchStatus });
  const final = await promise;
  expect(final.phase).toBe(PHASE.failed);
  expect(FakeEventSource.all).toHaveLength(0);
});

test('five consecutive poll failures keep the job recoverable, not failed', async () => {
  const fetchStatus = vi
    .fn()
    .mockRejectedValue(new ApiError('down', { status: 502 }));
  const { promise } = observe({
    EventSourceImpl: null,
    fetchStatus,
    policy: { pollIntervalMs: 1, maxConsecutivePollFailures: 5 },
  });
  const final = await promise;
  expect(final.phase).toBe(PHASE.lost);
  expect(fetchStatus).toHaveBeenCalledTimes(5);
});

test('aborting the observer closes the stream and ignores later events', async () => {
  const { promise, updates, controller, source } = observe();
  const es = source();
  es.emit('progress', events[0].data);
  controller.abort();
  const final = await promise;
  expect(es.closed).toBe(true);
  es.emit('complete', finished.data);
  expect(updates).toHaveLength(1);
  expect(final.phase).toBe(PHASE.running);
});

test('an observer that is no longer current stops at its next event', async () => {
  let current = true;
  const { promise, updates, source } = observe({ isCurrent: () => current });
  current = false;
  source().emit('complete', finished.data);
  const final = await promise;
  expect(updates).toEqual([]);
  expect(final.phase).toBe(PHASE.accepted);
  expect(source().closed).toBe(true);
});
