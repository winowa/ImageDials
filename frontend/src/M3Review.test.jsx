import { openStandardControls } from './controlUiTestSupport.js';
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

import App from './App.jsx';
import { checkImportFile } from './importFlow.js';
import {
  completeStatus,
  fakeLibrary,
  fixtures,
  installApi,
  listedFromJob,
  respond,
} from './testSupport.js';

const { m1, m3 } = fixtures;
const IMPORT = 'POST /api/images/import-analysis';
const GENERATE = 'POST /api/generate-image';
const STATIC_TRELLIS = 'GET /api/controls/static?generation_mode=trellis';
const JOB = 'GET /api/generation-jobs/fixture-image-1';
const jobPolicy = { pollIntervalMs: 1, maxConsecutivePollFailures: 3 };

let api;
let library;

function setup(overrides = {}) {
  library = fakeLibrary([]);
  api = installApi({
    'GET /api/app-capabilities': () => m3.capabilities,
    ...library.routes,
    ...overrides,
  });
}

const prompt = () => screen.getByLabelText('Image idea');
const pngFile = (name = 'bird.png') =>
  new File(
    [Uint8Array.from(atob(m3.metadata_png_base64), (c) => c.charCodeAt(0))],
    name,
    { type: 'image/png' },
  );
const chooseFile = (file) =>
  fireEvent.change(document.querySelector('input[type="file"]'), {
    target: { files: [file] },
  });

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  localStorage.clear();
  let next = 0;
  URL.createObjectURL = vi.fn(() => `blob:review-${(next += 1)}`);
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test('progress lists the title and alt text step before saving', async () => {
  setup({
    [GENERATE]: () => respond(202, { generation_job_id: 'fixture-image-1' }),
    [JOB]: () => m3.job_enriching,
  });
  render(<App jobPolicy={jobPolicy} />);
  await openStandardControls();
  fireEvent.change(prompt(), { target: { value: 'a glass bird' } });
  fireEvent.keyDown(prompt(), { key: 'Enter' });
  const steps = await screen.findByRole('list', {
    name: 'Generation progress',
  });
  expect(
    within(steps)
      .getAllByRole('listitem')
      .map((item) => item.textContent),
  ).toEqual([
    'Options',
    'Queued',
    'Prompt',
    'Rendering',
    'Title and alt text',
    'Saving',
  ]);
});

test('a manual edit while a description is analysed wins: nothing is applied or generated', async () => {
  let answer;
  setup({
    [IMPORT]: () =>
      new Promise((resolve) => {
        answer = () => resolve(m3.import_description);
      }),
  });
  render(<App jobPolicy={jobPolicy} />);
  await openStandardControls();
  chooseFile(pngFile());
  await screen.findByText(/Reading bird\.png/);
  fireEvent.change(prompt(), { target: { value: 'my own newer idea' } });
  await act(async () => answer());
  await screen.findByText(/draft changed while the image was being read/);
  expect(prompt().value).toBe('my own newer idea');
  expect(api.called(GENERATE)).toHaveLength(0);
});

test('an aspect change while metadata is analysed keeps the draft and lists nothing', async () => {
  let answer;
  setup({
    [IMPORT]: () =>
      new Promise((resolve) => {
        answer = () => resolve(m3.import_metadata);
      }),
  });
  render(<App jobPolicy={jobPolicy} />);
  await openStandardControls();
  fireEvent.change(prompt(), { target: { value: 'keep me' } });
  chooseFile(pngFile());
  await screen.findByText(/Reading bird\.png/);
  const aspect = screen.getAllByRole('radio', { name: /1:1|Square/ })[0];
  fireEvent.click(aspect);
  await act(async () => answer());
  await screen.findByText(/draft changed while the image was being read/);
  expect(prompt().value).toBe('keep me');
  expect(screen.queryByText('Imported')).toBeNull();
});

test('description import fills the draft without loading controls or generating', async () => {
  const pending = [];
  setup({
    [IMPORT]: () => m3.import_description,
    [STATIC_TRELLIS]: () =>
      new Promise((resolve) => {
        pending.push(() => resolve(m1.static_trellis));
      }),
    [GENERATE]: () => respond(202, m1.accepted),
    [JOB]: () => {
      const status = completeStatus();
      library.records = [listedFromJob(status.result)];
      return status;
    },
  });
  render(<App jobPolicy={jobPolicy} />);
  await openStandardControls();
  // Asset mode has no cached controls; import remains available independently.
  fireEvent.click(screen.getByRole('radio', { name: 'Asset image for 3D' }));
  await waitFor(() => expect(pending).toHaveLength(1));
  chooseFile(pngFile());
  fireEvent.change(prompt(), { target: { value: 'typed while waiting' } });
  await act(async () => pending[0]());
  await screen.findByText(/draft changed while the image was being read/);
  expect(prompt().value).toBe('typed while waiting');
  expect(api.called(GENERATE)).toHaveLength(0);
  expect(pending).toHaveLength(1);
});

test('without upload limits from the server no file is sent', async () => {
  expect(
    checkImportFile(new File(['x'], 'a.png', { type: 'image/png' }), undefined),
  ).toMatch(/limits have not been read/);
  setup({
    'GET /api/app-capabilities': () => respond(503, { detail: 'down' }),
    [IMPORT]: () => m3.import_metadata,
  });
  render(<App jobPolicy={jobPolicy} />);
  await openStandardControls();
  await waitFor(() =>
    expect(api.called('GET /api/app-capabilities')).toHaveLength(1),
  );
  chooseFile(pngFile());
  await screen.findByText(/limits have not been read from the server/);
  expect(api.called(IMPORT)).toHaveLength(0);
});
