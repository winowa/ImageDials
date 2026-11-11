import React from 'react';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import SettingsPanel from './SettingsPanel.jsx';
import {
  usePreference,
  writePreference,
  resetPreferenceMemory,
} from '../../shared/browser/preferences.js';

const defaults = {
  providers: { IMAGE_PROVIDER: 'mock', IMAGE_MODEL_NAME: 'fixture-model' },
  keys_configured: {},
  editing: { route: 'generation', routes: ['generation', 'separate'] },
};
const settings = (data = defaults) => ({
  overrides: {},
  defaults: { status: 'ready', data },
  loadDefaults: vi.fn(),
  save: vi.fn(() => ({ persisted: true })),
  storageAvailable: true,
});
const show = (config = settings()) => {
  const close = vi.fn();
  render(<SettingsPanel settings={config} onClose={close} />);
  return { config, close };
};
const tab = (name) => fireEvent.click(screen.getByRole('tab', { name }));
beforeEach(() => {
  localStorage.clear();
  resetPreferenceMemory();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test('tabs have roving keyboard focus, linked panels, wrap, Home and End', () => {
  show();
  const tabs = screen.getAllByRole('tab');
  tabs[0].focus();
  for (let i = 1; i <= tabs.length; i++) {
    fireEvent.keyDown(document.activeElement, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(tabs[i % tabs.length]);
    const panel = screen.getByRole('tabpanel');
    expect(panel.id).toBe(document.activeElement.getAttribute('aria-controls'));
    expect(panel.getAttribute('aria-labelledby')).toBe(
      document.activeElement.id,
    );
  }
  fireEvent.keyDown(document.activeElement, { key: 'End' });
  expect(document.activeElement).toBe(tabs.at(-1));
  fireEvent.keyDown(document.activeElement, { key: 'Home' });
  fireEvent.keyDown(document.activeElement, { key: 'ArrowLeft' });
  expect(document.activeElement).toBe(tabs.at(-1));
  expect(tabs.filter((node) => node.tabIndex === 0)).toHaveLength(1);
});

test('Save selects the tab containing invalid input and focuses it without committing', async () => {
  const { config } = show();
  fireEvent.change(
    within(screen.getByRole('tabpanel')).getByLabelText(/^Endpoint/),
    {
      target: { value: 'invalid' },
    },
  );
  tab('Browsing');
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() =>
    expect(document.activeElement.name).toBe('LLM_MODEL_ENDPOINT_1'),
  );
  expect(
    screen.getByRole('tab', { name: 'Language' }).getAttribute('aria-selected'),
  ).toBe('true');
  expect(config.save).not.toHaveBeenCalled();
});

test('separate editing values survive same-as switching and old servers offer no unsupported route', () => {
  const { config } = show();
  tab('Editing');
  fireEvent.change(screen.getByLabelText('Editing provider'), {
    target: { value: 'separate' },
  });
  fireEvent.change(
    within(screen.getByRole('tabpanel')).getByLabelText(/^Endpoint/),
    {
      target: { value: 'https://edit.example.invalid' },
    },
  );
  fireEvent.change(
    within(screen.getByRole('tabpanel')).getByLabelText(/^API key/),
    {
      target: { value: 'browser-edit-key' },
    },
  );
  fireEvent.change(screen.getByLabelText('Editing provider'), {
    target: { value: 'generation' },
  });
  fireEvent.change(screen.getByLabelText('Editing provider'), {
    target: { value: 'separate' },
  });
  expect(
    within(screen.getByRole('tabpanel')).getByLabelText(/^API key/).value,
  ).toBe('browser-edit-key');
  expect(
    within(screen.getByRole('tabpanel')).getByLabelText(/^API key/).type,
  ).toBe('password');
  fireEvent.change(screen.getByLabelText('Editing provider'), {
    target: { value: 'generation' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(config.save).toHaveBeenCalledWith({
    IMAGE_EDIT_ROUTE: 'generation',
    IMAGE_EDIT_MODEL_ENDPOINT: 'https://edit.example.invalid',
    IMAGE_EDIT_MODEL_KEY: 'browser-edit-key',
  });
  cleanup();
  show({
    ...settings(),
    defaults: { status: 'ready', data: { ...defaults, editing: undefined } },
  });
  tab('Editing');
  expect(screen.queryByLabelText('Editing provider')).toBeNull();
  expect(screen.getByText(/does not support a separate/)).toBeTruthy();
});

function MountedPreferences() {
  const [tour] = usePreference('show-tour', false, (value) => value === true);
  const [size] = usePreference('library-page-size', 24);
  return (
    <output aria-label="Mounted preferences">
      {String(tour)}:{size}
    </output>
  );
}

test('tour defaults off; Cancel and outside discard, Save updates mounted views, reload and save off', () => {
  render(<MountedPreferences />);
  show();
  tab('Browsing');
  const tour = screen.getByRole('checkbox', { name: 'Show tour button' });
  expect(tour.checked).toBe(false);
  fireEvent.click(tour);
  fireEvent.change(screen.getByLabelText('Images per page'), {
    target: { value: '48' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(localStorage.getItem('imagedials-show-tour')).toBeNull();
  expect(screen.getByLabelText('Mounted preferences').textContent).toBe(
    'false:24',
  );
  cleanup();
  render(<MountedPreferences />);
  show();
  tab('Browsing');
  fireEvent.click(screen.getByRole('checkbox', { name: 'Show tour button' }));
  fireEvent.change(screen.getByLabelText('Images per page'), {
    target: { value: '48' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(screen.getByLabelText('Mounted preferences').textContent).toBe(
    'true:48',
  );
  cleanup();
  show();
  tab('Browsing');
  expect(
    screen.getByRole('checkbox', { name: 'Show tour button' }).checked,
  ).toBe(true);
  fireEvent.click(screen.getByRole('checkbox', { name: 'Show tour button' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(localStorage.getItem('imagedials-show-tour')).toBe('false');
});

test('same-window and cross-tab preferences synchronize with sanitized values, even with denied storage', () => {
  render(<MountedPreferences />);
  fireEvent(
    window,
    new StorageEvent('storage', {
      key: 'imagedials-show-tour',
      newValue: 'true',
    }),
  );
  expect(screen.getByLabelText('Mounted preferences').textContent).toBe(
    'false:24',
  );
  localStorage.setItem('imagedials-show-tour', 'true');
  fireEvent(
    window,
    new StorageEvent('storage', {
      key: 'imagedials-show-tour',
      newValue: 'true',
    }),
  );
  expect(screen.getByLabelText('Mounted preferences').textContent).toBe(
    'true:24',
  );
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw Error('denied');
  });
  // writePreference dispatches a real same-window event; wrap it in fireEvent's act.
  const button = document.createElement('button');
  button.onclick = () => writePreference('show-tour', false);
  document.body.append(button);
  fireEvent.click(button);
  button.remove();
  expect(screen.getByLabelText('Mounted preferences').textContent).toBe(
    'false:24',
  );
});

test('Escape and an outside pointer discard provider and preference drafts', () => {
  for (const dismiss of ['escape', 'outside']) {
    const { config, close } = show();
    tab('Browsing');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show tour button' }));
    tab('Language');
    fireEvent.change(
      within(screen.getByRole('tabpanel')).getByLabelText(/^Model name/),
      { target: { value: 'discarded-model' } },
    );
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    if (dismiss === 'escape') fireEvent.keyDown(dialog, { key: 'Escape' });
    else fireEvent.pointerDown(dialog.parentElement);
    expect(close).toHaveBeenCalledOnce();
    expect(config.save).not.toHaveBeenCalled();
    expect(localStorage.getItem('imagedials-show-tour')).toBeNull();
    cleanup();
  }
});
