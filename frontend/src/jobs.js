import { diagnosticOf, jobDiagnostic } from './diagnostics.js';
/**
 * Generation job state machine and polling. A job is accepted once and then
 * only observed: this module never resubmits accepted work.
 *
 * Stream events and polled status history share one reducer (`applyEvent`), so
 * both transports reach the same state and replayed events change nothing.
 */

import { DEFAULT_CLIENT_POLICY } from './clientPolicy.js';

export const PHASE = {
  /** Fetching or reusing prompt-specific controls before submitting. */
  preparing: 'preparing',
  /** Request sent; no job id yet. */
  sending: 'sending',
  accepted: 'accepted',
  running: 'running',
  preview: 'preview',
  complete: 'complete',
  failed: 'failed',
  /** Polling gave up. The job may still finish; it is not a failure. */
  lost: 'lost',
};

/** Wire names of the job events (the same in the stream and in status history). */
export const JOB_EVENT = {
  progress: 'progress',
  /** A provisional image before the job completes. */
  preview: 'image-ready',
  complete: 'complete',
  failed: 'failed',
};

export const jobPolicy = {
  pollIntervalMs: DEFAULT_CLIENT_POLICY.transport.jobPollIntervalMs,
  maxConsecutivePollFailures:
    DEFAULT_CLIENT_POLICY.transport.jobPollMaxFailures,
};

/** The job policy implied by a normalized client policy. */
export const jobPolicyFrom = (clientPolicy) => ({
  pollIntervalMs: clientPolicy.transport.jobPollIntervalMs,
  maxConsecutivePollFailures: clientPolicy.transport.jobPollMaxFailures,
});

// The backend retains at most 64 job events for replay and polling.
const MAX_RETAINED_JOB_EVENTS = 64;
const KNOWN_EVENTS = new Set(Object.values(JOB_EVENT));
const TERMINAL = new Set([PHASE.complete, PHASE.failed]);
export const isTerminal = (job) => TERMINAL.has(job?.phase);
export const isActive = (job) =>
  Boolean(job) && !TERMINAL.has(job.phase) && job.phase !== PHASE.lost;

export const newJob = (phase, id = null) => ({
  id,
  phase,
  stage: null,
  enrichment: null,
  preview: null,
  result: null,
  error: null,
  details: null,
});
export const acceptedJob = (id) => newJob(PHASE.accepted, id);

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** `job` itself when nothing changed, so replayed events cause no update. */
const changed = (job, patch) => {
  const next = { ...job, ...patch };
  return Object.keys(patch).every((key) => sameJson(job[key], next[key]))
    ? job
    : next;
};

/**
 * Fold one job event into the job. Terminal states are final; a repeated or
 * late event changes nothing; progress never moves a job back from preview.
 * @param {object} job
 * @param {{event: string, data: object}} event
 */
export function applyEvent(job, event) {
  if (isTerminal(job) || !KNOWN_EVENTS.has(event?.event)) return job;
  const signature = JSON.stringify(event);
  const previous = job.eventSignatures ?? [];
  if (previous.includes(signature)) return job;
  const next = reduceEvent(job, event);
  return {
    ...next,
    eventSignatures: [...previous, signature].slice(-MAX_RETAINED_JOB_EVENTS),
  };
}

function reduceEvent(job, event) {
  const data = event.data;
  switch (event.event) {
    case JOB_EVENT.progress:
      return changed(job, {
        phase: job.preview ? PHASE.preview : PHASE.running,
        stage: typeof data?.message === 'string' ? data.message : job.stage,
        enrichment: data?.enrichment ?? job.enrichment,
      });
    case JOB_EVENT.preview:
      return data?.image_url
        ? changed(job, { phase: PHASE.preview, preview: data })
        : job;
    case JOB_EVENT.complete:
      return data && typeof data === 'object' && !data.error
        ? { ...job, phase: PHASE.complete, result: data }
        : fail(job, job.preview, 'The job finished without an image.', data);
    case JOB_EVENT.failed:
      return fail(
        job,
        job.preview,
        typeof data?.error === 'string' ? data.error : 'Generation failed.',
        data,
      );
    default:
      return job;
  }
}

/**
 * Fold a job status response (its accumulated events, then its authoritative
 * state) into the job. Replays and late responses cannot reopen a terminal job.
 */
export function applyStatus(job, status) {
  if (isTerminal(job)) return job;
  const history = status?.events?.length
    ? status.events
    : status?.latest_event
      ? [status.latest_event]
      : [];
  const outcome = status?.status === 'complete' || status?.status === 'failed';
  // An outcome stated by the status itself is authoritative; its history
  // supplies the progress and previews that led to it.
  const events = outcome
    ? history.filter(
        (e) => e?.event !== JOB_EVENT.complete && e?.event !== JOB_EVENT.failed,
      )
    : history;
  const folded = events.reduce((state, event) => applyEvent(state, event), job);
  // A replayed history passes through its early stages again; only the end counts.
  const next = sameJson(folded, job) ? job : folded;
  if (isTerminal(next)) return next;
  if (status?.status === 'complete') {
    return status.result
      ? { ...next, phase: PHASE.complete, result: status.result }
      : fail(next, next.preview, 'The job finished without an image.', status);
  }
  if (status?.status === 'failed') {
    return fail(
      next,
      next.preview,
      status.result?.error ??
        status.latest_event?.data?.error ??
        'Generation failed.',
      status,
    );
  }
  return next.phase === PHASE.accepted || next.phase === PHASE.sending
    ? { ...next, phase: PHASE.running }
    : next;
}

const fail = (job, preview, error, record = null) => ({
  ...job,
  phase: PHASE.failed,
  preview,
  error,
  diagnostic: jobDiagnostic({ jobId: job.id, record, reason: error }),
});

const lose = (job, message) => ({ ...job, phase: PHASE.lost, error: message });

/** A preview that preceded a failure is kept for context; the job is still failed. */
export const failedAfterPreview = (job) =>
  job?.phase === PHASE.failed && Boolean(job.preview);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll until the job is terminal, tracking is lost, or `isCurrent()` turns false.
 * @param {object} options
 * @param {object} options.job accepted job
 * @param {(id: string) => Promise<object>} options.fetchStatus
 * @param {(job: object) => void} options.onUpdate called on every change
 * @param {() => boolean} options.isCurrent false once the view no longer tracks this job
 */
export async function trackJob({
  job,
  fetchStatus,
  onUpdate,
  isCurrent,
  wait = sleep,
  policy = jobPolicy,
}) {
  let state = job;
  let failures = 0;
  while (isCurrent()) {
    try {
      const next = applyStatus(state, await fetchStatus(state.id));
      failures = 0;
      if (!isCurrent()) return state;
      if (next !== state) {
        state = next;
        onUpdate(state);
      }
      if (isTerminal(state)) return state;
    } catch (error) {
      if (!isCurrent()) return state;
      if (error?.status === 404) {
        state = {
          ...fail(state, state.preview, 'The generation job was not found.'),
          diagnostic: diagnosticOf(error),
        };
        onUpdate(state);
        return state;
      }
      failures += 1;
      if (failures >= policy.maxConsecutivePollFailures) {
        state = lose(
          state,
          `Lost contact with the job: ${error.message} It may still finish; check the saved images.`,
        );
        state = { ...state, diagnostic: diagnosticOf(error) };
        onUpdate(state);
        return state;
      }
    }
    await wait(policy.pollIntervalMs);
  }
  return state;
}
