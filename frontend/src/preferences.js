import { useCallback, useEffect, useState } from 'react';

const STORAGE_PREFIX = 'imagedials-';

/**
 * Values that could not be written to storage, kept for the page's lifetime so
 * a preference still holds across route changes when storage is denied. A name
 * is consulted only once storage has failed for it, so a working store and a
 * cleared one are never overridden by stale memory.
 */
const memory = new Map();

/** Forget values held only in memory (tests). */
export const resetPreferenceMemory = () => memory.clear();

export function readPreference(name, fallback, sanitize = (stored) => stored) {
  try {
    if (!memory.has(name)) {
      const stored = localStorage.getItem(STORAGE_PREFIX + name);
      if (stored !== null) return sanitize(JSON.parse(stored), fallback);
      return fallback;
    }
  } catch {
    /* Storage is unavailable or the value is malformed. */
    if (!memory.has(name)) return fallback;
  }
  return sanitize(memory.get(name), fallback);
}

const PREFERENCE_EVENT = 'imagedials-preference-change';

/** Apply an existing preference and notify mounted consumers in this window. */
export function writePreference(name, next) {
  let persisted = true;
  try {
    localStorage.setItem(STORAGE_PREFIX + name, JSON.stringify(next));
    memory.delete(name);
  } catch {
    memory.set(name, next);
    persisted = false;
  }
  window.dispatchEvent(new CustomEvent(PREFERENCE_EVENT, { detail: { name } }));
  return persisted;
}

/**
 * A viewer preference kept in browser storage. `sanitize(stored, fallback)`
 * must return a valid value for any stored input, so an old or edited entry
 * cannot put a screen in an impossible state. When storage is denied the
 * preference is kept in memory for the page's lifetime.
 */
export function usePreference(name, fallback, sanitize = (stored) => stored) {
  const [value, setValue] = useState(() =>
    readPreference(name, fallback, sanitize),
  );
  useEffect(() => {
    const sync = (event) => {
      if (event.type === 'storage') {
        if (event.key !== null && event.key !== STORAGE_PREFIX + name) return;
        memory.delete(name);
      } else if (event.detail?.name !== name) return;
      setValue(readPreference(name, fallback, sanitize));
    };
    window.addEventListener(PREFERENCE_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(PREFERENCE_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, [name, fallback, sanitize]);
  const update = useCallback(
    (next) => {
      setValue(next);
      writePreference(name, next);
    },
    [name],
  );
  return [value, update];
}

/** `true` unless the viewer asked for reduced motion. */
export const motionAllowed = () =>
  !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** Whether the viewer prefers reduced motion; follows later changes. */
export function useReducedMotion() {
  const [reduced, setReduced] = useState(() => !motionAllowed());
  useEffect(() => {
    const query = window.matchMedia?.(REDUCED_MOTION_QUERY);
    if (!query) return undefined;
    const sync = () => setReduced(query.matches);
    sync();
    query.addEventListener?.('change', sync);
    return () => query.removeEventListener?.('change', sync);
  }, []);
  return reduced;
}
