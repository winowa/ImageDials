import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import Library from './Library.jsx';
import { SOURCE } from '../../data/storage/cachePolicy.js';
import { libraryRecord } from '../../../tests/helpers/testSupport.js';

let width;
let observers;
const records = Array.from({ length: 30 }, (_, i) =>
  libraryRecord({
    id: `r${i}`,
    title: `Card ${i}`,
    original_prompt: i ? 'Other' : 'Needle',
  }),
);
const studioFor = (items = records, paged = false) => ({
  source: SOURCE.SHARED,
  images: {
    items,
    status: 'ready',
    error: null,
    paged,
    onFirstPage: true,
    imported: [],
    window: {
      binding: { q: '', limit: 24 },
      pages: [
        {
          images: items,
          count: items.length,
          total: items.length,
          position: 0,
        },
      ],
      activeIndex: 0,
      pending: null,
      error: null,
    },
  },
  reloadImages: vi.fn(),
  loadLibraryWindow: vi.fn(),
  loadLibraryRecord: vi.fn(),
  libraryScopeKey: 'test',
  discovery: { capabilities: { data: {} } },
  watermark: {
    visible: false,
    settings: null,
    setVisible: vi.fn(),
    queueAnalysis: vi.fn(),
    backfill: null,
  },
});
beforeEach(() => {
  localStorage.clear();
  width = 1300;
  observers = [];
  document.documentElement.style.fontSize = '16px';
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(
    function () {
      return this.classList.contains('library') ? width : 0;
    },
  );
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback) {
        this.callback = callback;
        observers.push(this);
      }
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(async () => {
  await act(async () => {});
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.documentElement.style.fontSize = '';
});
const resize = (next) =>
  act(() => {
    width = next;
    for (const observer of observers) observer.callback([]);
  });
const columns = () => screen.queryByRole('slider', { name: 'Columns' });

test('measured columns clamp without overwriting preference and recover after rotation and remount', () => {
  localStorage.setItem('imagedials-library-density', '8');
  const studio = studioFor();
  const view = render(<Library studio={studio} />);
  expect(columns().getAttribute('aria-valuetext')).toBe('8 columns');
  resize(780);
  expect(columns().getAttribute('aria-valuetext')).toBe('5 columns');
  expect(
    document.querySelector('.cards').style.getPropertyValue('--density'),
  ).toBe('5');
  resize(350);
  expect(columns()).toBeNull();
  expect(localStorage.getItem('imagedials-library-density')).toBe('8');
  resize(1300);
  expect(columns().getAttribute('aria-valuetext')).toBe('8 columns');
  view.unmount();
  render(<Library studio={studio} />);
  expect(columns().getAttribute('aria-valuetext')).toBe('8 columns');
  expect(studio.watermark.queueAnalysis).not.toHaveBeenCalled();
});

test('a disappearing focused column slider hands focus to Search, retaining query', () => {
  render(<Library studio={studioFor()} />);
  const search = screen.getByRole('searchbox');
  fireEvent.change(search, { target: { value: 'Needle' } });
  columns().focus();
  resize(300);
  expect(columns()).toBeNull();
  expect(document.activeElement).toBe(search);
  expect(search.value).toBe('Needle');
  resize(1300);
  expect(document.activeElement).toBe(search);
});

test('counts use singular and result-wide watermark scope even across local pages', () => {
  const view = render(<Library studio={studioFor([records[0]])} />);
  expect(screen.getByText('1 image')).toBeTruthy();
  expect(screen.getByText('Watermark check: 0 of 1 in results')).toBeTruthy();
  view.rerender(<Library studio={studioFor()} />);
  expect(screen.getByText('30 images')).toBeTruthy();
  expect(screen.getByText('Watermark check: 0 of 30 in results')).toBeTruthy();
  fireEvent.change(screen.getByRole('searchbox'), {
    target: { value: 'Needle' },
  });
  expect(screen.getByText('1 of 30 images')).toBeTruthy();
  expect(screen.getByText('Watermark check: 0 of 1 in results')).toBeTruthy();
});

test('bounded pages label only the analyzed records on that page', () => {
  const studio = studioFor([records[0]], true);
  studio.images.window.pages[0].total = 50;
  render(<Library studio={studio} />);
  expect(screen.getByText('50 images')).toBeTruthy();
  expect(screen.getByText('Watermark check: 0 of 1 on this page')).toBeTruthy();
});
