import { expect, test, vi } from 'vitest';

import {
  acceptedJob,
  applyEvent,
  applyStatus,
  failedAfterPreview,
  isActive,
  newJob,
  PHASE,
  trackJob,
} from './jobs.js';
import { clone, fixtures } from '../../../tests/helpers/testSupport.js';

const {
  job_running,
  job_preview,
  job_complete,
  job_failed,
  job_failed_after_preview,
} = fixtures.m1;

test('a running status keeps the job active and records the stage', () => {
  const job = applyStatus(acceptedJob('j'), job_running);
  expect(job).toMatchObject({ phase: PHASE.running, stage: 'rendering' });
  expect(isActive(job)).toBe(true);
});

test('a preview is provisional: shown, but not a terminal success', () => {
  const job = applyStatus(acceptedJob('j'), job_preview);
  expect(job.phase).toBe(PHASE.preview);
  expect(job.preview.image_url).toMatch(/\/content$/);
  expect(job.result).toBeNull();
  expect(isActive(job)).toBe(true);
});

test('completion carries the saved result', () => {
  const job = applyStatus(
    applyStatus(acceptedJob('j'), job_preview),
    job_complete,
  );
  expect(job.phase).toBe(PHASE.complete);
  expect(job.result.id).toBe('fixture-image-1');
  expect(isActive(job)).toBe(false);
});

test('failure after a preview stays failed and keeps the preview for context', () => {
  const job = applyStatus(acceptedJob('j'), job_failed_after_preview);
  expect(job.phase).toBe(PHASE.failed);
  expect(job.error).toBe(job_failed_after_preview.result.error);
  expect(failedAfterPreview(job)).toBe(true);
  expect(failedAfterPreview(applyStatus(acceptedJob('j'), job_failed))).toBe(
    false,
  );
});

test('terminal states are final: replays and late responses change nothing', () => {
  const done = applyStatus(acceptedJob('j'), job_complete);
  expect(applyStatus(done, job_running)).toBe(done);
  expect(applyStatus(done, job_failed)).toBe(done);
  const failed = applyStatus(acceptedJob('j'), job_failed);
  expect(applyStatus(failed, job_complete)).toBe(failed);
});

test('a completed status without a result is a failure, not a success', () => {
  const job = applyStatus(acceptedJob('j'), {
    ...clone(job_complete),
    result: null,
  });
  expect(job.phase).toBe(PHASE.failed);
});

const policy = { pollIntervalMs: 5, maxConsecutivePollFailures: 3 };
const track = (fetchStatus, extra = {}) => {
  const updates = [];
  const waits = [];
  const promise = trackJob({
    job: acceptedJob('j'),
    fetchStatus,
    onUpdate: (job) => updates.push(job.phase),
    isCurrent: () => true,
    wait: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
    policy,
    ...extra,
  });
  return { promise, updates, waits };
};

test('polling waits the interval between reads and stops at completion', async () => {
  const replies = [job_running, job_preview, job_complete];
  const fetchStatus = vi.fn(() => Promise.resolve(replies.shift()));
  const { promise, updates, waits } = track(fetchStatus);
  const final = await promise;
  expect(final.phase).toBe(PHASE.complete);
  expect(fetchStatus).toHaveBeenCalledTimes(3);
  expect(updates).toEqual([PHASE.running, PHASE.preview, PHASE.complete]);
  expect(waits).toEqual([5, 5]);
});

test('transient poll failures recover without losing the job', async () => {
  const replies = [new Error('blip'), new Error('blip'), job_complete];
  const { promise } = track(() => {
    const next = replies.shift();
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  });
  expect((await promise).phase).toBe(PHASE.complete);
});

test('consecutive failures end tracking as lost, not failed', async () => {
  const fetchStatus = vi.fn(() => Promise.reject(new Error('down')));
  const { promise } = track(fetchStatus);
  const final = await promise;
  expect(final.phase).toBe(PHASE.lost);
  expect(final.error).toMatch(/may still finish/);
  expect(fetchStatus).toHaveBeenCalledTimes(3);
  expect(isActive(final)).toBe(false);
});

test('an unknown job id fails immediately', async () => {
  const { promise } = track(() =>
    Promise.reject(Object.assign(new Error('nope'), { status: 404 })),
  );
  expect((await promise).phase).toBe(PHASE.failed);
});

test('tracking stops without further reads once it is no longer current', async () => {
  let current = true;
  const fetchStatus = vi.fn(() => {
    current = false;
    return Promise.resolve(job_complete);
  });
  const updates = [];
  const final = await trackJob({
    job: acceptedJob('j'),
    fetchStatus,
    onUpdate: (job) => updates.push(job),
    isCurrent: () => current,
    wait: () => Promise.resolve(),
    policy,
  });
  expect(fetchStatus).toHaveBeenCalledTimes(1);
  expect(updates).toEqual([]);
  expect(final.phase).toBe(PHASE.accepted);
});

test('pre-accept phases are active so duplicate submission stays blocked', () => {
  expect(isActive(newJob(PHASE.preparing))).toBe(true);
  expect(isActive(newJob(PHASE.sending))).toBe(true);
  expect(isActive(null)).toBe(false);
});

test('replay suppression remembers only the latest 64 distinct events', () => {
  const progress = (n) => ({
    event: 'progress',
    data: { message: `step ${n}` },
  });
  let state = acceptedJob('j');
  for (let n = 0; n < 70; n += 1) state = applyEvent(state, progress(n));
  expect(state.eventSignatures).toHaveLength(64);
  expect(state.stage).toBe('step 69');
  // A replay of anything still remembered changes nothing, including the stage.
  for (let n = 6; n < 70; n += 1)
    expect(applyEvent(state, progress(n))).toBe(state);
  // The window is the backend's retention: an event older than it is new again.
  expect(applyEvent(state, progress(0))).not.toBe(state);
});
