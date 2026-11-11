import { afterEach, expect, test, vi } from 'vitest';

import { api, fetchBlob, request } from '../../data/api/api.js';
import {
  captureBody,
  diagnosticOf,
  httpDiagnostic,
  localDiagnostic,
  MAX_BODY_CHARS,
  networkDiagnostic,
  preserveError,
  redactText,
  redactValue,
  sanitizeEndpoint,
} from './diagnostics.js';

afterEach(() => vi.unstubAllGlobals());

test.each([
  'X-ImageDials-Provider-Overrides',
  'x-imagedials-provider-overrides',
  'X-IMAGEDIALS-PROVIDER-OVERRIDES',
])('redacts encoded credentials in an echoed %s header', (name) => {
  const encoded = btoa(
    JSON.stringify({ IMAGE_MODEL_KEY_1: 'fixture-provider-credential' }),
  );
  const body = captureBody(
    JSON.stringify({ headers: { [name]: encoded }, detail: 'Rejected' }),
    'application/json',
  );
  expect(body.text).not.toContain(encoded);
  expect(body.json.headers[name]).toBe('[redacted]');
  expect(body.json.detail).toBe('Rejected');
  expect(body.redacted).toBe(true);
  expect(redactText(`${name}: ${encoded}\nDetail: Rejected`)).toBe(
    `${name}: [redacted]\nDetail: Rejected`,
  );
  expect(redactText(`${name}=${encoded}`)).toBe(`${name}=[redacted]`);
});

test('redacts an echoed provider override before retaining an API error', async () => {
  const encoded = btoa(
    JSON.stringify({ IMAGE_EDIT_MODEL_KEY: 'fixture-edit-credential' }),
  );
  vi.stubGlobal(
    'fetch',
    async () =>
      new Response(
        JSON.stringify({
          detail: 'Rejected',
          headers: { 'X-ImageDials-Provider-Overrides': encoded },
        }),
        { status: 502, headers: { 'Content-Type': 'application/json' } },
      ),
  );
  const error = await failure(api.models());
  expect(error.status).toBe(502);
  expect(JSON.stringify(preserveError(error))).not.toContain(encoded);
  expect(error.diagnostic.body.json.headers).toEqual({
    'X-ImageDials-Provider-Overrides': '[redacted]',
  });
});

const failure = async (work) => {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error('Expected a failure');
};

test('HTTP JSON capture retains exact spacing, headers and structured data without extra requests', async () => {
  const body = ' { "detail": "Rejected", "nested": [1, true] }\n';
  const fetch = vi.fn(
    async () =>
      new Response(body, {
        status: 422,
        statusText: 'Unprocessable Content',
        headers: {
          'Content-Type': 'application/json',
          'X-Request-ID': 'fixture-request',
        },
      }),
  );
  vi.stubGlobal('fetch', fetch);
  const error = await failure(
    request('/api/example?apiKey=secret', {
      method: 'POST',
      body: { prompt: 'test' },
    }),
  );
  expect(error.diagnostic).toMatchObject({
    kind: 'http',
    method: 'POST',
    endpoint: '/api/example?apiKey=[redacted]',
    status: 422,
    statusText: 'Unprocessable Content',
    requestId: 'fixture-request',
    body: {
      text: body,
      json: { detail: 'Rejected', nested: [1, true] },
      truncated: false,
      redacted: false,
    },
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});

test.each([
  '{ broken JSON',
  '<html><script>alert(1)</script></html>',
  'Bad upstream\nTry later',
])(
  'captures malformed and non-JSON bodies exactly as inert text: %s',
  async (body) => {
    vi.stubGlobal('fetch', async () => new Response(body, { status: 502 }));
    const error = await failure(api.models());
    expect(error.diagnostic.body.text).toBe(body);
    expect(error.diagnostic.body.json).toBeUndefined();
  },
);

test('unreadable success and failed binary downloads preserve the received response', async () => {
  vi.stubGlobal(
    'fetch',
    async () => new Response('invalid', { status: 200, statusText: 'OK' }),
  );
  const error = await failure(api.models());
  expect(error.diagnostic).toMatchObject({
    category: 'unreadable-response',
    status: 200,
    body: { text: 'invalid' },
  });
  vi.stubGlobal('fetch', async () => new Response('missing', { status: 404 }));
  expect((await failure(fetchBlob('/api/original'))).diagnostic).toMatchObject({
    status: 404,
    body: { text: 'missing' },
  });
});

test('network rejection has no invented HTTP status or body; dropped body keeps received headers', async () => {
  vi.stubGlobal('fetch', async () => {
    throw new TypeError('Failed to fetch');
  });
  const error = await failure(api.models());
  expect(error.diagnostic).toMatchObject({
    kind: 'network',
    status: null,
    phase: 'request',
    cause: { name: 'TypeError', message: 'Failed to fetch' },
  });
  expect(error.diagnostic.body).toBeUndefined();
  vi.stubGlobal('fetch', async () => ({
    ok: false,
    status: 503,
    statusText: 'Unavailable',
    headers: new Headers({ 'X-Request-ID': 'drop-id' }),
    text: async () => {
      throw new TypeError('Read failed');
    },
  }));
  const dropped = await failure(fetchBlob('/api/file'));
  expect(dropped.diagnostic).toMatchObject({
    kind: 'network',
    status: 503,
    phase: 'response',
    requestId: 'drop-id',
  });
  expect(dropped.diagnostic.body).toBeUndefined();
});

test('nested, escaped-key, composite and case variant credentials are redacted in RAW and formatted bodies', () => {
  const raw = String.raw` {"safe":"keep spacing", "API_KEY":"secret-one", "nested":{"providerSecret":{"value":"secret-two"}}, "toke\u006e":["secret-three"], "KEY":123, "cookies":"secret-four"} `;
  const body = captureBody(raw);
  expect(body.text).not.toMatch(/secret-(one|two|three|four)|123/);
  expect(body.text).toContain('"safe":"keep spacing"');
  expect(body.text.startsWith(' {')).toBe(true);
  expect(body.redacted).toBe(true);
  expect(body.json.nested.providerSecret).toBe('[redacted]');
  expect(JSON.stringify(body)).not.toMatch(/secret-/);
});

test('raw credential assignments, authorization, cookies and credential URLs redact case-insensitively', () => {
  const credentialUrl = [
    'https://',
    'user',
    ':',
    'password',
    '@example.invalid/a?key=fixture-url-key&ok=2',
  ].join('');
  const raw =
    'Authorization: Bearer abcdefghijk\nSet-Cookie: session=private\napi_key=fixture-key-value &ACCESS_TOKEN=fixture-token ' +
    credentialUrl;
  const redacted = redactText(raw);
  expect(redacted).not.toMatch(
    /abcdefghijk|session=private|fixture-key-value|fixture-token|user:password|fixture-url-key/,
  );
  expect(redacted).toContain('&ok=2');
  expect(
    sanitizeEndpoint(
      [
        'https://',
        'user',
        ':',
        'pass',
        '@example.invalid/api/test?ToKeN=abc&n=2#secret',
      ].join(''),
    ),
  ).toBe('/api/test?ToKeN=[redacted]&n=2');
});

test('redacts before clipping, including a long secret that crosses the retention boundary', () => {
  const raw =
    '{"password":"' + 's'.repeat(MAX_BODY_CHARS * 3) + '","detail":"kept"}';
  const body = captureBody(raw);
  expect(body.text).toBe('{"password":"[redacted]","detail":"kept"}');
  expect(body.truncated).toBe(false);
  const long = captureBody('x'.repeat(MAX_BODY_CHARS + 1));
  expect(long).toMatchObject({ truncated: true, length: MAX_BODY_CHARS + 1 });
  expect(long.text.length).toBe(MAX_BODY_CHARS);
});

test('local warnings retain reason and safe cause without inventing HTTP data, and bound payloads', () => {
  const d = localDiagnostic({
    category: 'validation',
    reason: 'Unsupported file',
    facts: { Authorization: 'secret', Size: 12 },
    cause: new Error('api_key=hidden'),
    data: { provider_token: 'hidden', safe: 'x'.repeat(MAX_BODY_CHARS + 1) },
  });
  expect(d).toMatchObject({
    kind: 'local',
    reason: 'Unsupported file',
    facts: [
      ['Authorization', '[redacted]'],
      ['Size', '12'],
    ],
    cause: { message: 'api_key=[redacted]' },
    data: { truncated: true },
  });
  expect(d.status).toBeUndefined();
  expect(JSON.stringify(d)).not.toContain('hidden');
  const original = Object.assign(new Error('Rejected'), {
    diagnostic: d,
    status: 422,
  });
  expect(preserveError(original).diagnostic).toBe(d);
  expect(
    diagnosticOf({ details: 'legacy excerpt', status: 500 }),
  ).toMatchObject({ partial: true, body: { excerpt: true } });
});

test('object redaction handles prototype keys and nested secrets without changing prototypes', () => {
  const d = redactValue(
    JSON.parse(
      '{"__proto__":{"token":"hidden"},"Provider_API_Key":"hidden","safe":2}',
    ),
  );
  expect(Object.getPrototypeOf(d)).toBe(Object.prototype);
  expect(d.__proto__.token).toBe('[redacted]');
  expect(d.safe).toBe(2);
  expect(JSON.stringify(d)).not.toContain('hidden');
});

test('optional editing controls flag does not leak into fetch options or change normal callers', async () => {
  const fetch = vi.fn(async () => new Response('{}'));
  vi.stubGlobal('fetch', fetch);
  await api.staticControls('image');
  await api.staticControls('asset-image', { editing: true });
  expect(fetch.mock.calls[0][0]).toBe(
    '/api/controls/static?generation_mode=standard',
  );
  expect(fetch.mock.calls[1][0]).toBe(
    '/api/controls/static?generation_mode=trellis&image_edit=true',
  );
  expect(fetch.mock.calls[1][1]).not.toHaveProperty('editing');
});

test('all retained HTTP metadata and legacy message fields redact before being exposed', async () => {
  vi.stubGlobal(
    'fetch',
    async () =>
      new Response(
        '{"detail":"api_key=hidden", "evidence":{"apiKey":"hidden"}}',
        { status: 500 },
      ),
  );
  const error = await failure(api.models());
  expect(JSON.stringify(preserveError(error))).not.toContain('hidden');
  expect(error.message).toContain('[redacted]');
  expect(
    httpDiagnostic({
      path: '/api',
      response: { status: 500, statusText: 'api_key=hidden' },
      text: '',
    }).statusText,
  ).toBe('api_key=[redacted]');
  expect(
    networkDiagnostic({ path: '/api', cause: new Error('token=hidden') }).cause
      .message,
  ).toBe('token=[redacted]');
});

test('encoded credential URL parameters redact without changing safe URL bytes', () => {
  const text =
    'upstream https://example.invalid/a?API%5fKEY=hidden&x=%20a%20&access%5ftoken=hidden#section';
  expect(redactText(text)).toBe(
    'upstream https://example.invalid/a?API%5fKEY=[redacted]&x=%20a%20&access%5ftoken=[redacted]#section',
  );
});

test('shape validation retains a successful but invalid status response at the boundary', async () => {
  const body = ' {"watermark_backfill":{"status":"unknown"}}\n';
  vi.stubGlobal(
    'fetch',
    async () =>
      new Response(body, {
        status: 200,
        statusText: 'OK',
        headers: { 'X-Request-ID': 'shape-fixture' },
      }),
  );
  const error = await failure(api.watermarkBackfillStatus());
  expect(error.diagnostic).toMatchObject({
    kind: 'http',
    status: 200,
    statusText: 'OK',
    requestId: 'shape-fixture',
    body: { text: body },
    category: 'unreadable-response',
  });
});

test('a large provider evidence payload does not replace the concise error with JSON text', async () => {
  vi.stubGlobal(
    'fetch',
    async () =>
      new Response(
        JSON.stringify({
          evidence: { response: 'x'.repeat(MAX_BODY_CHARS + 1) },
          detail: 'Provider refused',
        }),
        { status: 502 },
      ),
  );
  const error = await failure(api.models());
  expect(error.message).toBe('Provider refused');
  expect(error.diagnostic.body.truncated).toBe(true);
  expect(error.evidence.truncated).toBe(true);
});
