import { afterEach, expect, test, vi } from 'vitest';

import { api, encodeProviderOverrides } from './api.js';

afterEach(() => vi.unstubAllGlobals());

test('provider header round-trips Unicode choices without returning default keys', () => {
  const overrides = {
    LLM_MODEL_NAME: 'Example 模型',
    LLM_MODEL_KEY_1: 'example-key',
  };
  const decoded = new TextDecoder().decode(
    Uint8Array.from(atob(encodeProviderOverrides(overrides)), (c) =>
      c.charCodeAt(0),
    ),
  );
  expect(JSON.parse(decoded)).toEqual(overrides);
  expect(encodeProviderOverrides({})).toBe(btoa('{}'));
  expect(() =>
    encodeProviderOverrides({ LLM_MODEL_KEY_1: 'x'.repeat(7000) }),
  ).toThrow(/size limit/);
});

test('browser defaults and watermark validation use the implemented endpoints', async () => {
  const fetch = vi.fn(
    async () =>
      new Response(JSON.stringify({ storage: 'browser' }), {
        headers: { 'Content-Type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetch);
  await api.browserDefaults();
  await api.validateBrowserWatermark({ type: 'text', text: 'Example' });
  expect(fetch.mock.calls[0][0]).toBe('/api/browser-settings/defaults');
  expect(fetch.mock.calls[1][0]).toBe(
    '/api/browser-settings/watermark/validate',
  );
  expect(fetch.mock.calls[1][1].method).toBe('POST');
});

test('local watermark analysis sends content without changing shared settings', async () => {
  const fetch = vi.fn(
    async () =>
      new Response('{}', { headers: { 'Content-Type': 'application/json' } }),
  );
  vi.stubGlobal('fetch', fetch);
  const settings = { type: 'text', text: 'Browser only' };
  await api.analyzeWatermarkImage(new Blob(['image'], { type: 'image/png' }), {
    watermarkSettings: settings,
  });
  expect(fetch.mock.calls).toHaveLength(1);
  expect(fetch.mock.calls[0][0]).toBe('/api/watermark/analyze-image');
  expect(
    JSON.parse(fetch.mock.calls[0][1].body.get('watermark_settings')),
  ).toEqual(settings);
});

test('prepared metadata transport returns the separate PNG and never the original', async () => {
  const fetch = vi.fn(
    async () =>
      new Response('prepared PNG bytes', {
        headers: { 'Content-Type': 'image/png' },
      }),
  );
  vi.stubGlobal('fetch', fetch);
  const metadata = {
    source_sha256: 'example-source-hash',
    watermark_settings: { type: 'text', text: 'Example' },
  };
  const result = await api.embedWatermarkMetadata(
    new Blob(['rendered pixels']),
    metadata,
  );
  expect(await result.text()).toBe('prepared PNG bytes');
  expect(fetch.mock.calls).toHaveLength(1);
  expect(fetch.mock.calls[0][0]).toBe('/api/watermark/embed-metadata');
  expect(fetch.mock.calls[0][1].method).toBe('POST');
  expect(JSON.parse(fetch.mock.calls[0][1].body.get('metadata'))).toEqual(
    metadata,
  );
});
