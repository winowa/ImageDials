/**
 * Ordered image references for the Create draft.
 *
 * - Files stay in memory as Blobs with reference-counted object URLs. Nothing
 *   here writes to LocalStorage, the library or saved metadata.
 * - Each reference is hashed from the exact model bytes and prepared serially.
 *   Accessibility descriptions never become edit proposals. The final set of
 *   at least two images supplies ordered pixels for one joint visual proposal.
 * - A prompt proposal is applied only for the current reference set and draft
 *   revision. If the prompt was edited meanwhile it is offered instead; either
 *   way the previous prompt can be restored.
 * - Sources attached in this tab are remembered by hash, so a saved edit can
 *   be reopened with its exact bytes. Originals the person chose to keep in
 *   this browser are looked up by hash, then saved images used as references
 *   are read again by identity. Anything else must be attached again. None of
 *   this describes, proposes or generates.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api, newKey } from './api.js';
import { localDiagnostic, preserveError, redactText } from './diagnostics.js';
import {
  adaptReference,
  prepareReference,
  pixelLimitFailure,
  referenceByteBudget,
} from './referenceUpload.js';
import { providerRequest } from './providerSettings.js';
import { keptFile } from './retainedReferences.js';
import { sha256Hex } from './privateThumbnail.js';
import {
  checkReferenceFile,
  REF_STATUS,
  referenceContext,
  referenceSignature,
  savedIdentityOf,
  shortName,
} from './references.js';

const aborted = (error) => error?.name === 'AbortError';

const GENERATION_MODE = { image: 'standard', 'asset-image': 'trellis' };

export const SOURCE_MEMORY_MAX_BYTES = 256 * 1024 * 1024;

/** Bound detached source recovery without releasing any attached file. */
export function trimSourceMemory(store, refs) {
  const blobsOf = (item) => [item?.blob, item?.original?.blob].filter(Boolean);
  const pinned = new Set(refs.flatMap(blobsOf));
  const bytes = () =>
    [...new Set([...store.values()].flatMap(blobsOf))].reduce(
      (total, blob) => total + blob.size,
      0,
    );
  if (bytes() <= SOURCE_MEMORY_MAX_BYTES) return;
  for (const [key, item] of store) {
    if (blobsOf(item).some((blob) => pinned.has(blob))) continue;
    store.delete(key);
    if (bytes() <= SOURCE_MEMORY_MAX_BYTES) break;
  }
}

/** The prompt-suggestion warning in an analysis or retry answer, or null. */
const promptWarning = (response) => {
  const found = Array.isArray(response?.warnings)
    ? response.warnings.find(
        (item) => item?.code === 'prompt_suggestion_unavailable',
      )
    : null;
  if (!found) return null;
  return {
    message:
      typeof found.message === 'string' && found.message
        ? redactText(found.message)
        : 'No prompt suggestion was made. The image is ready to use.',
    detail: typeof found.detail === 'string' ? redactText(found.detail) : '',
  };
};

/**
 * @param {object} options
 * @param {ReturnType<import('./objectUrls.js').createUrlLedger>} options.urls
 * @param {ReturnType<import('./references.js').editingCapability>} options.capability
 * @param {object} [options.uploads] capabilities.uploads
 * @param {() => {prompt: string, mode: string, revision: number}} options.getDraft
 * @param {(prompt: string) => void} options.setPrompt places a proposal
 * @param {() => string|null} options.getProviderHeader
 * @param {(identity: string, options: {signal: AbortSignal}) => Promise<Blob|null>} [options.readSaved]
 * @param {((sha256: string, options: {signal: AbortSignal}) => Promise<{blob: Blob}|null>)|null} [options.readRetained]
 *   one kept original by checksum; read only when a restored slot needs it
 * @param {(blob: Blob) => Promise<string|null>} [options.digest]
 * @param {string|null} [options.providerScope] the selected provider's header,
 *   so a warning from another provider is not shown
 *
 * Draft access may instead be supplied later with `bind`, from an effect.
 * `bind` may also supply `onTransaction(label)`, called just before a
 * person's own change to the list or a proposal is committed, so the owner
 * can record the draft for undo. Restores, recovery and analysis never call it.
 */
export function useReferences({
  urls,
  capability,
  uploads,
  getDraft,
  setPrompt,
  getProviderHeader,
  readSaved = null,
  readRetained = null,
  digest = sha256Hex,
  providerScope = null,
}) {
  const [refs, setRefs] = useState([]);
  const [proposal, setProposal] = useState(null);
  const proposalRef = useRef(null);
  const showProposal = useCallback((next) => {
    proposalRef.current = next;
    setProposal(next);
  }, []);
  const [problem, setProblemValue] = useState(null);
  const [problemDiagnostic, setProblemDiagnostic] = useState(null);
  const setProblem = useCallback((message) => {
    setProblemValue(message);
    setProblemDiagnostic(
      message
        ? localDiagnostic({
            category: 'reference-validation',
            reason: message,
          })
        : null,
    );
  }, []);
  /**
   * The optional prompt suggestion failed for the current reference set. The
   * references stay usable; this only offers a retry of the suggestion.
   */
  const [promptNotice, setPromptNotice] = useState(null);
  const noticeRef = useRef(null);
  const noticeRun = useRef(null);
  const showNotice = useCallback((next) => {
    noticeRef.current = next;
    setPromptNotice(next);
  }, []);
  /** Forget the warning and stop a retry that is still waiting. */
  const dropNotice = useCallback(() => {
    noticeRun.current?.abort();
    noticeRun.current = null;
    showNotice(null);
  }, [showNotice]);
  const live = useRef([]);
  const additionEpoch = useRef(0);
  const queue = useRef(Promise.resolve());
  const runs = useRef(new Map());
  const memory = useRef(new Map());
  const alive = useRef(true);
  const options = useRef({});
  const bound = useRef({});
  useEffect(() => {
    options.current = {
      getDraft,
      setPrompt,
      getProviderHeader,
      readSaved,
      readRetained,
      ...bound.current,
      capability,
      uploads,
      digest,
    };
  });
  /** Supply draft access from the owner's effect (it reads the owner's refs). */
  const bind = useCallback((access) => {
    bound.current = access;
    options.current = { ...options.current, ...access };
  }, []);
  const transaction = useCallback((label) => {
    options.current.onTransaction?.(label);
  }, []);

  useEffect(() => {
    alive.current = true;
    const pending = runs.current;
    return () => {
      alive.current = false;
      pending.forEach((controller) => controller.abort());
      noticeRun.current?.abort();
    };
  }, []);

  const commit = useCallback((change) => {
    const next = change(live.current);
    live.current = next;
    trimSourceMemory(memory.current, next);
    options.current.onChange?.(next);
    setRefs(next);
    return next;
  }, []);

  const patch = useCallback(
    (id, fields) =>
      commit((list) =>
        list.map((ref) => (ref.id === id ? { ...ref, ...fields } : ref)),
      ),
    [commit],
  );

  /** Remember exact bytes in a bounded recovery cache; live files stay held. */
  const remember = useCallback((sha, source) => {
    if (!sha || !source?.blob) return;
    const store = memory.current;
    store.delete(sha);
    store.set(sha, source);
    trimSourceMemory(store, live.current);
  }, []);

  /**
   * SHA-256 of exact bytes: hashed here when the browser can, otherwise by the
   * server's checksum-only inspection (no description, prompt or model call).
   */
  const checksum = useCallback(async (blob, name, signal) => {
    let local = null;
    try {
      local = await options.current.digest(blob);
    } catch {
      local = null;
    }
    if (local) return local;
    const answer = await api.inspectReference(blob, { name, signal });
    return typeof answer?.source_sha256 === 'string'
      ? answer.source_sha256
      : null;
  }, []);

  const stopRun = useCallback((id) => {
    runs.current.get(id)?.abort();
    runs.current.delete(id);
  }, []);

  /**
   * Place a usable suggestion. It is applied only when the prompt is as it was
   * when the request was made; otherwise it is offered. A first reference
   * never proposes prompt text. Either way the earlier prompt can be
   * restored, and a usable suggestion replaces any warning.
   */
  const deliver = useCallback(
    (suggested, { draft, revision, at, next }) => {
      if (next.length < 2) return;
      showNotice(null);
      const latest = options.current.getDraft();
      if (latest.prompt === suggested) return;
      const signature = referenceSignature(next);
      const untouched =
        latest.revision === draft.revision && revision === draft.revision;
      const shown = {
        text: suggested,
        previous: latest.prompt,
        index: at + 1,
        signature,
        provider: options.current.getProviderHeader?.() ?? null,
      };
      if (untouched) {
        options.current.setPrompt(suggested);
        showProposal({ kind: 'applied', ...shown });
      } else showProposal({ kind: 'offered', ...shown });
    },
    [showNotice, showProposal],
  );

  /** One joint visual request for the final prepared set, never caption-to-prompt. */
  const compose = useCallback(
    async (eligibleDraft = options.current.getDraft()) => {
      const draft = options.current.getDraft();
      const list = live.current;
      if (
        list.length < 2 ||
        !list.every(
          (ref) =>
            ref.blob &&
            ref.sha256 &&
            ref.status === REF_STATUS.ready &&
            !ref.analyzing,
        )
      )
        return;
      const sig = referenceSignature(list);
      const epoch = additionEpoch.current;
      const header = options.current.getProviderHeader?.() ?? null;
      const controller = new AbortController();
      noticeRun.current?.abort();
      noticeRun.current = controller;
      let response = null;
      let failure = null;
      try {
        response = await api.referencePrompt(
          {
            prompt: draft.prompt,
            generation_mode: GENERATION_MODE[draft.mode] ?? 'standard',
            revision: draft.revision,
            reference_images: referenceContext(list).map((item, index) => ({
              ...item,
              sha256: list[index].sha256,
            })),
          },
          {
            references: list,
            ...providerRequest(header),
            signal: controller.signal,
          },
        );
      } catch (error) {
        if (aborted(error)) return;
        failure = error;
      }
      if (
        !alive.current ||
        noticeRun.current !== controller ||
        epoch !== additionEpoch.current ||
        referenceSignature(live.current) !== sig ||
        (options.current.getProviderHeader?.() ?? null) !== header
      )
        return;
      noticeRun.current = null;
      const suggested =
        typeof response?.suggested_prompt === 'string'
          ? response.suggested_prompt.trim()
          : '';
      if (suggested) {
        deliver(suggested, {
          draft: eligibleDraft,
          revision: response.revision,
          at: list.length - 1,
          next: list,
        });
        return;
      }
      const warning = promptWarning(response);
      showNotice({
        message:
          warning?.message ??
          'No prompt suggestion was made. The images are ready to use.',
        detail: failure?.message ?? warning?.detail ?? '',
        failure: failure ? preserveError(failure) : null,
        diagnostic: failure
          ? preserveError(failure).diagnostic
          : localDiagnostic({
              category: 'reference-prompt',
              reason:
                warning?.detail ||
                warning?.message ||
                'No prompt suggestion was made.',
              data: response?.warnings,
            }),
        signature: sig,
        provider: header,
        retrying: false,
        failures: (noticeRef.current?.failures ?? 0) + 1,
      });
    },
    [deliver, showNotice],
  );

  /** Hash the bytes; the server hash from analysis is used where crypto is absent. */
  const hash = useCallback(
    async (id, blob) => {
      try {
        const sha = await options.current.digest(blob);
        if (!alive.current) return;
        const ref = live.current.find((r) => r.id === id);
        if (!ref || ref.blob !== blob) return;
        if (sha) {
          // A digest proves identity, not that the server accepted the file.
          patch(id, {
            sha256: sha,
            status:
              ref.status === REF_STATUS.error
                ? REF_STATUS.error
                : REF_STATUS.ready,
          });
          remember(sha, ref);
        }
      } catch {
        /* Analysis supplies the server's hash of the same bytes. */
      }
    },
    [patch, remember],
  );

  const prepare = useCallback(
    async (id, force = false) => {
      const ref = live.current.find((item) => item.id === id);
      if (!ref?.blob || (ref.prepared && !force)) return true;
      stopRun(id);
      const controller = new AbortController();
      runs.current.set(id, controller);
      patch(id, { converting: true });
      try {
        const original = ref.original?.blob ?? ref.blob;
        const result = force
          ? await adaptReference(original, {
              signal: controller.signal,
              maxNormalizedBytes: referenceByteBudget(
                options.current.capability,
              ),
            })
          : await prepareReference(original, options.current.uploads, {
              signal: controller.signal,
              maxNormalizedBytes: referenceByteBudget(
                options.current.capability,
              ),
            });
        if (!alive.current || runs.current.get(id) !== controller) return false;
        const reason = checkReferenceFile(
          result.blob,
          options.current.capability,
          live.current.filter((item) => item.id !== id),
          options.current.uploads,
        );
        if (reason) throw new Error(reason);
        const changed = result.blob !== ref.blob || !ref.url;
        if (changed && ref.url) urls.release(ref.url);
        const next = {
          ...result,
          ...(force ? { adaptationAttempted: true } : {}),
          prepared: true,
          converting: false,
          ...(result.sha256 ? { status: REF_STATUS.ready } : {}),
          type: result.blob.type,
          size: result.blob.size,
          ...(changed ? { url: urls.acquire(result.blob) } : {}),
        };
        const updated = patch(id, next).find((item) => item.id === id);
        remember(id, updated);
        if (result.sha256) remember(result.sha256, updated);
        if (result.original)
          remember(result.original.sha256, {
            ...result.original,
            name: ref.name,
          });
        return true;
      } catch (error) {
        if (
          !alive.current ||
          runs.current.get(id) !== controller ||
          aborted(error)
        )
          return false;
        patch(id, {
          converting: false,
          status: REF_STATUS.error,
          analysisError:
            preserveError(error).message ||
            'The smaller copy could not be prepared.',
          analysisFailure: {
            ...preserveError(error),
            diagnostic:
              error.diagnostic ??
              localDiagnostic({
                category: 'reference-adaptation',
                reason: 'The model copy could not be prepared.',
                cause: error,
              }),
          },
        });
        return false;
      } finally {
        if (runs.current.get(id) === controller) runs.current.delete(id);
      }
    },
    [patch, remember, stopRun, urls],
  );

  /**
   * Describe one reference. The context is every reference before it and the
   * prompt as it is now; the answer applies only while they are.
   */
  const analyze = useCallback(
    async function analyzeReference(
      id,
      { proposePrompt = true, proposalDraft = null } = {},
    ) {
      const epoch = additionEpoch.current;
      const provider = options.current.getProviderHeader?.() ?? null;
      if (!(await prepare(id))) return;
      const start = live.current;
      const index = start.findIndex((ref) => ref.id === id);
      const ref = start[index];
      if (!alive.current || !ref?.blob) return;
      // Every earlier reference, so the answer's marker index is the slot's.
      const before = start.slice(0, index);
      const sentContext = referenceContext(before);
      const draft = options.current.getDraft();
      const context = {
        prompt: draft.prompt,
        generation_mode: GENERATION_MODE[draft.mode] ?? 'standard',
        revision: draft.revision,
        reference_images: sentContext,
      };
      stopRun(id);
      const controller = new AbortController();
      runs.current.set(id, controller);
      patch(id, {
        analyzing: true,
        analysisError: null,
        analysisFailure: null,
      });
      hash(id, ref.blob);
      let response;
      try {
        response = await api.referenceAnalysis(ref.blob, context, {
          name: ref.name,
          ...providerRequest(options.current.getProviderHeader()),
          signal: controller.signal,
        });
      } catch (error) {
        if (aborted(error) || runs.current.get(id) !== controller) return;
        if (
          pixelLimitFailure(error) &&
          !ref.source &&
          !ref.adaptationAttempted
        ) {
          if (await prepare(id, true))
            return analyzeReference(id, { proposePrompt, proposalDraft });
          return;
        }
        let known = live.current.find((r) => r.id === id);
        let sha = known?.sha256 ?? null;
        // A transient failure (no connection, a server error) says nothing about
        // the file. Where this browser cannot hash, ask the checksum-only
        // inspection so a valid file stays usable instead of being discarded.
        const transient = error.network || error.status >= 500;
        if (!sha && known?.blob && transient) {
          try {
            sha = await checksum(known.blob, known.name, controller.signal);
          } catch (inner) {
            if (aborted(inner)) return;
            sha = null;
          }
          if (runs.current.get(id) !== controller || !alive.current) return;
          known = live.current.find((r) => r.id === id);
          if (!known) return;
        }
        runs.current.delete(id);
        const next = patch(id, {
          analyzing: false,
          analysisError:
            preserveError(error).message || 'The reference could not be read.',
          analysisFailure: preserveError(error),
          status: sha && transient ? REF_STATUS.ready : REF_STATUS.error,
          ...(sha && !known?.sha256 ? { sha256: sha } : {}),
        });
        if (sha && known) remember(sha, known);
        // A caption outage must not prevent joint visual understanding. The
        // composition endpoint validates these exact pixels independently.
        if (
          sha &&
          transient &&
          proposePrompt &&
          next.length > 1 &&
          next.at(-1)?.id === id &&
          epoch === additionEpoch.current &&
          provider === (options.current.getProviderHeader?.() ?? null)
        )
          await compose(proposalDraft ?? draft);
        return;
      }
      if (runs.current.get(id) !== controller || !alive.current) return;
      runs.current.delete(id);
      const now = live.current;
      const at = now.findIndex((r) => r.id === id);
      const current = now[at];
      if (!current) return;
      const sha =
        typeof response?.source_sha256 === 'string'
          ? response.source_sha256
          : null;
      const description =
        typeof response?.description === 'string'
          ? response.description.trim()
          : '';
      if (!sha || (current.sha256 && current.sha256 !== sha)) {
        patch(id, {
          analyzing: false,
          status: current.sha256 ? REF_STATUS.ready : REF_STATUS.error,
          analysisError: 'The analysis did not match this file.',
        });
        return;
      }
      const dimensions =
        response.dimensions?.width > 0 && response.dimensions?.height > 0
          ? {
              width: response.dimensions.width,
              height: response.dimensions.height,
            }
          : (current.dimensions ?? null);
      const next = patch(id, {
        analyzing: false,
        analysisError: null,
        status: REF_STATUS.ready,
        sha256: sha,
        description,
        dimensions,
      });
      remember(sha, { ...current, sha256: sha, dimensions });
      if (
        !proposePrompt ||
        at === 0 ||
        at !== next.length - 1 ||
        epoch !== additionEpoch.current ||
        provider !== (options.current.getProviderHeader?.() ?? null)
      )
        return;
      const stillBefore = referenceContext(now.slice(0, at));
      if (JSON.stringify(stillBefore) !== JSON.stringify(sentContext)) return;
      await compose(proposalDraft ?? draft);
    },
    [checksum, patch, remember, stopRun, compose, prepare, hash],
  );

  const enqueue = useCallback(
    (id, opts) => {
      const epoch = additionEpoch.current;
      const provider = options.current.getProviderHeader?.() ?? null;
      const draft = options.current.getDraft();
      queue.current = queue.current
        .then(() =>
          analyze(id, {
            ...opts,
            proposalDraft: opts?.proposalDraft ?? draft,
            proposePrompt:
              opts?.proposePrompt !== false &&
              epoch === additionEpoch.current &&
              provider === (options.current.getProviderHeader?.() ?? null),
          }),
        )
        .catch(() => {});
      return queue.current;
    },
    [analyze],
  );

  /**
   * Attach sources at the end of the list. Each is checked against the
   * server's limits before anything is sent; a refused file changes nothing.
   * @param {Array<Blob|File>} files
   * @param {{id?: string, name?: string}} [source] for a saved image
   */
  const add = useCallback(
    (files, source = {}) => {
      const list = Array.from(files ?? []);
      if (
        live.current.length + list.length >
        (options.current.capability?.maxReferences ?? 0)
      ) {
        setProblem(
          `${list.length} file${list.length === 1 ? '' : 's'} not added. ${options.current.capability?.model ?? 'The selected image model'} accepts up to ${options.current.capability?.maxReferences ?? 0} references here.`,
        );
        return 0;
      }
      additionEpoch.current += 1;
      dropNotice();
      showProposal(null);
      const added = [];
      const refused = [];
      let recorded = false;
      for (const [index, file] of list.entries()) {
        const descriptor = Array.isArray(source)
          ? (source[index] ?? {})
          : source;
        const reason = checkReferenceFile(
          file,
          options.current.capability,
          live.current,
          options.current.uploads,
        );
        if (reason) {
          refused.push(reason);
          continue;
        }
        const id = descriptor.id ?? `upload:${newKey()}`;
        if (live.current.some((ref) => ref.id === id)) {
          refused.push('That image is already a reference.');
          continue;
        }
        const ref = {
          id,
          blob: file,
          name: shortName(descriptor.name ?? file.name),
          type: file.type,
          size: file.size,
          url: null,
          sha256: null,
          description: '',
          dimensions: null,
          status: REF_STATUS.reading,
          analyzing: false,
          analysisError: null,
        };
        if (!recorded) {
          recorded = true;
          transaction(list.length > 1 ? 'Add references' : 'Add reference');
        }
        commit((prev) => [...prev, ref]);
        added.push(ref);
        remember(id, ref);
      }
      setProblem(
        refused.length
          ? `${refused.length} file${refused.length === 1 ? '' : 's'} not added. ${refused.join(' ')}`
          : null,
      );
      for (const ref of added) {
        enqueue(ref.id);
      }
      return added.length;
    },
    [
      commit,
      enqueue,
      remember,
      transaction,
      dropNotice,
      showProposal,
      setProblem,
    ],
  );

  const remove = useCallback(
    (id) => {
      const ref = live.current.find((r) => r.id === id);
      if (!ref) return;
      additionEpoch.current += 1;
      dropNotice();
      showProposal(null);
      transaction('Remove reference');
      stopRun(id);
      if (ref.url) urls.release(ref.url);
      commit((prev) => prev.filter((r) => r.id !== id));
      setProblem(null);
    },
    [commit, stopRun, transaction, urls, dropNotice, showProposal, setProblem],
  );

  /** Move one reference by `delta` places; the first becomes the base canvas. */
  const move = useCallback(
    (id, delta) => {
      const from = live.current.findIndex((r) => r.id === id);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= live.current.length) return;
      additionEpoch.current += 1;
      dropNotice();
      showProposal(null);
      transaction(to === 0 ? 'Make reference the base' : 'Move reference');
      commit((prev) => {
        const next = [...prev];
        const [item] = next.splice(from, 1);
        next.splice(to, 0, item);
        return next;
      });
    },
    [commit, transaction, dropNotice, showProposal],
  );

  const retryAnalysis = useCallback(
    (id) => {
      const ref = live.current.find((r) => r.id === id);
      if (!ref?.blob || ref.analyzing) return;
      if (!ref.sha256) patch(id, { status: REF_STATUS.reading });
      enqueue(id);
    },
    [enqueue, patch],
  );

  /**
   * Attach the exact original of a restored reference. A different file is
   * refused: its description and place belong to the original bytes.
   */
  const reattach = useCallback(
    async (id, file) => {
      const ref = live.current.find((r) => r.id === id);
      if (!ref || !file) return;
      const others = live.current.filter((r) => r.id !== id);
      const reason = checkReferenceFile(
        file,
        options.current.capability,
        others,
        options.current.uploads,
      );
      if (reason) {
        patch(id, {
          attachError: reason,
          attachFailure: {
            diagnostic: localDiagnostic({
              category: 'reference-validation',
              reason,
            }),
          },
        });
        return;
      }
      stopRun(id);
      const controller = new AbortController();
      runs.current.set(id, controller);
      patch(id, { attachError: null, checking: true });
      let sha = null;
      let prepared = null;
      let failure = null;
      try {
        sha = await checksum(file, shortName(file.name), controller.signal);
        if (ref.source && sha === ref.source.sha256) {
          prepared = await adaptReference(file, {
            signal: controller.signal,
            maxNormalizedBytes: ref.source.max_normalized_bytes,
          });
          sha = prepared.sha256;
        }
      } catch (error) {
        if (aborted(error)) return;
        failure = error;
      }
      if (runs.current.get(id) !== controller || !alive.current) return;
      runs.current.delete(id);
      if (!live.current.some((r) => r.id === id)) return;
      if (!sha) {
        patch(id, {
          checking: false,
          attachFailure: failure
            ? preserveError(failure)
            : {
                diagnostic: localDiagnostic({
                  category: 'reference-checksum',
                  reason: 'The file checksum could not be verified.',
                }),
              },
          attachError: failure
            ? `${shortName(file.name)} could not be checked: ${preserveError(failure).message || 'try again.'}`
            : `${shortName(file.name)} could not be checked. Try again.`,
        });
        return;
      }
      if (sha !== ref.sha256) {
        patch(id, {
          checking: false,
          attachError: `${shortName(file.name)} is not the original reference image.`,
          attachFailure: {
            diagnostic: localDiagnostic({
              category: 'reference-checksum',
              reason:
                'The attached file does not match the recorded reference checksum.',
              facts: { expected: ref.sha256, observed: sha },
            }),
          },
        });
        return;
      }
      const modelFile = prepared?.blob ?? file;
      const url = urls.acquire(modelFile);
      if (ref.url) urls.release(ref.url);
      patch(id, {
        ...prepared,
        prepared: true,
        blob: modelFile,
        url,
        name: ref.name || shortName(file.name),
        type: file.type,
        size: modelFile.size,
        status: REF_STATUS.ready,
        checking: false,
        attachError: null,
      });
      remember(sha, {
        ...ref,
        ...prepared,
        blob: modelFile,
        name: ref.name,
        type: modelFile.type,
      });
    },
    [checksum, patch, remember, stopRun, urls],
  );

  /** Drop every reference (new draft, restored text-only snapshot). */
  const clear = useCallback(() => {
    additionEpoch.current += 1;
    for (const ref of live.current) {
      stopRun(ref.id);
      if (ref.url) urls.release(ref.url);
    }
    commit(() => []);
    showProposal(null);
    dropNotice();
    setProblem(null);
  }, [commit, stopRun, urls, showProposal, dropNotice, setProblem]);

  /**
   * Find the exact bytes of a restored slot: kept in this browser by checksum,
   * then the saved image the id names. Each candidate must hash to the slot's
   * checksum; a different file never fills it. Nothing here describes.
   */
  const resolveRestored = useCallback(
    async (ref, { retained = true, saved = true } = {}) => {
      const id = ref.id;
      stopRun(id);
      const controller = new AbortController();
      const { signal } = controller;
      runs.current.set(id, controller);
      const current = () =>
        alive.current &&
        runs.current.get(id) === controller &&
        live.current.some((r) => r.id === id);
      const sources = [];
      const { readRetained: keptReader, readSaved: savedReader } =
        options.current;
      if (retained && keptReader && ref.sha256)
        sources.push(async () => {
          const entry = await keptReader(ref.sha256, { signal });
          return entry?.blob ? keptFile({ ...entry, name: ref.name }) : null;
        });
      if (retained && keptReader && ref.source?.sha256)
        sources.push(async () => {
          const entry = await keptReader(ref.source.sha256, { signal });
          return entry?.blob ? keptFile({ ...entry, name: ref.name }) : null;
        });
      const identity = savedIdentityOf(ref.id);
      if (saved && identity && savedReader)
        sources.push(() => savedReader(identity, { signal }));
      for (const read of sources) {
        let blob = null;
        try {
          blob = await read();
        } catch (error) {
          if (aborted(error)) return;
          blob = null;
        }
        if (!current()) return;
        if (!blob?.size) continue;
        let sha = null;
        let prepared = null;
        try {
          sha = await checksum(blob, ref.name, signal);
          if (ref.source && sha === ref.source.sha256) {
            prepared = await adaptReference(blob, {
              signal,
              maxNormalizedBytes: ref.source.max_normalized_bytes,
            });
            blob = prepared.blob;
            sha = prepared.sha256;
          }
        } catch (error) {
          if (aborted(error)) return;
          sha = null;
        }
        if (!current()) return;
        if (!sha || sha !== ref.sha256) continue;
        runs.current.delete(id);
        patch(id, {
          ...prepared,
          prepared: true,
          blob,
          url: urls.acquire(blob),
          type: blob.type,
          size: blob.size,
          status: REF_STATUS.ready,
        });
        remember(sha, {
          ...ref,
          ...prepared,
          blob,
          name: ref.name,
          type: blob.type,
        });
        return;
      }
      if (!current()) return;
      runs.current.delete(id);
      patch(id, { status: REF_STATUS.missing });
    },
    [checksum, patch, remember, stopRun, urls],
  );

  /**
   * Replace the list with a saved edit's references. Exact bytes come from
   * this tab's memory by hash, from the original kept in this browser, or from
   * the saved image a reference names; otherwise the slot asks for the file
   * again. Restoring never analyzes and never changes the saved descriptions.
   */
  const restore = useCallback(
    (descriptors) => {
      clear();
      const { readRetained: keptReader, readSaved: savedReader } =
        options.current;
      const restored = descriptors.map((item) => {
        const held =
          memory.current.get(item.id) ?? memory.current.get(item.sha256);
        const base = {
          id: item.id,
          name: shortName(item.filename ?? held?.name ?? 'reference'),
          sha256: item.sha256,
          description:
            typeof item.description === 'string' ? item.description : '',
          role: typeof item.role === 'string' ? item.role : undefined,
          dimensions: item.dimensions ?? null,
          ...(item.source ? { source: item.source } : {}),
          analyzing: false,
          analysisError: null,
          restored: true,
        };
        if (held)
          return {
            ...base,
            // Different originals can produce byte-identical model copies.
            // The descriptor's lineage, never a shared SHA cache entry, owns
            // which original belongs to this slot.
            original:
              base.source && held.original?.sha256 === base.source.sha256
                ? held.original
                : undefined,
            source: base.source,
            prepared: held.prepared ?? Boolean(item.sha256),
            blob: held.blob,
            type: held.blob.type,
            size: held.blob.size,
            url: urls.acquire(held.blob),
            status: REF_STATUS.ready,
          };
        const identity = savedIdentityOf(item.id);
        return {
          ...base,
          blob: null,
          url: null,
          size: 0,
          status:
            (keptReader && item.sha256) || (identity && savedReader)
              ? REF_STATUS.resolving
              : REF_STATUS.missing,
        };
      });
      commit(() => restored);
      for (const ref of restored)
        if (ref.status === REF_STATUS.resolving) resolveRestored(ref);
    },
    [clear, commit, resolveRestored, urls],
  );

  /**
   * Checksum a slot that came back with its bytes but before its checksum
   * arrived. Checksum only (the browser's digest, else the server's
   * inspection): nothing is described or proposed.
   */
  const rehash = useCallback(
    async (ref) => {
      const id = ref.id;
      if (!(await prepare(id))) return;
      ref = live.current.find((item) => item.id === id);
      if (!ref) return;
      stopRun(id);
      const controller = new AbortController();
      runs.current.set(id, controller);
      let sha = null;
      try {
        sha = await checksum(ref.blob, ref.name, controller.signal);
      } catch (error) {
        if (aborted(error)) return;
        sha = null;
      }
      if (
        !alive.current ||
        runs.current.get(id) !== controller ||
        live.current.find((r) => r.id === id)?.blob !== ref.blob
      )
        return;
      runs.current.delete(id);
      if (!sha) {
        patch(id, { status: REF_STATUS.error });
        return;
      }
      patch(id, { sha256: sha, status: REF_STATUS.ready });
      remember(sha, ref);
    },
    [checksum, patch, prepare, remember, stopRun],
  );

  /**
   * Put back the reference list of an undo or redo snapshot. A slot still
   * attached with the same identity is kept as it is, with its bytes, any
   * work in progress and its newest description. Any other slot is found
   * again like a restored edit: this tab's memory by checksum, the original
   * kept in this browser, then the saved image its id names; otherwise it
   * asks for the file. Slots left out stop their work. Nothing is described,
   * proposed or uploaded here.
   *
   * @param {Array<{id: string, sha256: string|null, filename?: string|null,
   *   description?: string, role?: string, dimensions?: object|null}>} descriptors
   * @param {object|null} [proposal] the proposal shown in that snapshot
   * @param {Map<string, {blob: Blob, name?: string}>|null} [sources] bytes
   *   held by id for parked slots, used before the checksum memory so a file
   *   parked before its checksum arrived still comes back
   * @returns {Array<object>} the restored list
   */
  const restoreDraft = useCallback(
    (descriptors, proposal = null, sources = null) => {
      additionEpoch.current += 1;
      dropNotice();
      const before = live.current;
      const attached = new Map(before.map((ref) => [ref.id, ref]));
      const wanted = new Set(descriptors.map((item) => item.id));
      for (const ref of before) {
        if (wanted.has(ref.id)) continue;
        stopRun(ref.id);
        if (ref.url) urls.release(ref.url);
      }
      const { readRetained: keptReader, readSaved: savedReader } =
        options.current;
      const next = descriptors.map((item) => {
        const same = attached.get(item.id);
        if (
          same &&
          (!item.sha256 || !same.sha256 || same.sha256 === item.sha256)
        )
          return same;
        if (same) {
          stopRun(same.id);
          if (same.url) urls.release(same.url);
        }
        const own = sources?.get(item.id) ?? null;
        const held =
          (own?.blob ? own : null) ??
          memory.current.get(item.id) ??
          (item.sha256 ? memory.current.get(item.sha256) : null);
        const base = {
          id: item.id,
          name: shortName(item.filename ?? held?.name ?? 'reference'),
          sha256: item.sha256 ?? null,
          description:
            typeof item.description === 'string' ? item.description : '',
          role: typeof item.role === 'string' ? item.role : undefined,
          dimensions: item.dimensions ?? null,
          ...(item.source ? { source: item.source } : {}),
          analyzing: false,
          // A file whose description never arrived is not described again on
          // its own: the person can retry, which asks the model explicitly.
          analysisError:
            item.analysisError ??
            (typeof item.description === 'string' && item.description
              ? null
              : 'it was restored before its description arrived.'),
          restored: true,
        };
        if (held)
          return {
            ...base,
            // Different originals can produce byte-identical model copies.
            // The descriptor's lineage, never a shared SHA cache entry, owns
            // which original belongs to this slot.
            original:
              base.source && held.original?.sha256 === base.source.sha256
                ? held.original
                : undefined,
            source: base.source,
            prepared: held.prepared ?? Boolean(item.sha256),
            blob: held.blob,
            type: held.blob.type,
            size: held.blob.size,
            url: urls.acquire(held.blob),
            // Parked before its checksum arrived: it is hashed again below.
            status:
              base.sha256 && held.prepared !== false
                ? REF_STATUS.ready
                : REF_STATUS.reading,
          };
        const identity = savedIdentityOf(item.id);
        return {
          ...base,
          analysisError: null,
          blob: null,
          url: null,
          size: 0,
          status:
            (keptReader && item.sha256) || (identity && savedReader)
              ? REF_STATUS.resolving
              : REF_STATUS.missing,
        };
      });
      commit(() => next);
      showProposal(proposal);
      setProblem(null);
      for (const ref of next) {
        if (attached.get(ref.id) === ref) continue;
        if (ref.status === REF_STATUS.resolving) resolveRestored(ref);
        else if (ref.status === REF_STATUS.reading && ref.blob) rehash(ref);
      }
      return next;
    },
    [
      commit,
      rehash,
      resolveRestored,
      showProposal,
      stopRun,
      urls,
      dropNotice,
      setProblem,
    ],
  );

  /**
   * Take every reference out of the draft without losing it: the ordered
   * descriptors, the proposal and each file's bytes by id. Work in progress
   * stops (a description that had not arrived can be asked for again).
   * `restoreDraft(parked.refs, parked.proposal, parked.sources)` puts them
   * back. Not a person's change by itself: no transaction is recorded.
   * @returns {{refs: Array<object>, proposal: object|null,
   *   sources: Map<string, {blob: Blob, name: string, type: string}>}|null}
   */
  const park = useCallback(() => {
    additionEpoch.current += 1;
    const list = live.current;
    const proposal = proposalRef.current;
    if (!list.length && !proposal) {
      dropNotice();
      return null;
    }
    const sources = new Map();
    for (const ref of list) {
      if (ref.blob) {
        sources.set(ref.id, {
          ...ref,
          blob: ref.blob,
          name: ref.name,
          type: ref.blob.type,
        });
        if (ref.sha256) remember(ref.sha256, ref);
      }
      stopRun(ref.id);
      if (ref.url) urls.release(ref.url);
    }
    const refs = list.map((ref) => ({
      id: ref.id,
      sha256: ref.sha256 ?? null,
      filename: ref.name ?? null,
      description: typeof ref.description === 'string' ? ref.description : '',
      role: typeof ref.role === 'string' ? ref.role : undefined,
      dimensions: ref.dimensions ?? null,
      ...(ref.source ? { source: ref.source } : {}),
    }));
    commit(() => []);
    showProposal(null);
    dropNotice();
    setProblem(null);
    return { refs, proposal, sources };
  }, [commit, dropNotice, remember, showProposal, stopRun, urls, setProblem]);

  /**
   * Try the kept original again for a slot that is still missing, once kept
   * files are readable or another tab keeps one. Fills only that slot.
   */
  const recoverRetained = useCallback(
    (id) => {
      const ref = live.current.find((r) => r.id === id);
      if (
        !alive.current ||
        ref?.status !== REF_STATUS.missing ||
        !ref.sha256 ||
        !options.current.readRetained
      )
        return;
      patch(id, { status: REF_STATUS.resolving });
      resolveRestored(
        live.current.find((r) => r.id === id),
        { saved: false },
      );
    },
    [patch, resolveRestored],
  );

  /**
   * Attach a kept original as the next reference without uploading it. Stored
   * metadata supplies the description, so nothing is described or proposed;
   * a kept file saved without one is described like any new reference.
   * @returns {Promise<{ok: true, id: string}|{ok: false, reason: string}>}
   */
  const attachRetained = useCallback(
    async (entry) => {
      if (!entry?.blob) return { ok: false, reason: 'The kept file is gone.' };
      const epoch = additionEpoch.current;
      const provider = options.current.getProviderHeader?.() ?? null;
      const file = keptFile(entry);
      const refuse = (held) => {
        if (held.some((r) => (r.source?.sha256 ?? r.sha256) === entry.sha256))
          return 'That image is already a reference.';
        return checkReferenceFile(
          file,
          options.current.capability,
          held,
          options.current.uploads,
        );
      };
      const early = refuse(live.current);
      if (early) return { ok: false, reason: early };
      let sha = null;
      try {
        sha = await checksum(file, shortName(file.name));
      } catch (error) {
        return {
          ok: false,
          reason: `${shortName(file.name)} could not be checked: ${error?.message || 'try again.'}`,
        };
      }
      if (
        !alive.current ||
        epoch !== additionEpoch.current ||
        provider !== (options.current.getProviderHeader?.() ?? null)
      )
        return {
          ok: false,
          reason: 'The draft changed before the file was attached.',
        };
      if (!sha || sha !== entry.sha256)
        return {
          ok: false,
          reason: `${shortName(file.name)} no longer matches its checksum.`,
        };
      // The draft may have changed while the bytes were checked.
      const late = refuse(live.current);
      if (late) return { ok: false, reason: late };
      const id = `upload:${newKey()}`;
      transaction('Add kept reference');
      const described = typeof entry.description === 'string';
      const ref = {
        id,
        blob: file,
        name: shortName(entry.name || file.name),
        type: file.type,
        size: file.size,
        url: null,
        sha256: sha,
        status: REF_STATUS.reading,
        description: described ? entry.description : '',
        dimensions: entry.dimensions ?? null,
        analyzing: false,
        analysisError: null,
      };
      commit((prev) => [...prev, ref]);
      setProblem(null);
      remember(sha, ref);
      if (await prepare(id)) {
        if (!ref.description) enqueue(id);
        else {
          const ready = live.current.find((item) => item.id === id);
          if (ready) {
            patch(id, { status: REF_STATUS.ready });
            remember(ready.sha256 ?? sha, ready);
          }
        }
      }
      return { ok: true, id };
    },
    [
      checksum,
      commit,
      enqueue,
      patch,
      prepare,
      remember,
      transaction,
      setProblem,
    ],
  );

  /** A source held in this tab by checksum, for read-only use. */
  const heldSource = useCallback((sha) => {
    const item = typeof sha === 'string' ? memory.current.get(sha) : null;
    return item?.blob
      ? {
          blob: item.blob,
          name: item.name || 'reference',
          dimensions: item.dimensions ?? null,
          ...(item.source ? { source: item.source } : {}),
        }
      : null;
  }, []);

  const undoProposal = useCallback(() => {
    additionEpoch.current += 1;
    dropNotice();
    const p = proposalRef.current;
    if (p?.kind === 'applied') {
      transaction('Restore earlier prompt');
      options.current.setPrompt(p.previous);
    }
    showProposal(null);
  }, [showProposal, transaction, dropNotice]);
  const acceptProposal = useCallback(() => {
    const p = proposalRef.current;
    if (
      p?.kind !== 'offered' ||
      live.current.length < 2 ||
      p.signature !== referenceSignature(live.current)
    )
      return;
    transaction('Use suggestion');
    const previous = options.current.getDraft().prompt;
    options.current.setPrompt(p.text);
    showProposal({ ...p, kind: 'applied', previous });
  }, [showProposal, transaction]);
  /** The proposal as shown now, for a draft snapshot. */
  const currentProposal = useCallback(() => proposalRef.current, []);
  const dismissProposal = useCallback(() => showProposal(null), [showProposal]);

  const signature = useMemo(() => referenceSignature(refs), [refs]);

  /** Whether this exact set can supply pixels for a joint prompt retry. */
  const retryReady = useCallback(
    (list) =>
      list.length > 1 &&
      list.every(
        (ref) =>
          ref.status === REF_STATUS.ready &&
          !ref.analyzing &&
          ref.sha256 &&
          ref.blob,
      ),
    [],
  );

  /**
   * Ask again for only the prompt suggestion, for the references and prompt as
   * they are now. Exact reference pixels are resent for joint understanding;
   * no separate captions or images are generated. Stale answers are dropped.
   */
  const retryPrompt = useCallback(async () => {
    const notice = noticeRef.current;
    const list = live.current;
    if (!notice || notice.retrying || !alive.current) return;
    const sig = referenceSignature(list);
    const header = options.current.getProviderHeader?.() ?? null;
    if (notice.signature !== sig || notice.provider !== header) return;
    if (!retryReady(list)) return;
    showNotice({ ...notice, retrying: true });
    await compose();
  }, [compose, retryReady, showNotice]);

  // The warning belongs to one reference set. A change of set makes it moot.
  useEffect(() => {
    if (noticeRef.current && noticeRef.current.signature !== signature)
      dropNotice();
  }, [signature, dropNotice]);
  useEffect(() => {
    additionEpoch.current += 1;
    noticeRun.current?.abort();
    noticeRun.current = null;
    noticeRef.current = null;
    proposalRef.current = null;
  }, [providerScope]);
  const visibleNotice =
    promptNotice &&
    promptNotice.signature === signature &&
    promptNotice.provider === providerScope
      ? { ...promptNotice, ready: retryReady(refs) }
      : null;

  return {
    refs,
    signature,
    live,
    bind,
    proposal:
      refs.length > 1 &&
      proposal?.signature === signature &&
      (proposal.provider ?? null) === providerScope
        ? proposal
        : null,
    problem,
    problemDiagnostic,
    dismissProblem: () => setProblem(null),
    add,
    remove,
    move,
    retryAnalysis,
    reattach,
    restore,
    restoreDraft,
    park,
    currentProposal,
    recoverRetained,
    attachRetained,
    heldSource,
    checksum,
    clear,
    undoProposal,
    acceptProposal,
    dismissProposal,
    promptNotice: visibleNotice,
    retryPrompt,
    dismissPromptNotice: dropNotice,
  };
}
