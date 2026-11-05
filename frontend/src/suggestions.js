import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { api } from './api.js';
import { providerRequest } from './providerSettings.js';

const emptyMode = { status: 'idle', items: [], provider: null, error: null };
const aborted = (error) => error?.name === 'AbortError';

function readSuggestions(response) {
  const list = response?.suggestions;
  if (
    !Array.isArray(list) ||
    !list.length ||
    list.some((item) => typeof item !== 'string' || !item.trim())
  )
    throw new Error('The prompt suggestions response was malformed.');
  return list;
}

/**
 * Prompt ideas per mode, cached for the session. A mode is fetched the first
 * time its page is ready and visible; only an explicit refresh asks again. A failed refresh
 * keeps the previous ideas and reports the actual error until the next try.
 * The server's content is never assumed, and nothing stands in for a failure.
 *
 * @param {'image'|'asset-image'} mode
 * @param {boolean} [enabled] nothing is requested while false (the ideas are
 *   page is not shown, or the server cannot run inference)
 * @param {{header: string|null, id: string}} [provider] the browser's provider
 *   choice. Ideas are cached per mode and provider, and a request for another
 *   provider is cancelled, so one provider's ideas never stand in for another's.
 */
export function useSuggestions(mode, enabled = true, provider = null) {
  const [byMode, setByMode] = useState({});
  const [visible, setVisible] = useState(
    () => document.visibilityState !== 'hidden',
  );
  const flights = useRef(new Map());
  const alive = useRef(true);
  const providerId = provider?.id ?? 'default';
  const header = useRef(provider?.header ?? null);
  const headerValue = provider?.header ?? null;
  useLayoutEffect(() => {
    header.current = headerValue;
  });
  const slot = `${providerId}|${mode}`;

  useEffect(() => {
    const changed = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', changed);
    return () => document.removeEventListener('visibilitychange', changed);
  }, []);

  const load = useCallback(
    (target) => {
      const cell = `${providerId}|${target}`;
      flights.current.get(cell)?.abort();
      const controller = new AbortController();
      flights.current.set(cell, controller);
      const patch = (change) =>
        setByMode((prev) => ({
          ...prev,
          [cell]: { ...emptyMode, ...prev[cell], ...change },
        }));
      // The previous ideas stay while a retry runs; its error clears at once.
      patch({ status: 'loading', error: null });
      return api
        .promptSuggestions(target, {
          ...providerRequest(header.current),
          signal: controller.signal,
        })
        .then(
          (response) => {
            if (!alive.current || flights.current.get(cell) !== controller)
              return;
            flights.current.delete(cell);
            try {
              patch({
                status: 'ready',
                items: readSuggestions(response),
                provider: response.provider ?? null,
              });
            } catch (error) {
              patch({ status: 'ready', error });
            }
          },
          (error) => {
            if (aborted(error) || !alive.current) return;
            if (flights.current.get(cell) !== controller) return;
            flights.current.delete(cell);
            patch({ status: 'ready', error });
          },
        );
    },
    [providerId],
  );

  // Requests made for another provider choice are no longer wanted.
  useEffect(() => {
    const pending = flights.current;
    for (const [cell, controller] of pending)
      if (!cell.startsWith(`${providerId}|`)) {
        controller.abort();
        pending.delete(cell);
      }
  }, [providerId]);

  useEffect(() => {
    alive.current = true;
    const pending = flights.current;
    return () => {
      alive.current = false;
      pending.forEach((controller) => controller.abort());
      pending.clear();
    };
  }, []);

  // First view of a mode fetches once. A "loading" mode with no request in
  // flight lost it to an unmount and starts again.
  const known = byMode[slot];
  const status = known?.status ?? 'idle';
  useEffect(() => {
    const flying = flights.current.has(slot);
    if (
      !enabled ||
      !visible ||
      flying ||
      (status !== 'idle' && status !== 'loading')
    )
      return undefined;
    // Let the page paint before starting inference. Opening the popover never
    // starts a second request: it reads this same pending/cached mode state.
    let nextFrame;
    const frame = requestAnimationFrame(() => {
      nextFrame = requestAnimationFrame(() => load(mode));
    });
    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(nextFrame);
    };
  }, [enabled, visible, mode, slot, status, load]);

  const state = known ?? { ...emptyMode, status: enabled ? 'loading' : 'idle' };
  return { ...state, refresh: () => load(mode) };
}
