import { openStandardControls } from '../helpers/controlUiTestSupport.js';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import App from '../../src/app/App.jsx';
import { fakeLibrary, fixtures, installApi } from '../helpers/testSupport.js';

vi.mock('../../src/features/controls/standardRandom.js', async (original) => ({
  ...(await original()),
  randomizeStandard: (entries) => entries,
}));

const jobPolicy = { pollIntervalMs: 1, maxConsecutivePollFailures: 3 };

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  localStorage.clear();
  const library = fakeLibrary();
  installApi({
    'GET /healthz': () => fixtures.m1.health,
    'GET /api/controls/static?generation_mode=standard': () =>
      fixtures.m1.static_standard,
    ...library.routes,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test('prompt typing coalesces and draft menu plus shortcuts undo and redo it', async () => {
  render(<App jobPolicy={jobPolicy} />);
  const prompt = await screen.findByLabelText('Image idea');
  await openStandardControls();
  fireEvent.change(prompt, { target: { value: 'Amber' } });
  fireEvent.change(prompt, { target: { value: 'Amber bird' } });
  await waitFor(() => expect(prompt.value).toBe('Amber bird'));

  fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
  await waitFor(() => expect(prompt.value).toBe(''));
  fireEvent.keyDown(document.body, { key: 'y', ctrlKey: true });
  await waitFor(() => expect(prompt.value).toBe('Amber bird'));

  fireEvent.click(screen.getByRole('button', { name: 'Draft actions' }));
  const menu = screen.getByRole('menu', { name: 'Draft actions' });
  fireEvent.click(
    within(menu).getByRole('menuitem', { name: /Undo edit prompt/i }),
  );
  await waitFor(() => expect(prompt.value).toBe(''));
  fireEvent.click(screen.getByRole('button', { name: 'Draft actions' }));
  fireEvent.click(
    within(screen.getByRole('menu', { name: 'Draft actions' })).getByRole(
      'menuitem',
      {
        name: /Redo edit prompt/i,
      },
    ),
  );
  await waitFor(() => expect(prompt.value).toBe('Amber bird'));
});

test('aspect and mode changes are draft transactions', async () => {
  render(<App jobPolicy={jobPolicy} />);
  await openStandardControls();
  const landscape = screen.getByRole('radio', { name: '3:2' });
  const square = screen.getByRole('radio', { name: '1:1' });
  fireEvent.click(square);
  expect(square.checked).toBe(true);
  fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
  await waitFor(() => expect(landscape.checked).toBe(true));
  fireEvent.keyDown(document.body, { key: 'y', ctrlKey: true });
  await waitFor(() => expect(square.checked).toBe(true));

  const mode = screen.getByRole('radio', { name: 'Asset image for 3D' });
  fireEvent.click(mode);
  await waitFor(() => expect(mode.checked).toBe(true));
  fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
  await waitFor(() => expect(mode.checked).toBe(false));
  expect(screen.getByRole('radio', { name: 'Text to image' }).checked).toBe(
    true,
  );
});
