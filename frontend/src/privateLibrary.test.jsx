import { createHash } from 'node:crypto';
import { createLocalPrepareService } from './localPrepare.js';
import { readOriginalBytes } from './originalBytes.js';
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import vectors from '../../fixtures/browser/private-read-pages.json';
import transientWatermark from '../../fixtures/api/transient-watermark.json';
import { STORE } from './cacheDb.js';
import { createCacheStore } from './cacheStore.js';
import { DEFAULT_CLIENT_POLICY } from './clientPolicy.js';
import {
  deferred,
  memoryChannels,
  memoryDb,
  quotaError,
} from './cacheTestSupport.js';
import { createUrlLedger } from './objectUrls.js';
import { createPrivateLibrary, privateLibraryView } from './privateLibrary.js';
import { createPrivateMedia } from './privateMedia.js';
import { searchPrivatePage } from './privateSearch.js';
import { usePrivateLibrary } from './usePrivateLibrary.js';
import { usePrivateHistory } from './privateHistory.js';
import { MediaContext } from './variantSrc.js';
import { SavedImg } from './ui.jsx';
import App from './App.jsx';
import { fakeLibrary, fixtures, installApi } from './testSupport.js';

const harness = vi.hoisted(() => ({ cache: { store: null, ready: true } }));
vi.mock('./useCacheStore.js', () => ({ useCacheStore: () => harness.cache }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const limits = {
  ...DEFAULT_CLIENT_POLICY.cache,
  privateRecordLimit: 1,
  privateMaxBytes: 1,
};
function setup(count = 10001, channel) {
  const db = memoryDb();
  const rows = new Map(),
    media = new Map();
  const blobs = [];
  for (let i = 0; i < count; i++) {
    const key = `item-${String(i).padStart(5, '0')}`;
    rows.set(key, {
      record: {
        id: key,
        title: key,
        prompt: i % 2 ? 'amber' : 'blue',
        image_url: 'https://invalid.example/never-fetch',
        unknown: [false, 0, null],
      },
      addedAt: Math.floor(i / 2),
      origin: 'imported',
    });
    const blob = new Blob([key], { type: 'image/png' });
    blobs.push(blob);
    media.set(`${key}|full`, { blob, bytes: blob.size });
    media.set(`${key}|thumbnail`, { blob, bytes: blob.size });
  }
  db.data.set(STORE.PRIVATE, rows);
  db.data.set(STORE.PRIVATE_MEDIA, media);
  const reads = [];
  const run = db.run.bind(db);
  db.run = (names, mode, work) =>
    run(names, mode, (access) =>
      work({
        ...access,
        get: async (name, key) => {
          reads.push([name, key]);
          return access.get(name, key);
        },
      }),
    );
  const store = createCacheStore(
    db,
    limits,
    channel ? { openChannel: channel } : {},
  );
  return { db, store, reads, blobs };
}
function urls() {
  const api = {
    createObjectURL: vi.fn(
      () => `blob:lease-${api.createObjectURL.mock.calls.length}`,
    ),
    revokeObjectURL: vi.fn(),
  };
  return { api, ledger: createUrlLedger(api) };
}

test('10k over-limit metadata traversal/search/exact off-window bytes preserve every original', async () => {
  const { store, db, reads } = setup();
  const before = new Map(db.data.get(STORE.PRIVATE_MEDIA));
  const hashes = async () =>
    Promise.all(
      [...db.data.get(STORE.PRIVATE_MEDIA)]
        .filter(([key]) => key.endsWith('|full'))
        .map(async ([key, value]) => [
          key,
          createHash('sha256')
            .update(await value.blob.text())
            .digest('hex'),
        ]),
    );
  const originalHashes = await hashes();
  const repo = createPrivateLibrary(store);
  let window = await repo.load({ binding: { q: '', limit: 24 } });
  expect(window.pages[0].total).toBe(10001);
  expect(window.pages[0].images).toHaveLength(24);
  expect(reads.filter(([name]) => name === STORE.PRIVATE_MEDIA)).toEqual([]);
  window = await repo.load({ direction: 'forward' });
  expect(window.pages[0].images[0].id).toBe('item-09976');
  window = await repo.load({ direction: 'last' });
  expect(window.pages[0].images.at(-1).id).toBe('item-00000');
  expect(reads.filter(([name]) => name === STORE.PRIVATE_MEDIA)).toEqual([]);
  const exact = await store.readPrivateDetail('item-05001');
  expect(exact.record.unknown).toEqual([false, 0, null]);
  const handle = repo.host.handleFor(privateLibraryView(exact));
  const release = repo.host.retain(handle);
  await repo.host.load(handle);
  await repo.load({ direction: 'first' });
  expect(repo.host.isListed(handle)).toBe(true);
  const original = await repo.host.readOriginal(handle);
  expect(await original.text()).toBe('item-05001');
  expect(
    (await searchPrivatePage(store, { q: 'amber', limit: 24, offset: 2400 }))
      .total,
  ).toBe(5000);
  const last = await searchPrivatePage(store, {
    q: 'amber',
    limit: 24,
    last: true,
  });
  expect(last.rows.at(-1).key).toBe('item-00001');
  expect(last.rows.length).toBeLessThanOrEqual(24);
  expect([...db.data.get(STORE.PRIVATE_MEDIA)]).toEqual([...before]);
  expect(await hashes()).toEqual(originalHashes);
  release();
  expect(repo.catalog.pinSnapshot()).toEqual([]);
});

test('oldest indexed edge matches shared tie-order fixture', async () => {
  const { db, store } = setup(0);
  for (const row of vectors.records)
    db.data.get(STORE.PRIVATE).set(row.record.id, row);
  expect(
    (await store.readPrivatePage({ edge: 'oldest', limit: 3 })).rows.map(
      (row) => row.key,
    ),
  ).toEqual(vectors.expected.oldest_edge_page_keys);
  await expect(store.readPrivatePage({ edge: 'invalid' })).rejects.toThrow();
});

test('concurrent display leases share one read/URL and release only after last consumer', async () => {
  const { store } = setup(1);
  const { api, ledger } = urls();
  const media = createPrivateMedia({ store, urls: ledger });
  const record = privateLibraryView(
    await store.readPrivateDetail('item-00000'),
  );
  const read = vi.spyOn(store, 'readPrivateMedia');
  const [a, b] = await Promise.all([
    media.lease(record, 'thumbnail'),
    media.lease(record, 'thumbnail'),
  ]);
  expect(read).toHaveBeenCalledTimes(1);
  expect(a.url).toBe(b.url);
  a.release();
  a.release();
  expect(api.revokeObjectURL).not.toHaveBeenCalled();
  b.release();
  expect(api.revokeObjectURL).toHaveBeenCalledTimes(1);
  expect(media.peek(record, 'thumbnail')).toBeNull();
});

test('visible cards lease thumbnails only; movement releases old URL and never displays imported wire URL', async () => {
  const { store, reads } = setup(2);
  const { api, ledger } = urls();
  const media = createPrivateMedia({ store, urls: ledger });
  const records = (await store.readPrivatePage({ limit: 2 })).rows.map(
    privateLibraryView,
  );
  const tree = (image) => (
    <MediaContext.Provider value={media}>
      <SavedImg image={image} />
    </MediaContext.Provider>
  );
  const view = render(tree(records[0]));
  await waitFor(() =>
    expect(view.container.querySelector('img')?.src).toContain('blob:lease'),
  );
  view.rerender(tree(records[1]));
  await waitFor(() => expect(api.revokeObjectURL).toHaveBeenCalledTimes(1));
  expect(
    reads
      .filter(([name]) => name === STORE.PRIVATE_MEDIA)
      .map(([, key]) => key),
  ).toEqual(['item-00001|thumbnail', 'item-00000|thumbnail']);
  expect(view.container.innerHTML).not.toContain('never-fetch');
  view.unmount();
  expect(api.revokeObjectURL).toHaveBeenCalledTimes(2);
});

test('search cancellation, mid-scan seq change, and count races reject partial results', async () => {
  const { store } = setup(210);
  const controller = new AbortController();
  const scan = store.scanPrivateSlice.bind(store);
  let calls = 0;
  store.scanPrivateSlice = async (args) => {
    const result = await scan(args);
    if (++calls === 1) controller.abort();
    return result;
  };
  await expect(
    searchPrivatePage(store, {
      q: 'amber',
      limit: 24,
      signal: controller.signal,
    }),
  ).rejects.toMatchObject({ name: 'AbortError' });
  calls = 0;
  store.scanPrivateSlice = async (args) => ({
    ...(await scan(args)),
    seq: ++calls,
  });
  await expect(
    searchPrivatePage(store, { q: 'amber', limit: 24 }),
  ).rejects.toThrow('changed during search');
  const repo = createPrivateLibrary(store);
  store.privateCount = async () => ({ count: 210, seq: 999 });
  await expect(repo.load()).rejects.toThrow('History changed');
});

test('off-window action pins survive movement; replacement/deletion requires direct identity; quota preserves original', async () => {
  const { store, db } = setup(150);
  const repo = createPrivateLibrary(store);
  const record = privateLibraryView(
    await store.readPrivateDetail('item-00004'),
  );
  const handle = repo.host.handleFor(record);
  const release = repo.host.retain(handle);
  await repo.host.load(handle);
  await repo.load();
  await repo.load({ direction: 'last' });
  expect(repo.host.current(handle).wire.id).toBe(record.id);
  db.failNext(quotaError());
  expect(await repo.remove(record)).toBe('full');
  expect(await repo.host.readOriginal(handle)).not.toBeNull();
  db.data.get(STORE.PRIVATE).set(handle.key, {
    ...db.data.get(STORE.PRIVATE).get(handle.key),
    addedAt: 9000,
  });
  await repo.refreshPins();
  expect(repo.host.isListed(handle)).toBe(false);
  expect(await repo.host.readOriginal(handle)).toBeNull();
  expect(await repo.remove(record)).toMatch(/replaced/);
  expect(db.data.get(STORE.PRIVATE_MEDIA).has(`${handle.key}|full`)).toBe(true);
  release();
});

test('bounded history keeps denied-storage unsaved pool independently and performs zero full-list reads', async () => {
  const store = createCacheStore(null, DEFAULT_CLIENT_POLICY.cache);
  const full = vi.spyOn(store, 'loadPrivate');
  const { ledger } = urls();
  const hook = renderHook(() =>
    usePrivateHistory({
      store,
      urls: ledger,
      limits: DEFAULT_CLIENT_POLICY.cache,
      enabled: true,
      boundedLibrary: true,
    }),
  );
  await waitFor(() => expect(hook.result.current.status).toBe('ready'));
  expect(hook.result.current.notice).toMatch(/not keeping history/);
  act(() =>
    hook.result.current.add(
      { id: 'held' },
      { origin: 'imported', blob: new Blob(['held']), url: 'blob:held' },
    ),
  );
  await waitFor(() => expect(hook.result.current.unsavedCount).toBe(1));
  expect(hook.result.current.items).toHaveLength(1);
  expect(full).not.toHaveBeenCalled();
});

test('visibility/cross-tab refresh stays metadata-only, and route disable fences late reads', async () => {
  const channels = memoryChannels();
  const { store, db, reads } = setup(220, channels);
  const second = createCacheStore(db, limits, {
    openChannel: channels,
  });
  const hook = renderHook(
    ({ enabled }) => usePrivateLibrary({ store, enabled }),
    { initialProps: { enabled: true } },
  );
  await act(() => hook.result.current.load());
  const old = hook.result.current.window.pages[0].total;
  await act(() => second.removePrivate('item-00000', 0));
  // Mutation accounting reads its removed media; the consumer refresh does not.
  reads.length = 0;
  await waitFor(() =>
    expect(hook.result.current.window.pages[0].total).toBe(old - 1),
  );
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: 'visible',
  });
  await act(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(reads.filter(([name]) => name === STORE.PRIVATE_MEDIA)).toEqual([]);
  const pending = deferred();
  store.readPrivatePage = () => pending.promise;
  act(() => {
    hook.result.current.load();
  });
  hook.rerender({ enabled: false });
  await act(() => pending.resolve({ rows: [], seq: 0 }));
  await waitFor(() => expect(hook.result.current.window.pages).toEqual([]));
});

test('a legacy cross-tab hydration cannot repopulate history after switching to bounded Library', async () => {
  const { store } = setup(2);
  const pending = deferred();
  const load = store.loadPrivate.bind(store);
  const rows = await load();
  let notify;
  store.onPrivateChange = (callback) => {
    notify = callback;
    return () => {};
  };
  store.loadPrivate = vi
    .fn()
    .mockResolvedValueOnce(rows)
    .mockImplementationOnce(() => pending.promise);
  const { ledger, api: urlApi } = urls();
  const hook = renderHook(
    ({ boundedLibrary }) =>
      usePrivateHistory({
        store,
        urls: ledger,
        limits: DEFAULT_CLIENT_POLICY.cache,
        enabled: true,
        boundedLibrary,
      }),
    { initialProps: { boundedLibrary: false } },
  );
  await waitFor(() => expect(hook.result.current.items).toHaveLength(2));
  act(() => {
    void notify();
  });
  expect(store.loadPrivate).toHaveBeenCalledTimes(2);
  hook.rerender({ boundedLibrary: true });
  await waitFor(() => expect(hook.result.current.items).toEqual([]));
  const acquisitions = urlApi.createObjectURL.mock.calls.length;
  await act(() => pending.resolve(rows));
  expect(hook.result.current.items).toEqual([]);
  expect(urlApi.createObjectURL).toHaveBeenCalledTimes(acquisitions);
});

test('private action updates its visible page record and preserves original metadata', async () => {
  const { store, db } = setup(1);
  const hook = renderHook(() => usePrivateLibrary({ store, enabled: true }));
  await act(() => hook.result.current.load());
  const repo = hook.result.current.repository;
  const record = hook.result.current.window.pages[0].images[0];
  const handle = repo.host.handleFor(record);
  const release = repo.host.retain(handle, 'selected');
  const wire = JSON.stringify(
    db.data.get(STORE.PRIVATE).get(handle.key).record,
  );
  try {
    await act(() =>
      repo.host.saveAnalysis(handle, {
        analysis: transientWatermark.response,
        settings: transientWatermark.response.watermark_settings,
        prepared: null,
      }),
    );
    expect(
      hook.result.current.window.pages[0].images[0].print_watermark,
    ).toEqual(transientWatermark.response.print_watermark);
    expect(hook.result.current.replacedRecord.print_watermark_key).toBe(
      transientWatermark.response.print_watermark_key,
    );
    expect(
      JSON.stringify(db.data.get(STORE.PRIVATE).get(handle.key).record),
    ).toBe(wire);
  } finally {
    release();
  }
});

test('confirmed deletion cannot remove a replacement that arrives after the identity read', async () => {
  const { store, db } = setup(1);
  const currentLimits = DEFAULT_CLIENT_POLICY.cache;
  store.setLimits(currentLimits);
  const other = createCacheStore(db, currentLimits);
  const repo = createPrivateLibrary(store);
  const selected = privateLibraryView(
    await store.readPrivateDetail('item-00000'),
  );
  const remove = store.removePrivate.bind(store);
  const replacement = new Blob(['replacement-original'], { type: 'image/png' });
  let seq;
  store.removePrivate = async (...args) => {
    expect(await other.removePrivate('item-00000', 0)).toEqual({
      removed: true,
    });
    expect(
      await other.admitPrivate({
        record: {
          id: 'item-00000',
          title: 'Replacement',
          preserved: [false, 0, null],
        },
        origin: 'imported',
        addedAt: 1,
        full: replacement,
      }),
    ).toMatchObject({ persisted: true });
    seq = (await other.privateCount()).seq;
    return remove(...args);
  };
  expect(await repo.remove(selected)).toMatch(/removed or replaced/);
  expect((await store.privateCount()).seq).toBe(seq);
  expect(await store.readPrivateDetail('item-00000')).toMatchObject({
    addedAt: 1,
    record: { title: 'Replacement', preserved: [false, 0, null] },
  });
  expect(
    await store.readPrivateMedia('item-00000', { addedAt: 1 }, 'full'),
  ).toBe(replacement);
  expect(db.data.get(STORE.PRIVATE_TOMBSTONES).get('item-00000').addedAt).toBe(
    0,
  );
});

test('fresh private Library startup reads bounded metadata/visible thumbnails, no full list or originals', async () => {
  const { store, reads } = setup(10001);
  harness.cache = { store, ready: true };
  const full = vi.spyOn(store, 'loadPrivate');
  const page = vi.spyOn(store, 'readPrivatePage');
  const { api } = urls();
  URL.createObjectURL = api.createObjectURL;
  URL.revokeObjectURL = api.revokeObjectURL;
  const server = fakeLibrary([]);
  const network = installApi({
    'GET /api/app-capabilities': () => fixtures.m1.capabilities_private,
    ...server.routes,
  });
  window.history.replaceState(null, '', '/print');
  render(<App />);
  await screen.findByText('10001 images');
  await waitFor(() => expect(api.createObjectURL).toHaveBeenCalledTimes(24));
  expect(full).not.toHaveBeenCalled();
  expect(page.mock.calls.every(([args]) => args.limit <= 96)).toBe(true);
  expect(reads.filter(([name]) => name === STORE.PRIVATE_MEDIA)).toHaveLength(
    24,
  );
  expect(
    reads
      .filter(([name]) => name === STORE.PRIVATE_MEDIA)
      .every(([, key]) => key.endsWith('|thumbnail')),
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Last' }));
  await screen.findByRole('button', { name: /item-00000/ });
  expect(
    network.calls.filter((call) =>
      /images\/library|never-fetch/.test(call.key),
    ),
  ).toEqual([]);
});

test('Library readiness loads private history without selecting an image on Create', async () => {
  localStorage.clear();
  const { store } = setup(2);
  const page = await store.readPrivatePage({ limit: 40 });
  const pending = deferred();
  const fullList = vi.spyOn(store, 'loadPrivate');
  harness.cache = { store, ready: true };
  const { api: urlApi } = urls();
  URL.createObjectURL = urlApi.createObjectURL;
  URL.revokeObjectURL = urlApi.revokeObjectURL;
  const network = installApi({
    'GET /api/app-capabilities': () => fixtures.m1.capabilities_private,
    ...fakeLibrary([]).routes,
  });
  window.history.replaceState(null, '', '/print');
  render(<App />);
  await screen.findByRole('button', { name: /item-00000/ });
  expect(fullList).not.toHaveBeenCalled();
  vi.spyOn(store, 'readPrivatePage').mockImplementationOnce(
    () => pending.promise,
  );
  fireEvent.click(screen.getByRole('link', { name: 'Create', exact: true }));
  expect(
    (await screen.findByRole('textbox', { name: 'Image idea', exact: true }))
      .value,
  ).toBe('');
  await act(() => pending.resolve(page));
  await waitFor(() => expect(page.rows.length).toBeGreaterThan(0));
  expect(
    screen.getByRole('textbox', { name: 'Image idea', exact: true }).value,
  ).toBe('');
  expect(document.querySelector('.stage-img')).toBeNull();
  expect(
    network.calls.filter((call) =>
      /POST \/api\/(generate-image|controls\/dynamic)/.test(call.key),
    ),
  ).toEqual([]);
});

test('private Analyze updates the open dialog without reopening or a shared request', async () => {
  localStorage.clear();
  const { store, db } = setup(1);
  harness.cache = { store, ready: true };
  const before = JSON.stringify(
    db.data.get(STORE.PRIVATE).get('item-00000').record,
  );
  const { api: urlApi } = urls();
  URL.createObjectURL = urlApi.createObjectURL;
  URL.revokeObjectURL = urlApi.revokeObjectURL;
  const server = fakeLibrary([]);
  const network = installApi({
    'GET /api/app-capabilities': () => ({
      ...fixtures.m1.capabilities_private,
      watermark: { transient_analysis_enabled: true },
    }),
    ...server.routes,
    'POST /api/watermark/analyze-image': () => ({
      ...transientWatermark.response,
      watermark_settings: fixtures.browserSettings.defaults.watermark,
    }),
  });
  window.history.replaceState(null, '', '/print');
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: /item-00000/ }));
  // Visible Library originals recover automatically before the dialog opens.
  fireEvent.click(
    await screen.findByRole('button', { name: 'Regenerate', exact: true }),
  );
  expect(
    await screen.findByRole('button', { name: 'Regenerate' }),
  ).toBeTruthy();
  expect(screen.getByText('Corner bottom left')).toBeTruthy();
  expect(
    JSON.stringify(db.data.get(STORE.PRIVATE).get('item-00000').record),
  ).toBe(before);
  expect(
    network.calls.filter((call) =>
      /images\/library|never-fetch/.test(call.key),
    ),
  ).toEqual([]);
});

test('exact off-window download and prepared action survive multiple page movements, release pins, and keep original bytes', async () => {
  const { store, db } = setup(180);
  store.setLimits({
    ...DEFAULT_CLIENT_POLICY.cache,
    privateRecordLimit: 1000,
    privateMaxBytes: 1024 * 1024,
  });
  const replaced = vi.fn();
  const repo = createPrivateLibrary(store, { onRecord: replaced });
  const record = privateLibraryView(
    await store.readPrivateDetail('item-00080'),
  );
  const original = db.data.get(STORE.PRIVATE_MEDIA).get('item-00080|full').blob;
  const fetchBlob = vi.fn();
  expect(
    await readOriginalBytes(record, {
      readLocal: (image) => repo.host.readOriginal(repo.host.handleFor(image)),
      fetchBlob,
    }),
  ).toBe(original);
  expect(fetchBlob).not.toHaveBeenCalled();
  const gate = deferred();
  const rendering = deferred();
  const settings = {
    fingerprint: 'test-settings',
    rendering: {
      rendererVersion: 'r1',
      defaultPresentation: {
        gradient_start: '#fff',
        gradient_end: null,
        separation_color: '#000',
        glow_color: '#fff',
      },
    },
  };
  const api = {
    analyzeWatermarkImage: vi.fn(async (source) => {
      expect(source).toBe(original);
      return {
        storage: 'transient',
        print_watermark: { position: { corner: 'bottom-left' } },
        print_watermark_key: 'opaque-key',
        source_sha256: 'a'.repeat(64),
        dimensions: { width: 120, height: 80 },
        watermark_settings: settings,
      };
    }),
    embedWatermarkMetadata: vi.fn(async (blob) => blob),
  };
  const service = createLocalPrepareService({
    host: repo.host,
    api,
    readSettings: async () => settings,
    render: async () => {
      rendering.resolve();
      return gate.promise;
    },
  });
  const action = service.prepare(record);
  await rendering.promise;
  await repo.load();
  await repo.load({ direction: 'forward' });
  await repo.load({ direction: 'last' });
  const png = new Blob(['prepared'], { type: 'image/png' });
  gate.resolve({ blob: png, width: 120, height: 80 });
  const outcome = await action;
  expect(outcome.blob).toBe(png);
  expect(outcome.persistence.state).toBe('stored');
  expect(replaced.mock.calls.at(-1)[0]).toMatchObject({
    local_watermark: { prepared: 'stored' },
    print_watermark: { position: { corner: 'bottom-left' } },
  });
  expect(
    await store.readPrivateMedia('item-00080', { addedAt: 40 }, 'watermarked'),
  ).toBe(png);
  expect(db.data.get(STORE.PRIVATE_MEDIA).get('item-00080|full').blob).toBe(
    original,
  );
  expect(repo.catalog.pinSnapshot()).toEqual([]);
});

test('late page reads cannot overwrite newer intent; read failures stay explicit and retryable', async () => {
  const { store } = setup(250);
  const repo = createPrivateLibrary(store);
  const read = store.readPrivatePage.bind(store);
  const pending = deferred();
  let calls = 0;
  store.readPrivatePage = (args) =>
    ++calls === 1 ? pending.promise : read(args);
  const late = repo.load();
  const last = await repo.load({ direction: 'last' });
  pending.resolve(await read({ limit: 24 }));
  expect(await late).toBeNull();
  expect(last.pages[0].images.at(-1).id).toBe('item-00000');
  const hook = renderHook(() => usePrivateLibrary({ store, enabled: true }));
  store.readPrivatePage = async () => {
    throw new Error('storage read failed');
  };
  await act(() => hook.result.current.load());
  expect(hook.result.current.window.error.message).toBe('storage read failed');
  expect(hook.result.current.window.pages).toEqual([]);
  store.readPrivatePage = read;
  await act(() => hook.result.current.load());
  expect(hook.result.current.window.error).toBeNull();
  expect(hook.result.current.window.pages[0].total).toBe(250);
});

test('rapid traversal bounds media concurrency and skips cancelled queued thumbnails without creating URLs', async () => {
  const { api, ledger } = urls();
  const gates = [];
  let running = 0,
    peak = 0;
  const store = {
    readPrivateMedia: vi.fn(async () => {
      running++;
      peak = Math.max(peak, running);
      const gate = deferred();
      gates.push(gate);
      try {
        return await gate.promise;
      } finally {
        running--;
      }
    }),
  };
  const media = createPrivateMedia({ store, urls: ledger });
  const controllers = Array.from({ length: 250 }, () => new AbortController());
  const leases = controllers.map((controller, i) =>
    media.lease({ id: `queued-${i}`, local_added_at: i }, 'thumbnail', {
      signal: controller.signal,
    }),
  );
  for (const controller of controllers.slice(0, -1)) controller.abort();
  await waitFor(() => expect(gates).toHaveLength(4));
  for (const gate of gates) gate.resolve(new Blob(['thumbnail']));
  await waitFor(() => expect(gates).toHaveLength(5));
  gates[4].resolve(new Blob(['visible']));
  const results = await Promise.all(leases);
  expect(peak).toBe(4);
  expect(store.readPrivateMedia).toHaveBeenCalledTimes(5);
  expect(results.slice(0, -1).every((lease) => lease === null)).toBe(true);
  expect(api.createObjectURL).toHaveBeenCalledTimes(1);
  results.at(-1).release();
  expect(api.revokeObjectURL).toHaveBeenCalledTimes(1);
});
