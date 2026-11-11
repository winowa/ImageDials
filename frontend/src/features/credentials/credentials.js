/**
 * Content Credentials inspection in the browser (see docs/CONTENT-CREDENTIALS.md).
 *
 * The SDK and its WebAssembly are loaded only when an inspection starts, never
 * with the application bundle. Image bytes stay in the browser: remote
 * manifests, certificate status and trust lists are not fetched.
 *
 * Outcomes are the SDK's own, never invented here:
 * - no reader            -> ABSENT (the file carries no credentials)
 * - a rejected read      -> an error (inspection failed; says nothing about presence)
 * - `Trusted` / `Valid` / `Invalid` as reported; anything else is UNVERIFIED.
 * Signature validity and signer trust are separate checks and neither says the
 * pictured content is true.
 */

export const CREDENTIAL_STATE = Object.freeze({
  ABSENT: 'absent',
  TRUSTED: 'trusted',
  VALID: 'valid',
  INVALID: 'invalid',
  UNVERIFIED: 'unverified',
});

/** Short functional label per state. */
export const CREDENTIAL_LABEL = Object.freeze({
  [CREDENTIAL_STATE.ABSENT]: 'No credentials',
  [CREDENTIAL_STATE.TRUSTED]: 'Valid, trusted signer',
  [CREDENTIAL_STATE.VALID]: 'Valid, signer not trusted',
  [CREDENTIAL_STATE.INVALID]: 'Invalid',
  [CREDENTIAL_STATE.UNVERIFIED]: 'Unverified',
});

/** Verification settings: local only, nothing remote. */
export const READER_SETTINGS = Object.freeze({
  verify: Object.freeze({
    verifyAfterReading: true,
    verifyTrust: true,
    remoteManifestFetch: false,
    ocspFetch: false,
  }),
});

const SDK_STATE = {
  Trusted: CREDENTIAL_STATE.TRUSTED,
  Valid: CREDENTIAL_STATE.VALID,
  Invalid: CREDENTIAL_STATE.INVALID,
};

/** The state of a manifest store; a missing or unknown value is unverified. */
export const classifyStore = (store) =>
  Object.hasOwn(SDK_STATE, store?.validation_state)
    ? SDK_STATE[store.validation_state]
    : CREDENTIAL_STATE.UNVERIFIED;

const text = (value) => (typeof value === 'string' && value ? value : null);

/** The facts worth a glance, from whatever the active manifest provides. */
export function summarizeStore(store) {
  const manifest = store?.manifests?.[store?.active_manifest] ?? null;
  const signature = manifest?.signature_info ?? null;
  const generators = Array.isArray(manifest?.claim_generator_info)
    ? manifest.claim_generator_info.map((g) => text(g?.name)).filter(Boolean)
    : [];
  const issues = (
    Array.isArray(store?.validation_status) ? store.validation_status : []
  )
    .filter((entry) => text(entry?.code))
    .map((entry) => ({
      code: entry.code,
      explanation: text(entry.explanation),
    }));
  return {
    title: text(manifest?.title),
    signer: text(signature?.common_name) ?? text(signature?.issuer),
    issuer: text(signature?.issuer),
    algorithm: text(signature?.alg),
    signedAt: text(signature?.time),
    generators,
    assertions: Array.isArray(manifest?.assertions)
      ? manifest.assertions.length
      : null,
    manifests: store?.manifests ? Object.keys(store.manifests).length : 0,
    issues,
  };
}

const BOUND_STRING = 400;
const BOUND_ITEMS = 100;
const BOUND_DEPTH = 10;

/** A display copy with long strings, long lists and deep nesting clipped. */
export function boundForDisplay(value, depth = 0) {
  if (typeof value === 'string')
    return value.length > BOUND_STRING
      ? `${value.slice(0, BOUND_STRING)}… (${value.length - BOUND_STRING} more characters)`
      : value;
  if (value === null || typeof value !== 'object') return value;
  if (depth >= BOUND_DEPTH) return '… (nested data omitted)';
  if (Array.isArray(value)) {
    const items = value
      .slice(0, BOUND_ITEMS)
      .map((v) => boundForDisplay(v, depth + 1));
    if (value.length > BOUND_ITEMS)
      items.push(`… (${value.length - BOUND_ITEMS} more items)`);
    return items;
  }
  const entries = Object.entries(value);
  const out = Object.fromEntries(
    entries
      .slice(0, BOUND_ITEMS)
      .map(([k, v]) => [k, boundForDisplay(v, depth + 1)]),
  );
  if (entries.length > BOUND_ITEMS)
    out['…'] = `${entries.length - BOUND_ITEMS} more fields`;
  return out;
}

const abortError = () => new DOMException('Aborted', 'AbortError');

/** Load the SDK and the separately served WebAssembly on demand. */
export async function loadBrowserSdk() {
  const [sdk, wasm] = await Promise.all([
    import('@contentauth/c2pa-web'),
    import('@contentauth/c2pa-web/resources/c2pa.wasm?url'),
  ]);
  return {
    createC2pa: sdk.createC2pa,
    Reader: sdk.Reader,
    Context: sdk.Context,
    wasmSrc: new URL(wasm.default, globalThis.location.href).href,
  };
}

/**
 * One inspector owns at most one SDK worker. `dispose` ends it, also while a
 * read is in flight; later calls then reject as aborted.
 * @param {object} [options]
 * @param {() => Promise<object>} [options.loadSdk] injected for tests
 */
export function createCredentialsInspector({ loadSdk = loadBrowserSdk } = {}) {
  let disposed = false;
  let runtime = null;

  const ensure = () => {
    runtime ??= (async () => {
      const sdk = await loadSdk();
      if (disposed) throw abortError();
      const instance = await sdk.createC2pa({ wasmSrc: sdk.wasmSrc });
      if (disposed) {
        instance.dispose();
        throw abortError();
      }
      return { sdk, instance, context: new sdk.Context(READER_SETTINGS) };
    })().catch((error) => {
      runtime = null; // a failed start is retried, not remembered
      throw error;
    });
    return runtime;
  };

  return {
    /**
     * @param {Blob} blob the original file
     * @param {{signal?: AbortSignal}} [options]
     * @returns {Promise<{state: string, label: string, store: object|null, summary: object|null}>}
     */
    async inspect(blob, { signal } = {}) {
      if (disposed || signal?.aborted) throw abortError();
      const { sdk, instance, context } = await ensure();
      if (disposed || signal?.aborted) throw abortError();
      const format = blob.type?.startsWith('image/') ? blob.type : 'image/png';
      const reader = await sdk.Reader.fromBlob(instance, format, blob, context);
      if (!reader)
        return {
          state: CREDENTIAL_STATE.ABSENT,
          label: CREDENTIAL_LABEL[CREDENTIAL_STATE.ABSENT],
          store: null,
          summary: null,
        };
      try {
        const store = await reader.manifestStore();
        if (disposed || signal?.aborted) throw abortError();
        const state = classifyStore(store);
        return {
          state,
          label: CREDENTIAL_LABEL[state],
          store,
          summary: summarizeStore(store),
        };
      } finally {
        try {
          await reader.free();
        } catch {
          // The worker may already be gone; nothing is left to release.
        }
      }
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      const pending = runtime;
      runtime = null;
      pending?.then(({ instance }) => instance.dispose()).catch(() => {});
    },
  };
}
