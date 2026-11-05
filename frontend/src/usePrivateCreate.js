import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { imageKey } from './imageRecord.js';
import { createPrivateLibrary, privateLibraryView } from './privateLibrary.js';

const emptyWindow = () => ({
  rows: [],
  bytes: 0,
  seq: null,
  next: null,
  previous: null,
  pending: null,
  error: null,
  missing: null,
  oversized: false,
  complete: false,
});
const DISABLED_WINDOW = Object.freeze(emptyWindow());
const noop = () => {};

function toView(row) {
  return privateLibraryView(row);
}

/** Create's private metadata window; it never hydrates the private catalog. */
export function usePrivateCreate({ store, enabled, onRecord = noop }) {
  const [window, setWindow] = useState(emptyWindow);
  const [pinError, setPinError] = useState(null);
  const pinErrorRef = useRef(null);
  const [missingPins, setMissingPins] = useState([]);
  const rolePins = useRef(new Map());
  const updateRecord = useCallback(
    (record) => {
      onRecord(record);
      setWindow((old) => ({
        ...old,
        rows: old.rows.map((row) =>
          row.key === imageKey(record) && row.addedAt === record.local_added_at
            ? { ...row, record }
            : row,
        ),
      }));
    },
    [onRecord],
  );
  const repository = useMemo(
    () =>
      store?.readPrivatePage
        ? createPrivateLibrary(store, {
            onRecord: updateRecord,
          })
        : null,
    [store, updateRecord],
  );
  const live = useRef({ repository, window, enabled, store });
  const ticket = useRef(0);
  const invalidate = useCallback(() => {
    ticket.current++;
  }, []);
  const rows = useMemo(() => window.rows.map(toView), [window.rows]);
  useLayoutEffect(() => {
    live.current = { repository, window, enabled, store };
  }, [repository, window, enabled, store]);

  const load = useCallback(
    async (intent = {}) => {
      const current = live.current;
      if (!enabled || !current.repository) return null;
      const run = ++ticket.current;
      setWindow((old) => ({ ...old, pending: run, error: null }));
      try {
        const catalog = current.repository.catalog;
        let response;
        switch (intent.direction ?? 'first') {
          case 'older':
            response = await catalog.older('create');
            break;
          case 'newer':
            response = await catalog.newer('create');
            break;
          case 'around':
            response = await catalog.around('create', intent.identity, {
              before: intent.before,
              after: intent.after,
            });
            break;
          case 'last': {
            response = await catalog.last('create');
            break;
          }
          case 'refresh':
          case 'first':
            response = await catalog.first('create');
            break;
          default:
            throw new TypeError('Unknown private Create history direction.');
        }
        if (run !== ticket.current || !live.current.enabled)
          return { accepted: false, stale: true };
        const next = catalog.snapshot('create');
        setWindow(next);
        return { ...response, state: next };
      } catch (error) {
        if (run !== ticket.current) return { accepted: false, stale: true };
        setWindow((old) => ({ ...old, pending: null, error }));
        return { accepted: false, stale: false, error };
      }
    },
    [enabled],
  );

  const exact = useCallback(
    async (image) => {
      if (!repository || !image || !Number.isFinite(image.local_added_at))
        return null;
      const metadata = await repository.catalog.confirm({
        key: imageKey(image),
        addedAt: image.local_added_at,
      });
      return metadata ? toView(metadata) : null;
    },
    [repository],
  );

  const byKey = useCallback(
    async (key, { signal } = {}) => {
      if (!repository || typeof key !== 'string' || !key) return null;
      const cancelled = () => {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      };
      cancelled();
      const direct = await repository.catalog.lookup(key);
      cancelled();
      if (direct) return toView(direct);
      // Edit URLs identify a result by image id; local storage may use its
      // storage/filename key instead. Search metadata slices without reading
      // any original bytes or retaining the complete private history.
      let anchor = null;
      for (;;) {
        const page = await store.scanPrivateSlice({ anchor });
        cancelled();
        const found = page.rows.find((row) =>
          [
            row.key,
            row.record.image_id,
            row.record.id,
            row.record.client_key,
          ].includes(key),
        );
        if (found) {
          const current = await repository.catalog.confirm({
            key: found.key,
            addedAt: found.addedAt,
          });
          cancelled();
          return current ? toView(current) : null;
        }
        if (page.done || !page.cursor) return null;
        anchor = page.cursor;
      }
    },
    [repository, store],
  );

  const pinRole = useCallback(
    (role, image) => {
      const catalog = repository?.catalog;
      if (!catalog) return { accepted: false, reason: 'unavailable' };
      const previous = rolePins.current.get(role) ?? null;
      const identity =
        image && Number.isFinite(image.local_added_at)
          ? { key: imageKey(image), addedAt: image.local_added_at }
          : image &&
              typeof image.key === 'string' &&
              Number.isFinite(image.addedAt)
            ? { key: image.key, addedAt: image.addedAt }
            : null;
      if (
        previous &&
        identity &&
        previous.key === identity.key &&
        previous.addedAt === identity.addedAt
      )
        return { accepted: true };
      if (previous) catalog.unpin(previous, role);
      rolePins.current.delete(role);
      if (!identity) {
        const missing = rolePins.current.get(role);
        if (missing)
          setMissingPins((items) =>
            items.some((item) => item.role === role)
              ? items.filter((item) => item.role !== role)
              : items,
          );
        if (pinErrorRef.current !== null) {
          pinErrorRef.current = null;
          setPinError(null);
        }
        return { accepted: true };
      }
      const result = catalog.pin(identity, role);
      if (result.accepted) rolePins.current.set(role, identity);
      if (result.accepted)
        setMissingPins((items) =>
          items.some((item) => item.role === role)
            ? items.filter((item) => item.role !== role)
            : items,
        );
      const error = result.accepted
        ? null
        : 'Too many private image actions are active. Close an image and retry.';
      if (pinErrorRef.current !== error) {
        pinErrorRef.current = error;
        setPinError(error);
      }
      return result;
    },
    [repository],
  );

  useEffect(() => {
    if (!enabled || !repository) {
      invalidate();
      return undefined;
    }
    const refresh = async () => {
      const catalog = repository.catalog;
      const missing = [];
      for (const [role, identity] of rolePins.current) {
        if (!(await catalog.confirm(identity)))
          missing.push({ role, identity });
      }
      setMissingPins(missing);
      repository.refreshPins().catch(() => {});
      load({ direction: 'refresh' });
    };
    const unsubscribe = store.onPrivateChange(refresh);
    const visible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', visible);
    return () => {
      invalidate();
      unsubscribe();
      document.removeEventListener('visibilitychange', visible);
    };
  }, [enabled, repository, store, load, invalidate]);

  return {
    repository,
    window:
      !enabled || !repository
        ? DISABLED_WINDOW
        : { ...window, rows, complete: false },
    load,
    exact,
    byKey,
    pinRole,
    pinError,
    missingPins,
  };
}
