/**
 * A failed optional prompt suggestion must never fail a reference. These
 * connected tests mock the server's documented answers; no model or provider
 * is called.
 */
import { createHash } from 'node:crypto';

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

import editing from '../../fixtures/api/image-editing.json';
import App from './App.jsx';
import { PROVIDER_OVERRIDE_HEADER } from './api.js';
import { openStandardControls } from './controlUiTestSupport.js';
import {
  clone,
  fakeLibrary,
  fixtures,
  installApi,
  networkFailure,
  respond,
} from './testSupport.js';

vi.mock('./standardRandom.js', async (original) => ({
  ...(await original()),
  randomizeStandard: (entries) => entries,
}));

const { m1 } = fixtures;
const ANALYZE = 'POST /api/images/reference-analysis';
const PROMPT = 'POST /api/images/reference-prompt';
const GENERATE = 'POST /api/generate-image';
const INSPECT = 'POST /api/images/reference-analysis?inspect_only=true';
const EDIT_JOB = `GET /api/generation-jobs/${editing.generation.accepted.generation_job_id}`;
const jobPolicy = { pollIntervalMs: 1, maxConsecutivePollFailures: 3 };
const WARNING = {
  code: 'prompt_suggestion_unavailable',
  message: 'No prompt suggestion was made. The image is ready to use.',
  detail: 'The language provider did not use the image labels: <image2>',
  retryable: true,
};
const GOOD = 'Place the subject of <image2> into <image1>.';
const MINE = 'Keep my own wording, exactly  as typed.';

const retryCalls = () => api.called(PROMPT).slice(1);
let api;
let urlCount = 0;

const hashOf = async (blob) =>
  createHash('sha256')
    .update(Buffer.from(await blob.arrayBuffer()))
    .digest('hex');

/** `analysis(form, context)` returns extra analysis fields per upload. */
function setup({
  analysis = () => ({}),
  overrides = {},
  initialPrompt = null,
} = {}) {
  const library = fakeLibrary([]);
  let firstProposal = true;
  api = installApi({
    'GET /api/app-capabilities': () => ({
      ...m1.capabilities,
      uploads: { image_mime_types: ['image/png'], import_max_bytes: 33554432 },
      image_editing: clone(editing.capabilities),
    }),
    'GET /api/models': () => ({
      ...clone(m1.models),
      image_editing: clone(editing.capabilities),
    }),
    [ANALYZE]: async (form) => {
      const context = JSON.parse(form.get('context'));
      return {
        ...clone(editing.analysis.additional.response),
        source_sha256: await hashOf(form.get('image')),
        dimensions: { width: 40, height: 24 },
        description: `Described ${form.get('image').name}`,
        suggested_prompt: '',
        warnings: [],
        reference_index: context.reference_images.length + 1,
        revision: context.revision,
        ...(await analysis(form, context)),
      };
    },
    [GENERATE]: () => respond(202, editing.generation.accepted),
    [EDIT_JOB]: () => clone(editing.generation.complete),
    ...library.routes,
    ...overrides,
    [PROMPT]: (form, ...args) => {
      if (firstProposal) {
        firstProposal = false;
        return {
          suggested_prompt: initialPrompt,
          warnings: initialPrompt ? [] : [WARNING],
          revision: JSON.parse(form.get('context')).revision,
        };
      }
      return (
        overrides[PROMPT]?.(JSON.parse(form.get('context')), ...args) ?? {
          suggested_prompt: null,
          warnings: [WARNING],
        }
      );
    },
  });
}

const fileN = (n) =>
  new File([new Uint8Array([137, 80, 78, 71, n, n + 7])], `ref-${n}.png`, {
    type: 'image/png',
  });
const region = () => screen.getByRole('region', { name: 'References' });
const rows = () => within(region()).queryAllByRole('listitem');
const prompt = () => screen.getByLabelText('Image idea');
const bar = () =>
  screen.getAllByRole('button', { name: /Generate edit/ }).at(-1);
const type = (text) => fireEvent.change(prompt(), { target: { value: text } });
const settled = () =>
  waitFor(() => expect(screen.queryAllByText('Describing…')).toHaveLength(0));
const retry = () =>
  within(region()).getByRole('button', { name: /Retry prompt/ });
const notice = () => region().querySelector('.ref-notice');
const warned = () => waitFor(() => expect(notice()).not.toBeNull());

async function attach(list) {
  const edit = screen.getByRole('radio', { name: /^Edit image/ });
  if (!edit.checked) fireEvent.click(edit);
  fireEvent.change(region().querySelector('input[type="file"]'), {
    target: { files: list },
  });
  await settled();
}

/** Two references where the suggestion for the second one came back unusable. */
async function twoWithWarning(extra = {}) {
  setup({
    analysis: (_form, context) =>
      context.reference_images.length === 1
        ? { suggested_prompt: null, warnings: [WARNING] }
        : {},
    ...extra,
  });
  render(<App jobPolicy={jobPolicy} />);
  await openStandardControls();
  type(MINE);
  await attach([fileN(1)]);
  await attach([fileN(2)]);
  await warned();
}

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  localStorage.clear();
  URL.createObjectURL = vi.fn(() => `blob:warning-${++urlCount}`);
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test('bad image markers warn, keep both references ready and let the typed prompt generate', async () => {
  await twoWithWarning();

  // Warning tone: a status, never an alert, and not the error color.
  expect(notice().getAttribute('role')).toBe('status');
  expect(notice().getAttribute('data-tone')).toBe('warning');
  expect(region().querySelector('[role="alert"]')).toBeNull();
  expect(within(notice()).getByText(WARNING.message)).toBeTruthy();
  // The detail sits behind the details control, not in the notice itself.
  expect(within(notice()).queryByText(WARNING.detail)).toBeNull();
  fireEvent.click(
    within(notice()).getByRole('button', { name: 'Prompt suggestion details' }),
  );
  expect(await screen.findByText(WARNING.detail)).toBeTruthy();

  // Both images are usable, described and shown.
  expect(rows()).toHaveLength(2);
  rows().forEach((row, index) => {
    expect(row.getAttribute('data-status')).toBe('ready');
    expect(row.querySelector('.ref-media img')).not.toBeNull();
    expect(row.textContent).toContain(`Described ref-${index + 1}.png`);
    expect(row.textContent).not.toMatch(/Not described|could not be read/);
  });
  // The invalid suggestion was not applied or offered, and the text is untouched.
  expect(prompt().value).toBe(MINE);
  expect(region().querySelector('.ref-proposal:not(.ref-notice)')).toBeNull();
  expect(screen.queryByText(/Suggested prompt/)).toBeNull();

  // Generation uses both files in order with the person's own prompt.
  expect(bar().disabled).toBe(false);
  fireEvent.click(bar());
  await waitFor(() => expect(api.called(GENERATE)).toHaveLength(1));
  const [call] = api.called(GENERATE);
  expect([...call.body.keys()]).toEqual([
    'request',
    'reference_1',
    'reference_2',
  ]);
  expect(call.body.get('reference_1').name).toBe('ref-1.png');
  expect(call.body.get('reference_2').name).toBe('ref-2.png');
  const request = JSON.parse(call.body.get('request'));
  expect(request.prompt).toBe(MINE);
  expect(request.reference_images.map((item) => item.description)).toEqual([
    'Described ref-1.png',
    'Described ref-2.png',
  ]);
  // The warning is not part of the frozen request.
  expect(JSON.stringify(request)).not.toMatch(/prompt_suggestion|warning/);
});

test('retrying the prompt asks only for a suggestion, then applies it with undo', async () => {
  await twoWithWarning({
    overrides: {
      [PROMPT]: (body) => ({
        suggested_prompt: GOOD,
        reference_count: 2,
        revision: body.revision,
        warnings: [],
        metadata: { prompt: { provider: 'mock', model: '' } },
      }),
    },
  });
  const analyses = api.called(ANALYZE).length;
  fireEvent.click(retry());
  await waitFor(() => expect(notice()).toBeNull());

  const [call] = retryCalls();
  // Full ordered context and exact frozen files; no caption or generation request.
  const context = JSON.parse(call.body.get('context'));
  expect(context.prompt).toBe(MINE);
  expect(context.reference_images.map((item) => item.id)).toHaveLength(2);
  expect(context.reference_images.map((item) => item.description)).toEqual([
    'Described ref-1.png',
    'Described ref-2.png',
  ]);
  expect(context.generation_mode).toBe('standard');
  expect(call.body.get('reference_1').name).toBe('ref-1.png');
  expect(call.body.get('reference_2').name).toBe('ref-2.png');
  expect(await hashOf(call.body.get('reference_1'))).toBe(
    context.reference_images[0].sha256,
  );
  expect(api.called(ANALYZE)).toHaveLength(analyses);
  expect(api.called(INSPECT)).toHaveLength(0);
  expect(api.called(GENERATE)).toHaveLength(0);

  // The prompt was as at the request, so the suggestion is applied reversibly.
  expect(prompt().value).toBe(GOOD);
  fireEvent.click(within(region()).getByRole('button', { name: /^Undo/ }));
  expect(prompt().value).toBe(MINE);
});

test('a retry that fails again stays a warning and generation remains possible', async () => {
  let attempt = 0;
  await twoWithWarning({
    overrides: {
      [PROMPT]: () => {
        attempt += 1;
        return attempt === 1
          ? {
              suggested_prompt: null,
              revision: 1,
              warnings: [{ ...WARNING, detail: 'Second answer was also bad.' }],
              metadata: { prompt: { status: 'unavailable' } },
            }
          : networkFailure();
      },
    },
  });
  fireEvent.click(retry());
  await waitFor(() => expect(retryCalls()).toHaveLength(1));
  await waitFor(() => expect(retry().disabled).toBe(false));
  expect(notice().getAttribute('data-tone')).toBe('warning');
  fireEvent.click(
    within(notice()).getByRole('button', { name: 'Prompt suggestion details' }),
  );
  expect(await screen.findByText('Second answer was also bad.')).toBeTruthy();

  fireEvent.click(retry());
  await waitFor(() => expect(retryCalls()).toHaveLength(2));
  await waitFor(() => expect(retry().disabled).toBe(false));
  expect(region().querySelector('[role="alert"]')).toBeNull();
  expect(prompt().value).toBe(MINE);
  expect(bar().disabled).toBe(false);
  fireEvent.click(bar());
  await waitFor(() => expect(api.called(GENERATE)).toHaveLength(1));
  expect(api.called(ANALYZE)).toHaveLength(2);
});

test('a late good suggestion is offered, not applied, once the prompt was edited', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await twoWithWarning({
    overrides: {
      [PROMPT]: async (body) => {
        await gate;
        return {
          suggested_prompt: GOOD,
          revision: body.revision,
          warnings: [],
        };
      },
    },
  });
  fireEvent.click(retry());
  await waitFor(() => expect(retryCalls()).toHaveLength(1));
  expect(retry().disabled).toBe(true);
  type('Edited while waiting');
  release();
  await waitFor(() =>
    expect(screen.getByText(/Suggested prompt from/)).toBeTruthy(),
  );
  expect(prompt().value).toBe('Edited while waiting');
  expect(notice()).toBeNull();
  fireEvent.click(within(region()).getByRole('button', { name: 'Use' }));
  expect(prompt().value).toBe(GOOD);
});

test('an answer for a changed reference set is discarded and never replaces the current state', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await twoWithWarning({
    overrides: {
      [PROMPT]: async (body) => {
        await gate;
        return {
          suggested_prompt: GOOD,
          revision: body.revision,
          warnings: [],
        };
      },
    },
  });
  fireEvent.click(retry());
  await waitFor(() => expect(retryCalls()).toHaveLength(1));
  // Reordering changes the set the suggestion was written for.
  fireEvent.click(
    screen.getByRole('button', { name: 'Actions for reference 2' }),
  );
  fireEvent.click(screen.getByRole('menuitem', { name: /^Move earlier/ }));
  release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(prompt().value).toBe(MINE);
  expect(screen.queryByText(/Suggested prompt from/)).toBeNull();
  expect(screen.queryByText(/Prompt updated from/)).toBeNull();
  expect(notice()).toBeNull();
  expect(retryCalls()).toHaveLength(1);
  expect(api.called(GENERATE)).toHaveLength(0);
  expect(bar().disabled).toBe(false);
});

test('removing a reference or dismissing the warning leaves no hidden retry', async () => {
  await twoWithWarning({
    overrides: {
      [PROMPT]: (body) => ({
        suggested_prompt: GOOD,
        revision: body.revision,
        warnings: [],
      }),
    },
  });
  fireEvent.click(
    within(notice()).getByRole('button', { name: 'Dismiss prompt warning' }),
  );
  expect(notice()).toBeNull();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(retryCalls()).toHaveLength(0);
  expect(prompt().value).toBe(MINE);
  expect(bar().disabled).toBe(false);
});

test('a warning is dropped when a later reference changes the set', async () => {
  await twoWithWarning();
  fireEvent.click(
    screen.getByRole('button', { name: 'Actions for reference 2' }),
  );
  fireEvent.click(screen.getByRole('menuitem', { name: /^Remove from draft/ }));
  await waitFor(() => expect(notice()).toBeNull());
  expect(rows()).toHaveLength(1);
  expect(prompt().value).toBe(MINE);
});

test('a browser without crypto gets the hash from the partial answer and stays usable', async () => {
  vi.stubGlobal('crypto', { randomUUID: () => `k-${++urlCount}` });
  setup({
    analysis: async (form, context) => ({
      source_sha256: await hashOf(form.get('image')),
      ...(context.reference_images.length === 1
        ? { suggested_prompt: null, warnings: [WARNING] }
        : {}),
    }),
  });
  render(<App jobPolicy={jobPolicy} />);
  await openStandardControls();
  type(MINE);
  await attach([fileN(1)]);
  await attach([fileN(2)]);
  await warned();
  rows().forEach((row) =>
    expect(row.getAttribute('data-status')).toBe('ready'),
  );
  expect(api.called(INSPECT)).toHaveLength(0);
  expect(bar().disabled).toBe(false);
  fireEvent.click(bar());
  await waitFor(() => expect(api.called(GENERATE)).toHaveLength(1));
});

test('an empty prompt with no suggestion keeps Generate blocked and invents nothing', async () => {
  setup({
    analysis: (_form, context) =>
      context.reference_images.length === 1
        ? { suggested_prompt: null, warnings: [WARNING] }
        : { suggested_prompt: '' },
  });
  render(<App jobPolicy={jobPolicy} />);
  await openStandardControls();
  await attach([fileN(1)]);
  await attach([fileN(2)]);
  await warned();
  expect(prompt().value).toBe('');
  expect(bar().disabled).toBe(true);
  expect(notice().getAttribute('data-tone')).toBe('warning');
});

test('genuinely unreadable references still block generation', async () => {
  setup({
    overrides: {
      [ANALYZE]: () =>
        respond(400, { detail: 'The uploaded image is invalid' }),
    },
  });
  vi.stubGlobal('crypto', { randomUUID: () => `k-${++urlCount}` });
  render(<App jobPolicy={jobPolicy} />);
  await openStandardControls();
  type(MINE);
  await attach([fileN(1)]);
  await waitFor(() =>
    expect(rows()[0].getAttribute('data-status')).toBe('error'),
  );
  expect(within(region()).getByRole('alert').textContent).toMatch(
    /The uploaded image is invalid/,
  );
  expect(notice()).toBeNull();
  expect(bar().disabled).toBe(true);
  expect(api.called(GENERATE)).toHaveLength(0);
});

test.each(['before', 'after'])(
  'a local checksum finishing %s a hard upload rejection cannot enable generation',
  async (timing) => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    vi.stubGlobal('crypto', {
      randomUUID: () => `k-${++urlCount}`,
      subtle: {
        digest: async (_algorithm, bytes) => {
          const value = new Uint8Array(
            createHash('sha256').update(Buffer.from(bytes)).digest(),
          );
          if (timing === 'after') await gate;
          return value.buffer;
        },
      },
    });
    setup({
      overrides: {
        [ANALYZE]: () =>
          respond(400, { detail: 'The uploaded image is invalid' }),
      },
    });
    render(<App jobPolicy={jobPolicy} />);
    await openStandardControls();
    type(MINE);
    await attach([fileN(1)]);
    await act(async () => {
      release();
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    expect(rows()[0].getAttribute('data-status')).toBe('error');
    expect(bar().disabled).toBe(true);
    expect(api.called(GENERATE)).toHaveLength(0);
  },
);

test('the provider header scopes the prompt retry like other provider calls', async () => {
  await twoWithWarning({
    overrides: {
      [PROMPT]: (body) => ({
        suggested_prompt: GOOD,
        revision: body.revision,
        warnings: [],
      }),
    },
  });
  fireEvent.click(retry());
  await waitFor(() => expect(retryCalls()).toHaveLength(1));
  // No browser override is selected, so none is sent or invented.
  expect(retryCalls()[0].headers[PROVIDER_OVERRIDE_HEADER]).toBeUndefined();
});

// A lost connection or server error is not a verdict on the file and is not the
// image-label warning: the file keeps its preview and hash, and can be retried.
const serverHash = async (form) => ({
  source_sha256: await hashOf(form.get('image')),
  dimensions: { width: 40, height: 24 },
});

test('a network failure on the second reference keeps its preview and hash and is not the label warning', async () => {
  let outage = true;
  setup({
    initialPrompt: MINE,
    overrides: {
      [ANALYZE]: async (form) => {
        const context = JSON.parse(form.get('context'));
        if (context.reference_images.length === 1 && outage)
          return networkFailure();
        return {
          ...clone(editing.analysis.additional.response),
          ...(await serverHash(form)),
          description: `Described ${form.get('image').name}`,
          suggested_prompt: '',
          warnings: [],
          reference_index: context.reference_images.length + 1,
          revision: context.revision,
        };
      },
    },
  });
  render(<App jobPolicy={jobPolicy} />);
  await openStandardControls();
  type(MINE);
  await attach([fileN(1)]);
  await attach([fileN(2)]);
  await waitFor(() =>
    expect(within(region()).getByText(/The API is unreachable\./)).toBeTruthy(),
  );
  expect(notice()).toBeNull();
  expect(rows()).toHaveLength(2);
  const [first, second] = rows();
  expect(first.getAttribute('data-status')).toBe('ready');
  expect(second.getAttribute('data-status')).toBe('ready');
  expect(
    second.querySelector('.ref-status[data-tone="warning"]'),
  ).not.toBeNull();
  expect(within(second).queryByRole('alert')).toBeNull();
  expect(second.querySelector('.ref-media img')).not.toBeNull();
  expect(prompt().value).toBe(MINE);
  expect(bar().disabled).toBe(false);

  outage = false;
  fireEvent.click(
    within(region()).getByRole('button', { name: 'Retry reference 2' }),
  );
  await settled();
  await waitFor(() =>
    expect(within(region()).queryByText(/Not described/)).toBeNull(),
  );
  expect(rows()[1].textContent).toContain('Described ref-2.png');
  expect(api.called(INSPECT)).toHaveLength(0);
});

test.each([
  ['a lost connection', () => networkFailure()],
  ['a server error', () => respond(503, { detail: 'busy' })],
])(
  'without crypto, %s on a valid file takes its hash from the checksum inspection',
  async (_name, fail) => {
    vi.stubGlobal('crypto', { randomUUID: () => `k-${++urlCount}` });
    setup({
      initialPrompt: MINE,
      overrides: {
        [INSPECT]: async (form) => ({
          ...(await serverHash(form)),
          metadata: { inspection: { provider: 'local', method: 'sha256' } },
        }),
        [ANALYZE]: async (form) => {
          const context = JSON.parse(form.get('context'));
          if (context.reference_images.length === 1) return fail();
          return {
            ...clone(editing.analysis.additional.response),
            ...(await serverHash(form)),
            description: `Described ${form.get('image').name}`,
            suggested_prompt: '',
            warnings: [],
            reference_index: 1,
            revision: context.revision,
          };
        },
      },
    });
    render(<App jobPolicy={jobPolicy} />);
    await openStandardControls();
    type(MINE);
    await attach([fileN(1)]);
    await attach([fileN(2)]);
    await waitFor(() =>
      expect(rows()[1].getAttribute('data-status')).toBe('ready'),
    );
    expect(api.called(INSPECT)).toHaveLength(1);
    expect(rows()[1].querySelector('.ref-media img')).not.toBeNull();
    expect(notice()).toBeNull();
    expect(bar().disabled).toBe(false);
    fireEvent.click(bar());
    await waitFor(() => expect(api.called(GENERATE)).toHaveLength(1));
    const [call] = api.called(GENERATE);
    expect(call.body.get('reference_2').name).toBe('ref-2.png');
  },
);

test('without crypto, a failure with no inspection hash blocks instead of guessing', async () => {
  vi.stubGlobal('crypto', { randomUUID: () => `k-${++urlCount}` });
  setup({
    overrides: {
      [INSPECT]: () => networkFailure(),
      [ANALYZE]: async (form) => {
        const context = JSON.parse(form.get('context'));
        if (context.reference_images.length === 1) return networkFailure();
        return {
          ...clone(editing.analysis.additional.response),
          ...(await serverHash(form)),
          description: 'Described',
          suggested_prompt: '',
          warnings: [],
          reference_index: 1,
          revision: context.revision,
        };
      },
    },
  });
  render(<App jobPolicy={jobPolicy} />);
  await openStandardControls();
  type(MINE);
  await attach([fileN(1)]);
  await attach([fileN(2)]);
  await waitFor(() =>
    expect(rows()[1].getAttribute('data-status')).toBe('error'),
  );
  expect(bar().disabled).toBe(true);
});
