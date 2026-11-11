import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPrivateLibrary } from './privateLibrary.js';
import { imageKey } from '../records/imageRecord.js';

const empty = () => ({
  binding: { q: '', limit: 24 },
  pages: [],
  activeIndex: -1,
  pending: null,
  error: null,
});
export function usePrivateLibrary({ store, enabled }) {
  const [replacedRecord, setReplacedRecord] = useState(null);
  const [window, setWindow] = useState(empty);
  const replace = useCallback((record) => {
    setReplacedRecord(record);
    setWindow((old) => ({
      ...old,
      pages: old.pages.map((page) => ({
        ...page,
        images: page.images.map((image) =>
          imageKey(image) === imageKey(record) &&
          image.local_added_at === record.local_added_at
            ? record
            : image,
        ),
      })),
    }));
  }, []);
  const repository = useMemo(
    () =>
      store?.readPrivatePage
        ? createPrivateLibrary(store, { onRecord: replace })
        : null,
    [store, replace],
  );
  const current = useRef(window);
  const serial = useRef(0);
  const load = useCallback(
    async (intent = {}) => {
      if (!enabled || !repository) return;
      const ticket = ++serial.current;
      const binding = intent.binding ?? current.current.binding;
      setWindow((old) => ({ ...old, binding, pending: ticket, error: null }));
      try {
        const result = await repository.load(intent);
        if (ticket === serial.current && result) {
          current.current = result;
          setWindow(result);
        }
      } catch (error) {
        if (ticket === serial.current && error.name !== 'AbortError') {
          const result = { ...current.current, binding, pending: null, error };
          current.current = result;
          setWindow(result);
        }
      }
    },
    [enabled, repository],
  );
  const cancel = useCallback(() => {
    serial.current++;
    repository?.cancel();
  }, [repository]);
  useEffect(() => {
    let disposed = false;
    current.current = empty();
    // Reconcile the external repository lifetime after the route commits.
    Promise.resolve().then(() => {
      if (!disposed) {
        setWindow(empty());
        setReplacedRecord(null);
      }
    });
    return () => {
      disposed = true;
      cancel();
    };
  }, [repository, enabled, cancel]);
  useEffect(() => {
    if (!enabled || !repository) return undefined;
    const refresh = () => {
      repository.refreshPins().catch(() => {});
      load({ direction: 'refresh', binding: current.current.binding });
    };
    const visible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    const unsubscribe = store.onPrivateChange(refresh);
    document.addEventListener('visibilitychange', visible);
    return () => {
      unsubscribe();
      document.removeEventListener('visibilitychange', visible);
    };
  }, [enabled, repository, store, load]);
  return { repository, window, load, replacedRecord };
}
