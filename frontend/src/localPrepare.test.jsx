import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

import { DEFAULT_CLIENT_POLICY } from './clientPolicy.js';
import { createCacheStore, WRITE_SKIPPED } from './cacheStore.js';
import {
  deferred,
  imageBlob,
  memoryDb,
  scriptedStore,
} from './cacheTestSupport.js';
import { createUrlLedger } from './objectUrls.js';
import { createLocalPrepareService } from './localPrepare.js';
import { usePrivateHistory } from './privateHistory.js';

// The service runs outside React's event handlers; the hook state it changes
// is read back with `waitFor`, so updates need no act() wrapper.
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
});

const limits = {
  ...DEFAULT_CLIENT_POLICY.cache,
  sharedRecordLimit: 10,
  sharedVariantLimit: 10,
  sharedVariantMaxBytes: 1000,
  privateRecordLimit: 5,
  privateMaxBytes: 400,
};
const SIZE = { width: 120, height: 80 };
const urlApi = () => {
  let next = 0;
  return {
    createObjectURL: () => `blob:t-${(next += 1)}`,
    revokeObjectURL: () => {},
  };
};

/** Settings as the server returns them; `fingerprint` is the content version. */
const rendering1 = {
  rendererVersion: 'r1',
  defaultPresentation: {
    gradient_start: '#ffd15e',
    gradient_end: null,
    separation_color: '#05070a',
    glow_color: '#ff6f3d',
  },
};
const settingsOf = (fingerprint, rendering = rendering1) => ({
  type: 'text',
  text: fingerprint,
  fingerprint,
  rendering,
  limits: { max_lines: 4, max_line_length: 16 },
});

/** A scripted API: settings are mutable, keys are opaque tokens of the content. */
function fakeApi(initial = 'f1') {
  const state = {
    settings: settingsOf(initial),
    sourceSha: 'a'.repeat(64),
    analyses: 0,
    forced: [],
    uploads: [],
    embedded: [],
  };
  const api = {
    watermarkSettings: vi.fn(async () => structuredClone(state.settings)),
    analyzeWatermarkImage: vi.fn(async (image, { force = false } = {}) => {
      state.analyses += 1;
      state.forced.push(force);
      state.uploads.push(image);
      return {
        print_watermark: {
          position: { corner: 'bottom-left' },
          presentation: { gradient_start: '#fff' },
        },
        print_watermark_key: `key-${state.settings.fingerprint}-${state.analyses}`,
        source_sha256: state.sourceSha,
        dimensions: SIZE,
        watermark_settings: structuredClone(state.settings),
        storage: 'transient',
      };
    }),
    // A shared route must never be reached from the private branch.
    // The metadata endpoint returns a distinct PNG object.
    embedWatermarkMetadata: vi.fn(async (file) => {
      state.embedded.push(file);
      return new Blob([file], { type: 'image/png' });
    }),
    analyzeWatermark: vi.fn(),
    uploadPrintReady: vi.fn(),
    queueWatermarkBackfill: vi.fn(),
  };
  return { api, state };
}

function setup({ store, fetchBlob, ...rest } = {}) {
  const db = memoryDb();
  const real = store ?? createCacheStore(db, limits);
  const urls = createUrlLedger(urlApi());
  const hook = renderHook(() =>
    usePrivateHistory({
      store: real,
      urls,
      limits,
      enabled: true,
      fetchBlob: fetchBlob ?? vi.fn(async () => imageBlob(20)),
      thumbnail: vi.fn(async () => imageBlob(4, 'image/jpeg')),
      digest: vi.fn(async () => null),
      ...rest,
    }),
  );
  return { hook, db, store: real, urls };
}

const importWire = (id) => ({
  id,
  title: id,
  safe: false,
  count: 0,
  image_url: '/untrusted/server/url.png',
  width: 999,
  height: 999,
});

async function addImport(ctx, id, bytes = 30) {
  await waitFor(() => expect(ctx.hook.result.current.status).toBe('ready'));
  const file = imageBlob(bytes);
  const url = ctx.urls.acquire(file);
  act(() => {
    ctx.hook.result.current.add(importWire(id), {
      origin: 'imported',
      blob: file,
      url,
    });
  });
  await waitFor(() =>
    expect(
      ctx.hook.result.current.items.find((i) => i.id === id).local_storage
        .state,
    ).toBe('stored'),
  );
  return file;
}

const viewOf = (ctx, id) =>
  ctx.hook.result.current.items.find((item) => item.id === id);

function serviceFor(ctx, fake, overrides = {}) {
  const render = vi.fn(async () => ({
    blob: imageBlob(40),
    width: SIZE.width,
    height: SIZE.height,
  }));
  const service = createLocalPrepareService({
    api: fake.api,
    host: ctx.hook.result.current.watermarkHost,
    readSettings: (signal) => fake.api.watermarkSettings({ signal }),
    render,
    ...overrides,
  });
  return { service, render };
}

test('concurrent prepares of one image share one analysis and one render, and keep PNG and analysis beside the unchanged wire', async () => {
  const ctx = setup();
  const original = await addImport(ctx, 'a');
  const fake = fakeApi();
  const gate = deferred();
  const { service, render } = serviceFor(ctx, fake);
  render.mockImplementation(async () => {
    await gate.promise;
    return { blob: imageBlob(40), width: 120, height: 80 };
  });
  const record = viewOf(ctx, 'a');

  const first = service.prepare(record);
  const second = service.prepare(record);
  await waitFor(() => expect(render).toHaveBeenCalled());
  gate.resolve();
  const [one, two] = await Promise.all([first, second]);

  expect(one.blob).toBe(two.blob);
  expect(fake.api.analyzeWatermarkImage).toHaveBeenCalledTimes(1);
  expect(render).toHaveBeenCalledTimes(1);
  // The ORIGINAL bytes were analyzed and drawn on, never the wire URL.
  expect(fake.state.uploads[0]).toBe(original);
  expect(render.mock.calls[0][0].source).toBe(original);
  expect(one.persistence).toEqual({ state: 'stored' });
  expect(one.size).toEqual(SIZE);

  const [stored] = await ctx.store.loadPrivate();
  expect(stored.record).toEqual(importWire('a'));
  expect(stored.watermark.analysis.print_watermark_key).toBe('key-f1-1');
  expect(stored.watermark.prepared).toMatchObject({ bytes: 40, width: 120 });
  expect(stored.full).toBe(original);
  expect(stored.full.size).toBe(30);
  // No shared route was touched.
  for (const name of [
    'analyzeWatermark',
    'uploadPrintReady',
    'queueWatermarkBackfill',
  ])
    expect(fake.api[name]).not.toHaveBeenCalled();
});

test('the view shows the analysis and the actual size, not the historical wire size', async () => {
  const ctx = setup();
  await addImport(ctx, 'a');
  expect(viewOf(ctx, 'a').print_watermark).toBeUndefined();
  const fake = fakeApi();
  const { service } = serviceFor(ctx, fake);
  await service.analyze(viewOf(ctx, 'a'));
  await waitFor(() =>
    expect(viewOf(ctx, 'a').print_watermark_key).toBe('key-f1-1'),
  );
  const view = viewOf(ctx, 'a');
  expect(view.print_watermark.position.corner).toBe('bottom-left');
  expect([view.width, view.height]).toEqual([120, 80]);
  expect(view.local_watermark).toEqual({ prepared: null });
});

test('after a reload the stored PNG is reused without analysis or rendering; nothing is drawn twice', async () => {
  const ctx = setup();
  await addImport(ctx, 'a');
  const fake = fakeApi();
  await serviceFor(ctx, fake).service.prepare(viewOf(ctx, 'a'));
  ctx.hook.unmount();

  const reloaded = setup({ store: createCacheStore(ctx.db, limits) });
  await waitFor(() => expect(viewOf(reloaded, 'a')).toBeDefined());
  expect(viewOf(reloaded, 'a').local_watermark.prepared).toBe('stored');
  const { service, render } = serviceFor(reloaded, fake);
  const result = await service.prepare(viewOf(reloaded, 'a'));
  expect(result.reused).toBe(true);
  expect(result.blob.size).toBe(40);
  expect(render).not.toHaveBeenCalled();
  expect(fake.api.analyzeWatermarkImage).toHaveBeenCalledTimes(1);
});

test('a legacy prepared PNG without a pipeline version is not reused after reload: analysis reused, the original re-embedded, failure never returns the original', async () => {
  const ctx = setup();
  const original = await addImport(ctx, 'a');
  const fake = fakeApi();
  await serviceFor(ctx, fake).service.prepare(viewOf(ctx, 'a'));
  // Rewrite the stored entry as an older build wrote it: no pipeline marker.
  const [row] = await ctx.store.loadPrivate();
  const { pipeline, ...legacy } = row.watermark.prepared;
  expect(pipeline).toBe('embed-metadata-v1');
  await ctx.store.savePrivatePrepared(
    'a',
    { addedAt: row.addedAt },
    { ...row.watermark, prepared: legacy },
    imageBlob(40),
  );
  ctx.hook.unmount();

  const reloaded = setup({ store: createCacheStore(ctx.db, limits) });
  await waitFor(() => expect(viewOf(reloaded, 'a')).toBeDefined());
  expect(viewOf(reloaded, 'a').local_watermark.prepared).toBeNull();
  const failing = fakeApi();
  failing.api.embedWatermarkMetadata.mockRejectedValueOnce(
    new Error('metadata offline'),
  );
  const first = serviceFor(reloaded, failing);
  await expect(
    first.service.prepare(viewOf(reloaded, 'a')),
  ).rejects.toMatchObject({ stage: 'embed' });

  const { service, render } = serviceFor(reloaded, fake);
  const result = await service.prepare(viewOf(reloaded, 'a'));
  expect(result.reused).toBe(false);
  expect(fake.api.analyzeWatermarkImage).toHaveBeenCalledTimes(1);
  expect(failing.api.analyzeWatermarkImage).not.toHaveBeenCalled();
  expect(render.mock.calls[0][0].source).toBe(original);
  await waitFor(() =>
    expect(viewOf(reloaded, 'a').local_watermark.prepared).toBe('stored'),
  );
  const [stored] = await reloaded.store.loadPrivate();
  expect(stored.watermark.prepared.pipeline).toBe('embed-metadata-v1');
  expect(stored.full.size).toBe(original.size);

  reloaded.hook.unmount();
  const again = setup({ store: createCacheStore(ctx.db, limits) });
  await waitFor(() => expect(viewOf(again, 'a')).toBeDefined());
  const last = serviceFor(again, fake);
  const reused = await last.service.prepare(viewOf(again, 'a'));
  expect(reused.reused).toBe(true);
  expect(last.render).not.toHaveBeenCalled();
});

test('changed content keeps no stale PNG: the analyzer is asked again (it reuses pixels), a new key is drawn', async () => {
  const ctx = setup();
  await addImport(ctx, 'a');
  const fake = fakeApi('f1');
  const { service, render } = serviceFor(ctx, fake);
  await service.prepare(viewOf(ctx, 'a'));

  fake.state.settings = settingsOf('f2');
  const result = await service.prepare(viewOf(ctx, 'a'));
  expect(result.reused).toBe(false);
  expect(fake.api.analyzeWatermarkImage).toHaveBeenCalledTimes(2);
  expect(render).toHaveBeenCalledTimes(2);
  expect(render.mock.calls[1][0].settings.fingerprint).toBe('f2');
  const [stored] = await ctx.store.loadPrivate();
  expect(stored.watermark.analysis.print_watermark_key).toBe('key-f2-2');
  expect(stored.watermark.prepared.fingerprint).toBe('f2');
});

test('a changed rendering policy invalidates analysis and PNG even with the same content', async () => {
  const ctx = setup();
  await addImport(ctx, 'a');
  const fake = fakeApi('f1');
  const { service } = serviceFor(ctx, fake);
  await service.prepare(viewOf(ctx, 'a'));
  fake.state.settings = settingsOf('f1', {
    ...rendering1,
    rendererVersion: 'r2',
  });
  const result = await service.prepare(viewOf(ctx, 'a'));
  expect(result.reused).toBe(false);
  expect(fake.api.analyzeWatermarkImage).toHaveBeenCalledTimes(2);
});

test('a settings change DURING the render refreshes and renders once more; a second change fails honestly', async () => {
  const ctx = setup();
  await addImport(ctx, 'a');
  const fake = fakeApi('f1');
  const { service, render } = serviceFor(ctx, fake);
  let calls = 0;
  render.mockImplementation(async () => {
    calls += 1;
    if (calls === 1) fake.state.settings = settingsOf('f2');
    return { blob: imageBlob(40), width: 120, height: 80 };
  });
  const result = await service.prepare(viewOf(ctx, 'a'));
  expect(calls).toBe(2);
  expect(result.analysis.settings.fingerprint).toBe('f2');
  expect(fake.api.analyzeWatermarkImage).toHaveBeenCalledTimes(2);

  const again = setup();
  await addImport(again, 'b');
  const churn = fakeApi('g1');
  const second = serviceFor(again, churn);
  let n = 0;
  second.render.mockImplementation(async () => {
    n += 1;
    churn.state.settings = settingsOf(`g${n + 1}`);
    return { blob: imageBlob(40), width: 120, height: 80 };
  });
  await expect(
    second.service.prepare(viewOf(again, 'b')),
  ).rejects.toMatchObject({ stage: 'settings' });
  expect(n).toBe(2); // one retry, then the answer
  const [stored] = await again.store.loadPrivate();
  expect(stored.watermark.prepared).toBeNull();
});

test('force asks the analyzer to regenerate; ordinary requests do not', async () => {
  const ctx = setup();
  await addImport(ctx, 'a');
  const fake = fakeApi();
  const { service } = serviceFor(ctx, fake);
  await service.analyze(viewOf(ctx, 'a'));
  await service.analyze(viewOf(ctx, 'a')); // current: no call
  expect(fake.api.analyzeWatermarkImage).toHaveBeenCalledTimes(1);
  await service.analyze(viewOf(ctx, 'a'), { force: true });
  expect(fake.state.forced).toEqual([false, true]);
});

test('render and embed changes share one retry budget', async () => {
  const ctx = setup();
  await addImport(ctx, 'a');
  const fake = fakeApi();
  const { service, render } = serviceFor(ctx, fake);
  render.mockImplementationOnce(async () => {
    fake.state.settings = settingsOf('f2');
    return { blob: imageBlob(40), ...SIZE };
  });
  fake.api.embedWatermarkMetadata.mockImplementation(async (file) => {
    fake.state.settings = settingsOf('f3');
    return new Blob([file], { type: 'image/png' });
  });
  await expect(service.prepare(viewOf(ctx, 'a'))).rejects.toMatchObject({
    stage: 'settings',
  });
  expect(render).toHaveBeenCalledTimes(2);
  // The first render is already stale and must never be embedded.
  expect(fake.api.embedWatermarkMetadata).toHaveBeenCalledTimes(1);
  expect((await ctx.store.loadPrivate())[0].watermark.prepared).toBeNull();
});

test('HTTP409 and a later embed settings change share one retry budget', async () => {
  const ctx = setup();
  await addImport(ctx, 'a');
  const fake = fakeApi();
  fake.api.embedWatermarkMetadata.mockRejectedValueOnce(
    Object.assign(new Error('Stale key'), { status: 409 }),
  );
  fake.api.embedWatermarkMetadata.mockImplementation(async (file) => {
    fake.state.settings = settingsOf('f2');
    return new Blob([file], { type: 'image/png' });
  });
  const { service, render } = serviceFor(ctx, fake);
  await expect(service.prepare(viewOf(ctx, 'a'))).rejects.toMatchObject({
    stage: 'settings',
  });
  expect(render).toHaveBeenCalledTimes(2);
  expect(fake.api.embedWatermarkMetadata).toHaveBeenCalledTimes(2);
  expect((await ctx.store.loadPrivate())[0].watermark.prepared).toBeNull();
});

test('a settings change during metadata embedding discards the old PNG and retries with the latest content', async () => {
  const ctx = setup();
  const original = await addImport(ctx, 'a');
  const fake = fakeApi();
  const gate = deferred();
  fake.api.embedWatermarkMetadata.mockImplementationOnce(async (file) => {
    await gate.promise;
    return new Blob([file], { type: 'image/png' });
  });
  const { service, render } = serviceFor(ctx, fake);
  const pending = service.prepare(viewOf(ctx, 'a'));
  await waitFor(() =>
    expect(fake.api.embedWatermarkMetadata).toHaveBeenCalledTimes(1),
  );
  fake.state.settings = settingsOf('f2');
  gate.resolve();

  const result = await pending;
  expect(result.analysis.settings.fingerprint).toBe('f2');
  expect(render).toHaveBeenCalledTimes(2);
  expect(fake.api.embedWatermarkMetadata).toHaveBeenCalledTimes(2);
  const [stored] = await ctx.store.loadPrivate();
  expect(stored.watermark.settings.fingerprint).toBe('f2');
  expect(stored.watermark.prepared.key).toBe(
    result.analysis.analysis.print_watermark_key,
  );
  expect(stored.full).toBe(original);
});

test('a second settings change during metadata embedding fails without storing or returning a stale PNG', async () => {
  const ctx = setup();
  const original = await addImport(ctx, 'a');
  const fake = fakeApi();
  let calls = 0;
  fake.api.embedWatermarkMetadata.mockImplementation(async (file) => {
    calls += 1;
    fake.state.settings = settingsOf(`f${calls + 1}`);
    return new Blob([file], { type: 'image/png' });
  });
  const { service, render } = serviceFor(ctx, fake);
  await expect(service.prepare(viewOf(ctx, 'a'))).rejects.toMatchObject({
    stage: 'settings',
  });
  expect(render).toHaveBeenCalledTimes(2);
  expect(calls).toBe(2);
  const [stored] = await ctx.store.loadPrivate();
  expect(stored.watermark.prepared).toBeNull();
  expect(stored.full).toBe(original);
});

test('an image removed while analysis runs is not brought back and the action does not complete', async () => {
  const ctx = setup();
  await addImport(ctx, 'a');
  const fake = fakeApi();
  const gate = deferred();
  fake.api.analyzeWatermarkImage.mockImplementationOnce(async () => {
    await gate.promise;
    return {
      print_watermark: { position: { corner: 'top-left' } },
      print_watermark_key: 'late',
      source_sha256: 'b'.repeat(64),
      dimensions: SIZE,
      watermark_settings: settingsOf('f1'),
      storage: 'transient',
    };
  });
  const { service, render } = serviceFor(ctx, fake);
  const pending = service.prepare(viewOf(ctx, 'a'));
  await waitFor(() =>
    expect(fake.api.analyzeWatermarkImage).toHaveBeenCalled(),
  );
  await ctx.hook.result.current.remove(viewOf(ctx, 'a'));
  gate.resolve();
  await expect(pending).rejects.toMatchObject({ stage: 'removed' });
  expect(render).not.toHaveBeenCalled();
  expect(await ctx.store.loadPrivate()).toEqual([]);
  await waitFor(() => expect(ctx.hook.result.current.items).toEqual([]));
});

test('an image removed while rendering gets no late PNG write', async () => {
  const ctx = setup();
  await addImport(ctx, 'a');
  const fake = fakeApi();
  const gate = deferred();
  const { service, render } = serviceFor(ctx, fake);
  render.mockImplementation(async () => {
    await gate.promise;
    return { blob: imageBlob(40), width: 120, height: 80 };
  });
  const pending = service.prepare(viewOf(ctx, 'a'));
  await waitFor(() => expect(render).toHaveBeenCalled());
  await ctx.hook.result.current.remove(viewOf(ctx, 'a'));
  gate.resolve();
  await expect(pending).rejects.toMatchObject({ stage: 'removed' });
  expect(await ctx.store.loadPrivate()).toEqual([]);
});

test('a prepared PNG that does not fit beside the other copies is refused without pruning them; the PNG is still returned', async () => {
  const ctx = setup();
  await addImport(ctx, 'a', 100);
  await addImport(ctx, 'b', 100);
  const fake = fakeApi();
  const { service, render } = serviceFor(ctx, fake);
  // 200 bytes are stored; a 250 byte PNG would reach 450 > 400.
  render.mockResolvedValue({ blob: imageBlob(250), width: 120, height: 80 });
  const result = await service.prepare(viewOf(ctx, 'a'));
  expect(result.blob.size).toBe(250);
  expect(result.persistence).toMatchObject({
    state: 'not-stored',
    reason: WRITE_SKIPPED.OVERSIZE,
  });
  const stored = await ctx.store.loadPrivate();
  expect(stored.map((row) => row.record.id).sort()).toEqual(['a', 'b']);
  expect(stored.every((row) => row.full.size === 100)).toBe(true);
  await waitFor(() =>
    expect(viewOf(ctx, 'a').local_watermark.prepared).toBeNull(),
  );
});

test('prepared bytes count toward the budget, so a later import releases the prepared PNG and keeps every original', async () => {
  const ctx = setup();
  const first = await addImport(ctx, 'a', 100);
  const fake = fakeApi();
  const { service, render } = serviceFor(ctx, fake);
  render.mockResolvedValue({ blob: imageBlob(250), width: 120, height: 80 });
  await service.prepare(viewOf(ctx, 'a'));
  // 100 + 250 stored; a 100 byte import reaches 450 > 400, so the rebuildable
  // PNG goes first and no original is touched.
  await addImport(ctx, 'b', 100);
  const stored = await ctx.store.loadPrivate();
  expect(stored.map((row) => row.record.id)).toEqual(['b', 'a']);
  expect(stored[1].preparedBytes).toBe(0);
  expect(stored[1].full).toBe(first);
  await waitFor(() =>
    expect(viewOf(ctx, 'a').local_watermark.prepared).toBeNull(),
  );
});

test('removing an entry deletes its prepared PNG with it', async () => {
  const ctx = setup();
  await addImport(ctx, 'a');
  const { service } = serviceFor(ctx, fakeApi());
  await service.prepare(viewOf(ctx, 'a'));
  await ctx.hook.result.current.remove(viewOf(ctx, 'a'));
  const keys = [...ctx.db.data.get('privateMedia').keys()];
  expect(keys).toEqual([]);
});

test('a render of the wrong size is an error: the analyzed source is the truth', async () => {
  const ctx = setup();
  await addImport(ctx, 'a');
  const { service, render } = serviceFor(ctx, fakeApi());
  render.mockResolvedValue({ blob: imageBlob(40), width: 999, height: 999 });
  await expect(service.prepare(viewOf(ctx, 'a'))).rejects.toMatchObject({
    stage: 'render',
  });
  const [stored] = await ctx.store.loadPrivate();
  expect(stored.watermark.prepared).toBeNull();
});

test('an import with no local bytes is never fetched from its wire URL', async () => {
  const fetchBlob = vi.fn(async () => imageBlob(20));
  const ctx = setup({ fetchBlob });
  await waitFor(() => expect(ctx.hook.result.current.status).toBe('ready'));
  // A durable record with no stored bytes: only the wire snapshot is left.
  await ctx.store.admitPrivate({
    record: importWire('gone'),
    origin: 'imported',
    addedAt: 5,
  });
  ctx.hook.unmount();
  const reloaded = setup({ store: ctx.store, fetchBlob });
  await waitFor(() => expect(viewOf(reloaded, 'gone')).toBeDefined());
  const fake = fakeApi();
  const { service } = serviceFor(reloaded, fake);
  await expect(service.prepare(viewOf(reloaded, 'gone'))).rejects.toMatchObject(
    { stage: 'source' },
  );
  expect(fetchBlob).not.toHaveBeenCalled();
  expect(fake.api.analyzeWatermarkImage).not.toHaveBeenCalled();
});

test('a fresh private result without local bytes may be fetched from its server URL, checked against its checksum', async () => {
  const fetched = imageBlob(25);
  const fetchBlob = vi.fn(async () => fetched);
  const digest = vi.fn(async () => 'c'.repeat(64));
  const ctx = setup({ fetchBlob, digest });
  await waitFor(() => expect(ctx.hook.result.current.status).toBe('ready'));
  // Memory only: no capture happens, so the original is fetched on demand.
  const memory = setup({
    store: createCacheStore(null, limits),
    fetchBlob,
    digest,
  });
  await waitFor(() => expect(memory.hook.result.current.status).toBe('ready'));
  act(() => {
    memory.hook.result.current.add(
      {
        id: 'g',
        image_id: 'g',
        storage_id: 'local-0',
        filename: 'g.png',
        visibility: 'private',
        image_url: '/api/images/g/content',
        sha256: 'd'.repeat(64),
      },
      { origin: 'generated' },
    );
  });
  const fake = fakeApi();
  fake.state.sourceSha = 'd'.repeat(64);
  const { service } = serviceFor(memory, fake);
  await expect(service.prepare(viewOf(memory, 'g'))).rejects.toMatchObject({
    stage: 'source',
  });
  expect(fetchBlob).toHaveBeenCalledWith('/api/images/g/content', {
    signal: expect.any(AbortSignal),
  });
  digest.mockResolvedValue('d'.repeat(64));
  const ok = await service.prepare(viewOf(memory, 'g'));
  expect(ok.persistence).toEqual({ state: 'memory' });
  await waitFor(() =>
    expect(viewOf(memory, 'g').local_watermark.prepared).toBe('memory'),
  );
});

test('an original over the analyzer limit is not uploaded', async () => {
  const ctx = setup();
  await addImport(ctx, 'a', 30);
  const fake = fakeApi();
  const { service } = serviceFor(ctx, fake, {
    limits: () => ({ maxBytes: 10 }),
  });
  await expect(service.prepare(viewOf(ctx, 'a'))).rejects.toMatchObject({
    stage: 'source',
  });
  expect(fake.api.analyzeWatermarkImage).not.toHaveBeenCalled();
});

test('denied storage still returns the rendered PNG and says it was not stored', async () => {
  const store = scriptedStore({
    loadPrivate: vi.fn(async () => []),
    admitPrivate: vi.fn(async () => ({ persisted: true, duplicate: false })),
    readPrivateMedia: vi.fn(async () => imageBlob(30)),
    savePrivateWatermark: vi.fn(async () => ({ persisted: true })),
    savePrivatePrepared: vi.fn(async () => ({
      persisted: false,
      reason: WRITE_SKIPPED.QUOTA,
    })),
  });
  const ctx = setup({ store });
  await addImport(ctx, 'a');
  const { service } = serviceFor(ctx, fakeApi());
  const result = await service.prepare(viewOf(ctx, 'a'));
  expect(result.blob.size).toBe(40);
  expect(result.persistence).toMatchObject({
    state: 'not-stored',
    reason: 'quota',
  });
  await waitFor(() =>
    expect(viewOf(ctx, 'a').local_watermark.prepared).toBeNull(),
  );
  expect(viewOf(ctx, 'a').print_watermark_key).toBe('key-f1-1');
});

test('a memory-only history keeps analysis and PNG for the tab only, within the byte budget', async () => {
  const ctx = setup({ store: createCacheStore(null, limits) });
  await waitFor(() => expect(ctx.hook.result.current.status).toBe('ready'));
  const file = imageBlob(30);
  act(() => {
    ctx.hook.result.current.add(importWire('m'), {
      origin: 'imported',
      blob: file,
      url: ctx.urls.acquire(file),
    });
  });
  const { service, render } = serviceFor(ctx, fakeApi());
  const first = await service.prepare(viewOf(ctx, 'm'));
  expect(first.persistence).toEqual({ state: 'memory' });
  const second = await service.prepare(viewOf(ctx, 'm'));
  expect(second.reused).toBe(true);
  expect(second.blob).toBe(first.blob);
  expect(render).toHaveBeenCalledTimes(1);
});

test('the shared source of truth: a mismatched source hash makes the stored analysis stale', async () => {
  const ctx = setup();
  await addImport(ctx, 'a');
  const fake = fakeApi();
  const { service } = serviceFor(ctx, fake);
  await service.analyze(viewOf(ctx, 'a'));
  // The wire now names a different source: the analysis is not trusted.
  const entry = ctx.hook.result.current.watermarkHost.current(
    ctx.hook.result.current.watermarkHost.handleFor(viewOf(ctx, 'a')),
  );
  entry.wire.sha256 = 'f'.repeat(64);
  fake.state.sourceSha = 'f'.repeat(64);
  await service.analyze(viewOf(ctx, 'a'));
  expect(fake.api.analyzeWatermarkImage).toHaveBeenCalledTimes(2);
});

test('the metadata endpoint receives the whole wire record and the local content, and its RETURNED file is the one stored and reused', async () => {
  const ctx = setup();
  await addImport(ctx, 'a');
  const fake = fakeApi();
  const embed = fake.api.embedWatermarkMetadata;
  embed.mockImplementation(async () => imageBlob(77));
  const { service, render } = serviceFor(ctx, fake);
  const result = await service.prepare(viewOf(ctx, 'a'));

  expect(
    fake.api.analyzeWatermarkImage.mock.calls[0][1].watermarkSettings,
  ).toEqual(settingsOf('f1'));
  const [, metadata] = embed.mock.calls[0];
  expect(metadata).toMatchObject({
    source_image: importWire('a'),
    source_sha256: 'a'.repeat(64),
    watermark_key: 'key-f1-1',
    watermark_settings: settingsOf('f1'),
    dimensions: SIZE,
  });
  expect(metadata.print_watermark.position.corner).toBe('bottom-left');
  // The returned bytes, not the canvas render, are accounted for and stored.
  expect(result.blob.size).toBe(77);
  const [stored] = await ctx.store.loadPrivate();
  expect(stored.watermark.prepared.bytes).toBe(77);
  expect(stored.preparedBytes).toBe(77);
  const again = await service.prepare(viewOf(ctx, 'a'));
  expect(again.reused).toBe(true);
  expect(again.blob.size).toBe(77);
  expect(render).toHaveBeenCalledTimes(1);
  expect(embed).toHaveBeenCalledTimes(1);
});

test('a baked import is never analyzed or drawn on again', async () => {
  const ctx = setup();
  await addImport(ctx, 'a');
  const fake = fakeApi();
  const { service, render } = serviceFor(ctx, fake);
  await expect(
    service.prepare({ ...viewOf(ctx, 'a'), derivative_type: 'watermarked' }),
  ).rejects.toMatchObject({ stage: 'baked' });
  expect(render).not.toHaveBeenCalled();
  expect(fake.api.analyzeWatermarkImage).not.toHaveBeenCalled();
});

test('a changed analysis version cannot silently reuse browser-private placement or prepared pixels', async () => {
  const { analysisCurrent, isUsableAnalysis } =
    await import('./privateWatermark.js');
  const rendering = { ...rendering1, analysisVersion: 'pixel-analysis-v4' };
  const settings = settingsOf('same-content', rendering);
  const placement = {
    position: { corner: 'bottom-left' },
    provenance: { generator_version: 'pixel-analysis-v3' },
  };
  const state = {
    addedAt: 1,
    settings,
    analysis: {
      print_watermark: placement,
      print_watermark_key: 'old',
      dimensions: SIZE,
    },
  };
  expect(analysisCurrent(state, settings, { addedAt: 1 })).toBe(false);
  expect(
    isUsableAnalysis({
      storage: 'transient',
      watermark_settings: settings,
      dimensions: SIZE,
      print_watermark: placement,
      print_watermark_key: 'old',
    }),
  ).toBe(false);
  state.analysis.print_watermark.provenance.generator_version =
    'pixel-analysis-v4';
  expect(analysisCurrent(state, settings, { addedAt: 1 })).toBe(true);
});
