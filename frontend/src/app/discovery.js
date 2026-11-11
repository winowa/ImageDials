import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { api } from '../data/api/api.js';
import { providerRequest } from '../data/api/providerSettings.js';

const READS = {
  health: () => api.health(),
  models: (provider) => api.models(providerRequest(provider?.header)),
  capabilities: () => api.capabilities(),
};
const loading = { status: 'loading', data: null, error: null };

/**
 * Read-only server facts: health, model/size information and capabilities.
 * Reading them never starts inference.
 */
export function useDiscovery(provider = null) {
  const [state, setState] = useState({
    health: loading,
    models: loading,
    capabilities: loading,
  });
  const alive = useRef(true);
  const providerRef = useRef(provider);
  useLayoutEffect(() => {
    providerRef.current = provider;
  });
  /** Latest read per fact: a slower, older answer is discarded. */
  const reads = useRef({});

  const read = useCallback(
    (name, load) =>
      load(providerRef.current).then(
        (data) => ({ name, next: { status: 'ready', data, error: null } }),
        (error) => ({ name, next: { status: 'error', data: null, error } }),
      ),
    [],
  );

  const apply = useCallback((outcome) => {
    setState((prev) => ({ ...prev, [outcome.name]: outcome.next }));
  }, []);

  /** Explicit refresh: show loading, then settle. */
  const refresh = useCallback(
    (name, load) => {
      const token = (reads.current[name] = (reads.current[name] ?? 0) + 1);
      setState((prev) => ({ ...prev, [name]: loading }));
      return read(name, load).then((outcome) => {
        if (alive.current && reads.current[name] === token) apply(outcome);
      });
    },
    [read, apply],
  );

  useEffect(() => {
    // Initial state is already "loading", so the first reads set nothing early.
    alive.current = true;
    for (const [name, load] of Object.entries(READS)) {
      const token = (reads.current[name] = (reads.current[name] ?? 0) + 1);
      read(name, load).then((outcome) => {
        if (alive.current && reads.current[name] === token) apply(outcome);
      });
    }
    return () => {
      alive.current = false;
    };
  }, [read, apply]);

  // A different provider choice makes the model names stale: read them again.
  const providerId = provider?.id ?? null;
  const seenProvider = useRef(providerId);
  useEffect(() => {
    if (seenProvider.current === providerId) return;
    seenProvider.current = providerId;
    refresh('models', READS.models);
  }, [providerId, refresh]);

  return {
    ...state,
    reload: () =>
      Object.entries(READS).forEach(([name, load]) => refresh(name, load)),
    reloadModels: () => refresh('models', READS.models),
  };
}

/** Original download is offered unless the server turns it off. */
export const downloadEnabled = (capabilities) =>
  capabilities.data?.exports?.download_enabled !== false;

/** The browser print dialog is offered unless the server turns it off. */
export const browserPrintEnabled = (capabilities) =>
  capabilities.data?.exports?.browser_print_enabled !== false;
