import React, { StrictMode } from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import App from './App.jsx';
import { useStudio } from './studio.js';
import {
  clone,
  completeStatus,
  fakeLibrary,
  fixtures,
  installApi,
  respond,
  sizedRecord,
} from './testSupport.js';
import { openStandardControls } from './controlUiTestSupport.js';
import { normalizeClientPolicy } from './clientPolicy.js';

const IMPORT = 'POST /api/images/import-analysis';
const GENERATE = 'POST /api/generate-image';
const DYNAMIC = 'POST /api/controls/dynamic';
const policy = normalizeClientPolicy({
  controls: { debounce_ms: 20, reset_debounce_ms: 5 },
});
const sha = 'a'.repeat(64);
const file = (name = 'red.png') =>
  new File([new Uint8Array([137, 80, 78, 71])], name, { type: 'image/png' });
function observed(form, { status = 'ready' } = {}) {
  const binding = JSON.parse(form.get('context'));
  const blue = form.get('image').name === 'blue.png';
  const value = blue ? 'cool' : 'warm';
  const base = clone(fixtures.m1.static_standard.controls).map((wire) => ({
    ...wire,
    origin: 'fixed',
    apply_to_generation: true,
  }));
  const color = base.find((wire) => wire.id === 'color');
  color.value = value;
  color.options = { warm: 'Warm', cool: 'Cool', natural: 'Natural' };
  const controls = [
    ...base,
    ...['multi-select', 'checkbox'].map((kind, i) => ({
      id: `generated_${i}_observed`,
      origin: 'generated',
      kind,
      label: i ? 'Observed markings' : 'Observed details',
      options: {
        warm: 'Red surface',
        cool: 'Blue surface',
        neutral: 'Neutral surface',
      },
      value: [value],
      selection_provenance: {
        version: 1,
        source: 'suggested',
        anchor: 'pixel-fixture',
        effect: 'value',
      },
    })),
  ];
  return {
    mode: 'description',
    prompt_source: 'description',
    prompt: blue ? 'A blue object' : 'A red object',
    description: {
      status: 'ready',
      text: blue ? 'A blue object' : 'A red object',
    },
    binding,
    source_sha256: sha,
    image_controls:
      status === 'ready'
        ? {
            status,
            controls,
            dynamic_controls_metadata: {
              provider: 'mock-vision',
              source_sha256: sha,
            },
          }
        : {
            status,
            message: 'Synthetic vision controls failed',
            details: {
              failure: { http_status: 503, body: 'exact mocked body' },
            },
          },
  };
}
function setup(overrides = {}) {
  return installApi({
    ...fakeLibrary([]).routes,
    'GET /api/app-capabilities': () => ({
      ...fixtures.m3.capabilities,
      uploads: {
        ...fixtures.m3.capabilities.uploads,
        image_grounded_controls: true,
      },
    }),
    [IMPORT]: (form) => observed(form),
    [GENERATE]: () => respond(202, fixtures.m1.accepted),
    'GET /api/generation-jobs/fixture-image-1': () => completeStatus(),
    ...overrides,
  });
}
beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, '', '/');
  URL.createObjectURL = vi.fn(() => 'blob:visual-import');
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(Math, 'random').mockReturnValue(0.99);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const choose = (image) =>
  fireEvent.change(document.querySelector('input[type=file]'), {
    target: { files: [image] },
  });

for (const name of ['red.png', 'blue.png'])
  test(`StrictMode ${name}: exact observed chips are submitted once without dynamic controls or upload references`, async () => {
    const api = setup();
    render(
      <StrictMode>
        <App clientPolicy={policy} jobPolicy={{ pollIntervalMs: 1 }} />
      </StrictMode>,
    );
    await openStandardControls();
    choose(file(name));
    await waitFor(() => expect(api.called(GENERATE)).toHaveLength(1));
    const { body } = api.called(GENERATE)[0];
    const expected = name === 'blue.png' ? 'cool' : 'warm';
    expect(
      body.controls
        .filter((c) => c.id.startsWith('generated_'))
        .map((c) => c.value),
    ).toEqual([[expected], [expected]]);
    expect(body.controls.find((c) => c.id === 'color').value).toBe(expected);
    expect(body.dynamic_controls_metadata.import_source.source_sha256).toBe(
      sha,
    );
    expect(body.reference_images).toBeUndefined();
    expect(body.generation_mode).toBe('standard');
    expect(api.called(DYNAMIC)).toHaveLength(0);
    await screen.findAllByRole('checkbox', {
      name: name === 'blue.png' ? 'Blue surface' : 'Red surface',
    });
    expect(
      screen
        .getAllByRole('checkbox', {
          name: name === 'blue.png' ? 'Blue surface' : 'Red surface',
        })
        .every((c) => c.checked),
    ).toBe(true);
    expect(document.querySelectorAll('.generate-btn')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Use as prompt' }));
    await waitFor(() => expect(api.called(GENERATE)).toHaveLength(1));
    expect(api.called(DYNAMIC)).toHaveLength(0);
  });

for (const change of ['prompt', 'aspect', 'mode', 'new', 'dismiss', 'unmount'])
  test(`delayed pixel choices cannot overwrite ${change}`, async () => {
    let answer, form;
    const api = setup({
      [IMPORT]: (body) => {
        form = body;
        return new Promise((resolve) => {
          answer = resolve;
        });
      },
    });
    const hook = renderHook(() => useStudio({ clientPolicy: policy }));
    await waitFor(() => expect(hook.result.current.base.status).toBe('ready'));
    act(() => {
      hook.result.current.importImage(file());
    });
    await waitFor(() => expect(answer).toBeTypeOf('function'));
    act(() => {
      if (change === 'prompt') hook.result.current.setPrompt('My edited idea');
      if (change === 'aspect') hook.result.current.setAspect('1:1');
      if (change === 'mode') hook.result.current.setMode('asset-image');
      if (change === 'new') hook.result.current.newDraft();
      if (change === 'dismiss') hook.result.current.dismissImport();
      if (change === 'unmount') hook.unmount();
    });
    await act(async () => answer(observed(form)));
    expect(api.called(GENERATE)).toHaveLength(0);
    if (change !== 'unmount')
      expect(hook.result.current.draft.prompt).not.toBe('A red object');
  });

test('failed image controls preserve description; explicit controls retry submits once, description retry never submits or edits', async () => {
  let count = 0;
  const api = setup({
    [IMPORT]: (form) =>
      observed(form, { status: ++count <= 2 ? 'error' : 'ready' }),
  });
  render(<App clientPolicy={policy} jobPolicy={{ pollIntervalMs: 1 }} />);
  await openStandardControls();
  choose(file());
  await screen.findByRole('button', { name: 'Retry image controls' });
  expect(screen.getByLabelText('Image idea').value).toBe('A red object');
  expect(
    screen.getByRole('region', { name: 'Image description' }).textContent,
  ).toContain('A red object');
  expect(api.called(GENERATE)).toHaveLength(0);
  expect(api.called(DYNAMIC)).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Retry image controls' }));
  await waitFor(() => expect(api.called(GENERATE)).toHaveLength(1));
  expect(JSON.parse(api.called(IMPORT)[2].body.get('context')).action).toBe(
    'retry-controls',
  );
});

test('provider change and a newer file own their results; reload never replays an import', async () => {
  const answers = [];
  const api = setup({
    [IMPORT]: (form) =>
      new Promise((resolve) => answers.push(() => resolve(observed(form)))),
  });
  const hook = renderHook(
    ({ provider }) => useStudio({ clientPolicy: policy, provider }),
    { initialProps: { provider: { id: 'one', header: null } } },
  );
  await waitFor(() => expect(hook.result.current.base.status).toBe('ready'));
  act(() => {
    hook.result.current.importImage(file());
  });
  await waitFor(() => expect(answers).toHaveLength(1));
  hook.rerender({ provider: { id: 'two', header: null } });
  await act(async () => answers[0]());
  expect(hook.result.current.draft.prompt).toBe('');
  act(() => {
    hook.result.current.importImage(file());
  });
  await waitFor(() => expect(answers).toHaveLength(2));
  act(() => {
    hook.result.current.importImage(file('blue.png'));
  });
  await waitFor(() => expect(answers).toHaveLength(3));
  await act(async () => answers[1]());
  expect(api.called(GENERATE)).toHaveLength(0);
  await act(async () => answers[2]());
  await waitFor(() => expect(answers).toHaveLength(4));
  await act(async () => answers[3]());
  await waitFor(() => expect(api.called(GENERATE)).toHaveLength(1));
  expect(api.called(GENERATE)[0].body.prompt).toBe('A blue object');
  hook.unmount();
  const restored = renderHook(() => useStudio({ clientPolicy: policy }));
  await waitFor(() =>
    expect(restored.result.current.base.status).toBe('ready'),
  );
  expect(api.called(GENERATE)).toHaveLength(1);
  expect(api.called(IMPORT)).toHaveLength(4);
});

test('lost automatic answer retries the identical frozen body/key without controls regeneration', async () => {
  let lost = true;
  const api = setup({
    [GENERATE]: () => {
      if (lost) throw new TypeError('Synthetic lost response');
      return respond(202, fixtures.m1.accepted);
    },
  });
  const hook = renderHook(() =>
    useStudio({ clientPolicy: policy, jobPolicy: { pollIntervalMs: 1 } }),
  );
  await waitFor(() => expect(hook.result.current.base.status).toBe('ready'));
  await act(async () => hook.result.current.importImage(file()));
  await waitFor(() => expect(api.called(GENERATE)).toHaveLength(1));
  await waitFor(() => expect(hook.result.current.job.phase).toBe('failed'));
  const frozen = clone(api.called(GENERATE)[0].body);
  lost = false;
  await act(async () => hook.result.current.retry());
  await waitFor(() => expect(api.called(GENERATE)).toHaveLength(2));
  expect(api.called(GENERATE)[1].body).toEqual(frozen);
  expect(api.called(DYNAMIC)).toHaveLength(0);
});

test('description-only retry keeps the edited snapshot and starts no job', async () => {
  const api = setup({
    [IMPORT]: (form) => observed(form, { status: 'error' }),
  });
  const hook = renderHook(() => useStudio({ clientPolicy: policy }));
  await waitFor(() => expect(hook.result.current.base.status).toBe('ready'));
  await act(async () => hook.result.current.importImage(file()));
  act(() => hook.result.current.setPrompt('My manual prompt'));
  const before = clone(hook.result.current.entries);
  await act(async () => hook.result.current.retryImportDescription());
  expect(hook.result.current.draft.prompt).toBe('My manual prompt');
  expect(hook.result.current.entries).toEqual(before);
  expect(JSON.parse(api.called(IMPORT)[2].body.get('context')).action).toBe(
    'description-only',
  );
  expect(api.called(GENERATE)).toHaveLength(0);
});

test('controls retry after a manual edit cannot overwrite that edit or submit', async () => {
  const api = setup({
    [IMPORT]: (form) => observed(form, { status: 'error' }),
  });
  const hook = renderHook(() => useStudio({ clientPolicy: policy }));
  await waitFor(() => expect(hook.result.current.base.status).toBe('ready'));
  await act(async () => hook.result.current.importImage(file()));
  act(() => hook.result.current.setPrompt('My revised scene'));
  await act(async () => hook.result.current.retryImportControls());
  expect(hook.result.current.draft.prompt).toBe('My revised scene');
  expect(api.called(IMPORT)).toHaveLength(2);
  expect(api.called(GENERATE)).toHaveLength(0);
});

test('exact embedded choices auto-submit once and never call dynamic controls', async () => {
  const snapshot = clone(fixtures.m3.import_metadata);
  const api = setup({
    [IMPORT]: (form) => ({
      ...snapshot,
      binding: JSON.parse(form.get('context')),
      source_sha256: sha,
    }),
  });
  const hook = renderHook(() =>
    useStudio({ clientPolicy: policy, jobPolicy: { pollIntervalMs: 1 } }),
  );
  await waitFor(() => expect(hook.result.current.base.status).toBe('ready'));
  await act(async () => hook.result.current.importImage(file()));
  await waitFor(() => expect(api.called(GENERATE)).toHaveLength(1));
  const body = api.called(GENERATE)[0].body;
  for (const wire of snapshot.image.selected_controls) {
    expect(body.controls.find((c) => c.id === wire.id)?.value).toEqual(
      wire.value,
    );
  }
  expect(body.dynamic_controls_metadata.import_source.source_sha256).toBe(sha);
  expect(api.called(DYNAMIC)).toHaveLength(0);
  expect(api.called(IMPORT)).toHaveLength(1);
  expect(hook.result.current.importState.progress.restored).toBe(true);
});

test('mismatched request binding retains the description but never applies or generates', async () => {
  const api = setup({
    [IMPORT]: (form) => ({
      ...observed(form),
      binding: { ...JSON.parse(form.get('context')), request_id: 'different' },
    }),
  });
  const hook = renderHook(() => useStudio({ clientPolicy: policy }));
  await waitFor(() => expect(hook.result.current.base.status).toBe('ready'));
  await act(async () => hook.result.current.importImage(file()));
  expect(hook.result.current.draft.prompt).toBe('');
  expect(hook.result.current.importState.description).toBe('A red object');
  expect(hook.result.current.importState.error.message).toContain(
    'do not match',
  );
  expect(api.called(GENERATE)).toHaveLength(0);
});

const pending = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const progressSteps = () =>
  [...document.querySelectorAll('.stage .progress li')].map((node) => ({
    label: node.textContent,
    state: node.dataset.state,
  }));

test('real deferred photo/control requests hand validated options to exactly one existing job overlay', async () => {
  const photo = pending(),
    controls = pending(),
    accept = pending();
  const forms = [];
  const api = setup({
    ...fakeLibrary([
      sizedRecord('prior', 600, 900, { title: 'Prior portrait' }),
    ]).routes,
    [IMPORT]: async (form) => {
      forms.push(form);
      await (forms.length === 1 ? photo : controls).promise;
      const response = observed(form);
      if (forms.length === 1) delete response.image_controls;
      else
        response.prompt =
          'This second response must not replace the description';
      return response;
    },
    [GENERATE]: async () => {
      await accept.promise;
      return respond(202, fixtures.m1.accepted);
    },
    'GET /api/generation-jobs/fixture-image-1': () => fixtures.m1.job_running,
  });
  render(
    <StrictMode>
      <App clientPolicy={policy} jobPolicy={{ pollIntervalMs: 10 }} />
    </StrictMode>,
  );
  await openStandardControls();
  fireEvent.click(
    await screen.findByRole('button', { name: 'Prior portrait' }),
  );
  await screen.findByRole('heading', { name: 'Prior portrait' });
  const priorImage = document.querySelector('.stage-img').getAttribute('src');
  const priorPills = document.querySelector('.stage-pills').textContent;
  choose(file());
  await waitFor(() => expect(forms).toHaveLength(1));
  expect(progressSteps().map((s) => s.state)).toEqual([
    'active',
    'todo',
    'todo',
    'todo',
  ]);
  expect(document.querySelector('.stage [role=status]').textContent).toBe(
    'Analyzing photo',
  );
  expect(api.called(GENERATE)).toHaveLength(0);
  expect(document.querySelector('.stage-img').getAttribute('src')).toBe(
    priorImage,
  );
  expect(document.querySelector('.stage-pills').textContent).toBe(priorPills);
  await act(async () => photo.resolve());
  await waitFor(() => expect(forms).toHaveLength(2));
  expect(progressSteps().map((s) => s.state)).toEqual([
    'done',
    'active',
    'todo',
    'todo',
  ]);
  expect(document.querySelector('.stage-img').getAttribute('src')).toBe(
    priorImage,
  );
  expect(document.querySelector('.stage-pills').textContent).toBe(priorPills);
  const first = JSON.parse(forms[0].get('context'));
  const second = JSON.parse(forms[1].get('context'));
  expect(first.action).toBe('description-only');
  expect(second).toEqual({ ...first, action: 'retry-controls' });
  expect(forms[0].get('image')).toBe(forms[1].get('image'));
  expect(api.called(GENERATE)).toHaveLength(0);
  await act(async () => controls.resolve());
  await waitFor(() => expect(api.called(GENERATE)).toHaveLength(1));
  expect(progressSteps().map((s) => s.state)).toEqual([
    'done',
    'done',
    'done',
    'active',
  ]);
  expect(document.querySelectorAll('.stage .progress')).toHaveLength(1);
  expect(
    document.querySelector('.stage .progress [role=status]').textContent,
  ).toContain('Generating image');
  expect(api.called(GENERATE)[0].body.prompt).toBe('A red object');
  expect(
    api.called(GENERATE)[0].body.controls.find((c) => c.id === 'color').value,
  ).toBe('warm');
  await act(async () => accept.resolve());
  await waitFor(() =>
    expect(document.querySelector('.progress-detail').textContent).toBe(
      'Rendering',
    ),
  );
  expect(api.called(GENERATE)).toHaveLength(1);
  expect(api.called(DYNAMIC)).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'New draft' }));
  await waitFor(() =>
    expect(document.querySelector('.progress[data-import=true]')).toBeNull(),
  );
});

for (const change of [
  'prompt',
  'aspect',
  'mode',
  'provider',
  'new',
  'dismiss',
  'unmount',
])
  test(`during the real controls phase ${change} ends overlay ownership and rejects late choices`, async () => {
    const controls = pending();
    let controlForm;
    const api = setup({
      [IMPORT]: (form) => {
        if (JSON.parse(form.get('context')).action === 'description-only')
          return observed(form);
        controlForm = form;
        return controls.promise;
      },
    });
    const hook = renderHook(
      ({ provider }) => useStudio({ clientPolicy: policy, provider }),
      { initialProps: { provider: { id: 'one', header: null } } },
    );
    await waitFor(() => expect(hook.result.current.base.status).toBe('ready'));
    act(() => {
      hook.result.current.importImage(file());
    });
    await waitFor(() =>
      expect(hook.result.current.importState.progress?.step).toBe('controls'),
    );
    act(() => {
      if (change === 'prompt') hook.result.current.setPrompt('Manual edit');
      if (change === 'aspect') hook.result.current.setAspect('1:1');
      if (change === 'mode') hook.result.current.setMode('asset-image');
      if (change === 'provider')
        hook.rerender({ provider: { id: 'two', header: null } });
      if (change === 'new') hook.result.current.newDraft();
      if (change === 'dismiss') hook.result.current.dismissImport();
      if (change === 'unmount') hook.unmount();
    });
    if (change !== 'unmount')
      expect(hook.result.current.importState.progress).toBeNull();
    await act(async () => controls.resolve(observed(controlForm)));
    expect(api.called(GENERATE)).toHaveLength(0);
    if (change !== 'unmount')
      expect(hook.result.current.draft.prompt).not.toBe('A red object');
  });

test('changed source hash at the second boundary cannot apply controls or generate', async () => {
  let mismatch = true;
  const api = setup({
    [IMPORT]: (form) => ({
      ...observed(form),
      source_sha256:
        mismatch && JSON.parse(form.get('context')).action === 'retry-controls'
          ? 'b'.repeat(64)
          : sha,
    }),
  });
  const hook = renderHook(() => useStudio({ clientPolicy: policy }));
  await waitFor(() => expect(hook.result.current.base.status).toBe('ready'));
  await act(async () => hook.result.current.importImage(file()));
  expect(hook.result.current.importState.progress).toBeNull();
  expect(hook.result.current.importState.error.message).toContain(
    'source image changed',
  );
  expect(api.called(GENERATE)).toHaveLength(0);
  await act(async () => hook.result.current.retryImportControls());
  expect(api.called(IMPORT)).toHaveLength(2);
  expect(api.called(GENERATE)).toHaveLength(0);
  expect(hook.result.current.importState.progress).toBeNull();
  expect(hook.result.current.importState.error.message).toContain(
    'Load the image again',
  );
  mismatch = false;
  await act(async () => hook.result.current.retryImport());
  await waitFor(() => expect(api.called(GENERATE)).toHaveLength(1));
  expect(api.called(GENERATE)[0].body.prompt).toBe('A red object');
});

test('controls transport failure retains the first description and retries only controls', async () => {
  let fail = true;
  const api = setup({
    [IMPORT]: (form) => {
      if (fail && JSON.parse(form.get('context')).action === 'retry-controls')
        throw new TypeError('Mock connection lost');
      return observed(form);
    },
  });
  const hook = renderHook(() =>
    useStudio({ clientPolicy: policy, jobPolicy: { pollIntervalMs: 1 } }),
  );
  await waitFor(() => expect(hook.result.current.base.status).toBe('ready'));
  await act(async () => hook.result.current.importImage(file()));
  expect(hook.result.current.draft.prompt).toBe('A red object');
  expect(hook.result.current.importState.progress).toBeNull();
  expect(api.called(GENERATE)).toHaveLength(0);
  fail = false;
  await act(async () => hook.result.current.retryImportControls());
  await waitFor(() => expect(api.called(GENERATE)).toHaveLength(1));
  expect(
    api.called(IMPORT).map((c) => JSON.parse(c.body.get('context')).action),
  ).toEqual(['description-only', 'retry-controls', 'retry-controls']);
});

for (const transport of ['network', 'server'])
  for (const existingPrompt of ['', 'An unrelated earlier idea'])
    test(`first ${transport} failure requires full import retry with ${existingPrompt ? 'an earlier' : 'a blank'} prompt`, async () => {
      let fail = true;
      const api = setup({
        [IMPORT]: (form) => {
          if (fail) {
            if (transport === 'network')
              throw new TypeError('Mock connection lost');
            return respond(503, { message: 'Mock analysis unavailable' });
          }
          return observed(form);
        },
      });
      render(<App clientPolicy={policy} jobPolicy={{ pollIntervalMs: 1 }} />);
      await openStandardControls();
      if (existingPrompt)
        fireEvent.change(screen.getByLabelText('Image idea'), {
          target: { value: existingPrompt },
        });
      choose(file());
      await screen.findByRole('button', { name: 'Retry import' });
      expect(
        screen.queryByRole('button', { name: 'Retry image controls' }),
      ).toBeNull();
      expect(screen.queryByText('Generating image…')).toBeNull();
      expect(api.called(GENERATE)).toHaveLength(0);
      expect(screen.getByLabelText('Image idea').value).toBe(existingPrompt);
      fail = false;
      fireEvent.click(screen.getByRole('button', { name: 'Retry import' }));
      await waitFor(() => expect(api.called(GENERATE)).toHaveLength(1));
      expect(api.called(GENERATE)[0].body.prompt).toBe('A red object');
      expect(
        api.called(IMPORT).map((c) => JSON.parse(c.body.get('context')).action),
      ).toEqual(['description-only', 'description-only', 'retry-controls']);
    });

test('disabled inference finishes analysis without a controls request or generation', async () => {
  const api = setup({
    'GET /healthz': () => ({ ...fixtures.m1.health, inference_enabled: false }),
    [IMPORT]: (form) => ({
      ...observed(form),
      prompt: '',
      description: {
        status: 'unavailable',
        text: null,
        message: 'Inference is disabled',
      },
    }),
  });
  const hook = renderHook(() => useStudio({ clientPolicy: policy }));
  await waitFor(() => expect(hook.result.current.inferenceOff).toBe(true));
  await act(async () => hook.result.current.importImage(file()));
  expect(api.called(IMPORT)).toHaveLength(1);
  expect(api.called(GENERATE)).toHaveLength(0);
  expect(hook.result.current.importState.progress).toBeNull();
  expect(hook.result.current.importState.descriptionStatus.status).toBe(
    'unavailable',
  );
});

test('ComfyUI first-response prompt and provenance survive the controls boundary', async () => {
  const api = setup({
    [IMPORT]: (form) => ({
      ...observed(form),
      mode: 'comfyui',
      prompt:
        JSON.parse(form.get('context')).action === 'description-only'
          ? 'A violet paper bird'
          : 'Second response prompt',
      prompt_source: 'comfyui-workflow',
      metadata_notice: 'Synthetic metadata notice',
    }),
  });
  const hook = renderHook(() =>
    useStudio({ clientPolicy: policy, jobPolicy: { pollIntervalMs: 1 } }),
  );
  await waitFor(() => expect(hook.result.current.base.status).toBe('ready'));
  await act(async () => hook.result.current.importImage(file()));
  await waitFor(() => expect(api.called(GENERATE)).toHaveLength(1));
  const sent = api.called(GENERATE)[0].body;
  expect(sent.prompt).toBe('A violet paper bird');
  expect(sent.dynamic_controls_metadata.import_source.prompt_source).toBe(
    'comfyui-workflow',
  );
  expect(sent.dynamic_controls_metadata.import_source.description).toBe(
    'A red object',
  );
  expect(hook.result.current.importState.metadataNotice).toBe(
    'Synthetic metadata notice',
  );
});
