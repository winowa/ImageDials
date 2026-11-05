import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  ACCENT_KEY,
  applyAppearance,
  DEFAULT_ACCENT,
  LIGHT_QUERY,
  loadAccent,
  loadMode,
  MODE_KEY,
  resolveAccent,
  resolveTheme,
  saveAccent,
  saveMode,
  systemPrefersLight,
} from './appearance.js';

/**
 * The one owner of colour mode and accent. Applies them to the document,
 * follows system scheme changes and other tabs, and reports whether the
 * choice could be saved in this browser.
 */
export function useAppearance() {
  const [mode, setModeState] = useState(loadMode);
  const [accent, setAccentState] = useState(loadAccent);
  const [systemLight, setSystemLight] = useState(systemPrefersLight);
  const [saved, setSaved] = useState(true);

  const theme = resolveTheme(mode, systemLight);
  const resolved = useMemo(() => resolveAccent(theme, accent), [theme, accent]);

  useEffect(() => {
    applyAppearance(mode, theme, resolved.tokens);
  }, [mode, theme, resolved]);

  useEffect(() => {
    const query = window.matchMedia?.(LIGHT_QUERY);
    if (!query) return undefined;
    const sync = () => setSystemLight(query.matches);
    sync();
    query.addEventListener?.('change', sync);
    return () => query.removeEventListener?.('change', sync);
  }, []);

  useEffect(() => {
    const onStorage = (event) => {
      // `key` is null when another tab cleared all storage.
      if (event.key === null || event.key === MODE_KEY)
        setModeState(loadMode());
      if (event.key === null || event.key === ACCENT_KEY)
        setAccentState(loadAccent());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const setMode = useCallback((next) => {
    setModeState(next);
    setSaved(saveMode(next));
  }, []);

  // The latest accent, so rapid slider events never write a stale value.
  const latest = useRef(accent);
  useEffect(() => {
    latest.current = accent;
  }, [accent]);
  const commitAccent = useCallback((next) => {
    latest.current = next;
    setAccentState(next);
    setSaved(saveAccent(next));
  }, []);
  const setAccent = useCallback(
    (patch) => commitAccent({ ...latest.current, ...patch }),
    [commitAccent],
  );

  const resetAccent = useCallback(
    () => commitAccent({ ...DEFAULT_ACCENT }),
    [commitAccent],
  );

  return {
    mode,
    theme,
    accent,
    resolved,
    saved,
    setMode,
    setAccent,
    resetAccent,
  };
}
