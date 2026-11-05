import React from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { createCacheStore } from './cacheStore.js';
import { memoryDb, quotaError } from './cacheTestSupport.js';
import { DEFAULT_CLIENT_POLICY } from './clientPolicy.js';
import Viewer from './Viewer.jsx';

vi.mock('./ui.jsx', async (original) => ({
  ...(await original()),
  SavedImg: ({ image, className }) => (
    <img className={className} alt={image.alt_text} />
  ),
}));

const image = {
  id: 'saved-one',
  image_id: 'saved-one',
  storage_id: 'local',
  filename: 'one.png',
  title: 'A quiet shore',
  alt_text: 'A quiet shore',
  provider: 'mock',
  width: 384,
  height: 256,
};
const studio = (store, current = image) => ({
  job: null,
  generating: null,
  current,
  draft: { aspect: '3:2', mode: 'image', prompt: 'A quiet shore' },
  discovery: { capabilities: { data: {} }, models: { data: {} } },
  watermark: { visible: false, settings: null },
  references: { refs: [] },
  imageAnnotations: { store, ready: true },
});
const setup = () => {
  const db = memoryDb();
  const cache = createCacheStore(db, DEFAULT_CLIENT_POLICY.cache, {
    openChannel: () => null,
  });
  return { db, store: cache.imageAnnotations };
};
async function action(name) {
  fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
  const item = await screen.findByRole('menuitem', { name });
  await waitFor(() =>
    expect(item.getAttribute('aria-disabled')).not.toBe('true'),
  );
  fireEvent.click(item);
}
afterEach(cleanup);

test('favorite and collection actions share the existing More and leave the image intact', async () => {
  const { store } = setup();
  const { entry: collection } = await store.createCollection('Coast');
  render(<Viewer studio={studio(store)} onEdit={() => {}} />);
  const row = document.querySelector('.result-actions');
  expect(row.children).toHaveLength(4);
  expect(
    within(row).getAllByRole('button', { name: 'More actions' }),
  ).toHaveLength(1);
  await action('Add to favorites');
  await screen.findByText('Saved in this browser.');
  await waitFor(async () =>
    expect((await store.list()).images[0].favorite).toBe(true),
  );
  await action('Add to Coast');
  await waitFor(async () =>
    expect((await store.list()).images[0].collections).toEqual([collection.id]),
  );
  expect(screen.getByRole('heading', { name: image.title })).toBeTruthy();
  expect(
    screen.getByRole('button', { name: 'Reuse settings', exact: true }),
  ).toBeTruthy();
});

test('quota refusal is visible and never reports a favorite as saved', async () => {
  const { db, store } = setup();
  render(<Viewer studio={studio(store)} onEdit={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
  const favorite = await screen.findByRole('menuitem', {
    name: 'Add to favorites',
  });
  await waitFor(() =>
    expect(favorite.getAttribute('aria-disabled')).not.toBe('true'),
  );
  db.failNext(quotaError());
  fireEvent.click(favorite);
  await screen.findByText('Browser storage is full. Nothing was changed.');
  expect(screen.queryByText('Saved in this browser.')).toBeNull();
  expect((await store.list()).images).toEqual([]);
});

test('late annotation feedback stays with the exact image incarnation', async () => {
  const { store } = setup();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const delayed = {
    ...store,
    setFavorite: async (...args) => {
      await gate;
      return store.setFavorite(...args);
    },
  };
  const view = render(<Viewer studio={studio(delayed)} onEdit={() => {}} />);
  await action('Add to favorites');
  const replacement = { ...image, id: 'replacement', image_id: 'replacement' };
  view.rerender(
    <Viewer studio={studio(delayed, replacement)} onEdit={() => {}} />,
  );
  await act(async () => {
    release();
    await gate;
  });
  await waitFor(async () =>
    expect((await store.list()).images[0]?.identity.imageId).toBe(
      image.image_id,
    ),
  );
  expect(screen.queryByText('Saved in this browser.')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
  expect(
    screen.getByRole('menuitem', { name: 'Add to favorites' }),
  ).toBeTruthy();
  expect(
    screen.queryByRole('menuitem', { name: 'Remove from favorites' }),
  ).toBeNull();
});
