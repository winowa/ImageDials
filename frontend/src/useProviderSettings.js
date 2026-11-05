import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from './api.js';
import {
  headerFor,
  loadOverrides,
  providerIdFor,
  saveOverrides,
} from './providerSettings.js';

const idleDefaults = { status: 'idle', data: null, error: null };

/**
 * The committed browser-private provider choices.
 *
 * `provider` is what requests use: the encoded header (null for the server
 * defaults) and an identity that separates caches. Saving always applies the
 * choice for this page; `persisted` reports whether the browser kept it.
 */
export function useProviderSettings() {
  const [initial] = useState(loadOverrides);
  const [overrides, setOverrides] = useState(initial.overrides);
  const [storageAvailable, setStorageAvailable] = useState(initial.available);
  const [defaults, setDefaults] = useState(idleDefaults);
  const run = useRef(0);

  const provider = useMemo(() => {
    const header = headerFor(overrides);
    return { header, id: providerIdFor(header) };
  }, [overrides]);

  /** Read the current server defaults (never contains a secret). */
  const loadDefaults = useCallback(() => {
    const token = ++run.current;
    setDefaults((prev) => ({ ...prev, status: 'loading', error: null }));
    return api.browserDefaults().then(
      (data) => {
        if (run.current !== token) return;
        setDefaults({ status: 'ready', data, error: null });
      },
      (error) => {
        if (run.current !== token) return;
        setDefaults((prev) => ({ ...prev, status: 'error', error }));
      },
    );
  }, []);

  useEffect(
    () => () => {
      run.current += 1;
    },
    [],
  );

  /** Apply `next` for this page and try to keep it in this browser. */
  const save = useCallback((next) => {
    const persisted = saveOverrides(next);
    setStorageAvailable(persisted);
    setOverrides(next);
    return { persisted };
  }, []);

  return {
    overrides,
    provider,
    defaults,
    loadDefaults,
    save,
    storageAvailable,
  };
}
