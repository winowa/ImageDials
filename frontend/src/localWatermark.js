/**
 * The watermark CONTENT this browser uses, private to this browser.
 *
 * Only the person's choice is stored: `{type: 'text', text}` or
 * `{type: 'svg', svg_markup, svg_recolor}`. The fingerprint, limits and
 * rendering policy are never stored; they come back from the server each time
 * the choice is validated, so a changed policy cannot leave a stale document
 * behind. With no stored choice the server's defaults apply
 * (`GET /api/browser-settings/defaults`, from `WATERMARK_DEFAULT_TEXT` or the
 * server's current setting). Saving validates through
 * `POST /api/browser-settings/watermark/validate` and never calls the shared
 * settings write. Text is small and lives in LocalStorage; SVG markup lives in
 * the cache database. Denied storage keeps the choice for this page only.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from './api.js';
import { sameSettings, stableJson } from './privateWatermark.js';
import { untilAborted } from './runRegistry.js';

export const CONTENT_STORAGE_KEY = 'imagedials-watermark-content';
export const SVG_SETTING = 'watermark-svg';
const CONTENT_VERSION = 1;
/** Stored text beyond this is not a watermark text (4 lines x 16 characters). */
const MAX_STORED_TEXT_CHARS = 1024;
/** Matches the server's SVG byte limit with room for multi-byte text. */
const MAX_STORED_SVG_CHARS = 65536;
const HTTP_INVALID = new Set([400, 422]);

/** The content part of any settings or editor body. */
export function contentBody(source) {
  if (source?.type === 'svg')
    return {
      type: 'svg',
      svg_markup: String(source.svg_markup ?? ''),
      svg_recolor: source.svg_recolor !== false,
    };
  return { type: 'text', text: String(source?.text ?? '') };
}

export const sameContent = (a, b) =>
  stableJson(contentBody(a)) === stableJson(contentBody(b));

const safeStorage = () => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

/**
 * Read the stored choice. Corrupt, future-version or oversized entries are
 * ignored rather than trusted.
 * @param {{storage?: Storage|null, settings?: object|null}} [options]
 *   `settings` is the cache store's local settings store (SVG markup)
 * @returns {Promise<{body: object|null, available: boolean}>}
 */
export async function loadContent({
  storage = safeStorage(),
  settings = null,
} = {}) {
  if (!storage) return { body: null, available: false };
  let parsed;
  try {
    const text = storage.getItem(CONTENT_STORAGE_KEY);
    if (!text) return { body: null, available: true };
    parsed = JSON.parse(text);
  } catch {
    return { body: null, available: true };
  }
  if (parsed?.v !== CONTENT_VERSION) return { body: null, available: true };
  if (parsed.type === 'text') {
    const ok =
      typeof parsed.text === 'string' &&
      parsed.text.length <= MAX_STORED_TEXT_CHARS;
    return {
      body: ok ? { type: 'text', text: parsed.text } : null,
      available: true,
    };
  }
  if (parsed.type === 'svg' && settings) {
    try {
      const markup = await settings.readSetting(SVG_SETTING);
      if (typeof markup === 'string' && markup.length <= MAX_STORED_SVG_CHARS)
        return {
          body: {
            type: 'svg',
            svg_markup: markup,
            svg_recolor: parsed.svg_recolor !== false,
          },
          available: true,
        };
    } catch {
      /* Unreadable markup is the same as none. */
    }
  }
  return { body: null, available: true };
}

/**
 * Keep the choice in this browser.
 * @returns {Promise<{persisted: boolean}>} false when the browser refused it
 */
export async function saveContent(
  body,
  { storage = safeStorage(), settings = null } = {},
) {
  const remember = (entry) => {
    if (!storage) return false;
    try {
      if (entry) storage.setItem(CONTENT_STORAGE_KEY, JSON.stringify(entry));
      else storage.removeItem(CONTENT_STORAGE_KEY);
      return true;
    } catch {
      return false;
    }
  };
  if (body.type === 'svg') {
    const stored = settings
      ? await settings.writeSetting(SVG_SETTING, body.svg_markup)
      : { persisted: false };
    if (!stored.persisted) {
      // A pointer without its markup would be worse than none.
      remember(null);
      return { persisted: false };
    }
    return {
      persisted: remember({
        v: CONTENT_VERSION,
        type: 'svg',
        svg_recolor: body.svg_recolor,
      }),
    };
  }
  const persisted = remember({
    v: CONTENT_VERSION,
    type: 'text',
    text: body.text,
  });
  await settings?.deleteSetting(SVG_SETTING);
  return { persisted };
}

/** Remove the stored choice, so the server defaults apply again. */
export async function clearContent({
  storage = safeStorage(),
  settings = null,
} = {}) {
  try {
    storage?.removeItem(CONTENT_STORAGE_KEY);
  } catch {
    /* Nothing stored that could be removed. */
  }
  await settings?.deleteSetting(SVG_SETTING);
}

const initial = {
  phase: 'loading',
  override: null,
  settings: null,
  defaults: null,
  error: null,
  invalid: null,
  persisted: true,
};

/**
 * The effective watermark settings of this browser and their owner.
 *
 * `settings` is what every consumer uses: the validated stored choice, or the
 * server defaults. `refresh(signal)` re-reads the defaults and re-validates
 * the choice so a prepare run always works from the server's current policy;
 * concurrent calls share one exchange.
 *
 * @param {{store: object|null, ready: boolean}} options the cache store
 */
export function useLocalWatermark({ store, ready }) {
  const [state, setState] = useState(initial);
  const override = useRef(null);
  const generation = useRef(0);
  const inflight = useRef(null);
  const alive = useRef(true);
  const kv = store?.local ?? null;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const commit = useCallback((mutate) => {
    if (alive.current) setState(mutate);
  }, []);

  const exchange = useCallback(async () => {
    const started = generation.current;
    const defaults = await api.browserDefaults();
    const body = override.current;
    let settings = defaults.watermark;
    let invalid = null;
    if (body) {
      try {
        settings = await api.validateBrowserWatermark(body);
      } catch (error) {
        // Content the server now rejects is reported; the defaults apply.
        if (!HTTP_INVALID.has(error?.status)) throw error;
        invalid = error.message;
      }
    }
    if (generation.current === started)
      commit((prev) => ({
        ...prev,
        phase: 'ready',
        defaults: defaults.watermark,
        settings: sameSettings(prev.settings, settings)
          ? prev.settings
          : settings,
        invalid,
        error: null,
      }));
    return settings;
  }, [commit]);

  /** The effective settings now, revalidated against the server's policy. */
  const refresh = useCallback(
    (signal) => {
      if (!inflight.current) {
        const run = exchange().finally(() => {
          if (inflight.current === run) inflight.current = null;
        });
        run.catch((error) =>
          commit((prev) => ({
            ...prev,
            phase: prev.settings ? prev.phase : 'error',
            error,
          })),
        );
        inflight.current = run;
      }
      return untilAborted(inflight.current, signal);
    },
    [commit, exchange],
  );

  // Load the stored choice once the database attempt has settled.
  useEffect(() => {
    if (!ready) return;
    let current = true;
    (async () => {
      const stored = await loadContent({ settings: kv });
      if (!current) return;
      override.current = stored.body;
      generation.current += 1;
      commit((prev) => ({ ...prev, override: stored.body }));
      refresh().catch(() => {});
    })();
    return () => {
      current = false;
    };
  }, [ready, kv, commit, refresh]);

  /**
   * Validate and keep new content for this browser.
   * Rejects with the server's reason when the content is not valid.
   * @returns {Promise<{persisted: boolean}>}
   */
  const save = useCallback(
    async (body) => {
      const content = contentBody(body);
      const settings = await api.validateBrowserWatermark(content);
      const outcome = await saveContent(content, { settings: kv });
      override.current = content;
      generation.current += 1;
      inflight.current = null;
      commit((prev) => ({
        ...prev,
        phase: 'ready',
        override: content,
        settings,
        invalid: null,
        error: null,
        persisted: outcome.persisted,
      }));
      return outcome;
    },
    [commit, kv],
  );

  /** Remove this browser's choice and use the server's current defaults. */
  const reset = useCallback(async () => {
    const defaults = await api.browserDefaults();
    await clearContent({ settings: kv });
    override.current = null;
    generation.current += 1;
    inflight.current = null;
    commit((prev) => ({
      ...prev,
      phase: 'ready',
      override: null,
      defaults: defaults.watermark,
      settings: defaults.watermark,
      invalid: null,
      error: null,
      persisted: true,
    }));
    return defaults.watermark;
  }, [commit, kv]);

  return {
    settings: state.settings,
    defaults: state.defaults,
    override: state.override,
    custom: state.override !== null,
    phase: state.phase,
    error: state.error,
    invalid: state.invalid,
    persisted: state.persisted,
    save,
    reset,
    refresh,
  };
}
