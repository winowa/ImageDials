/**
 * Browser-private provider choices.
 *
 * Only explicit overrides are stored; a field with no override follows the
 * server default, which is read from the defaults endpoint and never copied
 * into browser storage. Keys are stored as typed (they are the person's own)
 * and are never logged, exported or placed in a cache identifier.
 */

import { encodeProviderOverrides, PROVIDER_OVERRIDE_HEADER } from './api.js';

export const STORAGE_KEY = 'imagedials-provider-settings';
export const SETTINGS_VERSION = 1;
export const MAX_VALUE_CHARS = 1024;

export const KIND = { endpoint: 'endpoint', key: 'key', name: 'name' };

/** Editable fields, grouped as the panel shows them. This is the allowlist. */
export const PROVIDER_GROUPS = [
  {
    id: 'language',
    title: 'Language model',
    fields: [
      { name: 'LLM_MODEL_ENDPOINT_1', kind: KIND.endpoint, label: 'Endpoint' },
      { name: 'LLM_MODEL_KEY_1', kind: KIND.key, label: 'API key' },
      { name: 'LLM_MODEL_NAME', kind: KIND.name, label: 'Model name' },
    ],
  },
  {
    id: 'image',
    title: 'Image model',
    fields: [
      {
        name: 'IMAGE_MODEL_ENDPOINT_1',
        kind: KIND.endpoint,
        label: 'Endpoint',
      },
      { name: 'IMAGE_MODEL_KEY_1', kind: KIND.key, label: 'API key' },
    ],
  },
  {
    id: 'editing',
    title: 'Image editing model',
    fields: [
      {
        name: 'IMAGE_EDIT_MODEL_ENDPOINT',
        kind: KIND.endpoint,
        label: 'Endpoint',
      },
      { name: 'IMAGE_EDIT_MODEL_KEY', kind: KIND.key, label: 'API key' },
    ],
  },
  {
    id: 'description',
    title: 'Image description model',
    fields: [
      {
        name: 'DESCRIPTION_MODEL_ENDPOINT',
        kind: KIND.endpoint,
        label: 'Endpoint',
      },
      { name: 'DESCRIPTION_MODEL_KEY', kind: KIND.key, label: 'API key' },
      { name: 'DESCRIPTION_MODEL_NAME', kind: KIND.name, label: 'Model name' },
    ],
  },
];

export const FIELDS = PROVIDER_GROUPS.flatMap((group) => group.fields);
const BY_NAME = new Map(FIELDS.map((field) => [field.name, field]));
export const KEY_FIELDS = FIELDS.filter((f) => f.kind === KIND.key).map(
  (f) => f.name,
);
/** The key field that belongs to each endpoint field. */
export const KEY_FOR_ENDPOINT = {
  LLM_MODEL_ENDPOINT_1: 'LLM_MODEL_KEY_1',
  IMAGE_MODEL_ENDPOINT_1: 'IMAGE_MODEL_KEY_1',
  DESCRIPTION_MODEL_ENDPOINT: 'DESCRIPTION_MODEL_KEY',
  IMAGE_EDIT_MODEL_ENDPOINT: 'IMAGE_EDIT_MODEL_KEY',
};

/** Why `value` cannot be used for `name`, or null. Messages never echo values. */
export function validateField(name, value) {
  const field = BY_NAME.get(name);
  if (!field) return 'This setting is not supported.';
  if (typeof value !== 'string') return 'Enter text.';
  if (value.length > MAX_VALUE_CHARS)
    return `Use at most ${MAX_VALUE_CHARS} characters.`;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return 'Use a single line.';
  if (field.kind === KIND.endpoint && value) {
    let url;
    try {
      url = new URL(value);
    } catch {
      return 'Enter a full http:// or https:// address.';
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
      return 'Use an http:// or https:// address.';
    if (url.username || url.password)
      return 'Remove the user name or password from the address.';
    if (url.search || url.hash) return 'Remove the query or fragment.';
  }
  return null;
}

/** Keep only supported, valid, non-blank string overrides. */
export function cleanOverrides(raw) {
  const clean = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return clean;
  for (const field of FIELDS) {
    const value = raw[field.name];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed && !validateField(field.name, trimmed))
      clean[field.name] = trimmed;
  }
  if (['generation', 'separate'].includes(raw.IMAGE_EDIT_ROUTE))
    clean.IMAGE_EDIT_ROUTE = raw.IMAGE_EDIT_ROUTE;
  try {
    headerFor(clean);
  } catch {
    return {};
  }
  return clean;
}

/**
 * Read stored overrides. `available` is false when storage is denied; corrupt
 * or future-version content is ignored rather than trusted.
 */
export function loadOverrides(storage = safeStorage()) {
  if (!storage) return { overrides: {}, available: false };
  let text;
  try {
    text = storage.getItem(STORAGE_KEY);
  } catch {
    return { overrides: {}, available: false };
  }
  try {
    if (!text) return { overrides: {}, available: true };
    const parsed = JSON.parse(text);
    if (parsed?.v !== SETTINGS_VERSION)
      return { overrides: {}, available: true };
    return { overrides: cleanOverrides(parsed.overrides), available: true };
  } catch {
    return { overrides: {}, available: true };
  }
}

/** Persist overrides; false when the browser refuses (denied, full). */
export function saveOverrides(overrides, storage = safeStorage()) {
  if (!storage) return false;
  try {
    if (!Object.keys(overrides).length) storage.removeItem(STORAGE_KEY);
    else
      storage.setItem(
        STORAGE_KEY,
        JSON.stringify({ v: SETTINGS_VERSION, overrides }),
      );
    return true;
  } catch {
    return false;
  }
}

function safeStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** What an input shows before any edit: the override, else the server default. */
export function valuesFor(overrides, defaults) {
  const values = {};
  for (const field of FIELDS) {
    values[field.name] =
      overrides[field.name] ??
      (field.kind === KIND.key
        ? ''
        : (defaults?.providers?.[field.name] ?? ''));
  }
  values.IMAGE_EDIT_ROUTE =
    overrides.IMAGE_EDIT_ROUTE ?? defaults?.editing?.route ?? 'generation';
  return values;
}

/** Whether the input holds a custom value rather than the server default. */
export function isCustom(name, value, defaults) {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (BY_NAME.get(name).kind === KIND.key) return true;
  return trimmed !== (defaults?.providers?.[name] ?? '');
}

/** Convert edited input values into the override set that is stored. */
export function overridesFromValues(values, defaults) {
  const overrides = {};
  for (const field of FIELDS) {
    const value = (values[field.name] ?? '').trim();
    // Inactive editing fields may be unfinished. Retain only valid values,
    // never a credential-bearing URL that was hidden by choosing same-as.
    if (
      field.name.startsWith('IMAGE_EDIT_') &&
      values.IMAGE_EDIT_ROUTE !== 'separate' &&
      validateField(field.name, value)
    )
      continue;
    if (isCustom(field.name, value, defaults)) overrides[field.name] = value;
  }
  if (
    values.IMAGE_EDIT_ROUTE &&
    (values.IMAGE_EDIT_ROUTE !== (defaults?.editing?.route ?? 'generation') ||
      overrides.IMAGE_EDIT_MODEL_ENDPOINT ||
      overrides.IMAGE_EDIT_MODEL_KEY)
  )
    overrides.IMAGE_EDIT_ROUTE = values.IMAGE_EDIT_ROUTE;
  return overrides;
}

/** First problem per field in an edited value set. */
export function validateValues(values, defaults) {
  const errors = {};
  for (const field of FIELDS) {
    if (
      field.name.startsWith('IMAGE_EDIT_') &&
      values.IMAGE_EDIT_ROUTE !== 'separate'
    )
      continue;
    const problem = validateField(
      field.name,
      (values[field.name] ?? '').trim(),
    );
    if (problem) errors[field.name] = problem;
  }
  if (
    values.IMAGE_EDIT_ROUTE === 'separate' &&
    !values.IMAGE_EDIT_MODEL_ENDPOINT?.trim()
  )
    errors.IMAGE_EDIT_MODEL_ENDPOINT = 'Enter an image editing endpoint.';
  if (!Object.keys(errors).length) {
    try {
      headerFor(overridesFromValues(values, defaults));
    } catch {
      errors.LLM_MODEL_NAME =
        'Provider settings exceed the request size limit. Shorten the custom values.';
    }
  }
  return errors;
}

/** The request header for these overrides, or null when nothing is overridden. */
export function headerFor(overrides) {
  const active = { ...overrides };
  if (active.IMAGE_EDIT_ROUTE === 'generation') {
    delete active.IMAGE_EDIT_MODEL_ENDPOINT;
    delete active.IMAGE_EDIT_MODEL_KEY;
  }
  return Object.keys(active).length ? encodeProviderOverrides(active) : null;
}

/**
 * A short non-reversible identity for these overrides, used only to separate
 * in-memory caches. Two 32-bit FNV-1a passes over the canonical header.
 */
export function providerIdFor(header) {
  if (!header) return 'default';
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ header.length;
  for (let i = 0; i < header.length; i += 1) {
    const code = header.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ code, 0x85ebca6b) >>> 0;
  }
  return `p${a.toString(36)}${b.toString(36)}`;
}

/** Request options carrying the provider header; none for the defaults. */
export const providerRequest = (header) =>
  header ? { headers: { [PROVIDER_OVERRIDE_HEADER]: header } } : {};

/**
 * Whether the server key applies: only at the server's own endpoint. A custom
 * endpoint with no explicit key gets none.
 */
export function usesServerKey(keyName, values, defaults) {
  const endpoint = Object.entries(KEY_FOR_ENDPOINT).find(
    ([, key]) => key === keyName,
  )?.[0];
  if (!endpoint) return false;
  if (!defaults?.keys_configured?.[keyName]) return false;
  const typed = (values[endpoint] ?? '').trim();
  return !isCustom(endpoint, typed, defaults);
}
