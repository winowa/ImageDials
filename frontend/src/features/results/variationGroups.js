/**
 * Pure state of one explicitly requested group of 2–4 image variations.
 *
 * A group is accepted once (all children or none). Its children are then only
 * observed, through the group status endpoint, with the same job reducer as a
 * single job. Recovering status never creates work: the only way to start more
 * is an explicit retry of failed slots, which sends the original frozen request
 * with a new key and the exact failed indices. Completed siblings are never
 * changed.
 */
import {
  acceptedJob,
  applyStatus,
  isActive,
  newJob,
  PHASE,
} from '../../data/api/jobs.js';

export const MAX_VARIATIONS = 4;
export const DEFAULT_VARIATIONS = 1;

export const GROUP_STATUS = Object.freeze({
  running: 'running',
  complete: 'complete',
  partial: 'partial',
  failed: 'failed',
});

const DEFAULT_STATUS_URL = '/api/generation-groups/{group_id}';

/**
 * The server's variation support, or null when it offers none. Only an
 * explicit `enabled: true` with a bounded maximum of at least two counts; an
 * older server without the capability keeps the single-image request.
 */
export function variationCapability(capabilities) {
  const v = capabilities?.variations;
  if (!v || v.enabled !== true) return null;
  const max = Number.isInteger(v.max_count)
    ? Math.min(v.max_count, MAX_VARIATIONS)
    : 0;
  if (max < 2) return null;
  // The browser only follows relative API paths.
  const template =
    typeof v.status_url === 'string' &&
    v.status_url.startsWith('/') &&
    !v.status_url.startsWith('//') &&
    v.status_url.includes('{group_id}')
      ? v.status_url
      : DEFAULT_STATUS_URL;
  return {
    max,
    retryFailed: v.retry === 'failed-only',
    statusUrl: template,
  };
}

export const groupStatusUrl = (template, id) =>
  (template ?? DEFAULT_STATUS_URL).replace(
    '{group_id}',
    encodeURIComponent(id),
  );

/** A count the server can accept now: 1 without the capability. */
export function allowedCount(count, capability) {
  if (!capability) return DEFAULT_VARIATIONS;
  const n = Number.isInteger(count) ? count : DEFAULT_VARIATIONS;
  return Math.max(1, Math.min(n, capability.max));
}

const isIndex = (value, count) =>
  Number.isInteger(value) && value >= 0 && value < count;

/**
 * The validated `variation_group` of an acceptance, or null when the answer
 * carries none (a single job) or is malformed.
 * @returns {{id: string, count: number, jobs: Array<{jobId: string, index: number, attempt: number}>}|null}
 */
export function parseAcceptedGroup(accepted) {
  const g = accepted?.variation_group;
  if (!g || typeof g.id !== 'string' || !g.id) return null;
  if (!Number.isInteger(g.count) || g.count < 2 || g.count > MAX_VARIATIONS)
    return null;
  if (!Array.isArray(g.jobs) || !g.jobs.length) return null;
  const jobs = [];
  const seenIds = new Set();
  for (const job of g.jobs) {
    if (
      typeof job?.generation_job_id !== 'string' ||
      !job.generation_job_id ||
      seenIds.has(job.generation_job_id) ||
      !isIndex(job.index, g.count) ||
      !Number.isInteger(job.attempt) ||
      job.attempt < 0 ||
      jobs.some((seen) => seen.index === job.index)
    )
      return null;
    seenIds.add(job.generation_job_id);
    jobs.push({
      jobId: job.generation_job_id,
      index: job.index,
      attempt: job.attempt,
    });
  }
  // A first acceptance must describe every reserved slot. Retry acceptances
  // intentionally contain only the failed subset and carry later attempts.
  if (
    jobs.every((job) => job.attempt === 0) &&
    (jobs.length !== g.count || jobs.some((job, index) => job.index !== index))
  )
    return null;
  if (
    typeof accepted.generation_job_id === 'string' &&
    !jobs.some((job) => job.jobId === accepted.generation_job_id)
  )
    return null;
  return { id: g.id, count: g.count, jobs };
}

const slotOf = ({ jobId, index, attempt }) =>
  Object.freeze({ index, jobId, attempt, job: acceptedJob(jobId) });

const emptySlot = (index) =>
  Object.freeze({ index, jobId: null, attempt: -1, job: null });

/**
 * A new group from its accepted children.
 * @param {object} options
 * @param {ReturnType<typeof parseAcceptedGroup>} options.accepted
 * @param {object|null} options.frozen the original request: `{body, files,
 *   providerHeader}`; null when it is not available (after a reload), which
 *   leaves failed slots without a retry.
 * @param {string} [options.statusUrl] status URL template
 */
export function createGroup({ accepted, frozen = null, statusUrl }) {
  return Object.freeze({
    id: accepted.id,
    count: accepted.count,
    slots: Object.freeze(
      Array.from({ length: accepted.count }, (_, index) => {
        const job = accepted.jobs.find((j) => j.index === index);
        return job ? slotOf(job) : emptySlot(index);
      }),
    ),
    frozen,
    statusUrl: statusUrl ?? DEFAULT_STATUS_URL,
    /** A retry whose answer was lost: `{key, indices}`, sent again as is. */
    retry: null,
    /** Why status is unavailable; the children may still finish. */
    lost: null,
    /** Job ids whose results were already delivered to history. */
    delivered: Object.freeze([]),
    /** The stage has moved to one of this group's results once already. */
    selected: false,
  });
}

const withSlots = (group, slots) =>
  Object.freeze({ ...group, slots: Object.freeze(slots) });

/**
 * Take newer children (an accepted retry, or a later attempt found by
 * polling). An older or equal attempt never replaces what is known.
 * @returns {{group: object, replaced: Array<{index: number, previous: string|null, jobId: string}>}}
 */
export function adoptJobs(group, jobs) {
  const replaced = [];
  const slots = group.slots.map((slot) => {
    const next = jobs.find((j) => j.index === slot.index);
    if (!next || next.attempt <= slot.attempt || next.jobId === slot.jobId)
      return slot;
    replaced.push({
      index: slot.index,
      previous: slot.jobId,
      jobId: next.jobId,
    });
    return slotOf(next);
  });
  return { group: replaced.length ? withSlots(group, slots) : group, replaced };
}

/**
 * Fold one group status answer into the group. Each slot's latest canonical
 * job status goes through the single-job reducer; a later attempt the status
 * names is adopted (it was accepted by an earlier retry). An answer for
 * another group, or a stale earlier attempt, changes nothing.
 * @returns {{group: object, replaced: Array<object>}}
 */
export function applyGroupStatus(group, status) {
  if (status?.generation_group_id !== group.id || !Array.isArray(status.jobs))
    return { group, replaced: [] };
  const newer = status.jobs
    .filter(
      (j) =>
        isIndex(j?.index, group.count) &&
        typeof j.generation_job_id === 'string' &&
        Number.isInteger(j.attempt),
    )
    .map((j) => ({
      jobId: j.generation_job_id,
      index: j.index,
      attempt: j.attempt,
    }));
  const adopted = adoptJobs(group, newer);
  let changed = adopted.group !== group;
  const slots = adopted.group.slots.map((slot) => {
    const answer = status.jobs.find(
      (j) => j?.index === slot.index && j.generation_job_id === slot.jobId,
    );
    if (!answer || !slot.job) return slot;
    const job = applyStatus(slot.job, answer);
    if (job === slot.job) return slot;
    changed = true;
    return Object.freeze({ ...slot, job });
  });
  return {
    group: changed ? withSlots(adopted.group, slots) : group,
    replaced: adopted.replaced,
  };
}

/** Replace one slot's job state (a status answer for a single child). */
export function updateSlot(group, jobId, job) {
  const at = group.slots.findIndex((s) => s.jobId === jobId);
  if (at < 0 || group.slots[at].job === job) return group;
  const slots = [...group.slots];
  slots[at] = Object.freeze({ ...slots[at], job });
  return withSlots(group, slots);
}

export const markDelivered = (group, jobId) =>
  group.delivered.includes(jobId)
    ? group
    : Object.freeze({
        ...group,
        delivered: Object.freeze([...group.delivered, jobId]),
      });

export const patchGroup = (group, patch) =>
  Object.freeze({ ...group, ...patch });

/**
 * Counts and state of the group as it stands.
 * @returns {{status: string, total: number, complete: number, failed: number,
 *   active: number, lead: object|null, failedIndices: number[]}}
 */
export function summarize(group) {
  let complete = 0;
  let failed = 0;
  let active = 0;
  let lead = null;
  const failedIndices = [];
  for (const slot of group.slots) {
    const phase = slot.job?.phase;
    if (phase === PHASE.complete) complete += 1;
    else if (phase === PHASE.failed) {
      failed += 1;
      failedIndices.push(slot.index);
    } else if (slot.job) {
      active += 1;
      // Serial execution: the lowest active index is the one being made.
      if (!lead) lead = slot;
    }
  }
  const status = active
    ? GROUP_STATUS.running
    : complete === group.count
      ? GROUP_STATUS.complete
      : failed === group.count
        ? GROUP_STATUS.failed
        : GROUP_STATUS.partial;
  return {
    status,
    total: group.count,
    complete,
    failed,
    active,
    lead,
    failedIndices,
  };
}

/** Whether an explicit retry of the failed slots can be offered now. */
export const canRetry = (group, capability) => {
  if (!group?.frozen || !capability?.retryFailed || group.lost) return false;
  const s = summarize(group);
  return s.active === 0 && s.failed > 0;
};

/**
 * The retry request: the original frozen body unchanged apart from the new
 * key, the number of slots retried and which ones.
 */
export function retryBody(frozenBody, groupId, indices, key) {
  const sorted = [...indices].sort((a, b) => a - b);
  return {
    ...frozenBody,
    idempotency_key: key,
    variation_count: sorted.length,
    retry_variations: { group_id: groupId, indices: sorted },
  };
}

/**
 * The job the rest of the generator sees for this group: active while any
 * child is, carrying the child being made (its stage, and its preview while
 * nothing else is shown), and settled once every child is.
 */
export function groupJob(group) {
  const s = summarize(group);
  const meta = Object.freeze({
    id: group.id,
    count: group.count,
    complete: s.complete,
    failed: s.failed,
    active: s.active,
    status: s.status,
    index: s.lead?.index ?? null,
  });
  const anyId = group.slots.find((slot) => slot.jobId)?.jobId ?? null;
  if (group.lost)
    return {
      ...newJob(PHASE.lost, s.lead?.jobId ?? anyId),
      error: group.lost,
      group: meta,
    };
  if (s.lead) {
    const job = s.lead.job;
    return {
      ...job,
      phase: job.phase === PHASE.accepted ? PHASE.running : job.phase,
      group: meta,
    };
  }
  if (s.status === GROUP_STATUS.failed) {
    const first = group.slots.find((slot) => slot.job?.error);
    return {
      ...newJob(PHASE.failed, anyId),
      error: first?.job.error ?? 'Generation failed.',
      group: meta,
    };
  }
  return { ...newJob(PHASE.complete, anyId), group: meta };
}

/** Whether a job state is this group's own. */
export const isGroupJob = (job, groupId) =>
  Boolean(job?.group) && (!groupId || job.group.id === groupId);

export const groupActive = (group) =>
  Boolean(group) && !group.lost && group.slots.some((s) => isActive(s.job));

/** One concise line of the group's state. */
export function groupStatusText(group) {
  const s = summarize(group);
  if (group.lost)
    return `${s.complete} of ${s.total} ready · status unavailable`;
  if (s.status === GROUP_STATUS.running)
    return `Image ${s.lead.index + 1} of ${s.total}${
      s.complete ? ` · ${s.complete} ready` : ''
    }`;
  if (s.status === GROUP_STATUS.complete)
    return `${s.total} of ${s.total} ready`;
  if (s.status === GROUP_STATUS.failed) return `All ${s.total} failed`;
  return `${s.complete} of ${s.total} ready · ${s.failed} failed`;
}

// --- Recovery after a reload ------------------------------------------------

/** Tab-scoped: holds only server-issued ids, never prompts or bytes. */
export const RECOVERY_KEY = 'imagedials.variation-group.v1';

const storage = () => {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
};

/** Remember an unfinished group so a reload can keep following it. */
export function saveRecovery(group, source) {
  const store = storage();
  if (!store) return;
  try {
    const s = summarize(group);
    const pending = group.slots.some(
      (slot) =>
        slot.jobId &&
        (isActive(slot.job) ||
          group.lost ||
          (slot.job?.phase === PHASE.complete &&
            !group.delivered.includes(slot.jobId))),
    );
    if (!pending && s.active === 0) {
      store.removeItem(RECOVERY_KEY);
      return;
    }
    store.setItem(
      RECOVERY_KEY,
      JSON.stringify({
        id: group.id,
        count: group.count,
        source,
        statusUrl: group.statusUrl,
        jobs: group.slots
          .filter((slot) => slot.jobId)
          .map(({ jobId, index, attempt }) => ({ jobId, index, attempt })),
        delivered: group.delivered,
      }),
    );
  } catch {
    /* Storage refused: recovery is a convenience, not a requirement. */
  }
}

export function clearRecovery(groupId) {
  const store = storage();
  if (!store) return;
  try {
    const saved = JSON.parse(store.getItem(RECOVERY_KEY) ?? 'null');
    if (!groupId || saved?.id === groupId) store.removeItem(RECOVERY_KEY);
  } catch {
    store.removeItem(RECOVERY_KEY);
  }
}

/** The remembered group, validated, or null. */
export function readRecovery() {
  const store = storage();
  if (!store) return null;
  try {
    const saved = JSON.parse(store.getItem(RECOVERY_KEY) ?? 'null');
    const accepted = parseAcceptedGroup({
      variation_group: {
        id: saved?.id,
        count: saved?.count,
        jobs: (saved?.jobs ?? []).map((j) => ({
          generation_job_id: j?.jobId,
          index: j?.index,
          attempt: j?.attempt,
        })),
      },
    });
    if (!accepted) return null;
    return {
      accepted,
      source: typeof saved.source === 'string' ? saved.source : null,
      statusUrl:
        typeof saved.statusUrl === 'string' && saved.statusUrl.startsWith('/')
          ? saved.statusUrl
          : DEFAULT_STATUS_URL,
      delivered: Array.isArray(saved.delivered)
        ? saved.delivered.filter((id) => typeof id === 'string')
        : [],
    };
  } catch {
    return null;
  }
}
