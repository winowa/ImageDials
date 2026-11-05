import { expect, test, vi } from 'vitest';
import { STORE } from './cacheDb.js';
import { memoryDb, quotaError } from './cacheTestSupport.js';
import {
  CONTROL_PRESET_KEY,
  createControlPresetStore,
} from './controlPresetStore.js';
import { PRESET_LIMITS } from './controlPresets.js';

const preset = (name = 'Warm') => ({
  name,
  mode: 'image',
  controls: [
    { id: 'color', kind: 'multi-select', value: ['warm'], custom: [] },
  ],
  prompt: 'not stored',
  providerHeader: 'not stored',
  references: ['not stored'],
});
const setup = () => {
  const db = memoryDb();
  let id = 0;
  const store = createControlPresetStore(db, {
    makeId: () => `p${++id}`,
    openChannel: () => null,
  });
  return { db, store };
};

test('save and reload retain only allowlisted values without touching image stores', async () => {
  const { db, store } = setup();
  await store.save(preset());
  const run = vi.spyOn(db, 'run');
  const reload = await createControlPresetStore(db).list();
  expect(reload.items[0]).toMatchObject({ name: 'Warm', revision: 1 });
  expect(reload.items[0]).not.toHaveProperty('prompt');
  expect(reload.items[0]).not.toHaveProperty('providerHeader');
  expect(reload.items[0]).not.toHaveProperty('references');
  expect(
    run.mock.calls.every(
      ([tables]) => tables.length === 1 && tables[0] === STORE.SETTINGS,
    ),
  ).toBe(true);
});

test('same-name saves are refused per mode, with no overwrite', async () => {
  const { store } = setup();
  await store.save(preset());
  expect(await store.save(preset(' WARM '))).toMatchObject({
    persisted: false,
    reason: 'duplicate-name',
  });
  expect(await store.save({ ...preset(), mode: 'asset-image' })).toMatchObject({
    persisted: true,
  });
  expect((await store.list()).items).toHaveLength(2);
});

test('two tabs replacing a revision cannot silently overwrite each other', async () => {
  const { db, store } = setup();
  const { entry } = await store.save(preset());
  const other = createControlPresetStore(db, { openChannel: () => null });
  const options = { id: entry.id, revision: entry.revision };
  const results = await Promise.all([
    store.save(preset('One'), options),
    other.save(preset('Two'), options),
  ]);
  expect(results.map((r) => r.persisted).sort()).toEqual([false, true]);
  expect(results.find((r) => !r.persisted).reason).toBe('changed');
  expect((await store.list()).items).toHaveLength(1);
});

test('removal requires the exact revision and stale replacement cannot resurrect a removed row', async () => {
  const { store } = setup();
  const { entry } = await store.save(preset());
  expect(await store.remove(entry.id, { revision: 0 })).toMatchObject({
    reason: 'changed',
  });
  expect(await store.remove(entry.id, { revision: 1 })).toMatchObject({
    persisted: true,
  });
  expect(
    await store.save(preset(), { id: entry.id, revision: 1 }),
  ).toMatchObject({ reason: 'changed' });
  expect((await store.list()).items).toHaveLength(0);
});

test('count limit refuses admission without evicting presets', async () => {
  const { store } = setup();
  for (let n = 0; n < PRESET_LIMITS.count; n++)
    await store.save(preset(`Preset ${n}`));
  expect(await store.save(preset('One more'))).toMatchObject({
    reason: 'record-limit',
  });
  expect((await store.list()).items).toHaveLength(PRESET_LIMITS.count);
});

test('byte limit refuses a large control preset without changing earlier rows', async () => {
  const { store } = setup();
  await store.save(preset());
  const custom = Array.from({ length: 64 }, (_, n) => ({
    key: `key${n}`.padEnd(120, 'k'),
    label: 'x'.repeat(60),
  }));
  const controls = Array.from({ length: 32 }, (_, n) => ({
    id: `c${n}`,
    kind: 'multi-select',
    value: [],
    custom,
  }));
  expect(
    await store.save({ name: 'Large', mode: 'image', controls }),
  ).toMatchObject({ reason: 'byte-limit' });
  expect((await store.list()).items).toHaveLength(1);
});

test('quota failure at transaction commit rolls back a replacement and removal', async () => {
  const { db, store } = setup();
  const { entry } = await store.save(preset());
  db.failNext(quotaError());
  expect(
    await store.save(preset('Changed'), {
      id: entry.id,
      revision: entry.revision,
    }),
  ).toMatchObject({ reason: 'quota' });
  db.failNext(quotaError());
  expect(
    await store.remove(entry.id, { revision: entry.revision }),
  ).toMatchObject({ reason: 'quota' });
  expect((await store.list()).items[0]).toEqual(entry);
});

test('unavailable storage refuses durable save and corrupt storage is reported without overwriting', async () => {
  expect(await createControlPresetStore(null).save(preset())).toMatchObject({
    reason: 'no-storage',
  });
  const { db, store } = setup();
  await db.run([STORE.SETTINGS], 'readwrite', (a) =>
    a.put(STORE.SETTINGS, CONTROL_PRESET_KEY, { version: 99 }),
  );
  await expect(store.list()).rejects.toThrow('Stored presets');
  expect(await store.save(preset())).toMatchObject({ reason: 'failed' });
  expect(db.data.get(STORE.SETTINGS).get(CONTROL_PRESET_KEY)).toEqual({
    version: 99,
  });
});

test('notifications happen after committed writes only and throwing subscribers do not invalidate a save', async () => {
  const { db } = setup();
  const postMessage = vi.fn(),
    close = vi.fn();
  const store = createControlPresetStore(db, {
    openChannel: () => ({ postMessage, close }),
  });
  const off = store.subscribe(() => {
    throw new Error('Observer');
  });
  const notify = vi.fn();
  store.subscribe(notify);
  await store.save(preset());
  expect(notify).toHaveBeenCalledOnce();
  expect(postMessage).toHaveBeenCalledOnce();
  db.failNext(quotaError());
  await store.save(preset('No notification'));
  expect(notify).toHaveBeenCalledOnce();
  off();
});
