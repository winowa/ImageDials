/** Current-draft files survive reload, independently from explicitly kept files.
 * The studio owns mode, parking and New draft; this hook owns only reference
 * hydration and persistence. It never calls analysis, composition or generation.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { openCacheDb } from '../../data/storage/cacheDb.js';
import { createDraftReferenceStore } from '../../data/storage/draftReferenceStore.js';
import {
  localDiagnostic,
  preserveError,
} from '../../shared/diagnostics/diagnostics.js';

const storageNotice = (reason, { error, ...facts } = {}) => ({
  message:
    reason === 'quota' || facts.omitted || facts.originalsOmitted
      ? 'Some draft files could not be saved in this browser. Keep this page open or reattach them after reload.'
      : 'Draft files could not be saved in this browser. Keep this page open or reattach them after reload.',
  diagnostic: localDiagnostic({
    category: 'reference-storage',
    reason,
    facts,
    cause: error,
    data: error?.diagnostic,
  }),
});

/** Convert persisted rows into the existing undo/parking contract. */
export function restoredReferenceDraft(rows) {
  return {
    refs: rows.map((row) => ({
      ...row,
      filename: row.name,
    })),
    proposal: null,
    sources: new Map(
      rows
        .filter((row) => row.blob)
        .map((row) => [
          row.id,
          {
            ...row,
            // Persisted Blobs have no File name; preserve it as metadata.
            prepared: row.prepared,
            original: row.original
              ? {
                  ...row.original,
                  originalFile: row.original.blob,
                  dimensions: row.source
                    ? { width: row.source.width, height: row.source.height }
                    : null,
                }
              : undefined,
          },
        ]),
    ),
  };
}

/**
 * Optional store/ready injection is for tests or an existing database owner.
 * Otherwise opens a separate connection to the same cache database.
 * `parked` is `{refs, sources: Map, proposal}` or null. Its changes must render.
 * `clear()` invalidates pending reads/writes immediately; call it BEFORE New
 * draft clears live refs/parking. Its promise reports whether durable clear
 * succeeded. Only explicit New draft calls clear, never mode changes/unmount.
 */
export function useDraftReferencePersistence({
  references,
  parked = null,
  onRestoreParked,
  store: suppliedStore,
  ready: suppliedReady = true,
}) {
  const [opened, setOpened] = useState({ store: null, ready: false });
  const [hydrated, setHydrated] = useState(false);
  const [notice, setNotice] = useState(null);
  const latest = useRef({ references, parked, onRestoreParked });
  useEffect(() => {
    latest.current = { references, parked, onRestoreParked };
  });
  const owner = suppliedStore === undefined ? opened.store : suppliedStore;
  const ready = suppliedStore === undefined ? opened.ready : suppliedReady;
  const state = useRef({
    token: 0,
    epoch: 0,
    cleared: false,
    active: true,
    readFailed: false,
  });
  const writer = useRef(Promise.resolve());

  useEffect(() => {
    if (suppliedStore !== undefined) return;
    let active = true;
    let connection;
    openCacheDb().then((db) => {
      connection = db;
      if (active)
        setOpened({ store: createDraftReferenceStore(db), ready: true });
      else db?.close();
    });
    return () => {
      active = false;
      connection?.close();
    };
  }, [suppliedStore]);

  useEffect(() => {
    const lifecycle = state.current;
    lifecycle.active = true;
    return () => {
      lifecycle.active = false;
      lifecycle.token += 1;
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    let active = true;
    const token = state.current.token;
    const before =
      latest.current.references.live?.current ?? latest.current.references.refs;
    const run = async () => {
      try {
        if (!owner?.durable) {
          setNotice(storageNotice('no-storage'));
          return;
        }
        if (state.current.cleared) {
          const result = await owner.clear();
          if (result.cleared) {
            state.current.epoch = result.epoch;
            state.current.cleared = false;
            state.current.readFailed = false;
          } else setNotice(storageNotice(result.reason, result));
          return;
        }
        const saved = await owner.load();
        if (!active || token !== state.current.token) return;
        state.current.epoch = saved?.epoch ?? 0;
        // A gesture while storage opened owns the live draft. Do not replace
        // it or its parked state with an older persisted list.
        if (
          (latest.current.references.live?.current ??
            latest.current.references.refs) !== before ||
          before.length ||
          latest.current.parked
        )
          return;
        if (saved?.attached?.length) {
          const draft = restoredReferenceDraft(saved.attached);
          latest.current.references.restoreDraft(
            draft.refs,
            null,
            draft.sources,
          );
        }
        if (saved?.parked)
          latest.current.onRestoreParked?.(
            restoredReferenceDraft(saved.parked),
          );
        const rows = [...(saved?.attached ?? []), ...(saved?.parked ?? [])];
        const missing = rows.filter((row) => !row.blob).length;
        const originalsMissing = rows.filter(
          (row) => row.original && !row.original.blob,
        ).length;
        if (missing || originalsMissing)
          setNotice(
            storageNotice('missing-files', {
              omitted: missing,
              originalsOmitted: originalsMissing,
            }),
          );
      } catch (cause) {
        if (active && token === state.current.token) {
          state.current.readFailed = true;
          setNotice(
            storageNotice('read-failed', { error: preserveError(cause) }),
          );
        }
      } finally {
        if (active && token === state.current.token) setHydrated(true);
      }
    };
    void run();
    return () => {
      active = false;
    };
  }, [owner, ready]);

  useEffect(() => {
    if (!hydrated || !owner?.durable || state.current.readFailed) return;
    const token = state.current.token;
    const epoch = state.current.epoch;
    const snapshot = { attached: references.refs, parked };
    writer.current = writer.current
      .catch(() => {})
      .then(async () => {
        if (!state.current.active || token !== state.current.token) return;
        const result = await owner.save(snapshot, epoch);
        if (!state.current.active || token !== state.current.token) return;
        if (
          !result.persisted ||
          result.omitted ||
          result.originalsOmitted ||
          result.fallback
        )
          setNotice(storageNotice(result.reason ?? 'budget', result));
        else setNotice(null);
      })
      .catch((cause) => {
        if (state.current.active && token === state.current.token)
          setNotice(
            storageNotice('write-failed', { error: preserveError(cause) }),
          );
      });
  }, [hydrated, owner, references.refs, parked]);

  const clear = useCallback(() => {
    const token = ++state.current.token;
    state.current.cleared = true;
    setHydrated(false);
    setNotice(null);
    if (!ready) return Promise.resolve({ cleared: false, pending: true });
    const pending = (async () => {
      // clear's transaction queues behind any already-started save. Later
      // saves carry the old epoch and cannot resurrect cleared references.
      const result = owner
        ? await owner.clear()
        : { cleared: false, reason: 'no-storage' };
      if (!state.current.active || token !== state.current.token) return result;
      if (result.cleared) {
        state.current.epoch = result.epoch;
        state.current.cleared = false;
        state.current.readFailed = false;
      } else setNotice(storageNotice(result.reason, result));
      setHydrated(true);
      return result;
    })();
    return pending;
  }, [owner, ready]);

  return { hydrated, notice, clear };
}
