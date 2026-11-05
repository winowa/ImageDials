import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import App from './App.jsx';
import Gallery, { galleryCanRearmLoadedPicture } from './Gallery.jsx';
import { SOURCE } from './cachePolicy.js';
import gallerySessions from '../../fixtures/api/gallery-sessions.json';
import { SESSION_PREVIEW_POLL_INITIAL_MS } from './useGallerySession.js';
import {
  FakeEventSource,
  fakeLibrary,
  fixtures,
  installApi,
  respond,
  sizedRecord,
  withBoundedGallery,
} from './testSupport.js';
import { validGalleryPreview } from './useGallerySession.js';

const { m1 } = fixtures;
const READ = /^GET \/api\/images\/library\/shuffle-sessions\/([^/?]+)\?/;
const settle = async () => {
  for (let i = 0; i < 5; i += 1) await act(() => Promise.resolve());
};

test('legacy private Gallery data without session readiness may re-arm retained pixels', () => {
  expect(galleryCanRearmLoadedPicture(undefined)).toBe(true);
  expect(galleryCanRearmLoadedPicture(true)).toBe(true);
  expect(galleryCanRearmLoadedPicture(false)).toBe(false);
});

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('imagedials-gallery-effect', '"instant"');
  localStorage.setItem('imagedials-gallery-playing', 'true');
  FakeEventSource.reset();
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'Date',
    ],
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('validates the optional compact preview and ignores malformed or local records', () => {
  const canonicalPreview = gallerySessions.building_preview.response.preview;
  expect(validGalleryPreview(canonicalPreview)).toMatchObject(
    canonicalPreview.image,
  );
  expect(validGalleryPreview({ image: { id: 'one' } })).toBeNull();
  expect(
    validGalleryPreview({ snapshot_revision: 4, image: { id: 3 } }),
  ).toBeNull();
  expect(
    validGalleryPreview({
      snapshot_revision: 4,
      image: { id: 'one', visibility: 'private' },
    }),
  ).toBeNull();
  expect(
    validGalleryPreview({
      ...canonicalPreview,
      image: { ...canonicalPreview.image, id: 12 },
    }),
  ).toBeNull();
});

function scriptedGallery(records, answers, { repeatLast = false } = {}) {
  const library = fakeLibrary(records);
  const pending = [...answers];
  const repeated = repeatLast ? answers.at(-1) : undefined;
  const api = installApi({
    ...library.routes,
    match: (key) => {
      const match = READ.exec(key);
      if (!match || (!pending.length && repeated === undefined))
        return library.routes.match(key);
      const answer = pending.length ? pending.shift() : repeated;
      if (typeof answer === 'function') return answer(match[1], library);
      if (answer === 'ready') return library.routes.match(key);
      if (answer === 'failed')
        return () =>
          respond(200, {
            session_id: match[1],
            state: 'failed',
            error: 'The gallery order could not be prepared.',
          });
      return () =>
        respond(202, {
          session_id: match[1],
          state: 'building',
          ...(answer ? { preview: answer } : {}),
        });
    },
  });
  window.history.replaceState(null, '', '/gallery');
  render(
    <App jobPolicy={{ pollIntervalMs: 1, maxConsecutivePollFailures: 3 }} />,
  );
  return { api, library };
}

const previewOf = (library, record) => ({
  snapshot_revision: library.revision(),
  image: library.summaryOf(record),
});

test('shows a building preview, blocks navigation and preload, then adopts the loaded image into the ready order', async () => {
  const records = [
    sizedRecord('one', 1152, 768),
    sizedRecord('two', 1152, 768),
    sizedRecord('three', 1152, 768),
  ];
  const library = fakeLibrary(records);
  let reads = 0;
  const preloadUrls = [];
  vi.stubGlobal(
    'Image',
    class {
      set src(value) {
        preloadUrls.push(value);
      }
    },
  );
  const api = installApi({
    ...library.routes,
    'GET /api/app-capabilities': () => {
      const capabilities = withBoundedGallery(m1.capabilities);
      return capabilities;
    },
    match: (key) => {
      const match = READ.exec(key);
      if (match && reads++ < 3) {
        const held = library.sessions.get(match[1]);
        const candidate = records.find((row) =>
          held.order.includes(`${row.storage_id}/${row.filename}`),
        );
        const firstKey = held.order[0];
        const first = records.find(
          (row) => `${row.storage_id}/${row.filename}` === firstKey,
        );
        return () =>
          respond(202, {
            session_id: match[1],
            state: 'building',
            preview: {
              snapshot_revision: 1,
              image: library.summaryOf(first ?? candidate),
            },
          });
      }
      return library.routes.match(key);
    },
  });
  window.history.replaceState(null, '', '/gallery');
  render(
    <App jobPolicy={{ pollIntervalMs: 1, maxConsecutivePollFailures: 3 }} />,
  );
  await settle();

  const stageImage = document.querySelector('.gallery-stage img');
  expect(stageImage).toBeTruthy();
  const stageTitle = stageImage.closest('.stage-layer').querySelector('img');
  expect(screen.getByText('Preparing image order…').textContent).toMatch(
    /preparing image order/i,
  );
  expect(screen.getByRole('button', { name: 'Next image' }).disabled).toBe(
    true,
  );
  expect(screen.getByRole('button', { name: 'Pause slideshow' }).disabled).toBe(
    true,
  );
  expect(document.querySelectorAll('.strip li')).toHaveLength(0);
  expect(api.calls.some((call) => call.key.includes('/record/'))).toBe(true);

  Object.defineProperty(stageTitle, 'complete', {
    configurable: true,
    value: true,
  });
  Object.defineProperty(stageTitle, 'naturalWidth', {
    configurable: true,
    value: 1152,
  });
  fireEvent.load(stageTitle);
  await settle();
  await act(() => vi.advanceTimersByTimeAsync(SESSION_PREVIEW_POLL_INITIAL_MS));
  await settle();

  expect(document.querySelector('[data-preview="true"] img')).toBe(stageTitle);
  expect(screen.getByRole('button', { name: 'Next image' }).disabled).toBe(
    true,
  );
  expect(preloadUrls).toEqual([]);
  await act(() =>
    vi.advanceTimersByTimeAsync(SESSION_PREVIEW_POLL_INITIAL_MS * 2),
  );
  await settle();
  expect(document.querySelector('[data-preview="true"] img')).toBe(stageTitle);
  expect(screen.getByRole('button', { name: 'Next image' }).disabled).toBe(
    true,
  );
  expect(preloadUrls).toEqual([]);
  expect(document.querySelectorAll('.strip li')).toHaveLength(0);
  await act(() =>
    vi.advanceTimersByTimeAsync(SESSION_PREVIEW_POLL_INITIAL_MS * 4),
  );
  await settle();

  expect(screen.getByRole('button', { name: 'Next image' }).disabled).toBe(
    false,
  );
  expect(document.querySelector('.gallery-stage img')).toBe(stageTitle);
  const requestCount = api.calls.filter((call) =>
    call.key.includes('/file/'),
  ).length;
  await act(() => vi.advanceTimersByTimeAsync(6000));
  await settle();
  expect(api.calls.filter((call) => call.key.includes('/file/')).length).toBe(
    requestCount,
  );
  expect(
    api.calls.filter((call) => READ.test(call.key)).length,
  ).toBeGreaterThan(3);
});

test('a loaded preview has no slideshow clock or preload during a long build', async () => {
  const records = [
    sizedRecord('long-build', 1152, 768),
    sizedRecord('later', 768, 1152),
  ];
  const library = fakeLibrary(records);
  const preloads = [];
  vi.stubGlobal(
    'Image',
    class {
      set src(value) {
        preloads.push(value);
      }
    },
  );
  scriptedGallery(records, [previewOf(library, records[0])], {
    repeatLast: true,
  });
  await settle();
  const image = document.querySelector('[data-preview="true"] img');
  Object.defineProperty(image, 'complete', { configurable: true, value: true });
  Object.defineProperty(image, 'naturalWidth', {
    configurable: true,
    value: 1152,
  });
  fireEvent.load(image);
  await settle();

  await act(() => vi.advanceTimersByTimeAsync(10000));
  await settle();
  expect(document.querySelector('[data-preview="true"] img')).toBe(image);
  expect(screen.getByRole('button', { name: 'Next image' }).disabled).toBe(
    true,
  );
  expect(document.querySelectorAll('.strip li')).toHaveLength(0);
  expect(preloads).toEqual([]);
});

test('a failed candidate is suppressed across repeated 202 responses, then the ranked row can load', async () => {
  const records = [
    sizedRecord('repeat', 1152, 768),
    sizedRecord('other', 1152, 768),
  ];
  const candidate = (sessionId, library) => {
    const key = library.sessions.get(sessionId).order[0];
    const first = records.find(
      (record) => `${record.storage_id}/${record.filename}` === key,
    );
    const response = previewOf(library, first);
    return () =>
      respond(202, {
        session_id: sessionId,
        state: 'building',
        preview: response,
      });
  };
  scriptedGallery(records, [candidate, candidate, candidate, 'ready']);
  await settle();

  const previewLayer = document.querySelector('[data-preview="true"]');
  expect(previewLayer).toBeTruthy();
  fireEvent.error(previewLayer.querySelector('img'));
  await settle();
  expect(document.querySelector('[data-preview="true"]')).toBeNull();

  await act(() => vi.advanceTimersByTimeAsync(700));
  await settle();
  expect(document.querySelector('[data-preview="true"]')).toBeNull();
  expect(screen.getByRole('button', { name: 'Next image' }).disabled).toBe(
    false,
  );
  expect(document.querySelector('.strip li')).toBeTruthy();
  const rankedImage = document.querySelector('.gallery-stage img');
  expect(rankedImage).toBeTruthy();
  Object.defineProperty(rankedImage, 'complete', {
    configurable: true,
    value: true,
  });
  Object.defineProperty(rankedImage, 'naturalWidth', {
    configurable: true,
    value: 1152,
  });
  fireEvent.load(rankedImage);
  await settle();
  await act(() => vi.advanceTimersByTimeAsync(5000));
  await settle();
  expect(screen.getByRole('heading', { name: 'Image other' })).toBeTruthy();
});

test('withdrawn and malformed previews disappear while ready polling continues', async () => {
  const records = [
    sizedRecord('candidate', 1152, 768),
    sizedRecord('ranked', 768, 1152),
  ];
  const library = fakeLibrary(records);
  const first = previewOf(library, records[0]);
  const malformed = {
    ...first,
    image: { ...first.image, id: 77 },
  };
  scriptedGallery(records, [first, malformed, null, 'ready']);
  await settle();
  expect(document.querySelector('[data-preview="true"]')).toBeTruthy();

  await act(() => vi.advanceTimersByTimeAsync(100));
  await settle();
  expect(document.querySelector('[data-preview="true"]')).toBeNull();
  expect(screen.getByText('Preparing image order…')).toBeTruthy();

  await act(() => vi.advanceTimersByTimeAsync(200));
  await settle();
  expect(document.querySelector('[data-preview="true"]')).toBeNull();
  await act(() => vi.advanceTimersByTimeAsync(400));
  await settle();
  expect(screen.getByRole('button', { name: 'Next image' }).disabled).toBe(
    false,
  );
});

test('a different candidate replaces the first, and a failed session offers Retry', async () => {
  const records = [
    sizedRecord('first-preview', 1152, 768),
    sizedRecord('second-preview', 768, 1152),
  ];
  const library = fakeLibrary(records);
  scriptedGallery(records, [
    previewOf(library, records[0]),
    previewOf(library, records[1]),
    'failed',
  ]);
  await settle();
  const firstSrc = document.querySelector('[data-preview="true"] img').src;

  await act(() => vi.advanceTimersByTimeAsync(100));
  await settle();
  const changed = document.querySelector('[data-preview="true"] img');
  expect(changed).toBeTruthy();
  expect(changed.src).not.toBe(firstSrc);

  await act(() => vi.advanceTimersByTimeAsync(200));
  await settle();
  expect(screen.getByRole('alert').textContent).toMatch(
    /could not be prepared/i,
  );
  expect(document.querySelector('[data-preview="true"]')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await settle();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByRole('button', { name: 'Next image' }).disabled).toBe(
    false,
  );
});

test('a late preview from an abandoned filter session is ignored', async () => {
  const records = [
    sizedRecord('landscape-preview', 1152, 768),
    sizedRecord('portrait-ready', 768, 1152),
  ];
  const library = fakeLibrary(records);
  let releaseLate;
  const lateAnswer = (sessionId, fake) => () =>
    new Promise((resolve) => {
      releaseLate = () =>
        resolve(
          respond(202, {
            session_id: sessionId,
            state: 'building',
            preview: previewOf(fake, records[0]),
          }),
        );
    });
  scriptedGallery(records, [
    previewOf(library, records[0]),
    lateAnswer,
    'ready',
  ]);
  await settle();
  await act(() => vi.advanceTimersByTimeAsync(100));
  await settle();
  expect(releaseLate).toBeTypeOf('function');
  const panel = screen.getByRole('region', { name: 'Gallery controls' });
  fireEvent.click(screen.getByRole('checkbox', { name: /^Landscape/ }));
  await settle();
  expect(document.querySelector('[data-preview="true"]')).toBeNull();
  expect(
    screen.getByRole('heading', { name: 'Image portrait-ready' }),
  ).toBeTruthy();

  await act(async () => releaseLate());
  await settle();
  expect(document.querySelector('[data-preview="true"]')).toBeNull();
  expect(
    screen.getByRole('heading', { name: 'Image portrait-ready' }),
  ).toBeTruthy();
  expect(panel).toBeTruthy();
});

test('reduced motion keeps preview loading and adoption instantaneous', async () => {
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }));
  localStorage.setItem('imagedials-gallery-effect', '"fade"');
  const records = [
    sizedRecord('reduced', 1152, 768),
    sizedRecord('next', 768, 1152),
  ];
  const library = fakeLibrary(records);
  scriptedGallery(records, [previewOf(library, records[0]), 'ready']);
  await settle();

  const image = document.querySelector('[data-preview="true"] img');
  expect(image).toBeTruthy();
  Object.defineProperty(image, 'complete', { configurable: true, value: true });
  Object.defineProperty(image, 'naturalWidth', {
    configurable: true,
    value: 1152,
  });
  fireEvent.load(image);
  await settle();
  expect(
    document.querySelector('.gallery-stage').dataset.effects,
  ).toBeUndefined();
  expect(screen.getByRole('button', { name: 'Next image' }).disabled).toBe(
    true,
  );

  await act(() => vi.advanceTimersByTimeAsync(SESSION_PREVIEW_POLL_INITIAL_MS));
  await settle();
  expect(
    document.querySelector('.gallery-stage').dataset.effects,
  ).toBeUndefined();
  expect(screen.getByRole('button', { name: 'Next image' }).disabled).toBe(
    false,
  );
});

test('private thumbnails remain selectable and retained pixels re-arm after an interrupted A to B to A retarget', async () => {
  localStorage.setItem('imagedials-gallery-effect', '"fade"');
  const records = [
    sizedRecord('retained-a', 1152, 768),
    sizedRecord('loading-b', 768, 1152),
    sizedRecord('later-c', 1024, 1024),
  ];
  render(
    <Gallery
      seed={11}
      studio={{
        source: SOURCE.PRIVATE,
        images: { items: records, status: 'ready' },
        reloadImages: vi.fn(),
        watermark: { visible: false, setVisible: vi.fn(), settings: null },
      }}
    />,
  );
  await settle();

  const currentButton = document.querySelector('.strip [aria-current="true"]');
  expect(
    [...document.querySelectorAll('.strip button')].every(
      (button) => !button.disabled,
    ),
  ).toBe(true);
  const imageA = currentButton.getAttribute('aria-label');
  const imageB = [...document.querySelectorAll('.strip button')]
    .map((button) => button.getAttribute('aria-label'))
    .find((label) => label !== imageA);
  const load = (image) => {
    Object.defineProperty(image, 'complete', {
      configurable: true,
      value: true,
    });
    Object.defineProperty(image, 'naturalWidth', {
      configurable: true,
      value: 1152,
    });
    fireEvent.load(image);
  };
  const retainedA = [...document.querySelectorAll('.gallery-stage img')].find(
    (image) => image.alt === imageA,
  );
  expect(retainedA).toBeTruthy();
  load(retainedA);
  await settle();

  fireEvent.click(screen.getByRole('button', { name: imageB }));
  const loadingB = [...document.querySelectorAll('.gallery-stage img')].find(
    (image) => image.alt === imageB,
  );
  expect(loadingB).toBeTruthy();
  load(loadingB);
  await settle();
  expect(document.querySelector('.gallery-stage').dataset.effects).toBe('fade');

  fireEvent.click(screen.getByRole('button', { name: imageA }));
  await settle();
  const returnedA = [...document.querySelectorAll('.gallery-stage img')].find(
    (image) => image.alt === imageA,
  );
  expect(returnedA).toBe(retainedA);
  await act(() => vi.advanceTimersByTimeAsync(600));
  await settle();
  expect(document.querySelector('.strip [aria-current="true"]').ariaLabel).toBe(
    imageA,
  );

  await act(() => vi.advanceTimersByTimeAsync(5000));
  await settle();
  expect(
    document.querySelector('.strip [aria-current="true"]').ariaLabel,
  ).not.toBe(imageA);
});
