import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import Library from './Library.jsx';
import { SOURCE } from '../../data/storage/cachePolicy.js';
import { STORE } from '../../data/storage/cacheDb.js';
import {
  memoryDb,
  quotaError,
} from '../../../tests/helpers/cacheTestSupport.js';
import { createImageAnnotationStore } from '../../data/storage/imageAnnotationStore.js';
import { annotationIdentity } from '../../data/records/imageAnnotations.js';
import { MediaContext } from '../../data/media/variantSrc.js';

const record = (name, id) => ({
  id,
  image_id: id,
  storage_id: 'saved',
  filename: `${id}.png`,
  title: name,
  prompt: name,
  original_prompt: name,
  created_at: '2026-10-31T12:00:00Z',
  dimensions: { width: 640, height: 480 },
  selected_controls: [],
  image_url: '',
});

const setupAnnotations = async (images = []) => {
  const db = memoryDb();
  let sequence = 0;
  const store = createImageAnnotationStore(db, {
    makeId: () => `collection-${++sequence}`,
    openChannel: () => null,
  });
  return { db, store, images };
};

function makeStudio({ store, visible, source = SOURCE.SHARED, loader }) {
  const list = visible ?? [];
  return {
    source,
    images: { items: list, status: 'ready', error: null },
    libraryImages: { items: list, status: 'ready', paged: false },
    libraryScopeKey: 'test-scope',
    reloadImages: vi.fn(),
    loadLibraryWindow: vi.fn(),
    loadLibraryRecord:
      loader ??
      vi.fn(async (summary) => {
        const id = summary.id ?? summary.image_id;
        const result = record(
          id === 'offscreen' ? 'Needle outside current page' : 'Visible sample',
          id,
        );
        return result;
      }),
    removeImage: vi.fn(),
    rememberRecordForRestore: vi.fn(),
    retainPrivateRecord: vi.fn(),
    imageAnnotations: {
      store,
      ready: true,
      readPrivateDetail: store?.readPrivateDetail ?? null,
    },
    discovery: {
      capabilities: { data: { exports: { download_enabled: false } } },
    },
    watermark: {
      settings: null,
      visible: false,
      backfill: null,
      backfillError: null,
      localAvailable: false,
      preparable: false,
      readLocalOriginal: vi.fn(),
      analyze: vi.fn(),
      prepare: vi.fn(),
      inspect: vi.fn(async () => null),
      setVisible: vi.fn(),
      queueAnalysis: vi.fn(),
    },
  };
}

const app = (studio) => (
  <MediaContext.Provider value={null}>
    <Library studio={studio} onEdit={vi.fn()} />
  </MediaContext.Provider>
);

const openAnnotationMenu = () =>
  fireEvent.click(screen.getByRole('button', { name: /Filter images:/ }));
const chooseFavorites = async () => {
  await screen.findByRole('button', { name: /Filter images:/ });
  openAnnotationMenu();
  const favorites = screen.getByRole('menuitemradio', { name: /Favorites/ });
  await waitFor(() =>
    expect(favorites.getAttribute('aria-disabled')).not.toBe('true'),
  );
  fireEvent.click(favorites);
};
const openCollectionManager = async () => {
  await screen.findByRole('button', { name: /Filter images:/ });
  openAnnotationMenu();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Manage collections' }));
};

test.each(['favorites', 'collection'])(
  'confirmed deletion in a %s filter removes the card and updates availability without deleting its annotation',
  async (filter) => {
    const { store } = await setupAnnotations();
    const keeper = record('Alpha keeper', 'alpha');
    const doomed = record('Bravo doomed', 'bravo');
    const collection = await store.createCollection('Review set');
    for (const image of [keeper, doomed]) {
      await store.setFavorite(annotationIdentity(image), true);
      await store.setMembership(
        annotationIdentity(image),
        collection.entry.id,
        true,
      );
    }
    const studio = makeStudio({
      store,
      visible: [keeper, doomed],
      loader: vi.fn(async (summary) =>
        summary.id === 'bravo' ? doomed : keeper,
      ),
    });
    studio.removeImage.mockResolvedValue(null);
    render(app(studio));
    if (filter === 'favorites') await chooseFavorites();
    else {
      await screen.findByRole('button', { name: /Filter images:/ });
      openAnnotationMenu();
      fireEvent.click(
        await screen.findByRole('menuitemradio', { name: /Review set/ }),
      );
    }
    fireEvent.click(
      await screen.findByRole('button', { name: /Bravo doomed/ }),
    );
    fireEvent.click(await screen.findByRole('button', { name: /^Delete$/ }));
    const buttons = await screen.findAllByRole('button', { name: /Delete/ });
    fireEvent.click(buttons.at(-1));
    await waitFor(() => expect(studio.removeImage).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByRole('button', { name: /Bravo doomed/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Alpha keeper/ })).toBeTruthy();
    expect(screen.getByText('1 available image · 2 saved')).toBeTruthy();
    expect(screen.getByText('1 unavailable')).toBeTruthy();
  },
);

test('Favorites searches all stored membership beyond the visible Library page', async () => {
  const { store } = await setupAnnotations();
  const visible = record('Visible sample', 'visible');
  const offscreen = record('Needle outside current page', 'offscreen');
  await store.setFavorite(annotationIdentity(visible), true);
  await store.setFavorite(annotationIdentity(offscreen), true);
  const loader = vi.fn(async (summary) => {
    const id = summary.id ?? summary.image_id;
    return id === 'offscreen' ? offscreen : visible;
  });
  const studio = makeStudio({ store, visible: [visible], loader });
  render(app(studio));

  await chooseFavorites();

  expect(
    await screen.findByRole('button', { name: /Needle outside current page/ }),
  ).toBeTruthy();
  expect(loader).toHaveBeenCalledTimes(2);
  fireEvent.change(screen.getByRole('searchbox'), {
    target: { value: 'needle outside' },
  });
  expect(
    await screen.findByRole('button', { name: /Needle outside current page/ }),
  ).toBeTruthy();
  expect(screen.getByText(/1 available image matching/)).toBeTruthy();
  expect(studio.reloadImages).toHaveBeenCalledTimes(1);
  expect(studio.loadLibraryWindow).not.toHaveBeenCalled();
});

test('an image at a reused shared path is not inherited by its replacement', async () => {
  const { store } = await setupAnnotations();
  const old = record('Old image', 'old-id');
  const replacement = record('Replacement', 'new-id');
  await store.setFavorite(annotationIdentity(old), true);
  const loader = vi.fn(async () => replacement);
  const studio = makeStudio({ store, visible: [], loader });
  render(app(studio));
  await chooseFavorites();

  expect(await screen.findByText(/1 unavailable/)).toBeTruthy();
  expect(
    screen.getByText('No saved members are available in this Library source.'),
  ).toBeTruthy();
  expect(loader).toHaveBeenCalledTimes(1);
  expect((await store.list()).images).toHaveLength(1);
});

test('a missing membership remains counted and explicit retry can find the same image', async () => {
  const { store } = await setupAnnotations();
  const saved = record('Returns after retry', 'retry-id');
  await store.setFavorite(annotationIdentity(saved), true);
  const loader = vi
    .fn()
    .mockRejectedValueOnce(Object.assign(new Error('missing'), { status: 404 }))
    .mockResolvedValueOnce(saved);
  render(app(makeStudio({ store, visible: [], loader })));
  await chooseFavorites();
  expect(await screen.findByText(/1 unavailable/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Retry unavailable' }));
  expect(
    await screen.findByRole('button', { name: /Returns after retry/ }),
  ).toBeTruthy();
  expect(loader).toHaveBeenCalledTimes(2);
});

test('detail More offers browser-private favorite actions and leaves originals alone', async () => {
  const { db, store } = await setupAnnotations();
  const image = record('Visible sample', 'visible');
  await db.run(['privateMedia'], 'readwrite', (access) =>
    access.put('privateMedia', 'protected', { blob: new Blob(['original']) }),
  );
  render(app(makeStudio({ store, visible: [image] })));
  fireEvent.click(screen.getByRole('button', { name: /Visible sample/ }));
  fireEvent.click(
    await screen.findByRole('button', { name: 'Saved image actions' }),
  );
  fireEvent.click(screen.getByRole('menuitem', { name: /Add to favorites/ }));
  await waitFor(async () =>
    expect((await store.list()).images[0]?.favorite).toBe(true),
  );
  expect(
    await db.run(['privateMedia'], 'readonly', (access) =>
      access.get('privateMedia', 'protected'),
    ),
  ).toEqual({ blob: expect.any(Blob) });
});

test('collection removal confirmation focuses Cancel and Escape cancels only the question', async () => {
  const { store } = await setupAnnotations();
  const collection = await store.createCollection('Scene studies');
  const image = record('Visible sample', 'visible');
  await store.setMembership(
    annotationIdentity(image),
    collection.entry.id,
    true,
  );
  render(app(makeStudio({ store, visible: [image] })));
  openAnnotationMenu();
  const collectionOption = await screen.findByRole('menuitemradio', {
    name: /studies.*1 image/i,
  });
  expect(collectionOption).toBeTruthy();
  fireEvent.keyDown(collectionOption, { key: 'Escape' });
  await openCollectionManager();
  fireEvent.click(screen.getByRole('button', { name: /Remove$/ }));
  const cancel = screen.getByRole('button', { name: 'Cancel' });
  await waitFor(() => expect(document.activeElement).toBe(cancel));
  fireEvent.keyDown(cancel, { key: 'Escape' });
  expect(screen.queryByText(/Images remain in the Library/)).toBeNull();
  expect(
    screen.getByRole('dialog', { name: 'Manage collections' }),
  ).toBeTruthy();
  expect((await store.list()).collections).toHaveLength(1);
});

test('collection removal preserves the image favorite and image record', async () => {
  const { store } = await setupAnnotations();
  const collection = await store.createCollection('Studies');
  const image = record('Kept image', 'kept');
  await store.setFavorite(annotationIdentity(image), true);
  await store.setMembership(
    annotationIdentity(image),
    collection.entry.id,
    true,
  );
  render(app(makeStudio({ store, visible: [image] })));
  await openCollectionManager();
  fireEvent.click(screen.getByRole('button', { name: /Remove$/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Remove collection' }));
  await waitFor(async () =>
    expect((await store.list()).collections).toHaveLength(0),
  );
  expect((await store.list()).images).toMatchObject([
    { favorite: true, collections: [] },
  ]);
});

test('a collection rename from another tab wins the exact-revision conflict', async () => {
  const { db, store } = await setupAnnotations();
  const collection = await store.createCollection('Before');
  const otherTab = createImageAnnotationStore(db, { openChannel: () => null });
  render(app(makeStudio({ store, visible: [] })));
  await openCollectionManager();
  fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
  const input = screen.getByRole('textbox', { name: 'Collection name' });
  fireEvent.change(input, { target: { value: 'From this tab' } });
  await otherTab.renameCollection(collection.entry.id, 'From another tab', {
    revision: collection.entry.revision,
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByText(/changed in another tab/)).toBeTruthy();
  await waitFor(async () =>
    expect((await store.list()).collections[0].name).toBe('From another tab'),
  );
});

test('private collection reads exact addedAt metadata without fetching a private URL', async () => {
  const { store } = await setupAnnotations();
  const key = 'private/one.png';
  const collection = await store.createCollection('Private');
  const privateIdentity = { source: 'private', key, addedAt: 100 };
  await store.setMembership(privateIdentity, collection.entry.id, true);
  const readPrivateDetail = vi.fn(async (actualKey) =>
    actualKey === key
      ? {
          addedAt: 100,
          origin: 'generated',
          record: {
            id: key,
            title: 'Private saved image',
            prompt: 'Private saved image',
          },
          hasFull: true,
        }
      : null,
  );
  const studio = makeStudio({ store, visible: [], source: SOURCE.PRIVATE });
  studio.imageAnnotations.readPrivateDetail = readPrivateDetail;
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  render(app(studio));
  await screen.findByRole('button', { name: /Filter images:/ });
  openAnnotationMenu();
  fireEvent.click(
    await screen.findByRole('menuitemradio', { name: /Private.*1 image/ }),
  );
  expect(
    await screen.findByRole('button', { name: /Private saved image/ }),
  ).toBeTruthy();
  expect(readPrivateDetail).toHaveBeenCalledWith(key);
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
});

test('denied or quota writes show a refusal and never claim a favorite was saved', async () => {
  const { db, store } = await setupAnnotations();
  const image = record('Visible sample', 'visible');
  render(app(makeStudio({ store, visible: [image] })));
  await waitFor(async () => expect((await store.list()).durable).toBe(true));
  db.failNext(quotaError(), (stores) => stores.includes(STORE.SETTINGS));
  fireEvent.click(screen.getByRole('button', { name: /Visible sample/ }));
  fireEvent.click(
    await screen.findByRole('button', { name: 'Saved image actions' }),
  );
  fireEvent.click(screen.getByRole('menuitem', { name: /Add to favorites/ }));
  expect(await screen.findByText(/Browser storage is full/)).toBeTruthy();
});

test('unavailable annotation storage disables actions and explains the refusal', async () => {
  const image = record('Visible sample', 'visible');
  const studio = makeStudio({ store: null, visible: [image] });
  studio.imageAnnotations = {
    store: null,
    ready: true,
    readPrivateDetail: null,
  };
  render(app(studio));
  openAnnotationMenu();
  expect(
    screen
      .getByRole('menuitemradio', { name: /Favorites/ })
      .getAttribute('aria-disabled'),
  ).toBe('true');
  expect(
    screen.getByRole('menuitem', {
      name: /unavailable in this browser/,
    }),
  ).toBeTruthy();
  fireEvent.keyDown(screen.getByRole('menuitem', { name: /unavailable/ }), {
    key: 'Escape',
  });
  fireEvent.click(screen.getByRole('button', { name: /Visible sample/ }));
  fireEvent.click(
    await screen.findByRole('button', { name: 'Saved image actions' }),
  );
  expect(
    screen
      .getByRole('menuitem', { name: /Add to favorites/ })
      .getAttribute('aria-disabled'),
  ).toBe('true');
  expect(screen.getByText('Browser storage is unavailable')).toBeTruthy();
});
