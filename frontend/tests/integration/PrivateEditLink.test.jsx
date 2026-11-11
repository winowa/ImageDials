import { openStandardControls } from '../helpers/controlUiTestSupport.js';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import App from '../../src/app/App.jsx';
import { DEFAULT_CLIENT_POLICY } from '../../src/data/api/clientPolicy.js';
import { createCacheStore } from '../../src/data/storage/cacheStore.js';
import { memoryDb } from '../helpers/cacheTestSupport.js';
import { editTarget, hrefFor, ROUTE } from '../../src/app/routes.js';
import {
  completeStatus,
  fakeLibrary,
  fixtures,
  installApi,
  respond,
} from '../helpers/testSupport.js';

const harness = vi.hoisted(() => ({ cache: { store: null, ready: true } }));
vi.mock('../../src/data/storage/useCacheStore.js', () => ({
  useCacheStore: () => harness.cache,
}));

const { m1 } = fixtures;
const IDEA = 'An amber glass bird on a small wooden stand';
const TITLE = completeStatus().result.title;
const jobPolicy = { pollIntervalMs: 1, maxConsecutivePollFailures: 3 };

let api;
let db;

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  localStorage.clear();
  db = memoryDb();
  harness.cache = {
    store: createCacheStore(db, DEFAULT_CLIENT_POLICY.cache),
    ready: true,
  };
  let next = 0;
  URL.createObjectURL = vi.fn(() => `blob:p-${(next += 1)}`);
  URL.revokeObjectURL = vi.fn();
  api = installApi({
    'GET /api/app-capabilities': () => m1.capabilities_private,
    'POST /api/controls/dynamic': () => m1.dynamic_response,
    'POST /api/generate-image': () => respond(202, m1.accepted),
    'GET /api/generation-jobs/fixture-image-1': () => ({
      ...completeStatus(),
      result: {
        ...completeStatus().result,
        visibility: 'private',
        sha256: undefined,
      },
    }),
    'GET /api/images/fixture-image-1/content': () =>
      respond(200, 'png-bytes', { 'Content-Type': 'image/png' }),
    ...fakeLibrary([]).routes,
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test('a link to a private result restores it from this browser without a shared request', async () => {
  render(<App jobPolicy={jobPolicy} />);
  await openStandardControls();
  fireEvent.change(screen.getByLabelText('Image idea'), {
    target: { value: IDEA },
  });
  fireEvent.click(screen.getAllByRole('button', { name: /Generate image/ })[0]);
  await screen.findByRole('button', { name: TITLE });
  await waitFor(() => expect(db.data.get('private')?.size).toBe(1));
  const [row] = db.data.get('private').values();
  const href = hrefFor(ROUTE.create, '', { edit: editTarget(row.record) });
  cleanup();

  window.history.replaceState(null, '', href);
  render(<App jobPolicy={jobPolicy} />);
  await waitFor(() =>
    expect(screen.getByLabelText('Image idea').value).toBe(
      row.record.original_prompt,
    ),
  );
  const thumbnail = await screen.findByRole('button', { name: TITLE });
  expect(thumbnail.getAttribute('aria-current')).toBe('true');
  expect(screen.queryByText(/not in the library/)).toBeNull();
  expect(
    api.calls.filter(
      (c) =>
        c.key.includes('/api/images/library') || c.key.startsWith('DELETE'),
    ),
  ).toEqual([]);
});
