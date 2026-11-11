import { expect, test, vi } from 'vitest';
import { STORE } from './cacheDb.js';
import {
  memoryDb,
  quotaError,
} from '../../../tests/helpers/cacheTestSupport.js';
import {
  ANNOTATION_LIMITS,
  annotationMembers,
} from '../records/imageAnnotations.js';
import {
  IMAGE_ANNOTATION_KEY,
  createImageAnnotationStore,
} from './imageAnnotationStore.js';

const image = (n = 1) => ({
  source: 'shared',
  key: `files/${n}.png`,
  imageId: `image-${n}`,
});
const setup = () => {
  const db = memoryDb();
  let id = 0;
  return {
    db,
    store: createImageAnnotationStore(db, {
      makeId: () => `c${++id}`,
      openChannel: () => null,
    }),
  };
};

test('favorites and collection membership survive reload and image cache clearing', async () => {
  const { db, store } = setup();
  const { entry: collection } = await store.createCollection('Warm');
  await store.setFavorite(image(), true);
  await store.setMembership(image(), collection.id, true);
  const run = vi.spyOn(db, 'run');
  const reloaded = await createImageAnnotationStore(db).list();
  expect(annotationMembers(reloaded, { favorite: true })).toEqual([image()]);
  expect(annotationMembers(reloaded, { collectionId: collection.id })).toEqual([
    image(),
  ]);
  expect(
    run.mock.calls.every(
      ([tables]) => tables.length === 1 && tables[0] === STORE.SETTINGS,
    ),
  ).toBe(true);
});

test('one tab favorites while another adds membership without losing either operation', async () => {
  const { db, store } = setup();
  const { entry: c } = await store.createCollection('Set');
  const other = createImageAnnotationStore(db, { openChannel: () => null });
  const results = await Promise.all([
    store.setFavorite(image(), true),
    other.setMembership(image(), c.id, true),
  ]);
  expect(results.every((r) => r.persisted)).toBe(true);
  expect((await store.list()).images[0]).toMatchObject({
    favorite: true,
    collections: [c.id],
  });
});

test('a reused shared path cannot adopt or overwrite another image favorite', async () => {
  const { store } = setup();
  const original = image();
  const replacement = { ...original, imageId: 'replacement' };
  await store.setFavorite(original, true);
  await store.setFavorite(replacement, false);
  expect(annotationMembers(await store.list(), { favorite: true })).toEqual([
    original,
  ]);
  await store.setFavorite(replacement, true);
  expect(annotationMembers(await store.list(), { favorite: true })).toEqual([
    original,
    replacement,
  ]);
});

test('removing collection preserves favorites and never deletes images or settings', async () => {
  const { db, store } = setup();
  const { entry: c } = await store.createCollection('Set');
  await store.setFavorite(image(), true);
  await store.setMembership(image(), c.id, true);
  await store.setMembership(image(2), c.id, true);
  await db.run(
    [STORE.PRIVATE_MEDIA, STORE.SETTINGS],
    'readwrite',
    async (a) => {
      await a.put(STORE.PRIVATE_MEDIA, 'original', {
        blob: new Blob(['kept']),
      });
      await a.put(STORE.SETTINGS, 'watermark', { text: 'Unchanged' });
    },
  );
  expect(
    await store.removeCollection(c.id, { revision: c.revision }),
  ).toMatchObject({ persisted: true });
  const state = await store.list();
  expect(state.collections).toHaveLength(0);
  expect(state.images).toHaveLength(1);
  expect(state.images[0]).toMatchObject({ favorite: true, collections: [] });
  expect(db.data.get(STORE.PRIVATE_MEDIA).get('original').blob.size).toBe(4);
  expect(db.data.get(STORE.SETTINGS).get('watermark')).toEqual({
    text: 'Unchanged',
  });
});

test('late membership update cannot recreate a deleted collection', async () => {
  const { store } = setup();
  const { entry: c } = await store.createCollection('Set');
  await store.removeCollection(c.id, { revision: c.revision });
  expect(await store.setMembership(image(), c.id, true)).toMatchObject({
    reason: 'changed',
  });
  expect((await store.list()).images).toHaveLength(0);
});

test('rename and removal compare revisions, duplicate names cannot replace another collection', async () => {
  const { store } = setup();
  const { entry: c } = await store.createCollection('First');
  await store.createCollection('Second');
  expect(await store.createCollection(' FIRST ')).toMatchObject({
    reason: 'duplicate-name',
  });
  expect(
    await store.renameCollection(c.id, 'Second', { revision: c.revision }),
  ).toMatchObject({ reason: 'duplicate-name' });
  expect(
    await store.renameCollection(c.id, 'Renamed', { revision: c.revision }),
  ).toMatchObject({ persisted: true });
  expect(
    await store.removeCollection(c.id, { revision: c.revision }),
  ).toMatchObject({ reason: 'changed' });
});

test('quota failure rolls back favorites, membership and collection removal', async () => {
  const { db, store } = setup();
  const { entry: c } = await store.createCollection('Set');
  await store.setMembership(image(), c.id, true);
  const before = await store.list();
  db.failNext(quotaError());
  expect(await store.setFavorite(image(), true)).toMatchObject({
    reason: 'quota',
  });
  db.failNext(quotaError());
  expect(
    await store.removeCollection(c.id, { revision: c.revision }),
  ).toMatchObject({ reason: 'quota' });
  expect(await store.list()).toEqual(before);
});

test('image admission limit refuses new favorites but allows existing annotations to change', async () => {
  const { db, store } = setup();
  const images = Array.from({ length: ANNOTATION_LIMITS.images }, (_, n) => ({
    identity: image(n),
    favorite: true,
    collections: [],
    revision: 1,
  }));
  await db.run([STORE.SETTINGS], 'readwrite', (a) =>
    a.put(STORE.SETTINGS, IMAGE_ANNOTATION_KEY, {
      version: 1,
      sequence: 1,
      collections: [],
      images,
    }),
  );
  expect(await store.setFavorite(image(9999), true)).toMatchObject({
    reason: 'record-limit',
  });
  expect((await store.list()).images).toHaveLength(ANNOTATION_LIMITS.images);
  expect(await store.setFavorite(image(1), false)).toMatchObject({
    persisted: true,
  });
  expect((await store.list()).images).toHaveLength(
    ANNOTATION_LIMITS.images - 1,
  );
});

test('collection limit refuses admission and keeps existing collections', async () => {
  const { store } = setup();
  for (let n = 0; n < ANNOTATION_LIMITS.collections; n++)
    await store.createCollection(`Set ${n}`);
  expect(await store.createCollection('Overflow')).toMatchObject({
    reason: 'collection-limit',
  });
  expect((await store.list()).collections).toHaveLength(
    ANNOTATION_LIMITS.collections,
  );
});

test('invalid identities and unavailable storage fail honestly', async () => {
  expect(
    await createImageAnnotationStore(null).setFavorite(image(), true),
  ).toMatchObject({ reason: 'no-storage' });
  const { store } = setup();
  expect(
    await store.setFavorite({ source: 'private', key: 'old' }, true),
  ).toMatchObject({ reason: 'invalid' });
  expect(await store.setFavorite(image(), 'yes')).toMatchObject({
    reason: 'invalid',
  });
  expect(await store.createCollection('')).toMatchObject({ reason: 'invalid' });
});

test('unsupported stored data is reported rather than overwritten', async () => {
  const { db, store } = setup();
  await db.run([STORE.SETTINGS], 'readwrite', (a) =>
    a.put(STORE.SETTINGS, IMAGE_ANNOTATION_KEY, { version: 99 }),
  );
  await expect(store.list()).rejects.toThrow();
  expect(await store.createCollection('New')).toMatchObject({
    reason: 'failed',
  });
  expect(db.data.get(STORE.SETTINGS).get(IMAGE_ANNOTATION_KEY)).toEqual({
    version: 99,
  });
});

test('only committed writes announce, including a writer without subscribers', async () => {
  const { db } = setup();
  const postMessage = vi.fn(),
    close = vi.fn();
  const store = createImageAnnotationStore(db, {
    openChannel: () => ({ postMessage, close }),
  });
  expect(await store.setFavorite(image(), true)).toMatchObject({
    persisted: true,
  });
  expect(postMessage).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
  db.failNext(quotaError());
  await store.setFavorite(image(), false);
  expect(postMessage).toHaveBeenCalledOnce();
});
