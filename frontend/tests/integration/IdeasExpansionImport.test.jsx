import { controlMenuAction } from '../helpers/controlUiTestSupport.js';
import { openStandardControls } from '../helpers/controlUiTestSupport.js';
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
import {
  clone,
  completeStatus,
  fakeLibrary,
  fixtures,
  installApi,
  libraryRecord,
  listedFromJob,
  respond,
} from '../helpers/testSupport.js';

vi.mock('../../src/features/controls/standardRandom.js', async (original) => ({
  ...(await original()),
  randomizeStandard: (entries) => entries,
}));

const { m1, m3 } = fixtures;
const SUGGEST = {
  standard: 'GET /api/prompt-suggestions?generation_mode=standard',
  trellis: 'GET /api/prompt-suggestions?generation_mode=trellis',
};
const EXPAND = 'POST /api/add-control-options';
const IMPORT = 'POST /api/images/import-analysis';
const GENERATE = 'POST /api/generate-image';
const DYNAMIC = 'POST /api/controls/dynamic';
const JOB = 'GET /api/generation-jobs/fixture-image-1';
const jobPolicy = { pollIntervalMs: 1, maxConsecutivePollFailures: 3 };

let api;
let library;
let objectUrls;

const renderApp = () => render(<App jobPolicy={jobPolicy} />);
const prompt = () => screen.getByLabelText('Image idea');
const ideas = () => screen.getByRole('dialog', { name: /^Prompt ideas/ });
const ideaTexts = () =>
  within(ideas())
    .getAllByRole('listitem')
    .map((li) => li.textContent);
const openIdeas = () =>
  fireEvent.click(screen.getByRole('button', { name: 'Prompt ideas' }));

/** The standard Create routes with the m3 capabilities, plus overrides. */
function setup(overrides = {}, records = []) {
  library = fakeLibrary(records);
  api = installApi({
    'GET /api/app-capabilities': () => m3.capabilities,
    [DYNAMIC]: () => m1.dynamic_response,
    ...library.routes,
    ...overrides,
  });
  return api;
}

/** Complete the fixture job and, like the server, list its record afterwards. */
function completeJob() {
  const status = completeStatus();
  library.records = [listedFromJob(status.result), ...library.records];
  return status;
}

const pngFile = (name = 'bird.png', type = 'image/png') =>
  new File(
    [Uint8Array.from(atob(m3.metadata_png_base64), (c) => c.charCodeAt(0))],
    name,
    {
      type,
    },
  );
const chooseFile = (file) =>
  fireEvent.change(document.querySelector('input[type="file"]'), {
    target: { files: [file] },
  });

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  localStorage.clear();
  let next = 0;
  objectUrls = { revoked: [], created: [] };
  URL.createObjectURL = vi.fn(() => {
    const url = `blob:local-${(next += 1)}`;
    objectUrls.created.push(url);
    return url;
  });
  URL.revokeObjectURL = vi.fn((url) => objectUrls.revoked.push(url));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// --- Suggestions -------------------------------------------------------------

test('ideas warm before opening, stay cached per mode and replace the prompt when chosen', async () => {
  setup();
  renderApp();
  await openStandardControls();
  // Background inference finishes while the popover is still closed.
  await waitFor(() => expect(api.called(SUGGEST.standard)).toHaveLength(1));
  expect(screen.queryByRole('dialog', { name: /^Prompt ideas/ })).toBeNull();
  expect(screen.queryByRole('group', { name: /^Prompt ideas/ })).toBeNull();

  openIdeas();
  expect(within(ideas()).getByText('No ideas? We got you.')).toBeTruthy();
  await waitFor(() =>
    expect(ideaTexts()).toEqual(m3.suggestions_standard.suggestions),
  );
  expect(ideas().getAttribute('aria-label')).toBe('Prompt ideas for images');
  expect(api.called(SUGGEST.standard)).toHaveLength(1);

  // Closing and reopening answers from the cache.
  // Focus may sit on the trigger, whose tooltip must not swallow Escape.
  screen.getByRole('button', { name: 'Prompt ideas' }).focus();
  fireEvent.keyDown(screen.getByRole('button', { name: 'Prompt ideas' }), {
    key: 'Escape',
  });
  expect(screen.queryByRole('dialog', { name: /^Prompt ideas/ })).toBeNull();
  expect(document.activeElement).toBe(
    screen.getByRole('button', { name: 'Prompt ideas' }),
  );
  openIdeas();
  expect(ideaTexts()).toEqual(m3.suggestions_standard.suggestions);
  expect(api.called(SUGGEST.standard)).toHaveLength(1);
  // Pressing the trigger again dismisses it.
  fireEvent.click(screen.getByRole('button', { name: 'Prompt ideas' }));
  expect(screen.queryByRole('dialog', { name: /^Prompt ideas/ })).toBeNull();

  // The new mode warms while closed, without discarding the earlier cache.
  fireEvent.click(screen.getByRole('radio', { name: 'Asset image for 3D' }));
  await waitFor(() => expect(api.called(SUGGEST.trellis)).toHaveLength(1));
  openIdeas();
  await waitFor(() =>
    expect(ideaTexts()).toEqual(m3.suggestions_trellis.suggestions),
  );
  expect(ideas().getAttribute('aria-label')).toBe(
    'Prompt ideas for asset images',
  );
  fireEvent.click(screen.getByRole('radio', { name: 'Text to image' }));
  await waitFor(() =>
    expect(ideaTexts()).toEqual(m3.suggestions_standard.suggestions),
  );
  expect(api.called(SUGGEST.standard)).toHaveLength(1);
  expect(api.called(SUGGEST.trellis)).toHaveLength(1);

  fireEvent.change(prompt(), { target: { value: 'my own words' } });
  fireEvent.click(
    within(ideas()).getByRole('button', {
      name: m3.suggestions_standard.suggestions[2],
    }),
  );
  expect(prompt().value).toBe(m3.suggestions_standard.suggestions[2]);
  // Choosing closes the panel and returns to the prompt.
  expect(screen.queryByRole('dialog', { name: /^Prompt ideas/ })).toBeNull();
  expect(document.activeElement).toBe(prompt());
});

test('outside presses dismiss the ideas panel and the icon has no native title', async () => {
  setup();
  renderApp();
  await openStandardControls();
  const trigger = screen.getByRole('button', { name: 'Prompt ideas' });
  expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
  expect(trigger.hasAttribute('title')).toBe(false);
  fireEvent.click(trigger);
  expect(trigger.getAttribute('aria-expanded')).toBe('true');
  await waitFor(() => expect(ideaTexts()).toHaveLength(5));
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole('dialog', { name: /^Prompt ideas/ })).toBeNull();
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
});

test('a failed refresh keeps the previous ideas, shows the error, and a retry clears it', async () => {
  let failing = false;
  setup({
    [SUGGEST.standard]: () =>
      failing
        ? respond(502, { detail: 'Provider request failed' })
        : m3.suggestions_standard,
  });
  renderApp();
  openIdeas();
  await waitFor(() => expect(ideaTexts()).toHaveLength(5));

  failing = true;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh ideas' }));
  const alert = await within(ideas()).findByRole('alert');
  expect(alert.textContent).toContain('Ideas could not be refreshed');
  expect(alert.textContent).toContain('Provider request failed');
  expect(ideaTexts()).toEqual(m3.suggestions_standard.suggestions);

  failing = false;
  fireEvent.click(within(ideas()).getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(within(ideas()).queryByRole('alert')).toBeNull());
  expect(api.called(SUGGEST.standard)).toHaveLength(3);
});

test('without any ideas a failure is shown and no success text is invented', async () => {
  setup({
    [SUGGEST.standard]: () => respond(503, { detail: 'Inference is disabled' }),
  });
  renderApp();
  openIdeas();
  const alert = await within(ideas()).findByRole('alert');
  expect(alert.textContent).toContain('Inference is disabled');
  expect(within(ideas()).queryAllByRole('listitem')).toHaveLength(0);
});

// --- Option expansion ------------------------------------------------------------

/** Generated controls arrive after one Enter; return once the panel shows. */
async function withGeneratedControls() {
  renderApp();
  await openStandardControls();
  fireEvent.click(screen.getByRole('button', { name: 'Regenerate options' }));
  fireEvent.change(prompt(), { target: { value: 'a glass bird' } });
  fireEvent.click(screen.getByRole('button', { name: 'Regenerate options' }));
  await screen.findByRole('radiogroup', { name: 'Surface' });
}

test('expansion sends the complete current control and keeps edits made while it runs', async () => {
  let release;
  setup({
    [EXPAND]: (body) =>
      new Promise((resolve) => {
        release = () =>
          resolve({
            ...body.control,
            options: {
              ...body.control.options,
              extra: 'Extra surface',
              dup: 'Plain',
            },
            server_note: 'added by server',
          });
      }),
  });
  await withGeneratedControls();
  const surface = m1.dynamic_response.controls[0];
  fireEvent.click(controlMenuAction('Surface', 'More Surface options'));
  await waitFor(() => expect(release).toBeTypeOf('function'));
  const [sent] = api.called(EXPAND);
  expect(sent.body.control).toEqual({
    ...surface,
    selection_provenance: { version: 1, source: 'suggested', effect: 'value' },
  });
  // Every current category is context: label/kind (and id/description) only.
  expect(sent.body.categories.length).toBeGreaterThan(1);
  for (const summary of sent.body.categories) {
    expect(
      Object.keys(summary).every((k) =>
        ['id', 'label', 'kind', 'description'].includes(k),
      ),
    ).toBe(true);
  }
  expect(sent.body.categories.map((c) => c.label)).toContain('Surface');

  // Edit while the request is in flight: select an option and add a custom one.
  const group = screen.getByRole('radiogroup', { name: 'Surface' });
  const firstOption = within(group).getAllByRole('radio')[0];
  fireEvent.click(firstOption);
  fireEvent.click(controlMenuAction('Surface', 'Add custom Surface option'));
  fireEvent.change(screen.getByLabelText('Custom Surface option'), {
    target: { value: 'Etched' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Add Surface option' }));
  await act(async () => release());

  await within(group).findByRole('radio', { name: 'Extra surface' });
  expect(within(group).getByRole('radio', { name: 'Etched' }).checked).toBe(
    true,
  );
  expect(
    within(group).getByRole('radio', { name: 'Extra surface' }).checked,
  ).toBe(false);
  expect(
    controlMenuAction('Surface', 'More Surface options').getAttribute(
      'aria-disabled',
    ) === 'true',
  ).toBe(false);
});

test('a control removed while expanding is not recreated', async () => {
  let release;
  setup({
    [EXPAND]: (body) =>
      new Promise((resolve) => {
        release = () =>
          resolve({
            ...body.control,
            options: { ...body.control.options, x: 'X' },
          });
      }),
  });
  await withGeneratedControls();
  fireEvent.click(controlMenuAction('Surface', 'More Surface options'));
  await waitFor(() => expect(release).toBeTypeOf('function'));
  fireEvent.click(screen.getByRole('button', { name: 'Remove Surface' }));
  await waitFor(() =>
    expect(screen.queryByRole('radiogroup', { name: 'Surface' })).toBeNull(),
  );
  await act(async () => release());
  expect(screen.queryByRole('radiogroup', { name: 'Surface' })).toBeNull();
  expect(screen.queryByRole('button', { name: /More Surface/ })).toBeNull();
});

test('an expansion failure shows the status and leaves selections alone', async () => {
  setup({
    [EXPAND]: () => respond(502, { detail: 'Provider request failed' }),
  });
  await withGeneratedControls();
  const group = screen.getByRole('radiogroup', { name: 'Surface' });
  const option = () => within(group).getAllByRole('radio')[0];
  const before = option().checked;
  fireEvent.click(option());
  expect(option().checked).toBe(!before);
  fireEvent.click(controlMenuAction('Surface', 'More Surface options'));
  const alert = await screen.findByText(/More options failed/);
  expect(alert.textContent).toContain('Provider request failed');
  expect(option().checked).toBe(!before);
});

// --- Import ----------------------------------------------------------------------

test('metadata restores the draft, lists a browser-only image and never touches the library', async () => {
  setup({ [IMPORT]: () => m3.import_metadata });
  renderApp();
  await openStandardControls();
  chooseFile(pngFile());

  const imported = m3.import_metadata.image;
  await screen.findByText(/listed in this browser only/);
  expect(prompt().value).toBe(imported.original_prompt);
  expect(
    screen.getByRole('region', { name: 'Image description' }).textContent,
  ).toContain(m3.import_metadata.description.text);
  expect(screen.getByRole('button', { name: 'Use as prompt' })).toBeTruthy();
  expect(screen.getByRole('radiogroup', { name: 'Surface' })).toBeTruthy();

  // The upload is a multipart `image` field and nothing else.
  const [call] = api.called(IMPORT);
  expect(call.body).toBeInstanceOf(FormData);
  expect([...call.body.keys()]).toEqual(['image']);

  // The image is shown from the browser's object URL, not a server file route.
  const stage = document.querySelector('.stage-img');
  expect(stage.getAttribute('src')).toMatch(/^blob:local-/);
  expect(
    screen.getByRole('button', {
      name: `${imported.title} (imported, not saved)`,
    }),
  ).toBeTruthy();
  expect(
    api.calls.some((c) => c.key.startsWith('POST /api/images/library')),
  ).toBe(false);
  expect(library.records).toHaveLength(0);

  // Create has no destructive action. Browser-only imports remain manageable
  // in the Library dialog even when the server library is enabled.
  expect(
    screen.queryByRole('button', { name: /Delete|Remove from browser/ }),
  ).toBeNull();
  fireEvent.click(screen.getByRole('link', { name: 'Library' }));
  fireEvent.click(
    await screen.findByRole('button', { name: new RegExp(imported.title) }),
  );
  const dialog = screen.getByRole('dialog');
  fireEvent.click(
    within(dialog).getByRole('button', { name: 'Remove from browser' }),
  );
  fireEvent.click(
    within(screen.getByRole('group', { name: /^Remove/ })).getByRole('button', {
      name: 'Remove from browser',
    }),
  );
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(screen.getByText('No saved images yet.')).toBeTruthy();
  fireEvent.click(screen.getByRole('link', { name: 'Create' }));
  expect(
    screen.queryByRole('button', { name: /imported, not saved/ }),
  ).toBeNull();
  expect(api.calls.some((c) => c.key.startsWith('DELETE'))).toBe(false);
  // Every URL is released exactly once; the order is not part of the contract.
  expect([...objectUrls.revoked].sort()).toEqual(
    [...objectUrls.created].sort(),
  );
});

test('restored metadata keeps unknown fields, false and zero in the next request', async () => {
  setup({
    [IMPORT]: () => m3.import_metadata,
    [GENERATE]: () => respond(202, m1.accepted),
    [JOB]: () => completeJob(),
  });
  renderApp();
  await openStandardControls();
  chooseFile(pngFile());
  await screen.findByText(/listed in this browser only/);
  fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
  await waitFor(() => expect(api.called(GENERATE)).toHaveLength(1));
  const { body } = api.called(GENERATE)[0];
  const original = m3.import_metadata.image;
  expect(body.controls).toEqual(
    expect.arrayContaining(original.selected_controls),
  );
  expect(body.dynamic_controls_metadata).toEqual(
    original.dynamic_controls_metadata,
  );
  expect(body.dynamic_controls_metadata.response.extension).toEqual([false, 0]);
});

test('metadata for a saved image selects that image instead of listing a copy', async () => {
  const saved = libraryRecord({
    ...clone(m3.import_metadata.image),
    storage_id: 'local-0',
    storage_type: 'local',
    filename: `${m3.import_metadata.image.id}.png`,
    title: 'Saved copy',
  });
  setup({ [IMPORT]: () => m3.import_metadata }, [saved]);
  renderApp();
  await screen.findByRole('button', { name: 'Saved copy' });
  chooseFile(pngFile());
  await screen.findByText('Restored from the matching saved image.');
  expect(screen.queryByText('Imported')).toBeNull();
  expect(
    screen
      .getByRole('button', { name: 'Saved copy' })
      .getAttribute('aria-current'),
  ).toBe('true');
  // The preview was not kept, so its URL is released.
  expect(objectUrls.revoked).toEqual(objectUrls.created);
});

test('dropping a file works like the chooser', async () => {
  setup({ [IMPORT]: () => m3.import_metadata });
  renderApp();
  await openStandardControls();
  const card = screen.getByRole('region', { name: 'Prompt' });
  fireEvent.dragEnter(card, { dataTransfer: { types: ['Files'] } });
  expect(card.getAttribute('data-dragging')).toBe('true');
  fireEvent.drop(card, {
    dataTransfer: { types: ['Files'], files: [pngFile()] },
  });
  await screen.findByText(/listed in this browser only/);
  expect(card.getAttribute('data-dragging')).toBe('false');
});

test('a description import fills the prompt without generating', async () => {
  setup({
    [IMPORT]: () => m3.import_description,
    [GENERATE]: () => respond(202, m1.accepted),
    [JOB]: () => completeJob(),
  });
  renderApp();
  await openStandardControls();
  fireEvent.change(prompt(), { target: { value: 'typed before' } });
  chooseFile(pngFile('plain.png'));

  await screen.findByText(/Prompt filled from the imported image/);
  expect(api.called(GENERATE)).toHaveLength(0);
  expect(api.called(DYNAMIC)).toHaveLength(0);
  expect(prompt().value).toBe(m3.import_description.prompt);
  // The local preview stays until dismissed and is not a history item.
  expect(screen.getByAltText('Imported image preview')).toBeTruthy();
  expect(screen.queryByText('Imported')).toBeNull();
  expect(api.called(GENERATE)).toHaveLength(0);
  expect(api.called(DYNAMIC)).toHaveLength(0);

  fireEvent.click(screen.getByRole('button', { name: 'Use as prompt' }));
  expect(prompt().value).toBe(m3.import_description.prompt);

  fireEvent.click(screen.getByRole('button', { name: 'Dismiss import' }));
  expect(objectUrls.revoked).toEqual(objectUrls.created);
});

test('a delayed import keeps its description available without replacing a newer draft', async () => {
  let answer;
  setup({
    [IMPORT]: () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
  });
  renderApp();
  await openStandardControls();
  chooseFile(pngFile('delayed.png'));
  await screen.findByText(/Reading delayed.png/);
  fireEvent.change(prompt(), { target: { value: 'newer typed draft' } });
  await act(async () => answer(m3.import_description));

  await screen.findByText(/draft changed while the image was being read/);
  expect(prompt().value).toBe('newer typed draft');
  expect(
    screen.getByRole('region', { name: 'Image description' }).textContent,
  ).toContain(m3.import_description.description.text);
  expect(api.called(GENERATE)).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Use as prompt' }));
  expect(prompt().value).toBe(m3.import_description.description.text);
  expect(api.called(GENERATE)).toHaveLength(0);
});

test('ComfyUI prompt wins while the image description remains separately usable', async () => {
  setup({ [IMPORT]: () => m3.import_comfyui });
  renderApp();
  await openStandardControls();
  chooseFile(pngFile('workflow.png'));
  await screen.findByText(/Prompt filled from the imported image/);

  expect(prompt().value).toBe(m3.import_comfyui.prompt);
  expect(
    screen.getByRole('region', { name: 'Image description' }).textContent,
  ).toContain(m3.import_comfyui.description.text);
  fireEvent.click(screen.getByRole('button', { name: 'Use as prompt' }));
  expect(prompt().value).toBe(m3.import_comfyui.description.text);
  expect(api.called(GENERATE)).toHaveLength(0);
});

test('metadata with an unavailable description keeps restoration and offers retry', async () => {
  setup({ [IMPORT]: () => m3.import_description_unavailable });
  renderApp();
  await openStandardControls();
  chooseFile(pngFile('offline.png'));

  await screen.findByText(/listed in this browser only/);
  expect(prompt().value).toBe(m3.import_description_unavailable.image.prompt);
  expect(screen.getByText('Inference is disabled')).toBeTruthy();
  expect(
    screen.getByRole('button', { name: 'Retry description' }),
  ).toBeTruthy();
  expect(api.called(GENERATE)).toHaveLength(0);
});

test.each(['metadata', 'comfyui'])(
  'retrying a %s description preserves the edited prompt and controls',
  async (mode) => {
    const initial = clone(
      mode === 'metadata'
        ? m3.import_description_unavailable
        : m3.import_comfyui,
    );
    initial.description = {
      status: 'unavailable',
      text: null,
      message: 'Inference is disabled',
    };
    let calls = 0;
    setup({
      [IMPORT]: () => ({
        ...initial,
        description:
          calls++ === 0
            ? initial.description
            : {
                status: 'ready',
                text: 'A newly available visual description.',
              },
      }),
    });
    renderApp();
    await openStandardControls();
    chooseFile(pngFile());
    await screen.findByText('Inference is disabled');
    const edited = `${prompt().value} with a blue base`;
    fireEvent.change(prompt(), { target: { value: edited } });
    if (mode === 'metadata')
      fireEvent.change(screen.getByRole('slider', { name: 'Head angle' }), {
        target: { value: '17' },
      });
    fireEvent.click(screen.getByRole('button', { name: 'Retry description' }));
    await screen.findByText('A newly available visual description.');
    expect(prompt().value).toBe(edited);
    if (mode === 'metadata')
      expect(screen.getByRole('slider', { name: 'Head angle' }).value).toBe(
        '17',
      );
    expect(api.called(GENERATE)).toHaveLength(0);
  },
);

test('unsupported embedded metadata is explained alongside the usable description', async () => {
  const notice = 'Embedded settings use an unsupported version.';
  setup({
    [IMPORT]: () => ({ ...m3.import_description, metadata_notice: notice }),
  });
  renderApp();
  await openStandardControls();
  chooseFile(pngFile());
  await screen.findByText(/Prompt filled from the imported image/);
  expect(screen.getByText(notice)).toBeTruthy();
  expect(prompt().value).toBe(m3.import_description.prompt);
  expect(api.called(GENERATE)).toHaveLength(0);
});

test('a description during a running job fills the prompt without a second generation', async () => {
  let finish;
  setup({
    [IMPORT]: () => m3.import_description,
    [GENERATE]: () => respond(202, m1.accepted),
    [JOB]: () =>
      new Promise((resolve) => {
        finish = () => resolve(completeJob());
      }),
  });
  renderApp();
  await openStandardControls();
  fireEvent.change(prompt(), { target: { value: 'first idea' } });
  fireEvent.keyDown(prompt(), { key: 'Enter' });
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  chooseFile(pngFile());
  await screen.findByText(/Prompt filled from the imported image/);
  expect(prompt().value).toBe(m3.import_description.prompt);
  expect(api.called(GENERATE)).toHaveLength(1);
  await act(async () => finish());
});

test('failures show the actual status and keep the draft and previous preview', async () => {
  let response = respond(413, m3.errors.oversize);
  setup({ [IMPORT]: () => response });
  renderApp();
  await openStandardControls();
  fireEvent.change(prompt(), { target: { value: 'keep this idea' } });
  chooseFile(pngFile());
  const alert = await screen.findByText(m3.errors.oversize.detail);
  expect(alert.closest('[role="alert"]')).toBeTruthy();
  expect(prompt().value).toBe('keep this idea');
  expect(screen.getByAltText('Imported image preview')).toBeTruthy();

  response = respond(503, m3.errors.disabled);
  chooseFile(pngFile('again.png'));
  await screen.findByText(m3.errors.disabled.detail);
  expect(prompt().value).toBe('keep this idea');
});

test('limits from capabilities stop an empty, oversized or unsupported file before any request', async () => {
  setup({ [IMPORT]: () => m3.import_metadata });
  renderApp();
  await openStandardControls();
  await waitFor(() =>
    expect(api.called('GET /api/app-capabilities')).toHaveLength(1),
  );

  chooseFile(new File([], 'empty.png', { type: 'image/png' }));
  await screen.findByText(/empty\.png is empty/);
  chooseFile(new File(['x'], 'notes.txt', { type: 'text/plain' }));
  await screen.findByText(/notes\.txt is not a supported image type/);
  const big = new File(['x'], 'big.png', { type: 'image/png' });
  Object.defineProperty(big, 'size', {
    value: m3.capabilities.uploads.import_max_bytes + 1,
  });
  chooseFile(big);
  await screen.findByText(/big\.png is .* MiB; the limit is 32 MiB/);
  expect(api.called(IMPORT)).toHaveLength(0);
  expect(objectUrls.created).toHaveLength(0);
});

test('cancelling an analysis ignores its late answer and releases the preview URL', async () => {
  let answer;
  setup({
    [IMPORT]: () =>
      new Promise((resolve) => {
        answer = () => resolve(m3.import_metadata);
      }),
  });
  renderApp();
  await openStandardControls();
  fireEvent.change(prompt(), { target: { value: 'my draft' } });
  chooseFile(pngFile());
  await screen.findByText(/Reading bird\.png/);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel import' }));
  expect(objectUrls.revoked).toEqual(objectUrls.created);
  await act(async () => answer());
  expect(prompt().value).toBe('my draft');
  expect(screen.queryByText('Imported')).toBeNull();
});

test('a newer import replaces an older one and only the newest is applied', async () => {
  const answers = [];
  setup({
    [IMPORT]: () =>
      new Promise((resolve) => {
        answers.push(resolve);
      }),
  });
  renderApp();
  await openStandardControls();
  chooseFile(pngFile('first.png'));
  await screen.findByText(/Reading first\.png/);
  chooseFile(pngFile('second.png'));
  await screen.findByText(/Reading second\.png/);
  expect(objectUrls.revoked).toEqual([objectUrls.created[0]]);
  await act(async () => answers[0](m3.import_description));
  expect(api.called(GENERATE)).toHaveLength(0);
  await act(async () => answers[1](m3.import_metadata));
  await screen.findByText(/listed in this browser only/);
  expect(api.called(GENERATE)).toHaveLength(0);
});

// --- Progress and enrichment ---------------------------------------------------

test('the enriching stage is its own step and the finished record shows title and alt text', async () => {
  let phase = 'enriching';
  setup({
    [GENERATE]: () => respond(202, { generation_job_id: 'fixture-image-1' }),
    [JOB]: () => {
      if (phase === 'enriching') return m3.job_enriching;
      library.records = [listedFromJob(m3.job_complete.result)];
      return m3.job_complete;
    },
  });
  renderApp();
  await openStandardControls();
  fireEvent.change(prompt(), { target: { value: 'a glass bird' } });
  fireEvent.keyDown(prompt(), { key: 'Enter' });
  const steps = await screen.findByRole('list', {
    name: 'Generation progress',
  });
  await waitFor(() =>
    expect(
      within(steps)
        .getByText('Title and alt text')
        .getAttribute('aria-current'),
    ).toBe('step'),
  );
  expect(within(steps).getByText('Options').getAttribute('data-state')).toBe(
    'done',
  );

  phase = 'complete';
  const result = m3.job_complete.result;
  await screen.findByRole('heading', { name: result.title });
  fireEvent.click(screen.getByRole('button', { name: 'Details' }));
  expect(screen.getByText(result.alt_text, { selector: 'dd' })).toBeTruthy();
});
