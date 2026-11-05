/**
 * Reference originals kept in this browser, as the Create screen uses them.
 *
 * - Keeping is always an explicit action on one attached reference. The file
 *   stays in the draft whatever happens: a refused, denied or failed save only
 *   reports "not kept" and may be retried with a fresh ticket.
 * - The list holds metadata only (`list()`); a Blob is read when a file is
 *   chosen, restored, previewed or compared, never to build the list.
 * - Removing a kept copy never touches an attached reference or its URL.
 * - The list is refreshed on this tab's own commits, other tabs' commits (the
 *   store's channel) and when the page becomes visible again, and a slower
 *   older listing never replaces a newer one.
 * - Nothing here calls a model or an HTTP endpoint other than the checksum-only
 *   inspection `references.checksum` already uses where WebCrypto is absent.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { preserveError } from './diagnostics.js';
import { REF_STATUS } from './references.js';
import {
  keepFailure,
  removeFailure,
  retainedReader,
} from './retainedReferences.js';

const EMPTY = Object.freeze({
  status: 'idle',
  items: [],
  usage: null,
  error: null,
  failure: null,
});
const LOADING = Object.freeze({ ...EMPTY, status: 'loading' });

/**
 * @param {object} options
 * @param {ReturnType<import('./referenceAssets.js').createReferenceAssetsStore>|null} options.store
 * @param {boolean} [options.ready] the cache has finished opening
 * @param {ReturnType<import('./useReferences.js').useReferences>} options.references
 * @param {ReturnType<import('./references.js').editingCapability>} [options.capability]
 */
export function useRetainedReferences({
  store,
  ready = true,
  references,
  capability = null,
}) {
  const [stored, setListing] = useState(LOADING);
  const [keeps, setKeeps] = useState({});
  const alive = useRef(true);
  const sequence = useRef(0);
  const latest = useRef({ store, references });
  const inflight = useRef(new Set());
  const attempted = useRef(new Set());
  useEffect(() => {
    latest.current = { store, references };
  });
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const durable = Boolean(store?.durable);
  // Without open, durable storage there is nothing to list or to wait for.
  const listing = ready && durable ? stored : EMPTY;

  const refresh = useCallback(async () => {
    const owner = latest.current.store;
    const token = ++sequence.current;
    if (!owner?.durable) return null;
    try {
      const answer = await owner.list();
      if (!alive.current || token !== sequence.current) return null;
      setListing({
        status: 'ready',
        items: answer.items,
        usage: answer.usage,
        error: null,
        failure: null,
      });
      return answer;
    } catch (error) {
      if (!alive.current || token !== sequence.current) return null;
      const failure = preserveError(error);
      setListing({
        status: 'error',
        items: [],
        usage: null,
        error: failure.message || 'The kept files could not be read.',
        failure,
      });
      return null;
    }
  }, []);

  // Metadata only, once storage is open; then follow this and other tabs.
  useEffect(() => {
    if (!ready || !store) {
      sequence.current += 1;
      return undefined;
    }
    refresh();
    const stop = store.subscribe?.(() => {
      refresh();
    });
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stop?.();
      document.removeEventListener('visibilitychange', onVisible);
      // A listing still in flight belongs to the store that is going away.
      sequence.current += 1;
    };
  }, [ready, store, refresh]);

  const bySha = useMemo(
    () => new Map(listing.items.map((item) => [item.sha256, item])),
    [listing.items],
  );
  const find = useCallback(
    (sha) => (typeof sha === 'string' ? (bySha.get(sha) ?? null) : null),
    [bySha],
  );

  const reader = useMemo(
    () => (durable ? retainedReader(store) : null),
    [store, durable],
  );
  /** One kept original's Blob (and metadata), read now; null if not kept. */
  const load = useCallback(
    async (sha, { signal } = {}) => {
      const entry = reader ? await reader(sha, { signal }) : null;
      return entry?.blob ? entry.blob : null;
    },
    [reader],
  );

  const setKeep = useCallback((id, state) => {
    setKeeps((prev) => {
      const next = { ...prev };
      if (state) next[id] = state;
      else delete next[id];
      return next;
    });
  }, []);

  /**
   * Keep one attached reference. The ticket is taken BEFORE any hashing so a
   * removal in another tab fences this write.
   */
  const keep = useCallback(
    async (id) => {
      const owner = latest.current.store;
      const held = latest.current.references;
      const target = held.live.current.find((ref) => ref.id === id);
      if (!owner || !target?.blob || inflight.current.has(id)) return null;
      inflight.current.add(id);
      setKeep(id, { status: 'saving' });
      let outcome;
      try {
        const ticket = await owner.beginKeep();
        if (!ticket) outcome = { persisted: false, reason: 'no-storage' };
        else {
          const sha =
            target.original?.sha256 ??
            target.sha256 ??
            (await held.checksum(target.blob, target.name));
          const now = held.live.current.find((ref) => ref.id === id) ?? target;
          outcome = sha
            ? await owner.keep(ticket, {
                sha256: sha,
                blob: target.original?.blob ?? target.blob,
                name: now.name,
                description: now.description,
                dimensions: target.original?.dimensions ?? now.dimensions,
              })
            : { persisted: false, reason: 'checksum-mismatch' };
        }
      } catch (error) {
        outcome = {
          persisted: false,
          reason: 'failed',
          error: preserveError(error),
        };
      }
      inflight.current.delete(id);
      if (!alive.current) return outcome;
      if (outcome.persisted) {
        setKeep(id, null);
        await refresh();
      } else {
        const answer = await refresh().catch(() => null);
        if (alive.current)
          setKeep(id, {
            status: 'failed',
            reason: outcome.reason,
            ...keepFailure(outcome.reason, answer?.usage ?? listing.usage),
            ...(outcome.error
              ? {
                  error: outcome.error,
                  diagnostic: outcome.error.diagnostic,
                }
              : {}),
          });
      }
      return outcome;
    },
    [listing.usage, refresh, setKeep],
  );

  const dismissKeep = useCallback((id) => setKeep(id, null), [setKeep]);

  /**
   * Remove one kept copy at the revision the person confirmed. Attached
   * references, their descriptions and object URLs are left alone.
   * @returns {Promise<{removed: boolean, message?: string}>}
   */
  const remove = useCallback(
    async (item) => {
      const owner = latest.current.store;
      if (!owner)
        return { removed: false, message: removeFailure('no-storage') };
      let result;
      try {
        result = await owner.remove(item.sha256, {
          revision: item.revision,
        });
      } catch (error) {
        await refresh();
        return {
          removed: false,
          message: removeFailure('failed'),
          error: preserveError(error),
        };
      }
      await refresh();
      return result.removed
        ? { removed: true }
        : { removed: false, message: removeFailure(result.reason) };
    },
    [refresh],
  );

  const attached = useMemo(
    () =>
      new Set(
        references.refs
          .map((ref) => ref.source?.sha256 ?? ref.sha256)
          .filter((sha) => sha),
      ),
    [references.refs],
  );
  const addBlock = !capability?.enabled
    ? 'Image editing is unavailable.'
    : references.refs.length >= capability.maxReferences
      ? `Limit of ${capability.maxReferences} references reached.`
      : null;

  /** Attach a kept original to the draft; reads its bytes only now. */
  const pick = useCallback(
    async (item) => {
      let entry = null;
      try {
        entry = reader ? await reader(item.sha256) : null;
      } catch (error) {
        await refresh();
        return {
          ok: false,
          reason: `${item.name || 'The kept file'} could not be read.`,
          error: preserveError(error),
        };
      }
      if (!entry) {
        await refresh();
        return { ok: false, reason: 'That kept file is no longer available.' };
      }
      return latest.current.references.attachRetained(entry);
    },
    [reader, refresh],
  );

  // A restored slot that was missing when kept files could not be read yet
  // (or that another tab has since kept) is offered the kept copy once.
  const recover = references.recoverRetained;
  useEffect(() => {
    if (!durable || listing.status !== 'ready') return;
    for (const ref of references.refs) {
      if (ref.status !== REF_STATUS.missing || !ref.sha256) continue;
      const item = bySha.get(ref.source?.sha256 ?? ref.sha256);
      if (!item) continue;
      const key = `${ref.id}:${item.sha256}:${item.revision}`;
      if (attempted.current.has(key)) continue;
      attempted.current.add(key);
      recover(ref.id);
    }
  }, [durable, listing.status, references.refs, bySha, recover]);

  return {
    /** The cache has opened (the Keep action can be judged). */
    ready,
    /** Browser storage accepts kept files. */
    available: durable,
    status: listing.status,
    error: listing.error,
    failure: listing.failure,
    items: listing.items,
    usage: listing.usage,
    find,
    keeps,
    attached,
    addBlock,
    refresh,
    keep,
    dismissKeep,
    remove,
    pick,
    load,
  };
}
