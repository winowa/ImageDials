import { expect, test } from 'vitest';

import { ApiError } from './api.js';
import {
  attachDiagnostic,
  httpDiagnostic,
  networkDiagnostic,
} from './diagnostics.js';
import {
  acceptedJob,
  applyEvent,
  applyStatus,
  JOB_EVENT,
  PHASE,
  trackJob,
} from './jobs.js';

test('failed job events retain their payload as job data, never inventing an HTTP response', () => {
  const record = {
    error: 'Provider failed',
    stage: 'render',
    provider_secret: 'fixture-private',
    evidence: { safe: 'provider detail' },
  };
  const job = applyEvent(acceptedJob('fixture-job'), {
    event: JOB_EVENT.failed,
    data: record,
  });
  expect(job.error).toBe('Provider failed');
  expect(job.phase).toBe(PHASE.failed);
  expect(job.diagnostic).toMatchObject({
    kind: 'job',
    jobId: 'fixture-job',
    data: {
      error: 'Provider failed',
      provider_secret: '[redacted]',
      evidence: { safe: 'provider detail' },
    },
  });
  expect(job.diagnostic.status).toBeUndefined();
  expect(job.diagnostic.body).toBeUndefined();
  expect(JSON.stringify(job.diagnostic)).not.toContain('fixture-private');
  expect(applyEvent(job, { event: JOB_EVENT.failed, data: record })).toBe(job);
});

test('authoritative failed status retains the actual status payload and error string', () => {
  const record = {
    status: 'failed',
    result: { error: 'Failed to save' },
    events: [{ event: 'progress', data: { message: 'Saving' } }],
  };
  const job = applyStatus(acceptedJob('fixture-job'), record);
  expect(job.error).toBe('Failed to save');
  expect(job.diagnostic.data).toEqual(record);
  expect(job.diagnostic.status).toBeUndefined();
  expect(applyStatus(job, { status: 'running' })).toBe(job);
});

test.each([404, 503])(
  'tracking failure %s preserves its real HTTP status and exact body without resubmitting',
  async (status) => {
    const text = ' {"detail":"Tracking failed"}\n';
    const error = attachDiagnostic(
      new ApiError('Tracking failed', { status }),
      httpDiagnostic({
        method: 'GET',
        path: '/api/generation-jobs/fixture-job',
        response: new Response(text, { status }),
        text,
      }),
    );
    let calls = 0;
    const updates = [];
    const job = await trackJob({
      job: acceptedJob('fixture-job'),
      fetchStatus: async () => {
        calls++;
        throw error;
      },
      onUpdate: (job) => updates.push(job),
      isCurrent: () => true,
      wait: async () => {},
      policy: { pollIntervalMs: 1, maxConsecutivePollFailures: 2 },
    });
    expect(job.phase).toBe(status === 404 ? PHASE.failed : PHASE.lost);
    expect(typeof job.error).toBe('string');
    expect(job.diagnostic).toMatchObject({
      kind: 'http',
      status,
      body: { text },
    });
    expect(calls).toBe(status === 404 ? 1 : 2);
    expect(updates).toHaveLength(1);
  },
);

test('lost network tracking reports no response and retains the final cause', async () => {
  const error = attachDiagnostic(
    new ApiError('Unreachable', { network: true }),
    networkDiagnostic({
      path: '/api/job',
      cause: new TypeError('Failed to fetch'),
    }),
  );
  const job = await trackJob({
    job: acceptedJob('fixture-job'),
    fetchStatus: async () => {
      throw error;
    },
    onUpdate: () => {},
    isCurrent: () => true,
    wait: async () => {},
    policy: { pollIntervalMs: 1, maxConsecutivePollFailures: 1 },
  });
  expect(job.phase).toBe(PHASE.lost);
  expect(job.diagnostic).toMatchObject({
    kind: 'network',
    status: null,
    cause: { message: 'Failed to fetch' },
  });
  expect(job.diagnostic.body).toBeUndefined();
});
