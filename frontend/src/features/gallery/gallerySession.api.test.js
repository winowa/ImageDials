import { afterEach, expect, test, vi } from 'vitest';

import { api } from '../../data/api/api.js';
import { installApi, respond } from '../../../tests/helpers/testSupport.js';

afterEach(() => vi.unstubAllGlobals());

test('session reads preserve accepted status and bounded query parameters', async () => {
  const { calls } = installApi({
    'GET /api/images/library/shuffle-sessions/session%2Fone?rank=12&direction=backward&limit=48&event_name=Spring+Show':
      () => respond(202, { session_id: 'session/one', state: 'building' }),
  });

  const result = await api.readGallerySession('session/one', {
    rank: 12,
    direction: 'backward',
    limit: 48,
    eventName: 'Spring Show',
  });

  expect(calls[0].key).toBe(
    'GET /api/images/library/shuffle-sessions/session%2Fone?rank=12&direction=backward&limit=48&event_name=Spring+Show',
  );
  expect(result).toMatchObject({
    status: 202,
    notModified: false,
    session: { session_id: 'session/one', state: 'building' },
  });
});

test('session allocation sends only supported fields and exposes the server lease', async () => {
  const { calls } = installApi({
    'POST /api/images/library/shuffle-sessions': () =>
      respond(202, {
        session_id: 'session-1',
        state: 'building',
        first_image_member: null,
        expires_at: 1_800_000_000,
      }),
  });

  const result = await api.createGallerySession({
    eventName: 'Spring Show',
    orientations: ['landscape', 'unknown'],
    firstImageId: 'image-7',
    ignored: true,
  });

  expect(calls[0].body).toEqual({
    event_name: 'Spring Show',
    orientations: ['landscape', 'unknown'],
    first_image_id: 'image-7',
  });
  expect(result).toMatchObject({
    session_id: 'session-1',
    state: 'building',
    expires_at: 1_800_000_000,
  });
});

test('facet and lease methods use their dedicated endpoints and conditional reads', async () => {
  const { calls } = installApi({
    'GET /api/images/library/event-facets?limit=100&q=studio': () =>
      respond(304, null, { ETag: 'facets-v4' }),
    'POST /api/images/library/shuffle-sessions/session-1/renew?event_name=Spring':
      () => ({ session_id: 'session-1', state: 'ready', expires_at: 900 }),
    'DELETE /api/images/library/shuffle-sessions/session-1?event_name=Spring':
      () => respond(204, null),
  });

  const unchanged = await api.libraryEventFacets(
    { limit: 100, q: 'studio' },
    { etag: 'facets-v4' },
  );
  const renewed = await api.renewGallerySession('session-1', {
    eventName: 'Spring',
  });
  await api.releaseGallerySession('session-1', { eventName: 'Spring' });

  expect(calls[0].headers['If-None-Match']).toBe('facets-v4');
  expect(unchanged).toMatchObject({ notModified: true, facets: null });
  expect(renewed.expires_at).toBe(900);
  expect(calls.map((call) => call.key)).toEqual([
    'GET /api/images/library/event-facets?limit=100&q=studio',
    'POST /api/images/library/shuffle-sessions/session-1/renew?event_name=Spring',
    'DELETE /api/images/library/shuffle-sessions/session-1?event_name=Spring',
  ]);
});
