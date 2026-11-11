import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import App from '../../src/app/App.jsx';
import {
  fakeLibrary,
  installApi,
  libraryRecord,
} from '../helpers/testSupport.js';

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function app(records = []) {
  installApi(fakeLibrary(records).routes);
  return render(<App />);
}

test('the first link skips to the prompt only on activation; navigation does not focus content', async () => {
  app();
  const prompt = await screen.findByLabelText('Image idea');
  const skip = screen.getByRole('link', { name: 'Skip to prompt' });
  expect(document.querySelector('a')).toBe(skip);
  expect(skip.getAttribute('href')).toBe('#prompt');
  act(() => skip.focus());
  expect(document.activeElement).toBe(skip);
  fireEvent.click(skip);
  expect(document.activeElement).toBe(prompt);
  for (const label of ['Gallery', 'Library']) {
    const route = screen.getByRole('link', { name: label });
    act(() => route.focus());
    fireEvent.click(route);
    expect(document.activeElement).toBe(route);
    const skipContent = screen.getByRole('link', { name: 'Skip to content' });
    expect(skipContent.getAttribute('href')).toBe('#main-content');
    fireEvent.click(skipContent);
    const main = screen.getByRole('main');
    expect(main.id).toBe('main-content');
    expect(main.tabIndex).toBe(-1);
    expect(document.activeElement).toBe(main);
  }
});

test('Gallery Hide UI removes the skip link as well as the header from interaction', async () => {
  app([libraryRecord()]);
  fireEvent.click(screen.getByRole('link', { name: 'Gallery' }));
  fireEvent.click(
    await screen.findByRole('button', { name: /^Hide controls/ }),
  );
  const skip = document.querySelector('.skip-link');
  expect(skip.hasAttribute('inert')).toBe(true);
  expect(document.querySelector('.app-header').hasAttribute('inert')).toBe(
    true,
  );
  expect(document.activeElement).toBe(document.querySelector('.gallery-stage'));
  // A tap on the skip link while hidden reveals instead of following it.
  expect(fireEvent.click(skip)).toBe(false);
  expect(skip.hasAttribute('inert')).toBe(false);
  expect(document.activeElement).toBe(
    screen.getByRole('button', { name: /^Hide controls/ }),
  );
});
