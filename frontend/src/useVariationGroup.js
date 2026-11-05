import { preserveError } from './diagnostics.js';
/**
 * Follows the current variation group and sends its one explicit kind of new
 * work: a retry of failed slots with the original frozen request.
 *
 * Status comes only from the group status endpoint (GET); following, resuming
 * and recovery after a reload never create work. The owner (the studio)
 * decides what a delivered result means for history and selection.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { api, newKey } from './api.js';
import { PHASE } from './jobs.js';
import { providerRequest } from './providerSettings.js';
import { buildEditForm } from './references.js';
import {
  adoptJobs,
  applyGroupStatus,
  canRetry,
  createGroup,
  groupActive,
  groupJob,
  groupStatusUrl,
  isGroupJob,
  markDelivered,
  parseAcceptedGroup,
  patchGroup,
  readRecovery,
  retryBody,
  saveRecovery,
  summarize,
} from './variationGroups.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const NOT_FOUND = 'The variation group was not found.';

const sameIndices = (a, b) =>
  a.length === b.length && a.every((value, i) => value === b[i]);

/**
 * @param {object} options
 * @param {ReturnType<import('./variationGroups.js').variationCapability>} options.capability
 * @param {{pollIntervalMs: number, maxConsecutivePollFailures: number}} options.policy
 * @param {string|null} options.source the history source results belong to
 * @param {(update: (job: object|null) => object|null) => void} options.setJob
 * @param {object} options.handlers `{observed(job), replaced(list, group),
 *   delivered(record, slot, group) => {selected?: boolean}, settled(group)}`
 * @param {(count: number) => string|null} [options.admission] why `count` new
 *   results cannot be kept here, checked before a retry is sent
 * @param {(ms: number) => Promise<void>} [options.wait]
 */
export function useVariationGroup({
  capability,
  policy,
  source,
  setJob,
  handlers,
  admission,
  wait = sleep,
}) {
  const [group, setGroup] = useState(null);
  const [retryState, setRetryState] = useState({ busy: false, error: null });
  const ref = useRef(null);
  /** The state last published, which can lag `ref` until status arrives. */
  const shown = useRef(null);
  const run = useRef(0);
  const mounted = useRef(true);
  const latest = useRef({ handlers, admission, policy, source, capability });
  useEffect(() => {
    latest.current = { handlers, admission, policy, source, capability };
  });

  /** Publish a new group state; the generator's job follows its own group. */
  const commit = useCallback(
    (next, { own = false } = {}) => {
      ref.current = next;
      shown.current = next;
      setGroup(next);
      saveRecovery(next, latest.current.source);
      if (next.recovered) return;
      const job = groupJob(next);
      setJob((shown) => (own || isGroupJob(shown, next.id) ? job : shown));
    },
    [setJob],
  );

  /** Hand finished results over once each, oldest index first. */
  const deliver = useCallback((current) => {
    let next = current;
    for (const slot of current.slots) {
      if (slot.job?.phase !== PHASE.complete) continue;
      if (next.delivered.includes(slot.jobId)) continue;
      const outcome = latest.current.handlers.delivered(
        slot.job.result,
        slot,
        next,
      );
      next = markDelivered(next, slot.jobId);
      if (outcome?.selected) next = patchGroup(next, { selected: true });
    }
    return next;
  }, []);

  /** Poll the group until every child settled, status is lost, or superseded. */
  const follow = useCallback(
    async (start) => {
      const token = ++run.current;
      const current = () =>
        mounted.current &&
        run.current === token &&
        ref.current?.id === start.id;
      let failures = 0;
      while (current()) {
        const { policy: limits, handlers: on } = latest.current;
        try {
          const status = await api.generationGroup(
            groupStatusUrl(ref.current.statusUrl, ref.current.id),
          );
          if (!current()) return ref.current;
          failures = 0;
          const applied = applyGroupStatus(ref.current, status);
          let next = applied.group;
          if (applied.replaced.length) on.replaced(applied.replaced, next);
          if (!next.recovered)
            next.slots.forEach((slot) => slot.job && on.observed(slot.job));
          next = deliver(next);
          if (next !== shown.current) commit(next);
          if (!groupActive(next)) {
            on.settled(next);
            return next;
          }
        } catch (error) {
          if (!current()) return ref.current;
          if (error?.status === 404) {
            const next = patchGroup(ref.current, {
              lost: NOT_FOUND,
              lostDiagnostic: preserveError(error).diagnostic,
            });
            commit(next);
            on.settled(next);
            return next;
          }
          failures += 1;
          if (failures >= limits.maxConsecutivePollFailures) {
            const next = patchGroup(ref.current, {
              lost: `Lost contact with the variations: ${error.message} They may still finish; check the saved images.`,
              lostDiagnostic: preserveError(error).diagnostic,
            });
            commit(next);
            on.settled(next);
            return next;
          }
        }
        await wait(limits.pollIntervalMs);
      }
      return ref.current;
    },
    [commit, deliver, wait],
  );

  /**
   * Start following a newly accepted group. `frozen` is the exact original
   * request (`{body, files, providerHeader}`), kept for a retry of failed
   * slots. Resolves with the group once it settles or status is lost.
   */
  const start = useCallback(
    (accepted, frozen, extra = {}) => {
      const parsed = parseAcceptedGroup(accepted);
      if (!parsed) return null;
      const next = patchGroup(
        createGroup({
          accepted: parsed,
          frozen,
          statusUrl: latest.current.capability?.statusUrl,
        }),
        extra,
      );
      setRetryState({ busy: false, error: null });
      commit(next, { own: true });
      return follow(next);
    },
    [commit, follow],
  );

  /**
   * Retry exactly the failed slots with the original request. A retry whose
   * answer was lost keeps its key, so sending it again cannot start the same
   * slots twice; status is checked once in case the server accepted it.
   */
  const retry = useCallback(async () => {
    const current = ref.current;
    if (!canRetry(current, latest.current.capability)) return null;
    const indices = summarize(current).failedIndices;
    const refused = latest.current.admission?.(indices.length) ?? null;
    if (refused) {
      setRetryState({ busy: false, error: { text: refused } });
      return null;
    }
    const frozenRetry =
      current.retry && sameIndices(current.retry.indices, indices)
        ? current.retry
        : { key: newKey(), indices };
    let working = patchGroup(current, { retry: frozenRetry });
    commit(working);
    setRetryState({ busy: true, error: null });
    const { frozen } = working;
    let accepted;
    try {
      const body = retryBody(frozen.body, working.id, indices, frozenRetry.key);
      accepted = await api.generateImage(
        frozen.files ? buildEditForm(body, frozen.files) : body,
        providerRequest(frozen.providerHeader),
      );
    } catch (error) {
      if (ref.current?.id !== working.id) return null;
      if (!error.network) commit(patchGroup(ref.current, { retry: null }));
      setRetryState({
        busy: false,
        error: {
          text:
            error.status === 429
              ? `The queue has no room for ${indices.length} more ${
                  indices.length === 1 ? 'image' : 'images'
                } now. Nothing was started.`
              : error.network
                ? `${error.message} Retry sends the same request again.`
                : error.message,
          details: error.details ?? null,
          diagnostic: preserveError(error).diagnostic,
        },
      });
      // The server may have accepted it before the answer was lost.
      if (error.network) return follow(ref.current);
      return null;
    }
    if (ref.current?.id !== working.id) return null;
    const parsed = parseAcceptedGroup(accepted);
    working = patchGroup(ref.current, { retry: null });
    if (!parsed || parsed.id !== working.id) {
      commit(working);
      setRetryState({
        busy: false,
        error: { text: 'The API did not return the retried variations.' },
      });
      return follow(working);
    }
    const adopted = adoptJobs(working, parsed.jobs);
    latest.current.handlers.replaced(adopted.replaced, adopted.group);
    setRetryState({ busy: false, error: null });
    commit(adopted.group, { own: true });
    return follow(adopted.group);
  }, [commit, follow]);

  /** Check again after status was lost. Never resubmits. */
  const resume = useCallback(() => {
    const current = ref.current;
    if (!current?.lost) return null;
    const next = patchGroup(current, { lost: null });
    commit(next, { own: !next.recovered });
    return follow(next);
  }, [commit, follow]);

  const dismissRetryError = useCallback(
    () => setRetryState((state) => ({ ...state, error: null })),
    [],
  );

  // A reload in the middle of a group keeps following what was accepted, for
  // the same history source only. It has no frozen request, so no retry.
  const recoveredOnce = useRef(false);
  useEffect(() => {
    if (recoveredOnce.current || !capability || !source) return;
    recoveredOnce.current = true;
    const saved = readRecovery();
    if (!saved || ref.current) return;
    if (saved.source !== source) return;
    let next = createGroup({
      accepted: saved.accepted,
      frozen: null,
      statusUrl: saved.statusUrl,
    });
    next = patchGroup(next, {
      recovered: true,
      selected: true,
      delivered: Object.freeze([...saved.delivered]),
    });
    // Shown once its first status answer arrives.
    ref.current = next;
    follow(next);
  }, [capability, source, follow]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      run.current += 1;
    };
  }, []);

  return {
    group,
    start,
    retry,
    resume,
    retrying: retryState.busy,
    retryError: retryState.error,
    dismissRetryError,
  };
}
