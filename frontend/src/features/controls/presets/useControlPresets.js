/**
 * Named control presets kept in this browser: the listing, kept current with
 * this and other tabs, plus explicit save and removal. Data rules live in
 * controlPresets.js and controlPresetStore.js; this only orders the answers.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

const LOADING = Object.freeze({
  status: 'loading',
  items: [],
  usage: null,
  error: null,
});
const UNAVAILABLE = Object.freeze({
  status: 'unavailable',
  items: [],
  usage: null,
  error: null,
});

/** Why a save or removal was refused, in words; null when it was stored. */
export function presetRefusal(reason, { limits } = {}) {
  switch (reason) {
    case undefined:
    case null:
      return null;
    case 'no-storage':
      return 'Browser storage is unavailable, so presets cannot be kept.';
    case 'quota':
      return 'Browser storage is full. The preset was not saved.';
    case 'record-limit':
      return `Presets are limited to ${limits?.count ?? 'a fixed number'}. Remove one to save another.`;
    case 'byte-limit':
      return 'Presets have reached their storage limit. Remove one to save another.';
    case 'changed':
      return 'This preset changed in another tab. Check the list and try again.';
    case 'duplicate-name':
      return 'Another preset for this mode already has that name.';
    case 'invalid':
      return 'These controls cannot be saved as a preset.';
    default:
      return 'The preset could not be saved.';
  }
}

/**
 * @param {{store: object|null, ready: boolean}} options
 *   `store` is `cacheStore.controlPresets`; `ready` is the cache's readiness.
 */
export function useControlPresets({ store, ready }) {
  const [listing, setListing] = useState(LOADING);
  const alive = useRef(true);
  const sequence = useRef(0);
  const owner = useRef(store);
  useEffect(() => {
    owner.current = store;
  });
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const durable = Boolean(store?.durable);

  const refresh = useCallback(async () => {
    const current = owner.current;
    const token = ++sequence.current;
    if (!current?.durable) return null;
    try {
      const answer = await current.list();
      // A newer listing, or a store that went away, owns the result.
      if (!alive.current || token !== sequence.current) return null;
      // Storage that closed since the check lists nothing and keeps nothing.
      setListing({
        status: answer.durable ? 'ready' : 'unavailable',
        items: answer.items,
        usage: answer.usage,
        error: null,
      });
      return answer;
    } catch {
      if (!alive.current || token !== sequence.current) return null;
      // Unreadable storage is reported and never written over.
      setListing({
        status: 'error',
        items: [],
        usage: null,
        error: 'Saved presets could not be read.',
      });
      return null;
    }
  }, []);

  useEffect(() => {
    if (!ready || !store?.durable) {
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
      sequence.current += 1;
    };
  }, [ready, store, refresh]);

  /** Save a new preset, or replace the exact `target` revision. */
  const save = useCallback(
    async (preset, target = null) => {
      const current = owner.current;
      if (!current?.durable) return { persisted: false, reason: 'no-storage' };
      const result = await current.save(
        preset,
        target ? { id: target.id, revision: target.revision } : undefined,
      );
      // A refusal may come from another tab's change: show the newest list.
      if (!result.persisted) refresh();
      return result;
    },
    [refresh],
  );

  /** Remove the exact revision that was shown. */
  const remove = useCallback(
    async (item) => {
      const current = owner.current;
      if (!current?.durable) return { persisted: false, reason: 'no-storage' };
      const result = await current.remove(item.id, {
        revision: item.revision,
      });
      if (!result.persisted) refresh();
      return result;
    },
    [refresh],
  );

  const state = !ready ? LOADING : durable ? listing : UNAVAILABLE;
  return { ...state, durable: ready && durable, refresh, save, remove };
}
