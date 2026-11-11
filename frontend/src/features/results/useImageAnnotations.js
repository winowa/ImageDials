import { preserveError } from '../../shared/diagnostics/diagnostics.js';
/**
 * Favorites and collections kept in this browser: the whole bounded stored
 * state, kept current with this and other tabs, plus the store's atomic
 * changes. Data rules live in imageAnnotations.js / imageAnnotationStore.js;
 * this only orders answers and words refusals.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  ANNOTATION_LIMITS,
  annotationIdentity,
  annotationKey,
  annotationMembers,
} from '../../data/records/imageAnnotations.js';

const EMPTY = Object.freeze({
  collections: [],
  images: [],
  usage: null,
  error: null,
});
const LOADING = Object.freeze({ ...EMPTY, status: 'loading' });
const UNAVAILABLE = Object.freeze({ ...EMPTY, status: 'unavailable' });
const NO_STORAGE = Object.freeze({ persisted: false, reason: 'no-storage' });
const byName = (a, b) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

/** Why a change was refused, in words; null when it was stored. */
export function annotationRefusal(reason) {
  switch (reason) {
    case undefined:
    case null:
      return null;
    case 'no-storage':
      return 'Browser storage is unavailable, so favorites and collections cannot be kept.';
    case 'quota':
      return 'Browser storage is full. Nothing was changed.';
    case 'record-limit':
      return `Up to ${ANNOTATION_LIMITS.images} images can be in favorites and collections. Remove some first.`;
    case 'byte-limit':
      return 'Favorites and collections have reached their storage limit. Nothing was changed.';
    case 'collection-limit':
      return `Up to ${ANNOTATION_LIMITS.collections} collections can be kept. Remove one to add another.`;
    case 'duplicate-name':
      return 'Another collection already has that name.';
    case 'changed':
      return 'This changed in another tab. Check the list and try again.';
    case 'invalid':
      return `Use a collection name of 1–${ANNOTATION_LIMITS.name} characters.`;
    default:
      return 'The change could not be saved.';
  }
}

/** The exact stored identity of a record, or null when it cannot be marked. */
export function identityOf(record) {
  try {
    return record ? annotationIdentity(record) : null;
  } catch {
    return null;
  }
}

/**
 * @param {{store: object|null, ready: boolean}|null|undefined} resources
 *   `studio.imageAnnotations`: the cache owner's annotation store; no other
 *   database is opened here.
 */
export function useImageAnnotations(resources) {
  const store = resources?.store ?? null;
  const ready = Boolean(resources?.ready);
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
      setListing(
        answer.durable
          ? {
              status: 'ready',
              collections: answer.collections,
              images: answer.images,
              usage: answer.usage,
              error: null,
            }
          : UNAVAILABLE,
      );
      return answer;
    } catch (error) {
      if (!alive.current || token !== sequence.current) return null;
      // Unreadable stored state is reported and never written over.
      setListing({
        ...EMPTY,
        status: 'error',
        error: 'Saved favorites and collections could not be read.',
        errorDetail: preserveError(error),
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

  const state = !ready ? LOADING : durable ? listing : UNAVAILABLE;
  const index = useMemo(() => {
    const rows = new Map();
    for (const row of state.images) rows.set(annotationKey(row.identity), row);
    return rows;
  }, [state.images]);
  const collections = useMemo(
    () => [...state.collections].sort(byName),
    [state.collections],
  );
  const memberCounts = useMemo(() => {
    const counts = new Map();
    let favorites = 0;
    for (const row of state.images) {
      if (row.favorite) favorites += 1;
      for (const id of row.collections)
        counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return { favorites, collections: counts };
  }, [state.images]);

  /** The stored marks of `record`; `identity` is null when it is ineligible. */
  const entryFor = useCallback(
    (record) => {
      const identity = identityOf(record);
      const row = identity ? index.get(annotationKey(identity)) : null;
      return {
        identity,
        favorite: Boolean(row?.favorite),
        collectionIds: row?.collections ?? [],
      };
    },
    [index],
  );

  /**
   * The whole stored membership of a filter, most recently marked first.
   * Never limited to images the Library has loaded.
   */
  const members = useCallback(
    (filter) => {
      const matching = annotationMembers(state, {
        favorite: filter?.kind === 'favorites',
        collectionId: filter?.kind === 'collection' ? filter.id : null,
      });
      const revision = new Map(
        state.images.map((row) => [annotationKey(row.identity), row.revision]),
      );
      return matching.sort(
        (a, b) =>
          (revision.get(annotationKey(b)) ?? 0) -
          (revision.get(annotationKey(a)) ?? 0),
      );
    },
    [state],
  );

  // Each change is one atomic store operation; a refusal may come from another
  // tab's change, so the newest state is read back.
  const write = useCallback(
    async (run) => {
      const current = owner.current;
      if (!current?.durable) return NO_STORAGE;
      let result;
      try {
        result = await run(current);
      } catch {
        result = { persisted: false, reason: 'failed' };
      }
      if (!result?.persisted) refresh();
      return result;
    },
    [refresh],
  );
  const setFavorite = useCallback(
    (identity, value) => write((s) => s.setFavorite(identity, value)),
    [write],
  );
  const setMembership = useCallback(
    (identity, collectionId, value) =>
      write((s) => s.setMembership(identity, collectionId, value)),
    [write],
  );
  const createCollection = useCallback(
    (name) => write((s) => s.createCollection(name)),
    [write],
  );
  /** Rename the exact revision that was shown. */
  const renameCollection = useCallback(
    (collection, name) =>
      write((s) =>
        s.renameCollection(collection.id, name, {
          revision: collection.revision,
        }),
      ),
    [write],
  );
  /** Remove the exact revision that was shown; images are never touched. */
  const removeCollection = useCallback(
    (collection) =>
      write((s) =>
        s.removeCollection(collection.id, { revision: collection.revision }),
      ),
    [write],
  );

  return {
    status: state.status,
    error: state.error,
    usage: state.usage,
    durable: ready && durable,
    images: state.images,
    collections,
    memberCounts,
    refresh,
    entryFor,
    members,
    setFavorite,
    setMembership,
    createCollection,
    renameCollection,
    removeCollection,
    refusal: annotationRefusal,
  };
}
