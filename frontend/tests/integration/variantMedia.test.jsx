import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import React, { StrictMode } from 'react';
import { expect, test, vi } from 'vitest';

import { deferred, scriptedStore } from '../helpers/cacheTestSupport.js';
import { imageKey, describeImage } from '../../src/data/records/imageRecord.js';
import { createUrlLedger } from '../../src/data/media/objectUrls.js';
import { libraryRecord } from '../helpers/testSupport.js';
import { SavedImg } from '../../src/data/media/SavedImg.jsx';
import {
  CAPTURE_CONCURRENCY,
  CAPTURE_QUEUE_LIMIT,
  createVariantMedia,
} from '../../src/data/media/variantMedia.js';
import { MediaContext } from '../../src/data/media/variantSrc.js';

const png = (size = 8) =>
  new Blob([new Uint8Array(size)], { type: 'image/png' });

function setup(storeOverrides = {}, fetchBlob = vi.fn(async () => png())) {
  let next = 0;
  const urlApi = {
    createObjectURL: vi.fn(() => `blob:cached-${next++}`),
    revokeObjectURL: vi.fn(),
  };
  const urls = createUrlLedger(urlApi);
  const store = scriptedStore(storeOverrides);
  const media = createVariantMedia({ store, urls, fetchBlob });
  return { media, store, urls, urlApi, fetchBlob };
}

test('a miss resolves null; a hit leases one shared URL revoked by the last release', async () => {
  const record = libraryRecord({ id: 'a' });
  const { media, urlApi } = setup({
    getVariant: vi.fn(async () => ({ blob: png(), bytes: 8 })),
  });
  expect(media.peek(record, 'thumbnail')).toBeNull();
  const first = await media.lease(record, 'thumbnail');
  const second = await media.lease(record, 'thumbnail');
  expect(second.url).toBe(first.url);
  expect(urlApi.createObjectURL).toHaveBeenCalledTimes(1);
  expect(media.peek(record, 'thumbnail')).toBe(first.url);
  first.release();
  first.release(); // releasing twice is harmless
  expect(urlApi.revokeObjectURL).not.toHaveBeenCalled();
  second.release();
  expect(urlApi.revokeObjectURL).toHaveBeenCalledWith(first.url);
  expect(media.peek(record, 'thumbnail')).toBeNull();

  const none = setup();
  expect(await none.media.lease(record, 'thumbnail')).toBeNull();
});

test('dropping or evicting a cached variant never revokes a displayed URL', async () => {
  const record = libraryRecord({ id: 'a' });
  const { media, store, urlApi } = setup({
    getVariant: vi.fn(async () => ({ blob: png(), bytes: 8 })),
  });
  const lease = await media.lease(record, 'full');
  await media.drop(record, 'full');
  expect(store.dropVariant).toHaveBeenCalledWith(imageKey(record), 'full');
  expect(urlApi.revokeObjectURL).not.toHaveBeenCalled();
  expect(media.peek(record, 'full')).toBe(lease.url);
});

test('capture stores image bytes and pins what is displayed', async () => {
  const shown = libraryRecord({ id: 'shown' });
  const fresh = libraryRecord({ id: 'fresh' });
  const { media, store, fetchBlob } = setup({
    getVariant: vi.fn(async () => ({ blob: png(), bytes: 8 })),
  });
  await media.lease(shown, 'thumbnail');
  media.capture(fresh, 'thumbnail', '/network/fresh');
  await waitFor(() => expect(store.putVariant).toHaveBeenCalledTimes(1));
  expect(fetchBlob).toHaveBeenCalledWith('/network/fresh');
  const [, kind, , options] = store.putVariant.mock.calls[0];
  expect(kind).toBe('thumbnail');
  expect([...options.pinned]).toEqual([`${imageKey(shown)}|thumbnail`]);
});

test('capture skips non-image bodies and does not repeat final refusals', async () => {
  const record = libraryRecord({ id: 'a' });
  const html = vi.fn(async () => new Blob(['<html>'], { type: 'text/html' }));
  const bad = setup({}, html);
  bad.media.capture(record, 'thumbnail', '/x');
  await waitFor(() => expect(html).toHaveBeenCalled());
  expect(bad.store.putVariant).not.toHaveBeenCalled();

  const big = setup({
    putVariant: vi.fn(async () => ({ persisted: false, reason: 'oversize' })),
  });
  big.media.capture(record, 'full', '/y');
  await waitFor(() => expect(big.store.putVariant).toHaveBeenCalledTimes(1));
  await act(async () => {});
  big.media.capture(record, 'full', '/y');
  await act(async () => {});
  expect(big.fetchBlob).toHaveBeenCalledTimes(1);
});

test('capture runs a bounded number at once and keeps a bounded queue', async () => {
  const gates = [];
  const fetchBlob = vi.fn(() => {
    const gate = deferred();
    gates.push(gate);
    return gate.promise;
  });
  const { media } = setup({}, fetchBlob);
  const total = CAPTURE_CONCURRENCY + CAPTURE_QUEUE_LIMIT + 10;
  for (let n = 0; n < total; n += 1)
    media.capture(libraryRecord({ id: `i${n}` }), 'thumbnail', `/n/${n}`);
  expect(fetchBlob).toHaveBeenCalledTimes(CAPTURE_CONCURRENCY);
  // Drain: only the newest CAPTURE_QUEUE_LIMIT waiting captures survive.
  for (let n = 0; n < total; n += 1) {
    await act(async () => {
      gates[n]?.resolve(png());
    });
  }
  expect(fetchBlob).toHaveBeenCalledTimes(
    CAPTURE_CONCURRENCY + CAPTURE_QUEUE_LIMIT,
  );
});

const renderImage = (media, props = {}, strict = false) => {
  const image = libraryRecord({ id: 'pic' });
  const tree = (
    <MediaContext.Provider value={media}>
      <SavedImg image={image} {...props} />
    </MediaContext.Provider>
  );
  return {
    image,
    ...render(strict ? <StrictMode>{tree}</StrictMode> : tree),
  };
};

test('without a cache the network URL is used immediately', () => {
  const image = libraryRecord({ id: 'pic' });
  render(<SavedImg image={image} />);
  expect(screen.getByRole('img').getAttribute('src')).toBe(
    describeImage(image).thumbnailUrl,
  );
});

test('a cache hit shows the leased blob URL and releases it on unmount', async () => {
  const { media, urlApi } = setup({
    getVariant: vi.fn(async () => ({ blob: png(), bytes: 8 })),
  });
  const { unmount } = renderImage(media, {}, true);
  await waitFor(() =>
    expect(screen.getByRole('img').getAttribute('src')).toBe('blob:cached-0'),
  );
  expect(urlApi.createObjectURL).toHaveBeenCalledTimes(1);
  unmount();
  expect(urlApi.revokeObjectURL).toHaveBeenCalledTimes(1);
});

test('a miss waits for the lookup, shows the network copy, then captures it', async () => {
  const lookup = deferred();
  const { media, store, fetchBlob } = setup({
    getVariant: vi.fn(() => lookup.promise),
  });
  const { image } = renderImage(media, {}, true);
  const img = screen.getByRole('img', { hidden: true });
  expect(img.getAttribute('src')).toBeNull();
  await act(async () => lookup.resolve(null));
  const networkUrl = describeImage(image).thumbnailUrl;
  await waitFor(() =>
    expect(screen.getByRole('img').getAttribute('src')).toBe(networkUrl),
  );
  expect(fetchBlob).not.toHaveBeenCalled();
  fireEvent.load(screen.getByRole('img'));
  await waitFor(() => expect(store.putVariant).toHaveBeenCalledTimes(1));
  expect(fetchBlob).toHaveBeenCalledWith(networkUrl);
});

test('a cached copy that cannot be displayed is dropped and the network is used', async () => {
  const { media, store } = setup({
    getVariant: vi.fn(async () => ({ blob: png(), bytes: 8 })),
  });
  const { image } = renderImage(media);
  await waitFor(() =>
    expect(screen.getByRole('img').getAttribute('src')).toBe('blob:cached-0'),
  );
  fireEvent.error(screen.getByRole('img'));
  await waitFor(() =>
    expect(screen.getByRole('img').getAttribute('src')).toBe(
      describeImage(image).thumbnailUrl,
    ),
  );
  expect(store.dropVariant).toHaveBeenCalledWith(imageKey(image), 'thumbnail');
});

test('an original-size image looks up the full variant', async () => {
  const { media, store } = setup();
  renderImage(media, { variant: 'original' });
  await waitFor(() => expect(store.getVariant).toHaveBeenCalled());
  expect(store.getVariant.mock.calls[0][1]).toBe('full');
});

test('a browser upload is never looked up in the shared cache', () => {
  const { media, store } = setup();
  const upload = libraryRecord({
    id: 'u',
    storage_type: 'browser-upload',
    image_url: 'blob:local',
  });
  render(
    <MediaContext.Provider value={media}>
      <SavedImg image={upload} />
    </MediaContext.Provider>,
  );
  expect(screen.getByRole('img').getAttribute('src')).toBe('blob:local');
  expect(store.getVariant).not.toHaveBeenCalled();
});
