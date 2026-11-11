import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import Gallery from './Gallery.jsx';
import { SOURCE } from '../../data/storage/cachePolicy.js';
import { sizedRecord } from '../../../tests/helpers/testSupport.js';
const studioFor = (prompt = 'Same title') => ({
  source: SOURCE.PRIVATE,
  images: {
    items: [
      sizedRecord('one', 600, 400, {
        title: 'Same title',
        original_prompt: prompt,
      }),
    ],
    status: 'ready',
    error: null,
  },
  reloadImages: vi.fn(),
  discovery: { capabilities: { data: {} } },
  watermark: { visible: false, settings: null, setVisible: vi.fn() },
});
beforeEach(() => {
  localStorage.clear();
});
afterEach(cleanup);
test('only exactly matching title and prompt are suppressed', async () => {
  const view = render(<Gallery studio={studioFor()} />);
  const meta = await screen.findByRole('complementary', {
    name: 'Image details',
  });
  expect(within(meta).getAllByText('Same title')).toHaveLength(1);
  view.rerender(<Gallery studio={studioFor('Same title, original detail')} />);
  await waitFor(() =>
    expect(within(meta).getByText('Same title, original detail')).toBeTruthy(),
  );
  view.rerender(<Gallery studio={studioFor('same title')} />);
  await waitFor(() =>
    expect(within(meta).getByText('same title')).toBeTruthy(),
  );
});
test('help is focusable and dismissible without hiding Gallery, and Hide UI removes its trigger', async () => {
  render(<Gallery studio={studioFor()} />);
  const trigger = await screen.findByRole('button', {
    name: 'Keyboard shortcuts',
  });
  fireEvent.focus(trigger);
  let panel = screen.getByRole('dialog', { name: 'Keyboard shortcuts' });
  expect(panel.tabIndex).toBe(-1);
  expect(panel.textContent).toContain('Show or hide carousel');
  fireEvent.keyDown(trigger, { key: 'Escape' });
  expect(
    screen.queryByRole('dialog', { name: 'Keyboard shortcuts' }),
  ).toBeNull();
  expect(document.querySelector('.gallery').dataset.chrome).toBe('shown');
  fireEvent.click(trigger);
  expect(
    screen.getByRole('dialog', { name: 'Keyboard shortcuts' }),
  ).toBeTruthy();
  fireEvent.click(trigger);
  expect(
    screen.queryByRole('dialog', { name: 'Keyboard shortcuts' }),
  ).toBeNull();
  fireEvent.click(trigger);
  fireEvent.pointerDown(document.body);
  expect(
    screen.queryByRole('dialog', { name: 'Keyboard shortcuts' }),
  ).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /^Hide controls/ }));
  expect(
    screen.queryByRole('button', { name: 'Keyboard shortcuts' }),
  ).toBeNull();
  expect(screen.queryByRole('button', { name: 'Show controls' })).toBeNull();
  expect(document.activeElement).toBe(document.querySelector('.gallery-stage'));
});

test('losing the library while hidden restores the header and leaves recovery clicks usable', async () => {
  const hidden = vi.fn();
  const studio = studioFor();
  const view = render(<Gallery studio={studio} onUiHidden={hidden} />);
  fireEvent.click(
    await screen.findByRole('button', { name: /^Hide controls/ }),
  );
  expect(hidden).toHaveBeenLastCalledWith(true);
  const failed = {
    ...studio,
    images: { items: [], status: 'error', error: 'Read failed' },
  };
  view.rerender(<Gallery studio={failed} onUiHidden={hidden} />);
  expect(hidden).toHaveBeenLastCalledWith(false);
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(studio.reloadImages).toHaveBeenCalledTimes(2);
  view.rerender(<Gallery studio={studio} onUiHidden={hidden} />);
  expect(document.querySelector('.gallery').dataset.chrome).toBe('shown');
});
