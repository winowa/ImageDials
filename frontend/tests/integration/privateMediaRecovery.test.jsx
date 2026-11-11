import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import React, { StrictMode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';

import { DEFAULT_CLIENT_POLICY } from '../../src/data/api/clientPolicy.js';
import { STORE } from '../../src/data/storage/cacheDb.js';
import { createCacheStore } from '../../src/data/storage/cacheStore.js';
import { deferred, memoryDb } from '../helpers/cacheTestSupport.js';
import { describeImage } from '../../src/data/records/imageRecord.js';
import { createUrlLedger } from '../../src/data/media/objectUrls.js';
import { privateLibraryView } from '../../src/data/storage/privateLibrary.js';
import { createPrivateMedia } from '../../src/data/media/privateMedia.js';
import { libraryRecord } from '../helpers/testSupport.js';
import { MediaContext } from '../../src/data/media/variantSrc.js';
import { SavedImg } from '../../src/data/media/SavedImg.jsx';
import { VARIANT_KIND } from '../../src/data/storage/cachePolicy.js';

const blob = (content, type = 'image/png') => new Blob([content], { type });
const thumb = () => blob('derived-jpeg', 'image/jpeg');

function urls() {
  let serial = 0;
  const api = {
    createObjectURL: vi.fn(() => `blob:private-${serial++}`),
    revokeObjectURL: vi.fn(),
  };
  return { api, ledger: createUrlLedger(api) };
}

async function setup({
  thumbnail = null,
  original = blob('original'),
  addedAt = 7,
} = {}) {
  const key = 'private-store/private-image.png';
  const wire = {
    id: 'private-image',
    image_id: 'private-image',
    title: 'Private image',
    visibility: 'private',
    storage_id: 'private-store',
    filename: 'private-image.png',
    image_url: 'https://wire.invalid/never-fetch',
    dimensions: { width: 800, height: 600 },
  };
  const db = memoryDb();
  const originalMap = new Map([
    [key, { record: wire, origin: 'generated', addedAt }],
  ]);
  const mediaMap = new Map();
  if (original)
    mediaMap.set(`${key}|full`, { blob: original, bytes: original.size });
  if (thumbnail)
    mediaMap.set(`${key}|thumbnail`, {
      blob: thumbnail,
      bytes: thumbnail.size,
    });
  db.data.set(STORE.PRIVATE, originalMap);
  db.data.set(STORE.PRIVATE_MEDIA, mediaMap);
  const store = createCacheStore(db, DEFAULT_CLIENT_POLICY.cache);
  const save = vi.spyOn(store, 'savePrivateThumbnail');
  const record = privateLibraryView(await store.readPrivateDetail(key));
  const read = vi.spyOn(store, 'readPrivateMedia');
  const { api, ledger } = urls();
  return { db, store, record, read, save, api, ledger, wire };
}

const renderPrivate = (media, record, props = {}, strict = false) => {
  const tree = (
    <MediaContext.Provider value={media}>
      <SavedImg image={record} {...props} />
    </MediaContext.Provider>
  );
  return render(strict ? <StrictMode>{tree}</StrictMode> : tree);
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test('a missing thumbnail is rebuilt from the exact stored original and saved', async () => {
  const ctx = await setup();
  const makeThumbnail = vi.fn(async () => thumb());
  const media = createPrivateMedia({
    store: ctx.store,
    urls: ctx.ledger,
    makeThumbnail,
  });
  const lease = await media.lease(ctx.record, VARIANT_KIND.THUMBNAIL);
  expect(lease).toMatchObject({ url: 'blob:private-0' });
  expect(makeThumbnail).toHaveBeenCalledWith(
    expect.objectContaining({ size: 8 }),
  );
  expect(ctx.read.mock.calls.map(([, , kind]) => kind)).toEqual([
    VARIANT_KIND.THUMBNAIL,
    VARIANT_KIND.FULL,
  ]);
  expect(ctx.save).toHaveBeenCalledWith(
    'private-store/private-image.png',
    { addedAt: 7 },
    expect.any(Blob),
  );
  expect(
    await ctx.store.readPrivateMedia(
      'private-store/private-image.png',
      { addedAt: 7 },
      VARIANT_KIND.THUMBNAIL,
    ),
  ).toBeInstanceOf(Blob);
  lease.release();
  expect(ctx.api.revokeObjectURL).toHaveBeenCalledTimes(1);
});

test('a valid thumbnail costs no original read', async () => {
  const ctx = await setup({ thumbnail: thumb() });
  const makeThumbnail = vi.fn();
  const media = createPrivateMedia({
    store: ctx.store,
    urls: ctx.ledger,
    makeThumbnail,
  });
  const lease = await media.lease(ctx.record, VARIANT_KIND.THUMBNAIL);
  expect(ctx.read.mock.calls.map(([, , kind]) => kind)).toEqual([
    VARIANT_KIND.THUMBNAIL,
  ]);
  expect(makeThumbnail).not.toHaveBeenCalled();
  lease.release();
});

test('the combined media adapter keeps shared cache-miss network fallbacks', async () => {
  const record = libraryRecord({
    id: 'shared-cache-miss',
    storage_id: 'shared-store',
    filename: 'shared-cache-miss.png',
  });
  const combined = {
    accepts: () => true,
    peek: () => null,
    lease: vi.fn(async () => null),
    capture: vi.fn(),
    drop: vi.fn(),
    recoverThumbnail: vi.fn(),
  };
  const thumbnail = renderPrivate(combined, record);
  await waitFor(() =>
    expect(thumbnail.container.querySelector('img')?.getAttribute('src')).toBe(
      describeImage(record).thumbnailUrl,
    ),
  );
  fireEvent.error(thumbnail.container.querySelector('img'));
  await waitFor(() =>
    expect(thumbnail.container.querySelector('img')?.getAttribute('src')).toBe(
      describeImage(record).originalUrl,
    ),
  );
  expect(combined.recoverThumbnail).not.toHaveBeenCalled();

  const original = renderPrivate(combined, record, { variant: 'original' });
  await waitFor(() =>
    expect(original.container.querySelector('img')?.getAttribute('src')).toBe(
      describeImage(record).originalUrl,
    ),
  );
  expect(combined.lease).toHaveBeenCalledWith(
    record,
    VARIANT_KIND.THUMBNAIL,
    expect.anything(),
  );
  expect(combined.lease).toHaveBeenCalledWith(
    record,
    VARIANT_KIND.FULL,
    expect.anything(),
  );
});

test('legacy generated private-history rows keep their existing image sources', async () => {
  const media = {
    accepts: () => false,
    peek: () => null,
    lease: vi.fn(async () => null),
    capture: vi.fn(),
    drop: vi.fn(),
  };
  const stored = libraryRecord({
    id: 'legacy-generated',
    local_origin: 'generated',
    image_url: 'blob:stored-generated',
  });
  const storedView = renderPrivate(media, stored);
  await waitFor(() =>
    expect(storedView.container.querySelector('img')?.getAttribute('src')).toBe(
      'blob:stored-generated',
    ),
  );
  storedView.unmount();

  const fresh = libraryRecord({
    id: 'fresh-generated',
    local_origin: 'generated',
    image_url: 'https://generation.invalid/current-result.png',
  });
  const freshView = renderPrivate(media, fresh);
  await waitFor(() =>
    expect(freshView.container.querySelector('img')?.getAttribute('src')).toBe(
      'https://generation.invalid/current-result.png',
    ),
  );
});

test('imported wire URLs stay blocked while indexed private rows stay lease-only', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const imported = libraryRecord({
    id: 'imported-image',
    storage_type: 'browser-upload',
    image_url: 'https://wire.invalid/imported.png',
  });
  const importedView = renderPrivate(null, imported);
  await waitFor(() =>
    expect(importedView.container.querySelector('.img-missing')).not.toBeNull(),
  );
  expect(importedView.container.innerHTML).not.toContain('wire.invalid');
  importedView.unmount();

  const ctx = await setup();
  const media = createPrivateMedia({
    store: ctx.store,
    urls: ctx.ledger,
    makeThumbnail: async () => null,
  });
  const indexedView = renderPrivate(media, {
    ...ctx.record,
    image_url: ctx.wire.image_url,
  });
  await waitFor(() =>
    expect(indexedView.container.querySelector('.img-missing')).not.toBeNull(),
  );
  expect(indexedView.container.innerHTML).not.toContain('wire.invalid');
  expect(fetch).not.toHaveBeenCalled();
});

test('missing or corrupt originals remain unavailable without allocating a URL', async () => {
  const missing = await setup({ original: null });
  const missingRenderer = vi.fn(async () => thumb());
  const first = createPrivateMedia({
    store: missing.store,
    urls: missing.ledger,
    makeThumbnail: missingRenderer,
  });
  expect(await first.lease(missing.record, VARIANT_KIND.THUMBNAIL)).toBeNull();
  expect(missingRenderer).not.toHaveBeenCalled();
  expect(missing.api.createObjectURL).not.toHaveBeenCalled();
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const onUnavailable = vi.fn();
  renderPrivate(
    first,
    { ...missing.record, image_url: missing.wire.image_url },
    { onUnavailable },
  );
  await waitFor(() => expect(onUnavailable).toHaveBeenCalledTimes(1));
  expect(
    screen.getByRole('img', { name: 'Private image' }).textContent,
  ).toMatch(/unavailable/i);
  expect(fetch).not.toHaveBeenCalled();

  const corrupt = await setup({ original: blob('not-an-image') });
  const corruptRenderer = vi.fn(async () => null);
  const second = createPrivateMedia({
    store: corrupt.store,
    urls: corrupt.ledger,
    makeThumbnail: corruptRenderer,
  });
  expect(await second.lease(corrupt.record, VARIANT_KIND.THUMBNAIL)).toBeNull();
  expect(corruptRenderer).toHaveBeenCalledTimes(1);
  expect(corrupt.api.createObjectURL).not.toHaveBeenCalled();
});

test('a refused thumbnail write gets a transient lease only while its original still exists', async () => {
  const ctx = await setup();
  ctx.store.savePrivateThumbnail = vi.fn(async () => ({
    persisted: false,
    reason: 'full',
  }));
  const media = createPrivateMedia({
    store: ctx.store,
    urls: ctx.ledger,
    makeThumbnail: async () => thumb(),
  });
  const lease = await media.lease(ctx.record, VARIANT_KIND.THUMBNAIL);
  expect(lease?.url).toBe('blob:private-0');
  expect(ctx.store.savePrivateThumbnail).toHaveBeenCalledTimes(1);
  expect(ctx.read.mock.calls.map(([, , kind]) => kind)).toEqual([
    VARIANT_KIND.THUMBNAIL,
    VARIANT_KIND.FULL,
    VARIANT_KIND.FULL,
  ]);
  expect(
    await ctx.store.readPrivateMedia(
      'private-store/private-image.png',
      { addedAt: 7 },
      VARIANT_KIND.THUMBNAIL,
    ),
  ).toBeNull();
  lease.release();
});

test('removal during thumbnail decode cannot allocate a URL or resurrect the record', async () => {
  const ctx = await setup();
  const decoding = deferred();
  const media = createPrivateMedia({
    store: ctx.store,
    urls: ctx.ledger,
    makeThumbnail: vi.fn(() => decoding.promise),
  });
  const pending = media.lease(ctx.record, VARIANT_KIND.THUMBNAIL);
  await waitFor(() => expect(ctx.read).toHaveBeenCalledTimes(2));
  expect(ctx.read.mock.calls.at(-1)[2]).toBe(VARIANT_KIND.FULL);
  await ctx.store.removePrivate('private-store/private-image.png', 7);
  decoding.resolve(thumb());
  expect(await pending).toBeNull();
  expect(ctx.api.createObjectURL).not.toHaveBeenCalled();
  expect(
    ctx.db.data.get(STORE.PRIVATE).has('private-store/private-image.png'),
  ).toBe(false);
});

test('replacement during thumbnail decode remains separate from the old derived result', async () => {
  const ctx = await setup();
  const decoding = deferred();
  const media = createPrivateMedia({
    store: ctx.store,
    urls: ctx.ledger,
    makeThumbnail: () => decoding.promise,
  });
  const pending = media.lease(ctx.record, VARIANT_KIND.THUMBNAIL);
  await waitFor(() => expect(ctx.read).toHaveBeenCalledTimes(2));
  const rows = ctx.db.data.get(STORE.PRIVATE);
  rows.set('private-store/private-image.png', {
    ...rows.get('private-store/private-image.png'),
    addedAt: 8,
    record: { ...ctx.wire, title: 'Replacement' },
  });
  decoding.resolve(thumb());
  expect(await pending).toBeNull();
  expect(ctx.api.createObjectURL).not.toHaveBeenCalled();
  expect(
    await ctx.store.readPrivateDetail('private-store/private-image.png'),
  ).toMatchObject({ addedAt: 8, record: { title: 'Replacement' } });
  expect(
    await ctx.store.readPrivateMedia(
      'private-store/private-image.png',
      { addedAt: 8 },
      VARIANT_KIND.THUMBNAIL,
    ),
  ).toBeNull();
});

test('a corrupt cached thumbnail gets one local retry and never tries its wire URL', async () => {
  const ctx = await setup({ thumbnail: blob('corrupt-thumbnail') });
  const makeThumbnail = vi.fn(async () => thumb());
  const media = createPrivateMedia({
    store: ctx.store,
    urls: ctx.ledger,
    makeThumbnail,
  });
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const onUnavailable = vi.fn();
  const view = renderPrivate(
    media,
    { ...ctx.record, image_url: ctx.wire.image_url },
    { onUnavailable },
  );
  await waitFor(() =>
    expect(view.container.querySelector('img')?.src).toBe('blob:private-0'),
  );
  fireEvent.error(view.container.querySelector('img'));
  await waitFor(() =>
    expect(view.container.querySelector('img')?.src).toBe('blob:private-1'),
  );
  expect(makeThumbnail).toHaveBeenCalledTimes(1);
  expect(view.container.innerHTML).not.toContain('wire.invalid');
  expect(fetch).not.toHaveBeenCalled();
  expect(onUnavailable).not.toHaveBeenCalled();

  fireEvent.error(view.container.querySelector('img'));
  await waitFor(() => expect(onUnavailable).toHaveBeenCalledTimes(1));
  expect(makeThumbnail).toHaveBeenCalledTimes(1);
  view.unmount();
  expect(ctx.api.revokeObjectURL).toHaveBeenCalledTimes(2);
});

test('StrictMode cancellation during decode neither writes nor allocates a URL', async () => {
  const ctx = await setup();
  const decoding = deferred();
  const makeThumbnail = vi.fn(() => decoding.promise);
  const media = createPrivateMedia({
    store: ctx.store,
    urls: ctx.ledger,
    makeThumbnail,
  });
  const view = renderPrivate(media, ctx.record, {}, true);
  await waitFor(() => expect(makeThumbnail).toHaveBeenCalledTimes(1));
  view.unmount();
  await act(async () => decoding.resolve(thumb()));
  await act(async () => Promise.resolve());
  expect(ctx.save).not.toHaveBeenCalled();
  expect(ctx.api.createObjectURL).not.toHaveBeenCalled();
});

test('thumbnail rebuild work stays within the four-job decode bound', async () => {
  const gates = [];
  let active = 0;
  let mostActive = 0;
  const store = {
    async readPrivateMedia(key, _identity, kind) {
      return kind === VARIANT_KIND.FULL ? blob(key) : null;
    },
    async savePrivateThumbnail() {
      return { persisted: true };
    },
  };
  const { api, ledger } = urls();
  const media = createPrivateMedia({
    store,
    urls: ledger,
    makeThumbnail: () => {
      active++;
      mostActive = Math.max(mostActive, active);
      const gate = deferred();
      gates.push(gate);
      return gate.promise.finally(() => active--);
    },
  });
  const records = Array.from({ length: 7 }, (_, index) => ({
    id: `concurrent-${index}`,
    local_added_at: index + 1,
  }));
  const leasesPromise = Promise.all(
    records.map((record) => media.lease(record, VARIANT_KIND.THUMBNAIL)),
  );
  await waitFor(() => expect(gates).toHaveLength(4));
  for (let index = 0; index < 4; index++) gates[index].resolve(thumb());
  await waitFor(() => expect(gates).toHaveLength(7));
  for (let index = 4; index < 7; index++) gates[index].resolve(thumb());
  const leases = await leasesPromise;
  expect(mostActive).toBe(4);
  expect(leases.every(Boolean)).toBe(true);
  leases.forEach((lease) => lease.release());
  expect(api.revokeObjectURL).toHaveBeenCalledTimes(7);
});
