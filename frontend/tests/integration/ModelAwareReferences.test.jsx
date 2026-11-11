/**
 * Selected-model reference limits in Create. `/api/models` responses are
 * client-contract mocks of the server's provider-scoped `image_editing`
 * object; no model or provider is called.
 */
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

import editing from '../../../fixtures/api/image-editing.json';
import App from '../../src/app/App.jsx';
import { PROVIDER_OVERRIDE_HEADER } from '../../src/data/api/api.js';
import { sha256Hex } from '../../src/data/media/privateThumbnail.js';
import {
  clone,
  fakeLibrary,
  fixtures,
  installApi,
  listedFromJob,
  networkFailure,
  respond,
} from '../helpers/testSupport.js';

vi.mock('../../src/features/controls/standardRandom.js', async (original) => ({
  ...(await original()),
  randomizeStandard: (entries) => entries,
}));

const { m1 } = fixtures;
const ANALYZE = 'POST /api/images/reference-analysis';
const GENERATE = 'POST /api/generate-image';
const MODELS = 'GET /api/models';
const EDIT_JOB = `GET /api/generation-jobs/${editing.generation.accepted.generation_job_id}`;
const jobPolicy = { pollIntervalMs: 1, maxConsecutivePollFailures: 3 };
const UPLOADS = {
  image_mime_types: ['image/png', 'image/jpeg', 'image/webp'],
  import_max_bytes: 33554432,
};
const IMAGE_ENDPOINT = 'https://images.example.invalid';
const OTHER_ENDPOINT = 'https://other-images.example.invalid';

/** The current server contract, optionally lowered as a deployment may do. */
function editingWith(max) {
  const current = clone(editing.capabilities);
  if (max === current.max_references) return current;
  const labels = Object.fromEntries(
    Object.entries(current.prompting.labels).filter(([n]) => Number(n) <= max),
  );
  return {
    ...current,
    max_references: max,
    limit_source: 'configured',
    prompting: { ...current.prompting, max_references: max, labels },
  };
}

const decode = (headers) => {
  const header = headers?.[PROVIDER_OVERRIDE_HEADER];
  return header
    ? JSON.parse(
        new TextDecoder().decode(
          Uint8Array.from(atob(header), (c) => c.charCodeAt(0)),
        ),
      )
    : null;
};

let api;
let library;
let urlCount = 0;

/** `limits` maps an image endpoint override (or 'default') to its answer. */
function setup({
  limits = { default: 10 },
  overrides = {},
  records = [],
} = {}) {
  library = fakeLibrary(records);
  api = installApi({
    'GET /api/app-capabilities': () => ({
      ...m1.capabilities,
      uploads: UPLOADS,
      image_editing: editingWith(limits.default),
    }),
    [MODELS]: (_body, _n, init) => {
      const endpoint =
        decode(init.headers)?.IMAGE_MODEL_ENDPOINT_1 ?? 'default';
      const answer = limits[endpoint];
      const respondWith = (max) => ({
        ...clone(m1.models),
        image_editing: editingWith(max),
      });
      return typeof answer === 'function'
        ? answer().then(respondWith)
        : respondWith(answer);
    },
    [ANALYZE]: async (form) => {
      const context = JSON.parse(form.get('context'));
      return {
        ...clone(editing.analysis.additional.response),
        source_sha256: await sha256Hex(form.get('image')),
        description: `Described ${form.get('image').name}`,
        suggested_prompt: '',
        reference_index: context.reference_images.length + 1,
        revision: context.revision,
      };
    },
    [GENERATE]: () => respond(202, editing.generation.accepted),
    [EDIT_JOB]: () => clone(editing.generation.complete),
    ...library.routes,
    ...overrides,
  });
}

const fileN = (n) =>
  new File([new Uint8Array([137, 80, 78, 71, n, n + 7])], `ref-${n}.png`, {
    type: 'image/png',
  });
const files = (from, to) =>
  Array.from({ length: to - from + 1 }, (_, i) => fileN(from + i));
const region = () => screen.getByRole('region', { name: 'References' });
const rows = () => within(region()).queryAllByRole('listitem');
const chooseEdit = () => {
  const edit = screen.getByRole('radio', { name: /^Edit image/ });
  if (!edit.checked) fireEvent.click(edit);
};
const attach = (list) => {
  chooseEdit();
  fireEvent.change(region().querySelector('input[type="file"]'), {
    target: { files: list },
  });
};
const settled = () =>
  waitFor(() => expect(screen.queryAllByText('Describing…')).toHaveLength(0));
const bar = () =>
  screen.getAllByRole('button', { name: /Generate edit/ }).at(-1);
const type = (text) =>
  fireEvent.change(screen.getByLabelText('Image idea'), {
    target: { value: text },
  });
const addButton = () =>
  within(region()).getByRole('button', { name: /Add reference/ });

async function chooseImageEndpoint(value) {
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
  const dialog = await screen.findByRole('dialog', { name: 'Settings' });
  fireEvent.click(within(dialog).getByRole('tab', { name: 'Generation' }));
  const group = await within(dialog).findByRole('group', {
    name: 'Image model',
  });
  fireEvent.change(within(group).getByLabelText(/^Endpoint/), {
    target: { value },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() =>
    expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull(),
  );
}

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  localStorage.clear();
  URL.createObjectURL = vi.fn(() => `blob:reference-${++urlCount}`);
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test('the selected Qwen-Image-2.1 model takes ten ordered references and refuses an eleventh', async () => {
  setup();
  render(<App jobPolicy={jobPolicy} />);
  await openStandardControls();
  attach(files(1, 4));
  await settled();
  attach(files(5, 10));
  await settled();
  expect(rows()).toHaveLength(10);
  expect(within(region()).getByText('10 of 10 references')).toBeTruthy();
  expect(addButton().disabled).toBe(true);
  // Rows 5 to 10 have their own thumbnails, numbers and native markers.
  rows().forEach((row, index) => {
    expect(row.querySelector('.ref-media img')?.getAttribute('src')).toMatch(
      /^blob:reference-/,
    );
    expect(row.querySelector('.ref-index').textContent).toBe(String(index + 1));
    expect(row.querySelector('.ref-prompt-label').textContent).toBe(
      `<image${index + 1}>`,
    );
  });
  // Each analysis sees every earlier reference, so its index is the slot's.
  const contexts = api
    .called(ANALYZE)
    .map((call) => JSON.parse(call.body.get('context')).reference_images);
  expect(contexts.map((list) => list.length)).toEqual([
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
  ]);

  attach([fileN(11)]);
  expect(
    await screen.findByText(
      '1 file not added. Qwen-Image-2.1 accepts up to 10 references here.',
    ),
  ).toBeTruthy();
  expect(rows()).toHaveLength(10);

  // Reordering renumbers the labels; the submission follows the new order.
  fireEvent.click(
    screen.getByRole('button', { name: 'Actions for reference 9' }),
  );
  fireEvent.click(screen.getByRole('menuitem', { name: /^Move later/ }));
  await waitFor(() =>
    expect(rows()[8].getAttribute('aria-label')).toMatch(/ref-10\.png$/),
  );
  expect(rows()[9].querySelector('.ref-prompt-label').textContent).toBe(
    '<image10>',
  );

  type('Combine every subject on the first image');
  fireEvent.click(bar());
  await waitFor(() => expect(api.called(GENERATE)).toHaveLength(1));
  const [call] = api.called(GENERATE);
  expect([...call.body.keys()]).toEqual([
    'request',
    ...Array.from({ length: 10 }, (_, i) => `reference_${i + 1}`),
  ]);
  expect(
    Array.from(
      { length: 10 },
      (_, i) => call.body.get(`reference_${i + 1}`).name,
    ),
  ).toEqual([
    ...Array.from({ length: 8 }, (_, i) => `ref-${i + 1}.png`),
    'ref-10.png',
    'ref-9.png',
  ]);
  expect(JSON.parse(call.body.get('request')).reference_images).toHaveLength(
    10,
  );
});

test('a smaller limit after a provider change keeps every reference, blocks, and unblocks after removal', async () => {
  setup({ limits: { default: 10, [IMAGE_ENDPOINT]: 3 } });
  render(<App jobPolicy={jobPolicy} />);
  await openStandardControls();
  attach(files(1, 6));
  await settled();
  type('Use these');
  expect(bar().disabled).toBe(false);

  await chooseImageEndpoint(IMAGE_ENDPOINT);
  const reason = await screen.findAllByText(
    'Qwen-Image-2.1 accepts up to 3 references here. Remove 3 to edit.',
  );
  expect(reason.length).toBeGreaterThan(0);
  expect(rows()).toHaveLength(6);
  expect(within(region()).getByText('6 of 3 references')).toBeTruthy();
  expect(bar().disabled).toBe(true);
  expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  // Over the limit, no slot shows a label the model would not accept.
  expect(region().querySelectorAll('.ref-prompt-label')).toHaveLength(0);

  // The provider header goes only to provider-scoped reads.
  const lastModels = api.called(MODELS).at(-1);
  expect(decode(lastModels.headers)).toMatchObject({
    IMAGE_MODEL_ENDPOINT_1: IMAGE_ENDPOINT,
  });
  for (const call of api.calls)
    if (
      call.key === 'GET /api/app-capabilities' ||
      call.key === 'GET /healthz' ||
      call.key.startsWith('GET /api/images')
    )
      expect(call.headers[PROVIDER_OVERRIDE_HEADER]).toBeUndefined();

  for (const n of [6, 5, 4]) {
    fireEvent.click(
      screen.getByRole('button', { name: `Actions for reference ${n}` }),
    );
    fireEvent.click(
      screen.getByRole('menuitem', { name: /^Remove from draft/ }),
    );
  }
  await waitFor(() => expect(rows()).toHaveLength(3));
  expect(within(region()).getByText('3 of 3 references')).toBeTruthy();
  expect(
    screen.queryByText(/accepts up to 3 references here\. Remove/),
  ).toBeNull();
  expect(bar().disabled).toBe(false);
  expect(URL.revokeObjectURL).toHaveBeenCalledTimes(3);
  fireEvent.click(bar());
  await waitFor(() => expect(api.called(GENERATE)).toHaveLength(1));
  expect(decode(api.called(GENERATE)[0].headers)).toMatchObject({
    IMAGE_MODEL_ENDPOINT_1: IMAGE_ENDPOINT,
  });
});

test('a frozen retry keeps its provider, key and files after the limit drops', async () => {
  let attempt = 0;
  setup({
    limits: { default: 10, [IMAGE_ENDPOINT]: 3 },
    overrides: {
      [GENERATE]: () => {
        attempt += 1;
        return attempt === 1
          ? networkFailure()
          : respond(202, editing.generation.accepted);
      },
    },
  });
  render(<App jobPolicy={jobPolicy} />);
  await openStandardControls();
  attach(files(1, 6));
  await settled();
  type('Use all six');
  fireEvent.click(bar());
  await screen.findByText('The API is unreachable.');

  await chooseImageEndpoint(IMAGE_ENDPOINT);
  await screen.findAllByText(
    'Qwen-Image-2.1 accepts up to 3 references here. Remove 3 to edit.',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(api.called(GENERATE)).toHaveLength(2));
  const [first, second] = api.called(GENERATE);
  expect(decode(first.headers)).toBeNull();
  expect(decode(second.headers)).toBeNull();
  const a = JSON.parse(first.body.get('request'));
  const b = JSON.parse(second.body.get('request'));
  expect(b.idempotency_key).toBe(a.idempotency_key);
  expect(b.reference_images).toHaveLength(6);
  expect(b.reference_images).toEqual(a.reference_images);
  expect([...second.body.keys()]).toHaveLength(7);
  // The draft still holds every file; only new submissions are blocked.
  expect(rows()).toHaveLength(6);
});

test('a late answer for an earlier provider choice does not replace the current limit', async () => {
  let release;
  const late = new Promise((resolve) => {
    release = () => resolve(2);
  });
  setup({
    limits: { default: 10, [IMAGE_ENDPOINT]: () => late, [OTHER_ENDPOINT]: 10 },
  });
  render(<App jobPolicy={jobPolicy} />);
  await openStandardControls();
  attach(files(1, 4));
  await settled();
  type('Keep going');
  await waitFor(() => expect(bar().disabled).toBe(false));

  await chooseImageEndpoint(IMAGE_ENDPOINT);
  // While the selected provider is being read, editing waits rather than
  // borrowing the server default's limit.
  await waitFor(() => expect(bar().disabled).toBe(true));
  expect(addButton().disabled).toBe(true);
  await chooseImageEndpoint(OTHER_ENDPOINT);
  await waitFor(() =>
    expect(within(region()).getByText('4 of 10 references')).toBeTruthy(),
  );
  expect(addButton().disabled).toBe(false);
  release();
  await late;
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(within(region()).getByText('4 of 10 references')).toBeTruthy();
  expect(screen.queryByText(/accepts up to 2 references/)).toBeNull();
  await waitFor(() => expect(bar().disabled).toBe(false));
});

function savedEditWith(count) {
  const result = clone(editing.generation.complete.result);
  const template = result.reference_images[1];
  result.reference_images = Array.from({ length: count }, (_, i) => ({
    ...clone(i === 0 ? result.reference_images[0] : template),
    id: `saved-reference-${i + 1}`,
    sha256: (i + 1).toString(16).padStart(64, 'a'),
    index: i + 1,
    filename: `saved-${i + 1}.png`,
  }));
  return listedFromJob(result);
}

test.each([
  [10, 'Attach reference 1 again to edit.'],
  [3, 'Qwen-Image-2.1 accepts up to 3 references here. Remove 7 to edit.'],
])(
  'reopening a saved ten-reference edit under a limit of %i keeps every slot',
  async (limit, reason) => {
    const saved = savedEditWith(10);
    setup({ limits: { default: limit }, records: [saved] });
    window.history.replaceState(
      null,
      '',
      `/?edit=${encodeURIComponent(saved.id)}`,
    );
    render(<App jobPolicy={jobPolicy} />);
    await waitFor(() => expect(rows()).toHaveLength(10));
    await waitFor(() =>
      expect(screen.getAllByText('Original file needed to edit.')).toHaveLength(
        10,
      ),
    );
    expect(screen.getAllByText(reason).length).toBeGreaterThan(0);
    expect(bar().disabled).toBe(true);
    expect(api.called(ANALYZE)).toHaveLength(0);
  },
);

test('reference help lists the selected model limit and its tags', async () => {
  setup({ limits: { default: 10 } });
  render(<App jobPolicy={jobPolicy} />);
  await openStandardControls();
  chooseEdit();
  fireEvent.click(
    within(region()).getByRole('button', {
      name: 'Image editing prompt guidance',
    }),
  );
  const help = await screen.findByText(/up to 10 images/);
  const panel = help.closest('.reference-prompt-help');
  const tags = [...panel.querySelectorAll('.reference-prompt-tags code')].map(
    (node) => node.textContent,
  );
  expect(tags).toEqual(Array.from({ length: 10 }, (_, i) => `<image${i + 1}>`));
  expect(panel.textContent).not.toMatch(/<subject|<reference_|Picture 1/);
});
