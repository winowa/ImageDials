import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useStudio } from './studio.js';
import { normalizeClientPolicy } from './clientPolicy.js';
import {
  fakeLibrary,
  fixtures,
  installApi,
  respond,
  clone,
  libraryRecord,
} from './testSupport.js';
import expanded from '../../fixtures/api/expanded-static-controls.json';
import editing from '../../fixtures/api/image-editing.json';
import { createEntries, GROUP, setValue } from './controls.js';
import { sha256Hex } from './privateThumbnail.js';

const { m1 } = fixtures;
const DYNAMIC = 'POST /api/controls/dynamic';
const GENERATE = 'POST /api/generate-image';
const STATIC = 'GET /api/controls/static?generation_mode=standard';
const policy = normalizeClientPolicy({
  controls: { debounce_ms: 30, reset_debounce_ms: 10, max_attempts: 1 },
});
const pausedPolicy = normalizeClientPolicy({
  controls: { debounce_ms: 5000, reset_debounce_ms: 5000, max_attempts: 1 },
});
const jobPolicy = { pollIntervalMs: 1, maxConsecutivePollFailures: 1 };
const hold = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const wire = (id, extra = {}) => ({
  id,
  kind: 'text-input',
  label: id,
  value: 'default',
  ...extra,
});
const response = (
  controls = [wire('new')],
  standard_selections = { style: ['watercolor'] },
) => ({
  controls,
  standard_selections,
  dynamic_controls_metadata: {
    suggestion_anchor: 'fixture-anchor',
    raw_response: 'opaque evidence',
  },
});
let api;
function setup(routes = {}, capabilities = {}) {
  api = installApi({
    ...fakeLibrary([]).routes,
    'GET /api/app-capabilities': () => ({
      ...m1.capabilities,
      control_application: { enabled: true, text_flag: 'apply_to_generation' },
      uploads: { image_mime_types: ['image/png'], import_max_bytes: 33554432 },
      image_editing: editing.capabilities,
      ...capabilities,
    }),
    [STATIC]: () => expanded.standard,
    [DYNAMIC]: () => response(),
    [GENERATE]: () => respond(202, m1.accepted),
    'GET /api/generation-jobs/fixture-image-1': () =>
      clone(
        fixtures.m1.complete ?? {
          ...editing.generation.complete,
          generation_job_id: 'fixture-image-1',
        },
      ),
    ...routes,
  });
}
async function start(
  options = {},
  initialProvider = { id: 'one', header: null },
) {
  const hook = renderHook(
    ({ provider }) =>
      useStudio({
        clientPolicy: pausedPolicy,
        jobPolicy,
        provider,
        ...options,
      }),
    { initialProps: { provider: initialProvider } },
  );
  await waitFor(() => expect(hook.result.current.base.status).toBe('ready'));
  await waitFor(() =>
    expect(hook.result.current.discovery.models.status).toBe('ready'),
  );
  return hook;
}
const style = (hook) =>
  hook.result.current.entries.find((e) => e.wire.id === 'style');
const pause = async (ms = 90) =>
  act(() => new Promise((resolve) => setTimeout(resolve, ms)));
const body = () => {
  const sent = api.called(GENERATE).at(-1).body;
  return sent instanceof FormData ? JSON.parse(sent.get('request')) : sent;
};
beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, '', '/');
  vi.spyOn(Math, 'random').mockReturnValue(0.99);
  vi.stubGlobal(
    'URL',
    Object.assign(URL, {
      createObjectURL: vi.fn(() => 'blob:fixture'),
      revokeObjectURL: vi.fn(),
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('immediate Generate awaits same background flight and freezes settled suggestions with one call', async () => {
  const pending = hold();
  setup({ [DYNAMIC]: () => pending.promise });
  const hook = await start({ clientPolicy: policy });
  act(() => hook.result.current.setPrompt('A watercolor fox in snow'));
  await waitFor(() => expect(api.called(DYNAMIC)).toHaveLength(1));
  expect(style(hook).pending).toBe(true);
  act(() => {
    void hook.result.current.submit();
  });
  expect(api.called(GENERATE)).toHaveLength(0);
  await act(async () => {
    pending.resolve(response());
  });
  await waitFor(() => expect(api.called(GENERATE)).toHaveLength(1));
  expect(api.called(DYNAMIC)).toHaveLength(1);
  expect(body().controls.find((c) => c.id === 'style')).toMatchObject({
    value: ['watercolor'],
    selection_provenance: { source: 'suggested', anchor: 'fixture-anchor' },
  });
  expect(body().controls.some((c) => c.pending !== undefined)).toBe(false);
});

test.each(['value', 'reset', 'off-on', 'preset', 'apply', 'keep', 'resetBase'])(
  'same-turn %s consumes pending eligibility before response resolution without a render',
  async (mutation) => {
    const pending = hold();
    setup({ [DYNAMIC]: () => pending.promise });
    const hook = await start();
    act(() => hook.result.current.setPrompt('A watercolor fox in snow'));
    let request;
    act(() => {
      request = hook.result.current.regenerateOptions();
    });
    await waitFor(() => expect(api.called(DYNAMIC)).toHaveLength(1));
    const key = style(hook).key;
    await act(async () => {
      const studio = hook.result.current;
      if (mutation === 'value')
        studio.setValue(key, ['photography', 'cinematic', 'watercolor']);
      if (mutation === 'reset') studio.reset(key);
      if (mutation === 'off-on') {
        studio.setEnabled(key, false);
        studio.setEnabled(key, true);
      }
      if (mutation === 'preset')
        studio.applyControlEntries('Use preset', (entries) =>
          entries.map((e) => (e.key === key ? setValue(e, ['cinematic']) : e)),
        );
      if (mutation === 'apply') studio.setApplyToEdit(key, true);
      if (mutation === 'keep') studio.setApplyToEdit(key, false);
      if (mutation === 'resetBase') studio.resetBase();
      pending.resolve(response());
      await request;
    });
    expect(style(hook).wire.selection_provenance.source).toBe('explicit');
    expect(style(hook).pending).toBeUndefined();
    if (mutation === 'value')
      expect(style(hook).wire.value).toEqual([
        'photography',
        'cinematic',
        'watercolor',
      ]);
    if (mutation === 'preset')
      expect(style(hook).wire.value).toEqual(['cinematic']);
    if (['reset', 'resetBase', 'off-on', 'apply', 'keep'].includes(mutation))
      expect(style(hook).wire.value).toEqual(
        expanded.standard.controls.find((c) => c.id === 'style').value,
      );
  },
);

test.each(['mode', 'episode', 'unmount', 'provider', 'undo', 'remove'])(
  'late answer ignored after %s even if abort ignored',
  async (change) => {
    const pending = hold();
    setup({ [DYNAMIC]: () => pending.promise });
    const hook = await start();
    act(() => hook.result.current.setPrompt('A watercolor fox in snow'));
    if (change === 'remove')
      act(() =>
        hook.result.current.applyControlEntries('Add removable', (entries) => [
          ...entries,
          ...createEntries([wire('new')], GROUP.generated),
        ]),
      );
    let request;
    act(() => {
      request = hook.result.current.regenerateOptions();
    });
    await waitFor(() => expect(api.called(DYNAMIC)).toHaveLength(1));
    if (change === 'provider')
      hook.rerender({ provider: { id: 'two', header: null } });
    else if (change === 'unmount') hook.unmount();
    else
      act(() => {
        if (change === 'mode') hook.result.current.setMode('asset-image');
        if (change === 'episode') {
          hook.result.current.setPrompt('Underwater jellyfish');
          hook.result.current.setValue(style(hook).key, ['photography']);
        }
        if (change === 'undo') hook.result.current.undoDraft();
        if (change === 'remove') hook.result.current.remove('generated:new');
      });
    await act(async () => {
      pending.resolve(response([wire('late')]));
      await request;
    });
    expect(hook.result.current.entries.some((e) => e.wire.id === 'late')).toBe(
      false,
    );
  },
);

test('whole capacity refusal preserves entries, both metadata kinds and pending expansion; no job and no auto loop', async () => {
  const expansion = hold();
  setup({
    [DYNAMIC]: () =>
      response(Array.from({ length: 8 }, (_, i) => wire(`incoming${i}`))),
    'POST /api/controls/options': () => expansion.promise,
  });
  const hook = await start({ clientPolicy: policy });
  act(() => hook.result.current.setPrompt('A fox in snow'));
  act(() =>
    hook.result.current.applyControlEntries('Use controls', (entries) => [
      ...entries,
      ...createEntries(
        Array.from({ length: 23 }, (_, i) => wire(`old${i}`)),
        GROUP.generated,
      ),
    ]),
  );
  const before = hook.result.current.entries;
  // This record is already over limit and must be preserved without request/job.
  act(() => {
    void hook.result.current.submit();
  });
  await waitFor(() =>
    expect(hook.result.current.notice?.text).toMatch(/Too many controls/),
  );
  expect(api.called(GENERATE)).toHaveLength(0);
  expect(hook.result.current.entries).toBe(before);
  // Remove 8, leaving 8 base + 15 retained: refresh union would be 31.
  act(() => {
    for (let i = 15; i < 23; i++)
      hook.result.current.remove(`generated:old${i}`);
  });
  const legal = hook.result.current.entries;
  await act(async () => {
    await hook.result.current.regenerateOptions();
  });
  expect(hook.result.current.capacityError).toMatchObject({
    count: 31,
    limit: 30,
  });
  expect(
    hook.result.current.entries.filter(
      (entry) => entry.group === GROUP.generated,
    ),
  ).toEqual(legal.filter((entry) => entry.group === GROUP.generated));
  for (const entry of legal.filter((entry) => entry.group === GROUP.generated))
    expect(
      hook.result.current.entries.find((current) => current.key === entry.key),
    ).toBe(entry);
  expect(style(hook).pending).toBeUndefined();
  expect(style(hook).wire.value).toEqual(['watercolor']);
  expect(hook.result.current.dynamic.metadata).toBeNull();
  await pause();
  expect(api.called(DYNAMIC)).toHaveLength(1);
  act(() => hook.result.current.remove('generated:old14'));
  await act(async () => {
    await hook.result.current.regenerateOptions();
  });
  expect(hook.result.current.entries).toHaveLength(30);
  expect(hook.result.current.capacityError).toBeNull();
  expect(api.called(DYNAMIC)).toHaveLength(2);
});

test.each([
  ['duplicate generated IDs', [wire('duplicate'), wire('duplicate')]],
  ['a Standard ID collision', [wire('style')]],
])(
  'Generate falls back to Standard controls after %s',
  async (_name, controls) => {
    setup({ [DYNAMIC]: () => response(controls) });
    const hook = await start();
    act(() => hook.result.current.setPrompt('A watercolor fox in snow'));
    await act(async () => {
      await hook.result.current.submit();
    });
    expect(api.called(DYNAMIC)).toHaveLength(1);
    expect(api.called(GENERATE)).toHaveLength(1);
    expect(body().controls).toHaveLength(expanded.standard.controls.length);
    expect(body().controls.map((control) => control.id)).toEqual(
      expanded.standard.controls.map((control) => control.id),
    );
    expect(hook.result.current.notice?.text).toMatch(
      /standard controls are used instead/,
    );
    expect(style(hook).pending).toBeUndefined();
  },
);

test('capacity refusal settles pending Standards without installing generated controls or creating a job', async () => {
  const pending = hold();
  setup(
    { [DYNAMIC]: () => pending.promise },
    { control_generation: { max_controls: 8 } },
  );
  const hook = await start({ clientPolicy: policy });
  act(() => hook.result.current.setPrompt('A watercolor fox in snow'));
  await waitFor(() => expect(api.called(DYNAMIC)).toHaveLength(1));
  expect(style(hook).pending).toBe(true);
  let submission;
  act(() => {
    submission = hook.result.current.submit();
  });
  await act(async () => {
    pending.resolve(response());
    await submission;
  });
  expect(hook.result.current.capacityError).toMatchObject({
    count: 9,
    limit: 8,
  });
  expect(hook.result.current.entries).toHaveLength(8);
  expect(style(hook).pending).toBeUndefined();
  expect(style(hook).wire).toMatchObject({
    value: ['watercolor'],
    selection_provenance: { source: 'suggested', anchor: 'fixture-anchor' },
  });
  expect(hook.result.current.dynamic.metadata).toBeNull();
  expect(api.called(GENERATE)).toHaveLength(0);
  expect(api.called(DYNAMIC)).toHaveLength(1);
});

test('saved restore and undo/redo suppress automatic work including catalog hydration', async () => {
  setup();
  const hook = await start({ clientPolicy: policy });
  const record = libraryRecord({
    id: 'restored',
    original_prompt: 'Restored fox',
    selected_controls: [
      wire('old', { origin: 'generated', apply_to_edit: false }),
    ],
  });
  await act(async () => {
    await hook.result.current.restore(record);
  });
  await waitFor(() =>
    expect(hook.result.current.draft.prompt).toBe('Restored fox'),
  );
  await pause();
  expect(api.called(DYNAMIC)).toHaveLength(0);
  act(() => hook.result.current.setValue('generated:old', 'manual'));
  act(() => hook.result.current.undoDraft());
  await pause();
  act(() => hook.result.current.redoDraft());
  await pause();
  expect(api.called(DYNAMIC)).toHaveLength(0);
  expect(
    hook.result.current.entries.find((e) => e.key === 'generated:old').wire
      .value,
  ).toBe('manual');
});

const file = (index = 0) =>
  new File(
    [
      Uint8Array.from(atob(editing.files[index].base64), (c) =>
        c.charCodeAt(0),
      ),
    ],
    `reference-${index}.png`,
    { type: 'image/png' },
  );
async function attach(hook, index = 0) {
  act(() => hook.result.current.references.add([file(index)]));
  await waitFor(() =>
    expect(hook.result.current.references.refs.at(-1)?.status).toBe('ready'),
  );
  await waitFor(() =>
    expect(hook.result.current.references.refs.at(-1)?.analyzing).toBe(false),
  );
}
const analysis = async (form) => {
  const context = JSON.parse(form.get('context'));
  return {
    ...clone(editing.analysis.first.response),
    source_sha256: await sha256Hex(form.get('image')),
    reference_index: context.reference_images.length + 1,
    revision: context.revision,
  };
};

test.each([false, true])(
  'applied X survives reference refresh and Generate reuses one fetch (background=%s)',
  async (background) => {
    setup({ 'POST /api/images/reference-analysis': analysis });
    const hook = await start({
      clientPolicy: background ? policy : pausedPolicy,
    });
    act(() => hook.result.current.setPrompt('Make the sky blue'));
    act(() =>
      hook.result.current.applyControlEntries('Add X', (entries) => [
        ...entries,
        ...createEntries([wire('X')], GROUP.generated),
      ]),
    );
    act(() => hook.result.current.setApplyToEdit('generated:X', true));
    await attach(hook);
    if (background)
      await waitFor(() =>
        expect(hook.result.current.dynamic.status).toBe('ready'),
      );
    act(() => {
      void hook.result.current.submit();
    });
    await waitFor(() => expect(api.called(GENERATE)).toHaveLength(1));
    expect(api.called(DYNAMIC)).toHaveLength(1);
    expect(body().controls.find((c) => c.id === 'X')).toMatchObject({
      value: 'default',
      apply_to_edit: true,
      selection_provenance: { source: 'explicit' },
    });
    expect(body().controls.find((c) => c.id === 'new').apply_to_edit).toBe(
      false,
    );
    expect(
      body().controls.find((c) => c.id === 'style').selection_provenance,
    ).toBeUndefined();
  },
);

test('late base catalog participates before dynamic admission and before Generate freezes', async () => {
  const pending = hold();
  setup({ [STATIC]: () => pending.promise });
  const hook = renderHook(() =>
    useStudio({ clientPolicy: pausedPolicy, jobPolicy }),
  );
  await waitFor(() =>
    expect(hook.result.current.discovery.models.status).toBe('ready'),
  );
  act(() => hook.result.current.setPrompt('A fox'));
  act(() => {
    void hook.result.current.submit();
  });
  await pause(10);
  expect(api.called(GENERATE)).toHaveLength(0);
  expect(api.called(DYNAMIC)).toHaveLength(0);
  await act(async () => {
    pending.resolve(expanded.standard);
  });
  await waitFor(() => expect(api.called(GENERATE)).toHaveLength(1));
  expect(api.called(STATIC)).toHaveLength(1);
  expect(body().controls.find((c) => c.id === 'style').value).toEqual([
    'watercolor',
  ]);
  expect(hook.result.current.standardSummary.pending).toBe(0);
});

test('inference off settles eligible fallback without requests; mount stays idle', async () => {
  setup({ 'GET /healthz': () => ({ ...m1.health, inference_enabled: false }) });
  const hook = await start({ clientPolicy: policy });
  await pause();
  expect(api.called(DYNAMIC)).toHaveLength(0);
  act(() => hook.result.current.setPrompt('A fox'));
  await pause();
  expect(api.called(DYNAMIC)).toHaveLength(0);
  expect(style(hook).pending).toBeUndefined();
  expect(style(hook).wire.selection_provenance.source).toBe('fallback-random');
});

test('failed/old-server calls settle fallback once before freeze; Refresh never reseeds', async () => {
  setup({ [DYNAMIC]: () => respond(503, { detail: 'fixture failure' }) });
  const hook = await start();
  act(() => hook.result.current.setPrompt('A fox'));
  act(() => {
    void hook.result.current.submit();
  });
  await waitFor(() => expect(api.called(GENERATE)).toHaveLength(1));
  expect(
    body().controls.find((c) => c.id === 'style').selection_provenance.source,
  ).toBe('fallback-random');
  const settled = style(hook).wire;
  api.routes[DYNAMIC] = () => response();
  await act(async () => {
    await hook.result.current.regenerateOptions();
  });
  expect(style(hook).wire).toBe(settled);
});

test('late ref answer cannot publish; final ordered refs debounce once then Generate reuses', async () => {
  const pending = hold();
  setup({
    [DYNAMIC]: () => pending.promise,
    'POST /api/images/reference-analysis': analysis,
  });
  const hook = await start({ clientPolicy: policy });
  act(() => hook.result.current.setPrompt('Make the sky blue'));
  await waitFor(() => expect(api.called(DYNAMIC)).toHaveLength(1));
  api.routes[DYNAMIC] = () => response([wire('current')]);
  await attach(hook);
  await act(async () => {
    pending.resolve(response([wire('old-ref-answer')]));
  });
  expect(
    hook.result.current.entries.some((e) => e.wire.id === 'old-ref-answer'),
  ).toBe(false);
  api.routes[DYNAMIC] = () => response([wire('current')]);
  await waitFor(() => expect(hook.result.current.dynamic.status).toBe('ready'));
  expect(hook.result.current.entries.some((e) => e.wire.id === 'current')).toBe(
    true,
  );
  const count = api.called(DYNAMIC).length;
  act(() => {
    void hook.result.current.submit();
  });
  await waitFor(() => expect(api.called(GENERATE)).toHaveLength(1));
  expect(api.called(DYNAMIC)).toHaveLength(count);
  expect(body().dynamic_controls_metadata).toEqual(
    response().dynamic_controls_metadata,
  );
});

test('overflow preserves both metadata owners and an in-flight option expansion exactly', async () => {
  const expansion = hold();
  const oldControls = Array.from({ length: 15 }, (_, i) => wire(`old${i}`));
  setup({
    [DYNAMIC]: () => response(oldControls),
    'POST /api/controls/additional': () => ({
      controls: [wire('added')],
      additional_controls_metadata: { opaque: ['earlier'] },
    }),
    'POST /api/add-control-options': () => expansion.promise,
  });
  const hook = await start({ clientPolicy: policy });
  act(() => hook.result.current.setPrompt('A fox'));
  await act(async () => {
    await hook.result.current.regenerateOptions();
  });
  await act(async () => {
    await hook.result.current.addControls();
  });
  act(() => hook.result.current.keepAllSources());
  act(() => {
    void hook.result.current.expand(style(hook).key);
  });
  await waitFor(() =>
    expect(api.called('POST /api/add-control-options')).toHaveLength(1),
  );
  const { entries, dynamic, additionalMetadata, expansions } =
    hook.result.current;
  api.routes[DYNAMIC] = () =>
    response(Array.from({ length: 8 }, (_, i) => wire(`fresh${i}`)));
  await act(async () => {
    await hook.result.current.regenerateOptions();
  });
  const after = hook.result.current;
  expect(after.capacityError).toMatchObject({ refused: 'capacity', count: 32 });
  expect(after.entries).toBe(entries);
  expect(after.dynamic.metadata).toBe(dynamic.metadata);
  expect(after.dynamic.anchor).toBe(dynamic.anchor);
  expect(after.dynamic.refs).toBe(dynamic.refs);
  expect(after.additionalMetadata).toBe(additionalMetadata);
  expect(after.expansions).toBe(expansions);
  await pause();
  expect(api.called(DYNAMIC)).toHaveLength(2);
  act(() => {
    hook.result.current.remove('generated:old14');
    hook.result.current.remove('generated:old13');
  });
  await act(async () => {
    await hook.result.current.regenerateOptions();
  });
  expect(hook.result.current.entries).toHaveLength(30);
  expect(hook.result.current.additionalMetadata).toEqual([]);
});

test('remove and undo invalidate pending responses, and explicit refresh can reintroduce freed key', async () => {
  setup({ [DYNAMIC]: () => response([wire('X')]) });
  const hook = await start();
  act(() => hook.result.current.setPrompt('A fox'));
  await act(async () => {
    await hook.result.current.regenerateOptions();
  });
  act(() => hook.result.current.setValue('generated:X', 'manual'));
  const original = hook.result.current.entries.find(
    (e) => e.key === 'generated:X',
  );
  const pending = hold();
  api.routes[DYNAMIC] = () => pending.promise;
  let request;
  act(() => {
    request = hook.result.current.regenerateOptions();
  });
  act(() => hook.result.current.remove('generated:X'));
  await act(async () => {
    pending.resolve(response([wire('X')]));
    await request;
  });
  expect(hook.result.current.entries.some((e) => e.key === 'generated:X')).toBe(
    false,
  );
  act(() => hook.result.current.undoDraft());
  expect(hook.result.current.entries.find((e) => e.key === 'generated:X')).toBe(
    original,
  );
  act(() => hook.result.current.remove('generated:X'));
  api.routes[DYNAMIC] = () => response([wire('X')]);
  await act(async () => {
    await hook.result.current.regenerateOptions();
  });
  expect(
    hook.result.current.entries.find((e) => e.key === 'generated:X').wire.value,
  ).toBe('default');
  expect(
    hook.result.current.entries.find((e) => e.key === 'generated:X')
      .intentClass,
  ).toBe('automatic');
});

test('rapid ordered reference edits debounce once for final signature; near prompt edits reuse it', async () => {
  setup({ 'POST /api/images/reference-analysis': analysis });
  const hook = await start({ clientPolicy: policy });
  act(() =>
    hook.result.current.setPrompt('Make the sky blue and keep the trees'),
  );
  await attach(hook, 0);
  await attach(hook, 1);
  await waitFor(() => expect(hook.result.current.dynamic.status).toBe('ready'));
  await pause();
  const count = api.called(DYNAMIC).length;
  const [first, second] = hook.result.current.references.refs;
  act(() => {
    hook.result.current.references.move(second.id, -1);
    hook.result.current.references.move(second.id, 1);
    hook.result.current.references.remove(first.id);
  });
  await waitFor(() => expect(api.called(DYNAMIC)).toHaveLength(count + 1));
  await waitFor(() => expect(hook.result.current.dynamic.status).toBe('ready'));
  expect(api.called(DYNAMIC).at(-1).body.reference_context).toHaveLength(1);
  act(() =>
    hook.result.current.setPrompt(`${hook.result.current.draft.prompt}!`),
  );
  await pause();
  expect(api.called(DYNAMIC)).toHaveLength(count + 1);
});

test.each(['restore', 'remove', 'undo'])(
  'pending Generate cannot resume across same-idea %s and resurrect work',
  async (mutation) => {
    const pending = hold();
    setup({ [DYNAMIC]: () => pending.promise });
    const hook = await start();
    act(() => hook.result.current.setPrompt('A fox'));
    act(() =>
      hook.result.current.applyControlEntries('Add X', (entries) => [
        ...entries,
        ...createEntries([wire('X')], GROUP.generated),
      ]),
    );
    act(() => hook.result.current.setValue('generated:X', 'manual'));
    let generation;
    act(() => {
      generation = hook.result.current.submit();
    });
    await waitFor(() => expect(api.called(DYNAMIC)).toHaveLength(1));
    if (mutation === 'restore')
      await act(async () => {
        await hook.result.current.restore(
          libraryRecord({
            id: 'same-idea',
            original_prompt: 'A fox',
            selected_controls: [wire('restored', { origin: 'generated' })],
          }),
        );
      });
    if (mutation === 'remove')
      act(() => hook.result.current.remove('generated:X'));
    if (mutation === 'undo') act(() => hook.result.current.undoDraft());
    await act(async () => {
      pending.resolve(response([wire('X')]));
      await generation;
    });
    expect(api.called(DYNAMIC)).toHaveLength(1);
    expect(api.called(GENERATE)).toHaveLength(0);
    if (mutation === 'remove')
      expect(
        hook.result.current.entries.some((e) => e.key === 'generated:X'),
      ).toBe(false);
    if (mutation === 'restore')
      expect(
        hook.result.current.entries.some((e) => e.key === 'generated:restored'),
      ).toBe(true);
  },
);
