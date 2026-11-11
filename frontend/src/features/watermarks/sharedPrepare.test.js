import { expect, test, vi } from 'vitest';

import { ApiError } from '../../data/api/api.js';
import { createCacheStore } from '../../data/storage/cacheStore.js';
import { DEFAULT_CLIENT_POLICY } from '../../data/api/clientPolicy.js';
import {
  deferred,
  imageBlob,
  memoryDb,
  quotaError,
} from '../../../tests/helpers/cacheTestSupport.js';
import { createLocalPrepareService } from './localPrepare.js';
import { fixtures } from '../../../tests/helpers/testSupport.js';
import { createSharedPreparedHost } from './sharedPreparedHost.js';

const SIZE = { width: 120, height: 80 };
const SHA = 'b'.repeat(64);
const settingsOf = (fingerprint) => ({
  type: 'text',
  text: fingerprint,
  fingerprint,
  rendering: fixtures.browserSettings.defaults.watermark.rendering,
  limits: {},
});
/** A shared library record, exactly as the server lists it. */
const record = (extra = {}) => ({
  id: 's1',
  image_id: 's1',
  storage_id: 'local-0',
  filename: 's1.png',
  sha256: SHA,
  title: 'Shared',
  unknown_future_field: { keep: true },
  image_url: '/api/images/library/file/local-0/s1.png',
  ...extra,
});

/** Everything one "browser" needs: a database, a store, a host and a service. */
function browser({
  db = memoryDb(),
  settings = settingsOf('f1'),
  listed = true,
} = {}) {
  const limits = {
    ...DEFAULT_CLIENT_POLICY.cache,
    sharedVariantMaxBytes: 1000,
  };
  const store = createCacheStore(db, limits);
  const state = {
    settings,
    listed,
    analyses: 0,
    uploads: [],
    metadata: [],
    sourceSha: SHA,
  };
  const original = imageBlob(30);
  const api = {
    analyzeWatermarkImage: vi.fn(async (image, options) => {
      state.analyses += 1;
      state.uploads.push({ image, options });
      return {
        print_watermark: {
          position: { corner: 'top-left' },
          provenance: {
            source_sha256: state.sourceSha ?? SHA,
            generator_version:
              options.watermarkSettings.rendering.analysisVersion,
          },
        },
        print_watermark_key: `key-${options.watermarkSettings.fingerprint}-${state.analyses}`,
        source_sha256: state.sourceSha ?? SHA,
        dimensions: SIZE,
        watermark_settings: structuredClone(options.watermarkSettings),
        storage: 'transient',
      };
    }),
    embedWatermarkMetadata: vi.fn(async (file, metadata) => {
      state.metadata.push(metadata);
      return new Blob([file, 'ImageDials'], { type: 'image/png' });
    }),
    // A shared write must never be reached by local content.
    saveWatermarkSettings: vi.fn(),
    uploadPrintReady: vi.fn(),
    analyzeWatermark: vi.fn(),
  };
  const fetchBlob = vi.fn(async () => original);
  const host = createSharedPreparedHost({ fetchBlob });
  host.bind({ store, isListed: () => state.listed, media: null });
  const render = vi.fn(async ({ source }) => ({
    blob: new Blob([source, 'painted'], { type: 'image/png' }),
    ...SIZE,
  }));
  const service = createLocalPrepareService({
    api,
    host,
    render,
    readSettings: async () => state.settings,
  });
  return { db, store, state, api, host, render, service, fetchBlob, original };
}

test('a shared original is prepared from local content: local settings analyzed, the RETURNED png kept, the original untouched', async () => {
  const b = browser();
  const source = record();
  const result = await b.service.prepare(source);

  // The original bytes (from the file route) and the local content were analyzed.
  expect(b.fetchBlob).toHaveBeenCalledTimes(1);
  expect(b.state.uploads[0].image).toBe(b.original);
  expect(b.state.uploads[0].options.watermarkSettings).toEqual(
    settingsOf('f1'),
  );
  expect(b.render.mock.calls[0][0].source).toBe(b.original);
  // The metadata endpoint received the whole wire record and the analysis facts.
  const [metadata] = b.state.metadata;
  expect(metadata.source_image).toBe(source);
  expect(metadata.source_image.unknown_future_field).toEqual({ keep: true });
  expect(metadata).toMatchObject({
    source_sha256: SHA,
    watermark_key: 'key-f1-1',
    watermark_settings: settingsOf('f1'),
    dimensions: SIZE,
  });
  expect(metadata.print_watermark.position.corner).toBe('top-left');
  // The blob that comes back is the prepared file, not the pre-embedded canvas.
  const rendered = await b.render.mock.results[0].value;
  expect(result.blob).not.toBe(rendered.blob);
  expect(result.blob.size).toBe(rendered.blob.size + 'ImageDials'.length);
  expect(result.persistence).toEqual({ state: 'stored' });
  expect((await b.store.local.readPrepared('local-0/s1.png')).blob).toBe(
    result.blob,
  );
  // No shared route, no source rewrite.
  expect(b.api.saveWatermarkSettings).not.toHaveBeenCalled();
  expect(b.api.uploadPrintReady).not.toHaveBeenCalled();
  expect(b.api.analyzeWatermark).not.toHaveBeenCalled();
  expect(source.sha256).toBe(SHA);
  expect(b.original.size).toBe(30);
});

test('after a reload the same returned bytes are reused: no analysis, render, embed or original read', async () => {
  const first = browser();
  const prepared = await first.service.prepare(record());
  // A new page: a new host and service over the same database.
  const second = browser({ db: first.db });
  const again = await second.service.prepare(record());
  expect(again.reused).toBe(true);
  expect(again.blob.size).toBe(prepared.blob.size);
  expect(await again.blob.text()).toBe(await prepared.blob.text());
  expect(second.api.analyzeWatermarkImage).not.toHaveBeenCalled();
  expect(second.api.embedWatermarkMetadata).not.toHaveBeenCalled();
  expect(second.render).not.toHaveBeenCalled();
  expect(second.fetchBlob).not.toHaveBeenCalled();
});

test('changed content keeps no stale png; the analyzer is asked again and a new file is made', async () => {
  const b = browser();
  const one = await b.service.prepare(record());
  b.state.settings = settingsOf('f2');
  const two = await b.service.prepare(record());
  expect(two.reused).toBe(false);
  expect(b.api.analyzeWatermarkImage).toHaveBeenCalledTimes(2);
  expect(b.state.metadata[1].watermark_key).toBe('key-f2-2');
  expect(two.blob).not.toBe(one.blob);
});

test('a source whose hash changed is not served from the stored copy', async () => {
  const b = browser();
  await b.service.prepare(record());
  b.state.sourceSha = 'c'.repeat(64);
  const again = await b.service.prepare(record({ sha256: 'c'.repeat(64) }));
  expect(again.reused).toBe(false);
});

test('a stale 409 refreshes the analysis and retries once; a second 409 is the answer', async () => {
  const b = browser();
  b.api.embedWatermarkMetadata.mockRejectedValueOnce(
    new ApiError('Watermark version changed', { status: 409 }),
  );
  const result = await b.service.prepare(record());
  expect(b.api.embedWatermarkMetadata).toHaveBeenCalledTimes(2);
  expect(b.api.analyzeWatermarkImage.mock.calls[1][1].force).toBe(true);
  expect(result.blob.size).toBeGreaterThan(0);

  const c = browser();
  c.api.embedWatermarkMetadata.mockRejectedValue(
    new ApiError('Watermark version changed', { status: 409 }),
  );
  await expect(c.service.prepare(record())).rejects.toMatchObject({
    stage: 'embed',
  });
  expect(c.api.embedWatermarkMetadata).toHaveBeenCalledTimes(2);
});

test.each([422, 413])(
  'a %i from the metadata endpoint fails honestly: nothing is stored, no original fallback',
  async (status) => {
    const b = browser();
    b.api.embedWatermarkMetadata.mockRejectedValue(
      new ApiError('Not accepted', { status }),
    );
    await expect(b.service.prepare(record())).rejects.toMatchObject({
      stage: 'embed',
    });
    expect(await b.store.local.readPrepared('local-0/s1.png')).toMatchObject({
      blob: null,
    });
  },
);

test('concurrent requests share one analysis, render and embed', async () => {
  const b = browser();
  const gate = deferred();
  b.render.mockImplementation(async ({ source }) => {
    await gate.promise;
    return { blob: new Blob([source], { type: 'image/png' }), ...SIZE };
  });
  const a = b.service.prepare(record());
  const c = b.service.prepare(record());
  await vi.waitFor(() => expect(b.render).toHaveBeenCalled());
  gate.resolve();
  const [one, two] = await Promise.all([a, c]);
  expect(one.blob).toBe(two.blob);
  expect(b.api.analyzeWatermarkImage).toHaveBeenCalledTimes(1);
  expect(b.api.embedWatermarkMetadata).toHaveBeenCalledTimes(1);
});

test('an image deleted while rendering gets no stored copy and the action does not complete', async () => {
  const b = browser();
  b.render.mockImplementation(async ({ source }) => {
    b.state.listed = false;
    return { blob: new Blob([source], { type: 'image/png' }), ...SIZE };
  });
  await expect(b.service.prepare(record())).rejects.toMatchObject({
    stage: 'removed',
  });
  // Only the (earlier) analysis may remain; no png was written after the delete.
  expect(
    (await b.store.local.readPrepared('local-0/s1.png'))?.blob ?? null,
  ).toBeNull();
});

test('purging a deleted image forgets its copy', async () => {
  const b = browser();
  await b.service.prepare(record());
  await b.host.purge('local-0/s1.png');
  expect(await b.store.local.readPrepared('local-0/s1.png')).toBeNull();
  expect(await b.host.inspect(record())).toEqual({
    analyzed: false,
    prepared: null,
  });
});

test('a quota failure refuses the cache write but returns the usable file and says so', async () => {
  const b = browser();
  b.db.failNext(quotaError(), (names) => names.includes('sharedPrepared'));
  b.db.failNext(quotaError(), (names) => names.includes('sharedPrepared'));
  const result = await b.service.prepare(record());
  expect(result.blob.size).toBeGreaterThan(0);
  expect(result.persistence).toMatchObject({
    state: 'not-stored',
    reason: 'quota',
  });
  expect(await b.host.inspect(record())).toMatchObject({ prepared: null });
});

test('without a database the copy is kept for the tab only and reported as such', async () => {
  const b = browser({ db: null });
  const result = await b.service.prepare(record());
  expect(result.persistence).toEqual({ state: 'memory' });
  expect(await b.host.inspect(record())).toEqual({
    analyzed: true,
    prepared: 'memory',
  });
});

test('a baked copy is refused: it is never watermarked twice', async () => {
  const b = browser();
  await expect(
    b.service.prepare(record({ derivative_type: 'watermarked' })),
  ).rejects.toMatchObject({ stage: 'baked' });
  expect(b.api.analyzeWatermarkImage).not.toHaveBeenCalled();
});

test('two browsers prepare the same original with different content independently', async () => {
  const one = browser({ settings: settingsOf('mine') });
  const two = browser({ settings: settingsOf('yours') });
  await one.service.prepare(record());
  await two.service.prepare(record());
  expect(one.state.metadata[0].watermark_settings.text).toBe('mine');
  expect(two.state.metadata[0].watermark_settings.text).toBe('yours');
});

/** Rewrite the stored row as an older build wrote it: raw canvas PNG, no pipeline. */
async function downgradeToLegacy(b, key = 'local-0/s1.png') {
  const row = await b.store.local.readPrepared(key);
  const { pipeline: _pipeline, ...legacy } = row.state.prepared;
  await b.store.local.writePrepared(key, {
    state: { ...row.state, prepared: legacy },
    blob: new Blob(['raw-canvas'], { type: 'image/png' }),
  });
}

test('a legacy prepared entry without a pipeline version is refreshed after reload: analysis reused, source re-embedded, never the old bytes', async () => {
  const first = browser();
  await first.service.prepare(record());
  await downgradeToLegacy(first);

  const second = browser({ db: first.db });
  expect(await second.host.inspect(record())).toEqual({
    analyzed: true,
    prepared: null,
  });
  const result = await second.service.prepare(record());
  expect(result.reused).toBe(false);
  // The analysis was reusable; only the source was re-read and re-embedded.
  expect(second.api.analyzeWatermarkImage).not.toHaveBeenCalled();
  expect(second.render).toHaveBeenCalledTimes(1);
  expect(second.api.embedWatermarkMetadata).toHaveBeenCalledTimes(1);
  expect(second.fetchBlob).toHaveBeenCalledTimes(1);
  expect(await result.blob.text()).not.toContain('raw-canvas');
  expect(await result.blob.text()).toContain('ImageDials');
  expect(first.original.size).toBe(30);

  // The new bytes carry the version and are reused on the next reload.
  const third = browser({ db: first.db });
  const again = await third.service.prepare(record());
  expect(again.reused).toBe(true);
  expect(await again.blob.text()).toBe(await result.blob.text());
  expect(third.render).not.toHaveBeenCalled();
  expect(third.api.embedWatermarkMetadata).not.toHaveBeenCalled();
});

test('a failed re-embed of a legacy entry is an error, never the original or the legacy bytes, and the entry stays refreshable', async () => {
  const first = browser();
  await first.service.prepare(record());
  await downgradeToLegacy(first);

  const second = browser({ db: first.db });
  second.api.embedWatermarkMetadata.mockRejectedValueOnce(
    new ApiError('metadata offline', { status: 503 }),
  );
  await expect(second.service.prepare(record())).rejects.toMatchObject({
    stage: 'embed',
  });
  expect(await second.host.inspect(record())).toMatchObject({ prepared: null });
  const retry = await browser({ db: first.db }).service.prepare(record());
  expect(retry.reused).toBe(false);
  expect(await retry.blob.text()).toContain('ImageDials');
});

test('new shared placement invalidates prepared bytes and passes its full context to local-content analysis', async () => {
  const b = browser();
  const first = await b.service.prepare(record());
  const context = {
    ...first.analysis.analysis.print_watermark,
    position: { corner: 'bottom-right' },
    presentation: { gradient_start: '#807060', gradient_end: '#908070' },
  };
  const analyze = b.api.analyzeWatermarkImage.getMockImplementation();
  b.api.analyzeWatermarkImage.mockImplementation(async (image, options) => ({
    ...(await analyze(image, options)),
    print_watermark: options.previousAnalysis,
  }));
  const next = await b.service.prepare(record({ print_watermark: context }));
  expect(next.reused).toBe(false);
  expect(next.analysis.analysis.print_watermark).toEqual(context);
  expect(b.state.uploads.at(-1).options.previousAnalysis).toEqual(context);
  expect(
    b.render.mock.calls.every(([args]) => args.source === b.original),
  ).toBe(true);
  expect(b.state.metadata.at(-1).print_watermark.position.corner).toBe(
    'bottom-right',
  );
  expect(next.blob).not.toBe(first.blob);
});

test('an analyzer response for another original is rejected before any render or storage', async () => {
  const b = browser();
  const analyze = b.api.analyzeWatermarkImage.getMockImplementation();
  b.api.analyzeWatermarkImage.mockImplementation(async (...args) => ({
    ...(await analyze(...args)),
    source_sha256: 'c'.repeat(64),
  }));
  await expect(b.service.prepare(record())).rejects.toMatchObject({
    stage: 'source',
  });
  expect(b.render).not.toHaveBeenCalled();
  expect(await b.store.local.readPrepared('local-0/s1.png')).toBeNull();
});

test('an aborted analysis cannot publish a late response even if transport ignores its signal', async () => {
  const b = browser();
  const held = deferred();
  const analyze = b.api.analyzeWatermarkImage.getMockImplementation();
  b.api.analyzeWatermarkImage.mockImplementation(async (...args) => {
    await held.promise;
    return analyze(...args);
  });
  const controller = new AbortController();
  const pending = b.service.analyze(record(), { signal: controller.signal });
  await vi.waitFor(() =>
    expect(b.api.analyzeWatermarkImage).toHaveBeenCalled(),
  );
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  held.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(await b.store.local.readPrepared('local-0/s1.png')).toBeNull();
});
