import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { DEFAULT_CLIENT_POLICY } from './clientPolicy.js';
import { createCacheStore } from './cacheStore.js';
import { memoryChannels, memoryDb, imageBlob } from './cacheTestSupport.js';
import { createUrlLedger } from './objectUrls.js';
import { imageKey } from './imageRecord.js';
import { usePrivateHistory } from './privateHistory.js';
import { STORE } from './cacheDb.js';
import { usePrivateCreate } from './usePrivateCreate.js';
import App from './App.jsx';
import { completeStatus, fixtures, installApi } from './testSupport.js';

const appHarness = vi.hoisted(() => ({ cache: { store: null, ready: true } }));
vi.mock('./useCacheStore.js', () => ({
  useCacheStore: () => appHarness.cache,
}));

const limits = {
  ...DEFAULT_CLIENT_POLICY.cache,
  privateRecordLimit: 20,
  privateMaxBytes: 1024 * 1024,
};
const noThumbnail = async () => null;

function storedWire(id) {
  return {
    id,
    image_id: id,
    title: `Image ${id}`,
    original_prompt: `Original prompt ${id}`,
    prompt: `Original prompt ${id}`,
    final_prompt: `Final prompt ${id}`,
    selected_controls: { style: false, count: 0 },
    original_selected_controls: [{ category: 'Style', selected: false }],
    dynamic_controls_metadata: { preserved: [false, 0, null] },
    generation_mode: 'image',
    requested_dimensions: { width: 1024, height: 768 },
    visibility: 'private',
    image_url: '/api/private-never-fetch',
  };
}

function urlLedger() {
  let counter = 0;
  return createUrlLedger({
    createObjectURL: () => `blob:private-create-${++counter}`,
    revokeObjectURL: vi.fn(),
  });
}

function seed(db, rows) {
  db.data.set(
    STORE.PRIVATE,
    new Map(
      rows.map(({ key, addedAt, payload = '' }) => [
        key,
        {
          record: { ...storedWire(key), payload },
          origin: 'generated',
          addedAt,
        },
      ]),
    ),
  );
  db.data.set(STORE.PRIVATE_MEDIA, new Map());
  db.data.set(STORE.META, new Map());
}

test('10k metadata Create reads stay bounded and exact near/far picks avoid full or media hydration', async () => {
  const db = memoryDb();
  seed(
    db,
    Array.from({ length: 10_000 }, (_, index) => ({
      key: `private-${String(index).padStart(5, '0')}`,
      addedAt: Math.floor(index / 5),
    })),
  );
  const store = createCacheStore(db, limits);
  const fullList = vi.spyOn(store, 'loadPrivate');
  const mediaRead = vi.spyOn(store, 'readPrivateMedia');
  let privateMediaGets = 0;
  const run = db.run.bind(db);
  db.run = (names, mode, work) =>
    run(names, mode, (access) =>
      work({
        ...access,
        get: async (name, key) => {
          if (name === STORE.PRIVATE_MEDIA) privateMediaGets++;
          return access.get(name, key);
        },
      }),
    );

  const hook = renderHook(() => usePrivateCreate({ store, enabled: true }));
  let result;
  await act(async () => {
    result = await hook.result.current.load({ direction: 'first' });
  });
  expect(result.accepted).toBe(true);
  expect(hook.result.current.window.rows).toHaveLength(40);
  expect(hook.result.current.window.complete).toBe(false);
  expect((await store.privateCount()).count).toBe(10_000);
  expect(fullList).not.toHaveBeenCalled();
  expect(mediaRead).not.toHaveBeenCalled();
  expect(privateMediaGets).toBe(0);

  const near = await hook.result.current.exact(
    hook.result.current.window.rows[4],
  );
  const far = await hook.result.current.byKey('private-00000');
  expect(near).toMatchObject({
    original_prompt: 'Original prompt private-09995',
    selected_controls: { style: false, count: 0 },
    dynamic_controls_metadata: { preserved: [false, 0, null] },
    local_added_at: 1999,
  });
  expect(far).toMatchObject({
    id: 'private-00000',
    original_prompt: 'Original prompt private-00000',
    local_added_at: 0,
  });

  await act(async () => {
    await hook.result.current.load({
      direction: 'around',
      identity: { key: 'private-00000', addedAt: 0 },
      before: 2,
      after: 2,
    });
  });
  expect(hook.result.current.window.rows.map(imageKey)).toEqual([
    'private-00002',
    'private-00001',
    'private-00000',
  ]);
  expect(fullList).not.toHaveBeenCalled();
  expect(mediaRead).not.toHaveBeenCalled();
  hook.unmount();
});

test('Create traverses beyond its window, refreshes cross-tab arrivals, and route disable discards late reads', async () => {
  const channels = memoryChannels();
  const db = memoryDb();
  seed(
    db,
    Array.from({ length: 87 }, (_, index) => ({
      key: `row-${String(index).padStart(3, '0')}`,
      addedAt: index,
    })),
  );
  const wideLimits = { ...limits, privateRecordLimit: 200 };
  const store = createCacheStore(db, wideLimits, { openChannel: channels });
  const other = createCacheStore(db, wideLimits, { openChannel: channels });
  const fullList = vi.spyOn(store, 'loadPrivate');
  const hook = renderHook(
    ({ enabled }) => usePrivateCreate({ store, enabled }),
    { initialProps: { enabled: true } },
  );
  await act(async () => {
    await hook.result.current.load({ direction: 'first' });
  });
  const pages = [hook.result.current.window.rows.map(imageKey)];
  await act(async () => {
    await hook.result.current.load({ direction: 'older' });
  });
  pages.push(hook.result.current.window.rows.map(imageKey));
  expect(pages.flat()).toHaveLength(80);
  expect(new Set(pages.flat()).size).toBe(80);
  expect(fullList).not.toHaveBeenCalled();

  await other.admitPrivate({
    record: storedWire('cross-tab-arrival'),
    origin: 'generated',
    addedAt: 9999,
    full: imageBlob(),
    thumbnail: imageBlob(4, 'image/jpeg'),
  });
  await waitFor(() =>
    expect(imageKey(hook.result.current.window.rows[0])).toBe(
      'cross-tab-arrival',
    ),
  );
  expect(fullList).not.toHaveBeenCalled();

  hook.rerender({ enabled: false });
  await waitFor(() => expect(hook.result.current.window.rows).toEqual([]));
  hook.unmount();
});

test('Last opens the indexed oldest window with one bounded metadata page read', async () => {
  const db = memoryDb();
  seed(
    db,
    Array.from({ length: 87 }, (_, index) => ({
      key: `private-${String(index).padStart(5, '0')}`,
      addedAt: index,
    })),
  );
  const store = createCacheStore(db, limits);
  const pageRead = vi.spyOn(store, 'readPrivatePage');
  const hook = renderHook(() => usePrivateCreate({ store, enabled: true }));
  let result;
  await act(async () => {
    result = await hook.result.current.load({ direction: 'last' });
  });

  expect(result.accepted).toBe(true);
  expect(hook.result.current.window.rows).toHaveLength(40);
  expect(hook.result.current.window.rows.map(imageKey)).toEqual(
    Array.from(
      { length: 40 },
      (_, index) => `private-${String(39 - index).padStart(5, '0')}`,
    ),
  );
  expect(pageRead).toHaveBeenCalledTimes(1);
  expect(pageRead).toHaveBeenCalledWith({
    edge: 'oldest',
    direction: 'newer',
    limit: 40,
  });
  hook.unmount();
});

test('bounded Create keeps denied-storage and imported bytes in the independent unsaved pool', async () => {
  const store = createCacheStore(null, limits);
  const fullList = vi.spyOn(store, 'loadPrivate');
  const urls = urlLedger();
  const hook = renderHook(() =>
    usePrivateHistory({
      store,
      urls,
      limits,
      enabled: true,
      boundedCreate: true,
      thumbnail: noThumbnail,
    }),
  );
  await waitFor(() => expect(hook.result.current.status).toBe('ready'));
  const bytes = imageBlob(9);
  act(() =>
    hook.result.current.add(storedWire('imported-held'), {
      origin: 'imported',
      blob: bytes,
    }),
  );
  await waitFor(() => expect(hook.result.current.unsavedCount).toBe(1));
  expect(hook.result.current.items[0].local_storage.state).toBe('memory');
  expect(hook.result.current.items[0].image_url).toBe('');
  expect(fullList).not.toHaveBeenCalled();
  hook.unmount();
});

test('bounded Create transfers a stored import to its indexed window before releasing the preview URL', async () => {
  const db = memoryDb();
  const store = createCacheStore(db, limits);
  const revoked = vi.fn();
  const urls = createUrlLedger({
    createObjectURL: () => 'blob:private-create-transfer',
    revokeObjectURL: revoked,
  });
  const onStored = vi.fn(async ({ key, addedAt }) => ({
    accepted: true,
    state: { rows: [{ key, addedAt }] },
  }));
  const hook = renderHook(() =>
    usePrivateHistory({
      store,
      urls,
      limits,
      enabled: true,
      boundedCreate: true,
      onStored,
      thumbnail: noThumbnail,
    }),
  );
  await waitFor(() => expect(hook.result.current.status).toBe('ready'));
  const blob = imageBlob(9);
  const preview = urls.acquire(blob);
  act(() =>
    hook.result.current.add(storedWire('adopted-import'), {
      origin: 'imported',
      blob,
      url: preview,
    }),
  );
  urls.release(preview);

  await waitFor(() => expect(hook.result.current.items).toEqual([]));
  expect(onStored).toHaveBeenCalledWith({
    key: 'adopted-import',
    addedAt: expect.any(Number),
  });
  expect(
    (await store.readPrivateDetail('adopted-import'))?.record,
  ).toMatchObject({
    id: 'adopted-import',
    original_prompt: 'Original prompt adopted-import',
  });
  await waitFor(() => expect(urls.held(preview)).toBe(0));
  expect(revoked).toHaveBeenCalledWith(preview);
  hook.unmount();
});

test('the private Create route starts blank without full history hydration', async () => {
  window.history.replaceState(null, '', '/');
  localStorage.clear();
  const db = memoryDb();
  const store = createCacheStore(db, limits);
  appHarness.cache = { store, ready: true };
  const fullList = vi.spyOn(store, 'loadPrivate');
  const record = {
    ...completeStatus().result,
    id: 'private-startup',
    image_id: 'private-startup',
    filename: 'private-startup.png',
    title: 'Private startup image',
    original_prompt: 'Restore this exact private prompt',
    prompt: 'Final composed prompt',
    visibility: 'private',
    sha256: undefined,
  };
  await store.admitPrivate({
    record,
    origin: 'generated',
    addedAt: 5,
    full: imageBlob(),
    thumbnail: imageBlob(8, 'image/jpeg'),
  });
  const api = installApi({
    'GET /api/app-capabilities': () => fixtures.m1.capabilities_private,
  });

  render(
    <App jobPolicy={{ pollIntervalMs: 1, maxConsecutivePollFailures: 3 }} />,
  );
  const prompt = await screen.findByLabelText('Image idea');
  await waitFor(() => expect(prompt.value).toBe(''));
  await screen.findByRole('button', { name: 'Private startup image' });
  expect(document.querySelector('.stage-img')).toBeNull();
  expect(fullList).not.toHaveBeenCalled();
  expect(
    api.calls.some(
      ({ key }) =>
        key.includes('/api/images/library') ||
        key.includes('/api/images/events'),
    ),
  ).toBe(false);
  cleanup();
});
