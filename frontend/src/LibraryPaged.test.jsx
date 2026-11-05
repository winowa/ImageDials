import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import libraryPages from '../../fixtures/api/library-pages.json';
import Library from './Library.jsx';
import { SOURCE } from './cachePolicy.js';
import { MediaContext } from './variantSrc.js';

const summary = libraryPages.first.response.images[0];
const firstPage = { ...libraryPages.first.response, images: [summary] };
const windowFor = (overrides = {}) => ({
  binding: {
    q: '',
    orientation: null,
    eventName: null,
    order: 'newest',
    limit: 24,
  },
  pages: [firstPage],
  activeIndex: 0,
  revision: firstPage.revision,
  pending: null,
  error: null,
  ...overrides,
});
const studioFor = (window, overrides = {}) => ({
  source: SOURCE.SHARED,
  images: { items: [], status: 'ready', error: null },
  libraryImages: {
    items: window.pages[0]?.images ?? [],
    status: 'ready',
    paged: true,
    window,
    onFirstPage: true,
    imported: [],
  },
  libraryWindow: window,
  libraryScopeKey: 'scope',
  loadLibraryWindow: vi.fn(),
  loadLibraryRecord: vi.fn(() => new Promise(() => {})),
  reloadImages: vi.fn(),
  removeImage: vi.fn(),
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
    inspect: vi.fn(() => Promise.resolve(null)),
    setVisible: vi.fn(),
    queueAnalysis: vi.fn(),
  },
  ...overrides,
});
const library = (studio) => (
  <MediaContext.Provider value={null}>
    <Library studio={studio} onEdit={vi.fn()} />
  </MediaContext.Provider>
);
const searchBox = () => screen.getByRole('searchbox');

test('typing keeps the field focused and busy prior rows; a no-match result keeps the field', async () => {
  const { rerender } = render(library(studioFor(windowFor())));
  const input = searchBox();
  input.focus();
  fireEvent.change(input, { target: { value: 'zebra' } });
  // The window still describes the old query: old rows stay, but busy.
  expect(searchBox()).toBe(input);
  expect(document.activeElement).toBe(input);
  const cards = document.querySelector('.cards');
  expect(cards.getAttribute('aria-busy')).toBe('true');
  expect(screen.getByText('Loading…')).toBeTruthy();
  expect(screen.queryByText(/images$/)).toBeNull();
  expect(
    screen.queryByRole('navigation', { name: 'Library pages' }),
  ).toBeNull();

  const binding = { ...windowFor().binding, q: 'zebra' };
  rerender(
    library(studioFor(windowFor({ binding, pages: [], activeIndex: -1 }))),
  );
  expect(document.querySelector('.cards').getAttribute('aria-busy')).toBe(
    'true',
  );

  const none = { ...firstPage, images: [], count: 0, total: 0 };
  rerender(library(studioFor(windowFor({ binding, pages: [none] }))));
  expect(searchBox()).toBe(input);
  expect(document.activeElement).toBe(input);
  expect(document.querySelector('.cards')).toBeNull();
  expect(screen.getByText(/No saved images match/)).toBeTruthy();
});

test('a failed new search shows its error with the field and never old rows as results', () => {
  const { rerender } = render(library(studioFor(windowFor())));
  const input = searchBox();
  fireEvent.change(input, { target: { value: 'zebra' } });
  const binding = { ...windowFor().binding, q: 'zebra' };
  rerender(
    library(
      studioFor(
        windowFor({
          binding,
          pages: [],
          activeIndex: -1,
          error: new Error('offline'),
        }),
      ),
    ),
  );
  expect(searchBox()).toBe(input);
  expect(document.querySelector('.cards')).toBeNull();
  expect(screen.getByRole('alert').textContent).toContain('offline');
  expect(screen.getByRole('alert').textContent).not.toContain('out of date');
});

test('an empty library still reports itself once nothing is held', () => {
  const none = { ...firstPage, images: [], count: 0, total: 0 };
  render(library(studioFor(windowFor({ pages: [none] }))));
  expect(screen.getByText('No saved images yet.')).toBeTruthy();
});

test('the detail dialog keeps one close control and its focus while bytes arrive', async () => {
  let resolveDetail;
  const loadLibraryRecord = vi.fn(
    () =>
      new Promise((resolve) => {
        resolveDetail = resolve;
      }),
  );
  render(library(studioFor(windowFor(), { loadLibraryRecord })));
  fireEvent.click(screen.getByRole('button', { name: /Ceramic vessel 2/ }));
  const close = screen.getByRole('button', { name: 'Close details' });
  close.focus();
  expect(document.activeElement).toBe(close);
  await act(async () => resolveDetail(libraryPages.detail));
  await screen.findByRole('button', { name: 'Edit in generator' });
  expect(screen.getByRole('button', { name: 'Close details' })).toBe(close);
  expect(document.activeElement).toBe(close);
});

test('an analysis result for the open image reaches its dialog', async () => {
  const loadLibraryRecord = vi.fn(async () => libraryPages.detail);
  const window = windowFor();
  const { rerender } = render(
    library(studioFor(window, { loadLibraryRecord })),
  );
  fireEvent.click(screen.getByRole('button', { name: /Ceramic vessel 2/ }));
  await screen.findByRole('button', { name: 'Edit in generator' });
  const updated = { ...libraryPages.detail, title: 'Analyzed title' };
  rerender(
    library(
      studioFor(window, { loadLibraryRecord, libraryReplacedRecord: updated }),
    ),
  );
  expect(
    await screen.findByRole('dialog', { name: /Ceramic vessel 2/ }),
  ).toBeTruthy();
  await waitFor(() =>
    expect(document.querySelector('.dialog').textContent).toContain(
      'Analyzed title',
    ),
  );
});

test('paged Library loads exact detail before exposing edit and delete actions', async () => {
  let resolveDetail;
  const detailPending = new Promise((resolve) => {
    resolveDetail = resolve;
  });
  const loadLibraryRecord = vi.fn(() => detailPending);
  const page = {
    ...libraryPages.first.response,
    images: [summary],
  };
  const window = {
    binding: {
      q: '',
      orientation: null,
      eventName: null,
      order: 'newest',
      limit: 24,
    },
    pages: [page],
    activeIndex: 0,
    revision: page.revision,
    pending: null,
    error: null,
  };
  const studio = {
    source: SOURCE.SHARED,
    images: { items: [], status: 'ready', error: null },
    libraryImages: {
      items: [summary],
      status: 'ready',
      paged: true,
      window,
      onFirstPage: true,
      imported: [],
    },
    libraryWindow: window,
    libraryScopeKey: 'scope',
    loadLibraryWindow: vi.fn(),
    loadLibraryRecord,
    reloadImages: vi.fn(),
    removeImage: vi.fn(),
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
      inspect: vi.fn(() => Promise.resolve(null)),
      setVisible: vi.fn(),
      queueAnalysis: vi.fn(),
    },
  };
  render(
    <MediaContext.Provider value={null}>
      <Library studio={studio} onEdit={vi.fn()} />
    </MediaContext.Provider>,
  );

  fireEvent.click(screen.getByRole('button', { name: /Ceramic vessel 2/ }));
  expect(loadLibraryRecord).toHaveBeenCalledWith(
    summary,
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(screen.getByText('Loading image details…')).toBeTruthy();
  expect(
    screen.queryByRole('button', { name: 'Edit in generator' }),
  ).toBeNull();

  resolveDetail(libraryPages.detail);
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Edit in generator' }),
    ).toBeTruthy(),
  );
  expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy();
});
