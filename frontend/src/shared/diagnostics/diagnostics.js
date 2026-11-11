/**
 * Structured technical details for a warning or error, kept alongside the
 * concise message a surface shows. A diagnostic records only what actually
 * happened: an HTTP failure keeps its status, endpoint and exact (redacted,
 * bounded) body; a network rejection says no response arrived; a local
 * failure keeps its own reason. Nothing is invented to fill a field.
 *
 * Every string that could carry a credential passes through `redactText`
 * before it is stored, clipped or displayed.
 */

export const DIAGNOSTIC_KIND = Object.freeze({
  http: 'http',
  network: 'network',
  local: 'local',
  job: 'job',
});

/** Longest response body kept, after redaction. */
export const MAX_BODY_CHARS = 64 * 1024;
const MAX_SHORT_CHARS = 2000;
export const REDACTED = '[redacted]';

const REQUEST_ID_HEADERS = [
  'X-Request-ID',
  'X-Correlation-ID',
  'X-Amzn-RequestId',
  'Request-Id',
];

/* ------------------------------------------------------------------ */
/* Redaction                                                           */
/* ------------------------------------------------------------------ */

const SENSITIVE_SUFFIXES = [
  'apikey',
  'token',
  'secret',
  'password',
  'passwd',
  'authorization',
  'cookie',
  'cookies',
  'tokens',
  'secrets',
  'passwords',
  'credential',
  'credentials',
  'privatekey',
  'accesskey',
  'secretkey',
  'sessionid',
  'signature',
  'bearer',
];
const SENSITIVE_EXACT = new Set([
  'auth',
  'pass',
  'pwd',
  'session',
  'sig',
  'key',
  'ximagedialsprovideroverrides',
]);

const normalizeName = (name) =>
  String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

/**
 * Whether a field, header or parameter name holds a credential. `inUrl`
 * also treats a bare `key` (common for provider API keys) as sensitive.
 */
export function isSensitiveName(name, { inUrl = false } = {}) {
  const normalized = normalizeName(name);
  if (!normalized) return false;
  if (SENSITIVE_EXACT.has(normalized)) return true;
  if (inUrl && (normalized === 'key' || normalized === 'code')) return true;
  return SENSITIVE_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

/** Name fragments that make a quoted field or header sensitive in raw text. */
const NAME_PATTERN =
  '[A-Za-z0-9_.-]*(?:api[_-]?key|token|secret|password|passwd|authorization|cookie|credentials?|private[_-]?key|access[_-]?key|session[_-]?id|signature|bearer)|auth|pass|pwd|session|sig|x-imagedials-provider-overrides';

const TEXT_RULES = [
  // "name": "value" inside JSON text (string values, escapes kept intact).
  [
    new RegExp(`("(?:${NAME_PATTERN})"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`, 'gi'),
    `$1"${REDACTED}"`,
  ],
  // "name": 12345 / true: non-string credential values in JSON text.
  [
    new RegExp(
      `("(?:${NAME_PATTERN})"\\s*:\\s*)(-?\\d[\\d.eE+-]*|true|false)`,
      'gi',
    ),
    `$1"${REDACTED}"`,
  ],
  // Header-style lines: "Authorization: Bearer abc", "Set-Cookie: a=b".
  [
    /\b((?:proxy-)?authorization|set-cookie|cookie|x-api-key|api-key|x-goog-api-key|x-auth-token|x-imagedials-provider-overrides)(\s*:\s*)[^\r\n]+/gi,
    `$1$2${REDACTED}`,
  ],
  // Authorization schemes wherever they appear.
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  // Credentials embedded in a URL.
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:"'<>]+:[^\s/@"'<>]+@/gi, `$1${REDACTED}@`],
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@"'<>]+@/gi, `$1${REDACTED}@`],
  // name=value in query strings, form bodies and prose.
  [
    new RegExp(
      `(^|[?&;\\s,"'(])((?:${NAME_PATTERN}|key|code))=([^&\\s"'<>;,)]*)`,
      'gi',
    ),
    (match, lead, name, value) =>
      value ? `${lead}${name}=${REDACTED}` : match,
  ],
  // Well-known provider key formats.
  [
    /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{30,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|hf_[A-Za-z0-9]{20,}|r8_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g,
    REDACTED,
  ],
];

/** Redact JSON field values in place, including escaped keys and composite values. */
function redactJsonFields(text) {
  const edits = [];
  const stringEnd = (start) => {
    for (let i = start + 1; i < text.length; i++) {
      if (text[i] === '\\') i++;
      else if (text[i] === '"') return i + 1;
    }
    return text.length;
  };
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '"') continue;
    const end = stringEnd(i);
    let name;
    try {
      name = JSON.parse(text.slice(i, end));
    } catch {
      i = end - 1;
      continue;
    }
    let start = end;
    while (/\s/.test(text[start] ?? '') && start < text.length) start++;
    if (text[start] !== ':' || !isSensitiveName(name)) {
      i = end - 1;
      continue;
    }
    start++;
    while (/\s/.test(text[start] ?? '') && start < text.length) start++;
    let stop = start;
    if (text[start] === '"') stop = stringEnd(start);
    else if (text[start] === '{' || text[start] === '[') {
      let depth = 0;
      for (; stop < text.length; stop++) {
        if (text[stop] === '"') {
          stop = stringEnd(stop) - 1;
          continue;
        }
        if ('{['.includes(text[stop])) depth++;
        if ('}]'.includes(text[stop]) && --depth === 0) {
          stop++;
          break;
        }
      }
    } else {
      while (stop < text.length && !/[,}\]\r\n]/.test(text[stop])) stop++;
    }
    if (stop > start) edits.push([start, stop]);
    i = Math.max(end - 1, stop - 1);
  }
  for (let i = edits.length - 1; i >= 0; i--) {
    const [start, end] = edits[i];
    text = text.slice(0, start) + JSON.stringify(REDACTED) + text.slice(end);
  }
  return text;
}

/**
 * Replace credentials in free text while leaving every other character as it
 * was received. Returns the text and whether anything was replaced.
 * @param {string} text
 * @returns {{text: string, redacted: boolean}}
 */
export function redactTextReport(text) {
  if (typeof text !== 'string' || !text)
    return { text: text ?? '', redacted: false };
  let out = redactJsonFields(text);
  // Decode names only for classification; preserve every noncredential URL byte.
  out = out.replace(
    /([?&])([^#&=\s"'<>]+)=([^#&\s"'<>]*)/g,
    (match, lead, name, value) => {
      let decoded;
      try {
        decoded = decodeURIComponent(name.replaceAll('+', ' '));
      } catch {
        decoded = name;
      }
      return value && isSensitiveName(decoded, { inUrl: true })
        ? `${lead}${name}=${REDACTED}`
        : match;
    },
  );
  for (const [pattern, replacement] of TEXT_RULES)
    out = out.replace(pattern, replacement);
  return { text: out, redacted: out !== text };
}

export const redactText = (text) => redactTextReport(text).text;

/** A deep copy with credential fields replaced and string values scrubbed. */
export function redactValue(value, depth = 0) {
  if (depth > 40) return '[data omitted: nesting limit]';
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, child] of Object.entries(value))
      Object.defineProperty(out, key, {
        enumerable: true,
        configurable: true,
        writable: true,
        value:
          isSensitiveName(key) && child !== null && child !== ''
            ? REDACTED
            : redactValue(child, depth + 1),
      });
    return out;
  }
  return value;
}

/**
 * A relative, display-safe endpoint: the origin is dropped when it matches
 * this page, and sensitive query parameters are replaced.
 */
export function sanitizeEndpoint(path) {
  if (typeof path !== 'string' || !path) return null;
  let url;
  try {
    const base = globalThis.location?.origin || 'http://localhost';
    url = new URL(path, base);
    for (const name of url.searchParams.keys())
      if (isSensitiveName(name, { inUrl: true }))
        url.searchParams.set(name, REDACTED);
    // URLSearchParams encodes the brackets; keep the marker readable.
    const query = url.search.replaceAll(encodeURIComponent(REDACTED), REDACTED);
    const relative = `${url.pathname}${query}`;
    return clip(redactText(relative));
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Builders                                                            */
/* ------------------------------------------------------------------ */

function clip(text, max = MAX_SHORT_CHARS) {
  if (typeof text !== 'string') return null;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Keep a received body exactly as received, minus credentials, bounded.
 * @param {string} text
 * @param {string|null} contentType
 */
export function captureBody(text, contentType = null) {
  if (typeof text !== 'string') return null;
  const length = text.length;
  const { text: scrubbed, redacted } = redactTextReport(text);
  const truncated = scrubbed.length > MAX_BODY_CHARS;
  const kept = truncated ? scrubbed.slice(0, MAX_BODY_CHARS) : scrubbed;
  const trimmed = kept.trim();
  const html =
    /html/i.test(contentType ?? '') ||
    /^<(!doctype|html|head|body)\b/i.test(trimmed);
  let json;
  let valueRedacted = false;
  if (!truncated && !html && trimmed) {
    try {
      const parsed = JSON.parse(kept);
      json = redactValue(parsed);
      valueRedacted = JSON.stringify(json) !== JSON.stringify(parsed);
    } catch {
      json = undefined;
    }
  }
  return {
    text: kept,
    length,
    truncated,
    redacted,
    structureLimited: valueRedacted,
    valueRedacted,
    html,
    json,
  };
}

function headerOf(headers, name) {
  try {
    return headers?.get?.(name) ?? null;
  } catch {
    return null;
  }
}

function requestIdOf(headers) {
  for (const name of REQUEST_ID_HEADERS) {
    const value = headerOf(headers, name);
    if (value) return clip(redactText(value), 200);
  }
  return null;
}

function httpCategory(status) {
  if (status === 429) return 'rate-limited';
  if (status === 401 || status === 403) return 'not-authorized';
  if (status === 404 || status === 410) return 'not-found';
  if (status === 413) return 'too-large';
  if (status === 409) return 'conflict';
  if (status === 422 || status === 400) return 'rejected-request';
  if ([502, 503, 504].includes(status)) return 'service-unavailable';
  if (status >= 500) return 'server-error';
  if (status >= 400) return 'client-error';
  return 'unreadable-response';
}

/** Safe provider detail from a parsed error body, when the API sent one. */
function providerDetailOf(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const evidence =
    json.evidence && typeof json.evidence === 'object' ? json.evidence : {};
  const value =
    json.provider_detail ??
    json.provider_body ??
    evidence.failure ??
    evidence.provider_body ??
    null;
  if (value === null || value === undefined) return null;
  const text =
    typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const safe = redactText(text);
  return safe.length > 8000
    ? `${safe.slice(0, 8000)}… [truncated: 8000 of ${safe.length} characters retained]`
    : safe;
}

const now = () => new Date().toISOString();

/**
 * An HTTP response that was received but not accepted (non-2xx, or a 2xx
 * whose body could not be read).
 * @param {{method?: string, path: string, response: Response, text: string, category?: string}} input
 */
export function httpDiagnostic({
  method = 'GET',
  path,
  response,
  text,
  category,
}) {
  const status = Number(response?.status) || 0;
  const contentType = headerOf(response?.headers, 'Content-Type');
  const body = captureBody(text ?? '', contentType);
  const retryAfter = headerOf(response?.headers, 'Retry-After');
  return {
    kind: DIAGNOSTIC_KIND.http,
    category: category ?? httpCategory(status),
    method: String(method).toUpperCase(),
    endpoint: sanitizeEndpoint(path),
    status,
    statusText: response?.statusText
      ? clip(redactText(response.statusText), 200)
      : null,
    requestId: requestIdOf(response?.headers),
    contentType: contentType ? clip(redactText(contentType), 200) : null,
    retryAfter: retryAfter ? clip(redactText(retryAfter), 100) : null,
    body,
    providerDetail: providerDetailOf(body?.json),
    occurredAt: now(),
  };
}

/**
 * No HTTP response arrived (`phase: 'request'`), or the connection dropped
 * while the body was being read (`phase: 'response'`).
 */
export function networkDiagnostic({
  method = 'GET',
  path,
  phase = 'request',
  cause = null,
  response = null,
}) {
  return {
    kind: DIAGNOSTIC_KIND.network,
    category: phase === 'response' ? 'connection-dropped' : 'network',
    method: String(method).toUpperCase(),
    endpoint: sanitizeEndpoint(path),
    status: phase === 'response' ? Number(response?.status) || null : null,
    statusText:
      phase === 'response' && response?.statusText
        ? clip(redactText(response.statusText), 200)
        : null,
    requestId: phase === 'response' ? requestIdOf(response?.headers) : null,
    phase,
    cause: causeOf(cause),
    occurredAt: now(),
  };
}

function causeOf(cause) {
  if (!cause) return null;
  if (typeof cause === 'string')
    return { name: null, message: clip(redactText(cause)) };
  const message =
    typeof cause.message === 'string' ? cause.message : String(cause);
  return {
    name: typeof cause.name === 'string' ? clip(redactText(cause.name)) : null,
    message: clip(redactText(message)),
  };
}

/**
 * A failure that happened in this browser: validation, file reading, local
 * storage, rendering. `facts` are short labelled values shown as a list.
 * @param {{category: string, reason?: string, facts?: Record<string, unknown>, cause?: unknown, data?: unknown}} input
 */
export function localDiagnostic({
  category,
  reason = null,
  facts = null,
  cause = null,
  data,
}) {
  const factList = Object.entries(facts ?? {})
    .filter(
      ([, value]) => value !== undefined && value !== null && value !== '',
    )
    .map(([label, value]) => [
      clip(redactText(label)),
      isSensitiveName(label) ? REDACTED : clip(redactText(String(value)), 500),
    ]);
  return {
    kind: DIAGNOSTIC_KIND.local,
    category,
    reason: reason ? clip(redactText(reason)) : null,
    facts: factList,
    cause: causeOf(cause),
    data: boundedValue(data),
    occurredAt: now(),
  };
}

/**
 * A job the server accepted, then reported as failed. `record` is the job
 * payload exactly as received (it is redacted here).
 */
export function jobDiagnostic({
  endpoint = null,
  jobId = null,
  record = null,
  reason = null,
}) {
  return {
    kind: DIAGNOSTIC_KIND.job,
    category: 'job-failed',
    endpoint: sanitizeEndpoint(endpoint),
    jobId: jobId ? clip(redactText(String(jobId)), 200) : null,
    reason: reason ? clip(redactText(reason)) : null,
    data: boundedValue(record),
    occurredAt: now(),
  };
}

/** Attach a diagnostic to an error without disturbing any existing field. */
export function attachDiagnostic(error, diagnostic) {
  if (error && typeof error === 'object' && diagnostic && !error.diagnostic)
    error.diagnostic = diagnostic;
  return error;
}

/**
 * The diagnostic for an error, notice or state object. Objects built before a
 * diagnostic existed (or by code that only kept `{message, details}`) get one
 * from what they still carry, labelled as partial.
 */
export function diagnosticOf(source) {
  if (!source) return null;
  if (typeof source === 'string')
    return localDiagnostic({ category: 'reported', reason: source });
  if (source.diagnostic && typeof source.diagnostic === 'object')
    return source.diagnostic;
  if (source.network)
    return {
      ...networkDiagnostic({ phase: 'request' }),
      endpoint: null,
      partial: true,
    };
  const status = Number(source.status) || 0;
  if (status >= 100) {
    const details = typeof source.details === 'string' ? source.details : '';
    return {
      kind: DIAGNOSTIC_KIND.http,
      category: httpCategory(status),
      method: null,
      endpoint: null,
      status,
      statusText: null,
      requestId: null,
      contentType: null,
      retryAfter: null,
      body: details ? { ...captureBody(details), excerpt: true } : null,
      providerDetail: null,
      occurredAt: null,
      partial: true,
    };
  }
  if (source.name === 'AbortError') return null;
  const isError = source instanceof Error;
  return {
    ...localDiagnostic({
      category: source.category ?? (isError ? 'browser' : 'reported'),
      reason:
        typeof source.details === 'string'
          ? source.details
          : (source.message ?? source.error ?? null),
      cause: isError ? source : null,
    }),
    occurredAt: null,
  };
}

/** Category codes as short readable labels. */
export const CATEGORY_LABEL = Object.freeze({
  'rate-limited': 'Rate limited',
  'not-authorized': 'Not authorized',
  'not-found': 'Not found',
  'too-large': 'Too large',
  conflict: 'Conflict',
  'rejected-request': 'Request rejected',
  'service-unavailable': 'Service unavailable',
  'server-error': 'Server error',
  'client-error': 'Request error',
  'unreadable-response': 'Unreadable response',
  network: 'No response (network)',
  'connection-dropped': 'Connection dropped',
  validation: 'Validation',
  storage: 'Browser storage',
  file: 'File',
  browser: 'Browser',
  render: 'Rendering',
  clipboard: 'Clipboard',
  provider: 'Provider',
  'job-failed': 'Job failed',
  reported: 'Reported',
});

export const categoryLabel = (category) =>
  CATEGORY_LABEL[category] ?? (category ? String(category) : 'Unknown');

/** Bounded, redacted local/provider payload, never persisted by this module. */
export function boundedValue(value) {
  if (value === undefined || value === null) return undefined;
  let raw;
  try {
    raw = JSON.stringify(redactValue(value));
  } catch {
    return { reason: 'The local payload could not be serialized.' };
  }
  const body = captureBody(raw);
  return (
    body?.json ?? {
      retainedText: body?.text ?? '',
      truncated: body?.truncated ?? false,
    }
  );
}

/** Preserve available technical context when a hook stores a plain error record. */
export function preserveError(error) {
  return {
    message: redactText(
      typeof error === 'string'
        ? error
        : (error?.message ?? 'An error occurred.'),
    ),
    details:
      typeof error?.details === 'string'
        ? captureBody(error.details).text
        : null,
    status: error?.status ?? null,
    network: error?.network === true,
    evidence: boundedValue(error?.evidence),
    diagnostic: diagnosticOf(error),
  };
}
