import { afterEach, expect, test } from 'vitest';

import groups from '../../../../fixtures/api/generation-groups.json';
import { PHASE } from '../../data/api/jobs.js';
import { planVolatileSlot } from '../../data/storage/cachePolicy.js';
import {
  adoptJobs,
  allowedCount,
  applyGroupStatus,
  canRetry,
  createGroup,
  GROUP_STATUS,
  groupJob,
  groupStatusText,
  groupStatusUrl,
  markDelivered,
  parseAcceptedGroup,
  readRecovery,
  RECOVERY_KEY,
  retryBody,
  saveRecovery,
  summarize,
  variationCapability,
} from './variationGroups.js';

const clone = (value) => JSON.parse(JSON.stringify(value));
const capability = variationCapability({ variations: groups.capability });
const { idempotency_key: _key, ...originalBody } = groups.generate_request;
const fresh = () =>
  createGroup({
    accepted: parseAcceptedGroup(groups.accepted),
    frozen: { body: originalBody, files: null, providerHeader: null },
    statusUrl: capability.statusUrl,
  });

afterEach(() => sessionStorage.clear());

test('the capability is honoured only when explicitly enabled and bounded', () => {
  expect(capability).toEqual({
    max: 4,
    retryFailed: true,
    statusUrl: '/api/generation-groups/{group_id}',
  });
  expect(variationCapability({})).toBeNull();
  expect(variationCapability({ variations: { enabled: 'yes' } })).toBeNull();
  expect(
    variationCapability({ variations: { ...groups.capability, max_count: 1 } }),
  ).toBeNull();
  // A larger server maximum is still bounded to four; an absolute URL is not followed.
  expect(
    variationCapability({
      variations: {
        ...groups.capability,
        max_count: 9,
        status_url: 'https://elsewhere.example/{group_id}',
      },
    }),
  ).toMatchObject({ max: 4, statusUrl: '/api/generation-groups/{group_id}' });
  expect(allowedCount(3, null)).toBe(1);
  expect(allowedCount(7, capability)).toBe(4);
  expect(groupStatusUrl(capability.statusUrl, 'a b')).toBe(
    '/api/generation-groups/a%20b',
  );
});

test('an acceptance parses only a valid bounded group; a single job has none', () => {
  expect(parseAcceptedGroup({ generation_job_id: 'x' })).toBeNull();
  const parsed = parseAcceptedGroup(groups.accepted);
  expect(parsed.id).toBe(groups.accepted.variation_group.id);
  expect(parsed.jobs.map((j) => j.index)).toEqual([0, 1]);
  const bad = clone(groups.accepted);
  bad.variation_group.jobs[1].index = 0;
  expect(parseAcceptedGroup(bad)).toBeNull();
  bad.variation_group.jobs[1].index = 2;
  expect(parseAcceptedGroup(bad)).toBeNull();
  const huge = clone(groups.accepted);
  huge.variation_group.count = 5;
  expect(parseAcceptedGroup(huge)).toBeNull();
  const missingSlot = clone(groups.accepted);
  missingSlot.variation_group.jobs.pop();
  expect(parseAcceptedGroup(missingSlot)).toBeNull();
  const duplicateJob = clone(groups.accepted);
  duplicateJob.variation_group.jobs[1].generation_job_id =
    duplicateJob.variation_group.jobs[0].generation_job_id;
  expect(parseAcceptedGroup(duplicateJob)).toBeNull();
});

test('fixture partial status folds each slot through the job reducer', () => {
  const { group, replaced } = applyGroupStatus(fresh(), groups.partial);
  expect(replaced).toEqual([]);
  const summary = summarize(group);
  expect(summary).toMatchObject({
    status: GROUP_STATUS.partial,
    complete: 1,
    failed: 1,
    active: 0,
    failedIndices: [1],
  });
  expect(group.slots[0].job.result.variation).toEqual({
    group_id: groups.accepted.variation_group.id,
    index: 0,
    count: 2,
    attempt: 0,
  });
  expect(group.slots[1].job.error).toBe('Synthetic second variation failed');
  expect(groupStatusText(group)).toBe('1 of 2 ready · 1 failed');
  expect(canRetry(group, capability)).toBe(true);
  // A replay is not a change.
  expect(applyGroupStatus(group, groups.partial).group).toBe(group);
  // Another group's answer changes nothing.
  expect(
    applyGroupStatus(group, { ...groups.partial, generation_group_id: 'other' })
      .group,
  ).toBe(group);
  // The settled job the rest of the generator sees: not active, not failed.
  expect(groupJob(group)).toMatchObject({
    phase: PHASE.complete,
    group: { complete: 1, failed: 1, status: 'partial' },
  });
});

test('the retry body is the frozen original with exactly the failed indices', () => {
  const { group } = applyGroupStatus(fresh(), groups.partial);
  const body = retryBody(
    group.frozen.body,
    group.id,
    summarize(group).failedIndices,
    'synthetic-variation-retry',
  );
  expect(body).toEqual(groups.retry_request);
});

test('a retry acceptance replaces only failed slots, and the completed sibling is untouched', () => {
  const partial = applyGroupStatus(fresh(), groups.partial).group;
  const { group, replaced } = adoptJobs(
    partial,
    parseAcceptedGroup(groups.retry_accepted).jobs,
  );
  expect(replaced).toEqual([
    {
      index: 1,
      previous: '10000000-0000-4000-8000-000000000002',
      jobId: '10000000-0000-4000-8000-000000000003',
    },
  ]);
  expect(group.slots[0]).toBe(partial.slots[0]);
  expect(group.slots[1].job.phase).toBe(PHASE.accepted);
  expect(summarize(group).status).toBe(GROUP_STATUS.running);
  expect(groupJob(group)).toMatchObject({
    id: '10000000-0000-4000-8000-000000000003',
    phase: PHASE.running,
    group: { index: 1, count: 2 },
  });
  expect(groupStatusText(group)).toBe('Image 2 of 2 · 1 ready');
  // The same acceptance again, or an older attempt, replaces nothing.
  expect(
    adoptJobs(group, parseAcceptedGroup(groups.retry_accepted).jobs).group,
  ).toBe(group);
  const done = applyGroupStatus(group, groups.complete).group;
  expect(summarize(done).status).toBe(GROUP_STATUS.complete);
  expect(done.slots[0]).toBe(group.slots[0]);
  expect(applyGroupStatus(done, groups.partial).group).toBe(done);
});

test('status naming a later accepted attempt is adopted without any request', () => {
  const partial = applyGroupStatus(fresh(), groups.partial).group;
  // The retry was accepted but its answer was lost; status names it.
  const { group, replaced } = applyGroupStatus(partial, groups.complete);
  expect(replaced.map((r) => r.jobId)).toEqual([
    '10000000-0000-4000-8000-000000000003',
  ]);
  expect(summarize(group).status).toBe(GROUP_STATUS.complete);
});

test('all failed is failed; lost status is not a failure', () => {
  const status = clone(groups.partial);
  status.jobs[0] = {
    ...clone(status.jobs[1]),
    generation_job_id: status.jobs[0].generation_job_id,
    index: 0,
  };
  status.status = 'failed';
  const failed = applyGroupStatus(fresh(), status).group;
  expect(groupJob(failed)).toMatchObject({
    phase: PHASE.failed,
    error: 'Synthetic second variation failed',
  });
  expect(groupStatusText(failed)).toBe('All 2 failed');
  const lost = { ...fresh(), lost: 'Lost contact.' };
  expect(groupJob(lost).phase).toBe(PHASE.lost);
  expect(canRetry(lost, capability)).toBe(false);
  // No frozen request (after a reload) means no retry.
  expect(canRetry({ ...failed, frozen: null }, capability)).toBe(false);
});

test('recovery keeps only server ids, and is cleared once everything is delivered', () => {
  const group = fresh();
  saveRecovery(group, 'shared');
  const raw = sessionStorage.getItem(RECOVERY_KEY);
  expect(raw).not.toContain(originalBody.prompt);
  const saved = readRecovery();
  expect(saved).toMatchObject({ source: 'shared', delivered: [] });
  expect(saved.accepted.jobs).toHaveLength(2);
  let done = applyGroupStatus(group, groups.partial).group;
  done = markDelivered(done, '10000000-0000-4000-8000-000000000001');
  saveRecovery(done, 'shared');
  expect(sessionStorage.getItem(RECOVERY_KEY)).toBeNull();
  sessionStorage.setItem(RECOVERY_KEY, '{"id":1}');
  expect(readRecovery()).toBeNull();
});

test('a group reserves one unstored place per image, without evicting', () => {
  const limits = { privateVolatileRecordLimit: 3, privateVolatileMaxBytes: 10 };
  expect(planVolatileSlot({ slots: 1, bytes: 0 }, null, limits, 2).slot).toBe(
    true,
  );
  expect(planVolatileSlot({ slots: 2, bytes: 0 }, null, limits, 2)).toEqual({
    slot: false,
    reason: 'no-slot',
  });
  expect(planVolatileSlot({ slots: 2, bytes: 0 }, null, limits).slot).toBe(
    true,
  );
});
