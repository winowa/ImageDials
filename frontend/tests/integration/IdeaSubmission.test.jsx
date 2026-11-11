import React from 'react';
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
import App from '../../src/app/App.jsx';
import editing from '../../../fixtures/api/image-editing.json';
import { sha256Hex } from '../../src/data/media/privateThumbnail.js';
import { openStandardControls } from '../helpers/controlUiTestSupport.js';
import { normalizeClientPolicy } from '../../src/data/api/clientPolicy.js';
import {
  completeStatus,
  fakeLibrary,
  fixtures,
  installApi,
  libraryRecord,
  respond,
} from '../helpers/testSupport.js';

const DYNAMIC = 'POST /api/controls/dynamic';
const GENERATE = 'POST /api/generate-image';
const policy = normalizeClientPolicy({
  controls: { debounce_ms: 60000, reset_debounce_ms: 60000 },
});
const generated = [
  {
    id: 'generated_multi_wings',
    kind: 'multi-select',
    label: 'Wing markings',
    options: { a: 'Speckled', b: 'Striped', c: 'Plain' },
    value: [],
  },
  {
    id: 'generated_checkbox_feathers',
    kind: 'checkbox',
    label: 'Feathers',
    options: { a: 'Soft', b: 'Glossy', c: 'Ruffled' },
    value: [],
  },
];
beforeEach(() => {
  window.history.replaceState(null, '', '/');
  localStorage.clear();
  vi.spyOn(Math, 'random').mockReturnValue(0.9);
  URL.createObjectURL = vi.fn(() => 'blob:idea-reference');
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function chooseSpark() {
  fireEvent.click(screen.getByRole('button', { name: 'Prompt ideas' }));
  const ideas = await screen.findByRole('dialog', { name: /^Prompt ideas/ });
  const items = await within(ideas).findAllByRole('listitem');
  fireEvent.click(within(items[0]).getByRole('button'));
}

function setup({ background = false, records = [], overrides = {} } = {}) {
  let resolve;
  const pending = new Promise((r) => {
    resolve = r;
  });
  const api = installApi({
    ...fakeLibrary(records).routes,
    [DYNAMIC]: () => pending,
    [GENERATE]: () => respond(202, fixtures.m1.accepted),
    'GET /api/generation-jobs/fixture-image-1': () => completeStatus(),
    ...overrides,
  });
  render(
    <App
      clientPolicy={
        background
          ? normalizeClientPolicy({
              controls: { debounce_ms: 20, reset_debounce_ms: 5 },
            })
          : policy
      }
      jobPolicy={{ pollIntervalMs: 1 }}
    />,
  );
  return { api, resolve };
}

test('capacity refusal after one explicit spark submission never starts an image', async () => {
  const { api, resolve } = setup({
    overrides: {
      'GET /api/app-capabilities': () => ({
        ...fixtures.m1.capabilities,
        control_generation: {
          max_controls: fixtures.m1.static_standard.controls.length + 1,
        },
      }),
    },
  });
  await openStandardControls();
  await chooseSpark();
  fireEvent.click(
    screen.getByRole('button', { name: 'Generate image', exact: true }),
  );
  await waitFor(() => expect(api.called(DYNAMIC)).toHaveLength(1));
  await act(async () =>
    resolve({
      controls: generated,
      dynamic_controls_metadata: { provider: 'mock' },
    }),
  );
  await within(
    screen.getByRole('region', { name: 'Generated controls' }),
  ).findByText(/Too many controls to refresh options \(6 of 5\)/);
  expect(api.called(GENERATE)).toHaveLength(0);
});

test('a newer prompt while spark controls wait does not auto-submit either idea', async () => {
  const { api, resolve } = setup();
  await openStandardControls();
  await chooseSpark();
  fireEvent.click(
    screen.getByRole('button', { name: 'Generate image', exact: true }),
  );
  await waitFor(() => expect(api.called(DYNAMIC)).toHaveLength(1));
  fireEvent.change(screen.getByLabelText('Image idea'), {
    target: { value: 'A completely different lunar greenhouse' },
  });
  await act(async () =>
    resolve({
      controls: generated,
      dynamic_controls_metadata: { provider: 'mock' },
    }),
  );
  expect(api.called(GENERATE)).toHaveLength(0);
  expect(screen.getByLabelText('Image idea').value).toBe(
    'A completely different lunar greenhouse',
  );
});

test('manual standard choices made while spark controls wait survive settlement in the one image request', async () => {
  const { api, resolve } = setup();
  await openStandardControls();
  await chooseSpark();
  fireEvent.click(
    screen.getByRole('button', { name: 'Generate image', exact: true }),
  );
  await waitFor(() => expect(api.called(DYNAMIC)).toHaveLength(1));
  fireEvent.click(screen.getByRole('radio', { name: 'Watercolor' }));
  await act(async () =>
    resolve({
      controls: generated,
      standard_selections: { style: 'photography' },
      dynamic_controls_metadata: { provider: 'mock' },
    }),
  );
  await waitFor(() => expect(api.called(GENERATE)).toHaveLength(1));
  const body = api.called(GENERATE)[0].body;
  expect(body.controls.find((c) => c.id === 'style').value).toBe('watercolor');
  expect(
    body.controls.find((c) => c.id === 'style').selection_provenance.source,
  ).toBe('explicit');
  for (const wire of generated)
    expect(body.controls.find((c) => c.id === wire.id).value).toEqual(['c']);
});

test.each(['image', 'asset-image'])(
  'one Generate click after an idea awaits controls and submits fresh choices: %s',
  async (mode) => {
    const { api, resolve } = setup();
    await screen.findByRole('region', { name: 'Standard controls' });
    if (mode === 'asset-image')
      fireEvent.click(
        screen.getByRole('radio', { name: 'Asset image for 3D' }),
      );
    fireEvent.click(screen.getByRole('button', { name: 'Prompt ideas' }));
    const ideas = await screen.findByRole('dialog', { name: /^Prompt ideas/ });
    const items = await within(ideas).findAllByRole('listitem');
    fireEvent.click(within(items[0]).getByRole('button'));
    expect(api.called(GENERATE)).toHaveLength(0);
    fireEvent.click(
      screen.getByRole('button', { name: 'Generate image', exact: true }),
    );
    await waitFor(() => expect(api.called(DYNAMIC)).toHaveLength(1));
    expect(api.called(GENERATE)).toHaveLength(0);
    await act(async () =>
      resolve({
        controls: generated,
        dynamic_controls_metadata: { provider: 'mock' },
      }),
    );
    await waitFor(() => expect(api.called(GENERATE)).toHaveLength(1));
    const body = api.called(GENERATE)[0].body;
    expect(body.generation_mode).toBe(
      mode === 'asset-image' ? 'trellis' : 'standard',
    );
    for (const control of generated)
      expect(body.controls.find((c) => c.id === control.id).value).toEqual([
        'c',
      ]);
    expect(api.called(DYNAMIC)).toHaveLength(1);
  },
);

test.each(['image', 'asset-image'])(
  'blank %s spark submits once while its catalog is still loading',
  async (mode) => {
    let releaseCatalog;
    const catalog = new Promise((resolve) => {
      releaseCatalog = resolve;
    });
    const staticPath = `GET /api/controls/static?generation_mode=${mode === 'image' ? 'standard' : 'trellis'}`;
    const { api, resolve } = setup({
      background: true,
      overrides: { [staticPath]: () => catalog },
    });
    await screen.findByRole('region', { name: 'Standard controls' });
    if (mode === 'asset-image')
      fireEvent.click(
        screen.getByRole('radio', { name: 'Asset image for 3D' }),
      );
    fireEvent.click(screen.getByRole('button', { name: 'Prompt ideas' }));
    const ideas = await screen.findByRole('dialog', { name: /^Prompt ideas/ });
    const items = await within(ideas).findAllByRole('listitem');
    fireEvent.click(within(items[0]).getByRole('button'));
    fireEvent.click(
      screen.getByRole('button', { name: 'Generate image', exact: true }),
    );
    expect(api.called(GENERATE)).toHaveLength(0);
    expect(api.called(DYNAMIC)).toHaveLength(0);
    await act(async () =>
      releaseCatalog(
        mode === 'image'
          ? fixtures.m1.static_standard
          : fixtures.m1.static_trellis,
      ),
    );
    await waitFor(() => expect(api.called(DYNAMIC)).toHaveLength(1));
    await act(async () =>
      resolve({
        controls: generated,
        dynamic_controls_metadata: { provider: 'mock' },
      }),
    );
    await waitFor(() => expect(api.called(GENERATE)).toHaveLength(1));
    expect(api.called(DYNAMIC)).toHaveLength(1);
    for (const wire of generated)
      expect(
        api.called(GENERATE)[0].body.controls.find((c) => c.id === wire.id)
          .value,
      ).toEqual(['c']);
  },
);

test.each(
  ['image', 'asset-image', 'edit'].flatMap((mode) =>
    ['immediate', 'pending'].map((timing) => [mode, timing]),
  ),
)(
  'a spark in an existing draft or edit submits once with %s / %s controls',
  async (mode, timing) => {
    const restored = libraryRecord({
      ...completeStatus().result,
      selected_controls: fixtures.m1.static_standard.controls,
    });
    if (mode !== 'edit')
      window.history.replaceState(null, '', `/?edit=${restored.id}`);
    const { api, resolve } = setup({
      background: timing === 'pending',
      records: [restored],
      overrides:
        mode === 'edit'
          ? {
              'GET /api/app-capabilities': () => ({
                ...fixtures.m1.capabilities,
                image_editing: editing.capabilities,
                uploads: {
                  image_mime_types: ['image/png'],
                  import_max_bytes: 33554432,
                },
              }),
              'POST /api/images/reference-analysis': async (form) => ({
                ...editing.analysis.first.response,
                source_sha256: await sha256Hex(form.get('image')),
                revision: JSON.parse(form.get('context')).revision,
              }),
            }
          : {},
    });
    await openStandardControls();
    if (mode === 'edit') {
      fireEvent.click(screen.getByRole('radio', { name: /^Edit image/ }));
      const file = editing.files[0];
      fireEvent.change(
        screen
          .getByRole('region', { name: 'References' })
          .querySelector('input[type="file"]'),
        {
          target: {
            files: [
              new File(
                [Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0))],
                file.filename,
                { type: 'image/png' },
              ),
            ],
          },
        },
      );
      await screen.findByText(editing.analysis.first.response.description);
    } else {
      await waitFor(() =>
        expect(screen.getByLabelText('Image idea').value).toBe(
          restored.original_prompt,
        ),
      );
      if (mode === 'asset-image')
        fireEvent.click(
          screen.getByRole('radio', { name: 'Asset image for 3D' }),
        );
    }
    fireEvent.click(screen.getByRole('button', { name: 'Prompt ideas' }));
    const ideas = await screen.findByRole('dialog', { name: /^Prompt ideas/ });
    const items = await within(ideas).findAllByRole('listitem');
    fireEvent.click(within(items[0]).getByRole('button'));
    const chosenPrompt = screen.getByLabelText('Image idea').value;
    const ideaCalls = () =>
      api.called(DYNAMIC).filter((call) => call.body.prompt === chosenPrompt);
    if (timing === 'pending')
      await waitFor(() => expect(ideaCalls()).toHaveLength(1));
    expect(api.called(GENERATE)).toHaveLength(0);
    fireEvent.click(
      screen.getByRole('button', {
        name:
          mode === 'edit' ? 'Generate edit' : /^(Generate image|Regenerate)$/,
        exact: true,
      }),
    );
    await waitFor(() => expect(ideaCalls()).toHaveLength(1));
    await act(async () =>
      resolve({
        controls: generated,
        dynamic_controls_metadata: { provider: 'mock' },
      }),
    );
    await waitFor(() => expect(api.called(GENERATE)).toHaveLength(1));
    expect(ideaCalls()).toHaveLength(1);
    const sent = api.called(GENERATE)[0].body;
    const body = mode === 'edit' ? JSON.parse(sent.get('request')) : sent;
    for (const control of generated)
      expect(body.controls.find((c) => c.id === control.id).value).toEqual(
        mode === 'edit' ? [] : ['c'],
      );
    if (mode === 'edit')
      for (const control of generated)
        expect(
          body.controls.find((c) => c.id === control.id).apply_to_edit,
        ).toBe(false);
  },
);
