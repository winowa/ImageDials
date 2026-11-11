import { openStandardControls } from '../helpers/controlUiTestSupport.js';
/**
 * Named Standard control presets through App with a real preset store over
 * an in-memory database: save, apply as one undo step, duplicates, removal,
 * refused storage, partial matches, modes and another tab's changes.
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import editingFixture from '../../../fixtures/api/image-editing.json';
import App from '../../src/app/App.jsx';
import { createCacheStore } from '../../src/data/storage/cacheStore.js';
import { memoryDb, quotaError } from '../helpers/cacheTestSupport.js';
import { DEFAULT_CLIENT_POLICY } from '../../src/data/api/clientPolicy.js';
import { createControlPresetStore } from '../../src/data/storage/controlPresetStore.js';
import { fakeLibrary, fixtures, installApi } from '../helpers/testSupport.js';

const harness = vi.hoisted(() => ({ cache: { store: null, ready: true } }));
vi.mock('../../src/data/storage/useCacheStore.js', () => ({
  useCacheStore: () => harness.cache,
}));
vi.mock('../../src/features/controls/standardRandom.js', async (original) => ({
  ...(await original()),
  randomizeStandard: (entries) => entries,
}));

const { m1 } = fixtures;
const DYNAMIC = 'POST /api/controls/dynamic';
const jobPolicy = { pollIntervalMs: 1, maxConsecutivePollFailures: 3 };

let db;

/** Another tab: its own store over the same database, posting to this one. */
const otherTab = () => createControlPresetStore(db);

function setup({ storage = true, edits = false } = {}) {
  db = memoryDb();
  harness.cache = {
    store: storage
      ? createCacheStore(db, DEFAULT_CLIENT_POLICY.cache, {
          openChannel: () => null,
        })
      : null,
    ready: true,
  };
  installApi({
    'GET /api/app-capabilities': () => ({
      ...m1.capabilities,
      ...(edits ? { image_editing: editingFixture.capabilities } : {}),
      client_policy: { controls: { debounce_ms: 20, reset_debounce_ms: 20 } },
    }),
    [DYNAMIC]: () => m1.dynamic_response,
    ...fakeLibrary().routes,
  });
}

const renderApp = () => render(<App jobPolicy={jobPolicy} />);
const ready = () => openStandardControls();
const group = (name) => screen.getByRole('radiogroup', { name });
const option = (groupName, name) =>
  within(group(groupName)).getByRole('radio', { name });
const pick = (groupName, name) => fireEvent.click(option(groupName, name));
const checked = (groupName, name) => option(groupName, name).checked;
const openPresets = () =>
  fireEvent.click(screen.getByRole('button', { name: 'Presets' }));
const presetMenu = () => screen.getByRole('menu', { name: 'Presets' });
const menuItem = (name) => within(presetMenu()).getByRole('menuitem', { name });
const undo = () =>
  fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
const redo = () =>
  fireEvent.keyDown(document.body, { key: 'y', ctrlKey: true });

async function savePreset(name) {
  openPresets();
  fireEvent.click(menuItem(/Save as preset/));
  const dialog = await screen.findByRole('dialog', { name: 'Save preset' });
  const field = within(dialog).getByLabelText('Preset name');
  await waitFor(() => expect(document.activeElement).toBe(field));
  fireEvent.change(field, { target: { value: name } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  return dialog;
}

test('a delayed close cannot take focus from a newly opened preset dialog', async () => {
  setup();
  renderApp();
  await ready();
  const frames = [];
  vi.stubGlobal('requestAnimationFrame', (callback) => {
    frames.push(callback);
    return frames.length;
  });
  await savePreset('First');
  await waitFor(() =>
    expect(screen.queryByRole('dialog', { name: 'Save preset' })).toBeNull(),
  );
  openPresets();
  fireEvent.click(menuItem(/Save as preset/));
  const dialog = await screen.findByRole('dialog', { name: 'Save preset' });
  const field = within(dialog).getByLabelText('Preset name');
  await waitFor(() => expect(document.activeElement).toBe(field));
  act(() => frames.splice(0).forEach((callback) => callback(0)));
  expect(document.activeElement).toBe(field);
});

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test('a saved preset applies as one undo step and keeps the prompt, aspect and generated controls', async () => {
  setup();
  renderApp();
  await ready();
  fireEvent.change(screen.getByLabelText('Image idea'), {
    target: { value: 'A red kite over dunes' },
  });
  await screen.findByRole('heading', { name: 'Generated controls' });
  const generated = await screen.findByRole('heading', { name: 'Surface' });
  pick('Style', 'Watercolor');
  pick('Lighting', 'Golden hour');
  await savePreset('Dusk wash');
  await screen.findByText('Saved Dusk wash.');
  expect(screen.queryByRole('dialog', { name: 'Save preset' })).toBeNull();

  pick('Style', 'Illustration');
  pick('Lighting', 'Studio');
  fireEvent.click(screen.getByRole('radio', { name: '1:1' }));
  openPresets();
  fireEvent.click(menuItem('Apply Dusk wash'));
  expect(checked('Style', 'Watercolor')).toBe(true);
  expect(checked('Lighting', 'Golden hour')).toBe(true);
  expect(screen.getByLabelText('Image idea').value).toBe(
    'A red kite over dunes',
  );
  expect(screen.getByRole('radio', { name: '1:1' }).checked).toBe(true);
  expect(generated.isConnected).toBe(true);
  await screen.findByText('Applied Dusk wash.');

  // One step: undo returns both values together, redo applies them again.
  undo();
  await waitFor(() => expect(checked('Style', 'Illustration')).toBe(true));
  expect(checked('Lighting', 'Studio')).toBe(true);
  expect(screen.getByRole('radio', { name: '1:1' }).checked).toBe(true);
  redo();
  await waitFor(() => expect(checked('Style', 'Watercolor')).toBe(true));
  expect(checked('Lighting', 'Golden hour')).toBe(true);

  // Nothing about the draft beyond Standard values was kept.
  const [stored] = (await harness.cache.store.controlPresets.list()).items;
  expect(Object.keys(stored).sort()).toEqual([
    'controls',
    'createdAt',
    'id',
    'mode',
    'name',
    'revision',
    'updatedAt',
  ]);
  expect(stored.controls.map((c) => c.id)).toEqual([
    'style',
    'color',
    'lighting',
    'composition',
  ]);
  expect(JSON.stringify(stored)).not.toContain('kite');
});

test('a duplicate name asks before replacing, with Cancel focused and Escape cancelling only the question', async () => {
  setup();
  renderApp();
  await ready();
  pick('Color', 'Warm');
  await savePreset('Warm');
  await screen.findByText('Saved Warm.');
  pick('Color', 'Cool');

  const dialog = await savePreset(' warm ');
  const question = await within(dialog).findByRole('group', {
    name: 'Replace Warm',
  });
  const cancel = within(question).getByRole('button', { name: 'Cancel' });
  expect(document.activeElement).toBe(cancel);
  fireEvent.keyDown(cancel, { key: 'Escape' });
  await waitFor(() =>
    expect(within(dialog).queryByRole('group', { name: 'Replace Warm' })).toBe(
      null,
    ),
  );
  expect(dialog.isConnected).toBe(true);
  // Nothing was replaced by asking.
  let listed = await harness.cache.store.controlPresets.list();
  expect(listed.items).toHaveLength(1);
  expect(listed.items[0].controls[1].value).toBe('warm');

  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  const again = await within(dialog).findByRole('group', {
    name: 'Replace Warm',
  });
  fireEvent.click(within(again).getByRole('button', { name: 'Replace' }));
  await screen.findByText('Saved warm.');
  listed = await harness.cache.store.controlPresets.list();
  expect(listed.items).toHaveLength(1);
  expect(listed.items[0].controls[1].value).toBe('cool');
  expect(listed.items[0].revision).toBe(2);
});

test('removal asks first, Escape and Cancel keep the preset, Remove deletes that revision', async () => {
  setup();
  renderApp();
  await ready();
  await savePreset('Keep me');
  await screen.findByText('Saved Keep me.');
  openPresets();
  fireEvent.click(menuItem(/Manage presets/));
  const dialog = await screen.findByRole('dialog', { name: 'Presets' });
  await within(dialog).findByText('1 of 32 presets', { exact: false });
  const openRemove = () => {
    fireEvent.click(
      within(dialog).getByRole('button', {
        name: 'Actions for preset Keep me',
      }),
    );
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove…' }));
    return within(dialog).getByRole('group', { name: 'Remove Keep me' });
  };
  let question = openRemove();
  const cancel = within(question).getByRole('button', { name: 'Cancel' });
  expect(document.activeElement).toBe(cancel);
  fireEvent.keyDown(cancel, { key: 'Escape' });
  expect(within(dialog).queryByRole('group', { name: 'Remove Keep me' })).toBe(
    null,
  );
  expect(dialog.isConnected).toBe(true);

  question = openRemove();
  fireEvent.click(within(question).getByRole('button', { name: 'Cancel' }));
  expect((await harness.cache.store.controlPresets.list()).items).toHaveLength(
    1,
  );

  question = openRemove();
  fireEvent.click(
    within(question).getByRole('button', { name: 'Remove preset' }),
  );
  await waitFor(() => expect(within(dialog).queryByText('Keep me')).toBeNull());
  await within(dialog).findByText('No presets saved.');
  expect((await harness.cache.store.controlPresets.list()).items).toEqual([]);
});

test('without browser storage saving is unavailable and nothing pretends to be kept', async () => {
  setup({ storage: false });
  renderApp();
  await ready();
  openPresets();
  const save = menuItem(/Save as preset/);
  expect(save.getAttribute('aria-disabled')).toBe('true');
  expect(save.textContent).toContain('Browser storage unavailable');
  expect(within(presetMenu()).queryByRole('menuitem', { name: /Manage/ })).toBe(
    null,
  );
  fireEvent.click(save);
  expect(screen.queryByRole('dialog', { name: 'Save preset' })).toBeNull();
});

test('a quota failure keeps the dialog open with the reason and stores nothing', async () => {
  setup();
  renderApp();
  await ready();
  db.failNext(quotaError());
  const dialog = await savePreset('Too much');
  expect(
    await within(dialog).findByText(
      'Browser storage is full. The preset was not saved.',
    ),
  ).toBeTruthy();
  expect(screen.queryByText('Saved Too much.')).toBeNull();
  expect((await harness.cache.store.controlPresets.list()).items).toEqual([]);
});

test('a preset that only partly matches says what it skipped', async () => {
  setup();
  await harness.cache.store.controlPresets.save({
    name: 'Old catalog',
    mode: 'image',
    controls: [
      { id: 'style', kind: 'single-select', value: 'oil-painting', custom: [] },
      { id: 'lighting', kind: 'single-select', value: 'neon', custom: [] },
      { id: 'film_grain', kind: 'slider', value: 0, custom: [] },
    ],
  });
  renderApp();
  await ready();
  openPresets();
  const item = await waitFor(() => menuItem(/Apply Old catalog/));
  expect(item.textContent).toContain('1 of 3 controls apply');
  fireEvent.click(item);
  expect(checked('Style', 'Oil painting')).toBe(true);
  expect(checked('Lighting', 'Soft daylight')).toBe(true);
  const status = await screen.findByText(
    'Applied Old catalog to 1 of 3 controls.',
  );
  const region = status.closest('.preset-status');
  expect(region.textContent).toContain(
    'Lighting: saved choice is no longer offered',
  );
  expect(region.textContent).toContain('Film grain: not in these controls');
  fireEvent.click(
    within(region).getByRole('button', { name: 'Warning details' }),
  );
  const detail = screen.getByRole('dialog', { name: 'Warning details' });
  expect(detail.textContent).toContain(
    'Applied Old catalog to 1 of 3 controls.',
  );
  expect(detail.textContent).not.toContain('HTTP status');
  fireEvent.keyDown(detail, { key: 'Escape' });
  expect(checked('Style', 'Oil painting')).toBe(true);
});

test('presets for another mode are not offered, and are named as such', async () => {
  setup();
  await harness.cache.store.controlPresets.save({
    name: 'Ceramic',
    mode: 'asset-image',
    controls: [
      { id: 'material', kind: 'single-select', value: 'ceramic', custom: [] },
    ],
  });
  renderApp();
  await ready();
  openPresets();
  await waitFor(() => menuItem(/No image presets/));
  expect(
    within(presetMenu()).queryByRole('menuitem', { name: /Apply Ceramic/ }),
  ).toBeNull();
  expect(menuItem(/No image presets/).textContent).toContain(
    '1 for asset image mode',
  );
});

test("another tab's save appears, and its change blocks a removal of the revision shown", async () => {
  setup();
  renderApp();
  await ready();
  const tab = otherTab();
  // The other tab's commit reaches this tab through the store's notification.
  await act(async () => {
    await tab.save({
      name: 'From elsewhere',
      mode: 'image',
      controls: [
        { id: 'color', kind: 'single-select', value: 'cool', custom: [] },
      ],
    });
    await harness.cache.store.controlPresets
      .list()
      .then(() => new Promise((resolve) => setTimeout(resolve, 20)));
  });
  openPresets();
  await waitFor(() => menuItem(/Apply From elsewhere/));
  fireEvent.click(menuItem(/Manage presets/));
  const dialog = await screen.findByRole('dialog', { name: 'Presets' });
  fireEvent.click(
    await within(dialog).findByRole('button', {
      name: 'Actions for preset From elsewhere',
    }),
  );
  fireEvent.click(screen.getByRole('menuitem', { name: 'Remove…' }));
  const question = within(dialog).getByRole('group', {
    name: 'Remove From elsewhere',
  });

  const [shown] = (await tab.list()).items;
  await act(async () => {
    await tab.save(
      { name: 'Renamed there', mode: 'image', controls: shown.controls },
      { id: shown.id, revision: shown.revision },
    );
  });
  // Visibility refresh stands in for a missed cross-tab message.
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await within(question).findByText(/changed in another tab/);
  expect(
    within(question)
      .getByRole('button', { name: 'Remove preset' })
      .hasAttribute('disabled'),
  ).toBe(true);
  const listed = await tab.list();
  expect(listed.items.map((p) => p.name)).toEqual(['Renamed there']);
});

test('edit defaults save off, replace-current captures mixed flags, and applying restores them in one Undo', async () => {
  setup({ edits: true });
  renderApp();
  await ready();
  fireEvent.click(screen.getByRole('radio', { name: 'Edit image' }));
  await ready();
  await savePreset('Edit choices');
  await screen.findByText('Saved Edit choices.');
  let saved = (await harness.cache.store.controlPresets.list()).items[0];
  expect(saved.controls).toHaveLength(6);
  expect(saved.controls.every((control) => control.applyToEdit === false)).toBe(
    true,
  );
  const appearance = () =>
    screen.getByRole('textbox', { name: 'Appearance change' });
  const identityApply = () =>
    screen.getByRole('button', { name: 'Apply Preserve identity to edit' });
  const appearanceApply = () =>
    screen.getByRole('button', { name: 'Apply Appearance change to edit' });
  fireEvent.change(appearance(), { target: { value: 'Warm reflected light' } });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Facial features' }));
  fireEvent.click(identityApply());
  openPresets();
  fireEvent.click(menuItem(/Manage presets/));
  const dialog = await screen.findByRole('dialog', { name: 'Presets' });
  fireEvent.click(
    within(dialog).getByRole('button', {
      name: 'Actions for preset Edit choices',
    }),
  );
  fireEvent.click(
    screen.getByRole('menuitem', { name: 'Replace with current values…' }),
  );
  const confirm = within(dialog).getByRole('group', {
    name: 'Replace Edit choices',
  });
  fireEvent.click(within(confirm).getByRole('button', { name: 'Replace' }));
  await waitFor(async () => {
    saved = (await harness.cache.store.controlPresets.list()).items[0];
    expect(
      saved.controls.find((control) => control.id === 'edit-appearance-v1')
        .value,
    ).toBe('Warm reflected light');
  });
  expect(
    saved.controls.find((control) => control.id === 'edit-appearance-v1')
      .applyToEdit,
  ).toBe(true);
  expect(
    saved.controls.find((control) => control.id === 'edit-identity-v1')
      .applyToEdit,
  ).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Close presets' }));
  fireEvent.change(appearance(), { target: { value: 'Cool light' } });
  fireEvent.click(appearanceApply());
  openPresets();
  fireEvent.click(menuItem('Apply Edit choices'));
  expect(appearance().value).toBe('Warm reflected light');
  expect(appearanceApply().getAttribute('aria-pressed')).toBe('true');
  expect(identityApply().getAttribute('aria-pressed')).toBe('false');
  undo();
  expect(appearance().value).toBe('Cool light');
  expect(appearanceApply().getAttribute('aria-pressed')).toBe('false');
});
