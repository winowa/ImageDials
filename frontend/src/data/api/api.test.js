import { afterEach, expect, test, vi } from 'vitest';

import { api, ApiError, request } from './api.js';
import libraryPages from '../../../../fixtures/api/library-pages.json';
import {
  fakeLibrary,
  fixtures,
  installApi,
  libraryRecord,
  respond,
} from '../../../tests/helpers/testSupport.js';

afterEach(() => vi.unstubAllGlobals());

const fail = async (promise) => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the request to fail.');
};

test('static controls request the wire mode for each UI mode', async () => {
  const { calls } = installApi();
  await api.staticControls('image');
  await api.staticControls('asset-image');
  expect(calls.map((c) => c.key)).toEqual([
    'GET /api/controls/static?generation_mode=standard',
    'GET /api/controls/static?generation_mode=trellis',
  ]);
});

test('requests use relative paths, root health and JSON bodies', async () => {
  const { calls } = installApi({
    'POST /api/controls/dynamic': () => ({ controls: [] }),
  });
  await api.health();
  await api.dynamicControls({ prompt: 'x' });
  expect(calls.map((c) => c.key)).toEqual([
    'GET /healthz',
    'POST /api/controls/dynamic',
  ]);
  expect(calls[1].body).toEqual({ prompt: 'x' });
});

test('job ids are percent-encoded into the path', async () => {
  const { calls } = installApi({
    'GET /api/generation-jobs/a%2Fb': () => ({ status: 'running' }),
  });
  await api.generationJob('a/b');
  expect(calls[0].key).toBe('GET /api/generation-jobs/a%2Fb');
});

test('JSON errors use the detail text and keep technical details', async () => {
  installApi({
    'GET /api/models': () => respond(400, { detail: 'Bad things' }),
  });
  const error = await fail(api.models());
  expect(error).toBeInstanceOf(ApiError);
  expect(error.message).toBe('Bad things');
  expect(error.status).toBe(400);
  expect(error.details).toContain('Bad things');
  expect(error.unavailable).toBe(false);
});

test('validation error arrays are joined into one message', async () => {
  installApi({
    'GET /api/models': () =>
      respond(422, { detail: [{ msg: 'first' }, { msg: 'second' }] }),
  });
  expect((await fail(api.models())).message).toBe('first; second');
});

test('HTML error pages become a concise message with the page as details', async () => {
  installApi({
    'GET /api/models': () =>
      respond(503, '<html><body>Service unavailable</body></html>'),
  });
  const error = await fail(api.models());
  expect(error.message).toBe('Request failed (503).');
  expect(error.details).toContain('<html>');
  expect(error.unavailable).toBe(true);
});

test('plain-text errors are shown and truncated', async () => {
  installApi({ 'GET /api/models': () => respond(500, 'x'.repeat(500)) });
  const error = await fail(api.models());
  expect(error.message).toHaveLength(200);
});

test('network failures are marked unreachable', async () => {
  vi.stubGlobal('fetch', () =>
    Promise.reject(new TypeError('Failed to fetch')),
  );
  const error = await fail(api.models());
  expect(error).toMatchObject({
    network: true,
    message: 'The API is unreachable.',
  });
  expect(error.unavailable).toBe(true);
});

test('aborts propagate as aborts, not as API errors', async () => {
  vi.stubGlobal('fetch', (_url, init) => {
    const aborted = new DOMException('aborted', 'AbortError');
    return init.signal?.aborted ? Promise.reject(aborted) : Promise.resolve();
  });
  const controller = new AbortController();
  controller.abort();
  const error = await fail(
    request('/api/models', { signal: controller.signal }),
  );
  expect(error.name).toBe('AbortError');
});

test('an unreadable success body is an error', async () => {
  installApi({ 'GET /api/models': () => respond(200, 'not json') });
  expect((await fail(api.models())).message).toMatch(/unreadable/);
});

const { m2 } = fixtures;

test('the canonical library list returns the full records and the ETag', async () => {
  const etag = m2.conditional.etag;
  const { calls } = installApi({
    'GET /api/images/library': () => respond(200, m2.library, { ETag: etag }),
  });
  const result = await api.library();
  expect(calls[0].key).toBe('GET /api/images/library');
  expect(calls[0].headers['If-None-Match']).toBeUndefined();
  expect(result.notModified).toBe(false);
  expect(result.etag).toBe(etag);
  // Unknown and nullable fields survive exactly as served.
  expect(result.library).toEqual(m2.library);
  expect(result.library.images[0].selected_controls[4].vendor).toBe(
    'independent-fixture',
  );
});

test('bounded page reads preserve exact summaries and send conditional queries', async () => {
  const first = {
    ...libraryPages.first.response,
    images: [
      {
        ...libraryPages.first.response.images[0],
        extension: { enabled: false, number: 0 },
      },
      ...libraryPages.first.response.images.slice(1),
    ],
  };
  const { calls } = installApi({
    'GET /api/images/library/page?limit=2&q=blue+paper&event_name=Spring+Show&orientation=landscape&order=oldest&cursor=opaque%2Fcursor':
      () => respond(200, first, { ETag: libraryPages.first.etag }),
    'GET /api/images/library/page?limit=2&edge=last': () => respond(304),
  });
  const page = await api.libraryPage(
    {
      limit: 2,
      q: 'blue paper',
      eventName: 'Spring Show',
      orientation: 'landscape',
      order: 'oldest',
      cursor: 'opaque/cursor',
    },
    { signal: new AbortController().signal },
  );
  expect(calls[0].key).toBe(
    'GET /api/images/library/page?limit=2&q=blue+paper&event_name=Spring+Show&orientation=landscape&order=oldest&cursor=opaque%2Fcursor',
  );
  expect(page).toEqual({
    notModified: false,
    etag: libraryPages.first.etag,
    page: first,
  });
  expect(page.page.images[0].id).toBe(first.images[0].id);
  expect(page.page.images[0].extension).toEqual({ enabled: false, number: 0 });

  const unchanged = await api.libraryPage(
    { limit: 2, edge: 'last' },
    { etag: 'last-etag' },
  );
  expect(calls[1].headers['If-None-Match']).toBe('last-etag');
  expect(unchanged).toMatchObject({ notModified: true, page: null });
});

test('a page projection conflict is surfaced without a full-list fallback', async () => {
  const { calls } = installApi({
    'GET /api/images/library/page?limit=48': () =>
      respond(409, libraryPages.projection_changed.response),
  });
  expect(await fail(api.libraryPage({ limit: 48 }))).toMatchObject({
    status: 409,
    message: libraryPages.projection_changed.response.detail,
  });
  expect(calls.map((call) => call.key)).toEqual([
    'GET /api/images/library/page?limit=48',
  ]);
});

test('selected detail has its own identity path, event scope and ETag', async () => {
  const detail = libraryPages.detail;
  const { calls } = installApi({
    'GET /api/images/library/record/a%2Fb?event_name=Spring+Show': () =>
      respond(200, detail, { ETag: 'detail-etag' }),
  });
  const result = await api.libraryRecord('a/b', {
    eventName: 'Spring Show',
    etag: 'old-detail-etag',
  });
  expect(calls[0].headers['If-None-Match']).toBe('old-detail-etag');
  expect(result).toEqual({
    notModified: false,
    etag: 'detail-etag',
    record: detail,
  });
});

test('a repeat read sends the exact ETag and a 304 carries no body', async () => {
  const library = fakeLibrary([libraryRecord()]);
  const { calls } = installApi(library.routes);
  const first = await api.library();
  const second = await api.library({ etag: first.etag });
  expect(calls[1].headers['If-None-Match']).toBe(first.etag);
  expect(second).toMatchObject({ notModified: true, library: null });
  // A changed library is no longer a match, so the new list is served.
  library.records = [libraryRecord({ id: 'newer' }), ...library.records];
  const third = await api.library({ etag: first.etag });
  expect(third.notModified).toBe(false);
  expect(third.library.count).toBe(2);
});

test('the shared fake server provides filtered page and exact detail routes', async () => {
  const records = [
    libraryRecord({
      id: 'older',
      created_at: 1,
      title: 'Blue vase',
      width: 200,
      height: 300,
    }),
    libraryRecord({
      id: 'newer',
      created_at: 2,
      title: 'Blue bowl',
      width: 300,
      height: 200,
    }),
    libraryRecord({ id: 'other', created_at: 3, title: 'Red bowl' }),
  ];
  const library = fakeLibrary(records);
  const { calls } = installApi(library.routes);
  const first = await api.libraryPage({ limit: 1, q: 'blue' });
  expect(first.page.images.map((image) => image.id)).toEqual(['newer']);
  expect(first.page.total).toBe(2);
  expect(first.page.next_cursor).toBeTruthy();
  const next = await api.libraryPage({
    limit: 1,
    q: 'blue',
    cursor: first.page.next_cursor,
  });
  expect(next.page.images.map((image) => image.id)).toEqual(['older']);
  expect((await api.libraryRecord('older')).record).toEqual(records[0]);
  expect(calls.some((call) => call.key === 'GET /api/images/library')).toBe(
    false,
  );
});

test('delete sends the exact storage identity as JSON', async () => {
  const library = fakeLibrary([libraryRecord()]);
  const { calls } = installApi(library.routes);
  const result = await api.deleteLibraryImage({
    ...libraryRecord(),
    title: 'ignored',
  });
  expect(calls[0].key).toBe('DELETE /api/images/library');
  expect(calls[0].body).toEqual(m2.delete_request);
  expect(result).toEqual(m2.delete_response);
});

test('library errors keep their server reason and status', async () => {
  installApi({
    'GET /api/images/library': () => respond(403, m2.errors.disabled),
    'DELETE /api/images/library': () => respond(502, m2.errors.storage),
  });
  expect(await fail(api.library())).toMatchObject({
    status: 403,
    message: m2.errors.disabled.detail,
  });
  const storage = await fail(api.deleteLibraryImage(libraryRecord()));
  expect(storage).toMatchObject({
    status: 502,
    message: m2.errors.storage.detail,
  });
  expect(storage.unavailable).toBe(true);
});

test('an import analysis is a multipart upload with one image field and no JSON header', async () => {
  const calls = [];
  vi.stubGlobal('fetch', async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ mode: 'description', prompt: 'p' }), {
      status: 200,
    });
  });
  const file = new File(['x'], 'a.png', { type: 'image/png' });
  await api.importAnalysis(file);
  const [{ url, init }] = calls;
  expect(url).toBe('/api/images/import-analysis');
  expect(init.method).toBe('POST');
  expect(init.body).toBeInstanceOf(FormData);
  expect([...init.body.keys()]).toEqual(['image']);
  expect(init.headers['Content-Type']).toBeUndefined();
});

test('option expansion posts the bare control and suggestions pick the wire mode', async () => {
  const calls = [];
  vi.stubGlobal('fetch', async (url, init) => {
    calls.push({ url, init });
    return new Response('{}', { status: 200 });
  });
  await api.addControlOptions({ id: 'a', kind: 'dropdown', label: 'A' });
  await api.promptSuggestions('asset-image');
  expect(JSON.parse(calls[0].init.body)).toEqual({
    id: 'a',
    kind: 'dropdown',
    label: 'A',
  });
  expect(calls[1].url).toBe('/api/prompt-suggestions?generation_mode=trellis');
});

test('keeps the exchange the server returned, apart from the clipped details', async () => {
  const evidence = { status: 'failed', raw_response: 'x'.repeat(2000) };
  vi.stubGlobal(
    'fetch',
    async () =>
      new Response(JSON.stringify({ detail: 'Invalid controls', evidence }), {
        status: 502,
      }),
  );
  const error = await api
    .dynamicControls({ prompt: 'a' })
    .catch((caught) => caught);
  expect(error.message).toBe('Invalid controls');
  expect(error.evidence).toEqual(evidence);
  expect(error.details).not.toContain('xxxx');
});

test('has no evidence for ordinary failures', async () => {
  vi.stubGlobal(
    'fetch',
    async () => new Response('{"detail":"plain"}', { status: 502 }),
  );
  const error = await api
    .dynamicControls({ prompt: 'a' })
    .catch((caught) => caught);
  expect(error.evidence).toBeNull();
});
