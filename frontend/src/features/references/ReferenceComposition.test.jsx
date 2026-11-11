/** Joint visual composition is independent of per-image accessibility captions. */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { api } from '../../data/api/api.js';
import { deferred } from '../../../tests/helpers/cacheTestSupport.js';
import { createUrlLedger } from '../../data/media/objectUrls.js';
import { useReferences } from './useReferences.js';

let draft, header, placed, analyses, compositions;
const file = (n) =>
  new File([String(n)], `source-${n}.png`, { type: 'image/png' });
const digest = async (blob) => (await blob.text()).padStart(64, '0');
const contextOf = (list) =>
  list.map((ref) => ({
    id: ref.id,
    sha256: ref.sha256,
    description: ref.description,
    filename: ref.name,
  }));
function setup() {
  const result = renderHook(
    ({ scope }) =>
      useReferences({
        urls: createUrlLedger(),
        capability: {
          enabled: true,
          maxReferences: 10,
          maxImageBytes: 100000,
          maxTotalBytes: 1000000,
        },
        uploads: { import_max_bytes: 100000 },
        getDraft: () => ({ ...draft }),
        setPrompt: (text) => {
          placed(text);
          draft = { ...draft, prompt: text, revision: draft.revision + 1 };
        },
        getProviderHeader: () => header,
        providerScope: scope,
        digest,
      }),
    { initialProps: { scope: null } },
  );
  return result;
}
const add = async (hook, ...files) => {
  act(() => hook.result.current.add(files));
  await waitFor(() =>
    expect(
      hook.result.current.refs.every(
        (ref) => ref.status === 'ready' && !ref.analyzing,
      ),
    ).toBe(true),
  );
};
beforeEach(() => {
  draft = { prompt: '', mode: 'image', revision: 1 };
  header = null;
  placed = vi.fn();
  analyses = [];
  compositions = [];
  URL.createObjectURL = vi.fn(() => 'blob:composition');
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(api, 'referenceAnalysis').mockImplementation(
    async (blob, context) => {
      analyses.push({ blob, context });
      return {
        source_sha256: await digest(blob),
        description: 'Internal caption',
        suggested_prompt: 'Must never insert this caption',
        revision: context.revision,
      };
    },
  );
  vi.spyOn(api, 'referencePrompt').mockImplementation(
    async (context, options) => {
      compositions.push({ context, options });
      return {
        suggested_prompt: context.reference_images
          .map((_, i) => `<image${i + 1}>`)
          .join(' with '),
        revision: context.revision,
      };
    },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test.each(['', 'Keep my exact  manual words'])(
  'first Edit attachment preserves %j without a proposal',
  async (prompt) => {
    draft.prompt = prompt;
    const hook = setup();
    await add(hook, file(1));
    expect(draft.prompt).toBe(prompt);
    expect(placed).not.toHaveBeenCalled();
    expect(api.referencePrompt).not.toHaveBeenCalled();
    expect(hook.result.current.proposal).toBeNull();
  },
);

test('one multi-file gesture composes once for the final ordered pixels; later upload includes the current prompt', async () => {
  const hook = setup();
  const files = [file(1), file(2), file(3)];
  await add(hook, ...files);
  await waitFor(() => expect(placed).toHaveBeenCalledTimes(1));
  expect(compositions).toHaveLength(1);
  expect(compositions[0].options.references.map((ref) => ref.blob)).toEqual(
    files,
  );
  expect(
    compositions[0].context.reference_images.map((ref) => ref.role),
  ).toEqual(['base', 'reference', 'reference']);
  expect(
    compositions[0].context.reference_images.map((ref) => ref.sha256),
  ).toEqual(await Promise.all(files.map(digest)));
  const prompt = draft.prompt;
  await add(hook, file(4));
  await waitFor(() => expect(compositions).toHaveLength(2));
  expect(compositions[1].context.prompt).toBe(prompt);
  expect(compositions[1].context.reference_images).toHaveLength(4);
  expect(analyses).toHaveLength(4);
});

test('typing during joint work offers Use; accepting and Undo preserve the manual version', async () => {
  const gate = deferred();
  api.referencePrompt.mockImplementation(async (context) => {
    await gate.promise;
    return {
      suggested_prompt:
        'Place the red kite from <image2> above the beach in <image1>.',
      revision: context.revision,
    };
  });
  const hook = setup();
  await add(hook, file(1), file(2));
  await waitFor(() => expect(api.referencePrompt).toHaveBeenCalledTimes(1));
  draft = { ...draft, prompt: 'My wording', revision: 2 };
  await act(async () => gate.resolve());
  expect(hook.result.current.proposal.kind).toBe('offered');
  expect(draft.prompt).toBe('My wording');
  act(() => hook.result.current.acceptProposal());
  expect(draft.prompt).toContain('<image2>');
  act(() => hook.result.current.undoProposal());
  expect(draft.prompt).toBe('My wording');
});

test.each(['remove', 'reorder-back', 'new-draft', 'park', 'undo', 'provider'])(
  'joint answer cannot cross %s, even if order or bytes return',
  async (change) => {
    const gate = deferred();
    let signal;
    api.referencePrompt.mockImplementation(async (context, options) => {
      signal = options.signal;
      await gate.promise;
      return {
        suggested_prompt: 'Put <image2> into <image1>.',
        revision: context.revision,
      };
    });
    const hook = setup();
    await add(hook, file(1), file(2));
    await waitFor(() => expect(signal).toBeTruthy());
    act(() => {
      const refs = hook.result.current.refs;
      if (change === 'remove') hook.result.current.remove(refs[1].id);
      if (change === 'reorder-back') {
        hook.result.current.move(refs[1].id, -1);
        hook.result.current.move(refs[1].id, 1);
      }
      if (change === 'new-draft') hook.result.current.clear();
      if (change === 'park') hook.result.current.park();
      if (change === 'undo') hook.result.current.restoreDraft(contextOf(refs));
      if (change === 'provider') header = 'changed';
    });
    if (change === 'provider') hook.rerender({ scope: 'changed' });
    await act(async () => gate.resolve());
    expect(placed).not.toHaveBeenCalled();
    expect(hook.result.current.proposal).toBeNull();
  },
);

test('restored described references do not call a model; a later upload composes their actual recovered bytes', async () => {
  const hook = setup();
  await add(hook, file(1), file(2));
  await waitFor(() => expect(placed).toHaveBeenCalledTimes(1));
  const descriptors = contextOf(hook.result.current.refs);
  act(() => hook.result.current.restore(descriptors));
  expect(api.referencePrompt).toHaveBeenCalledTimes(1);
  expect(api.referenceAnalysis).toHaveBeenCalledTimes(2);
  await add(hook, file(3));
  await waitFor(() => expect(api.referencePrompt).toHaveBeenCalledTimes(2));
  expect(compositions[1].options.references.map((ref) => ref.name)).toEqual([
    'source-1.png',
    'source-2.png',
    'source-3.png',
  ]);
});

test('typing while the first file in a batch is prepared is preserved, and the joint request uses that current prompt', async () => {
  const gate = deferred();
  const metadata = api.referenceAnalysis.getMockImplementation();
  api.referenceAnalysis.mockImplementation(async (blob, context) => {
    if (blob.name === 'source-1.png') await gate.promise;
    return metadata(blob, context);
  });
  const hook = setup();
  act(() => hook.result.current.add([file(1), file(2)]));
  await waitFor(() => expect(api.referenceAnalysis).toHaveBeenCalledTimes(1));
  draft = {
    ...draft,
    prompt: 'My edit while the batch is preparing',
    revision: 2,
  };
  await act(async () => gate.resolve());
  await waitFor(() =>
    expect(hook.result.current.proposal?.kind).toBe('offered'),
  );
  expect(compositions[0].context.prompt).toBe(
    'My edit while the batch is preparing',
  );
  expect(draft.prompt).toBe('My edit while the batch is preparing');
  expect(placed).not.toHaveBeenCalled();
});

test('an unavailable individual caption does not prevent a joint visual proposal from current pixels', async () => {
  const metadata = api.referenceAnalysis.getMockImplementation();
  api.referenceAnalysis.mockImplementation((blob, context) => {
    if (blob.name === 'source-2.png')
      return Promise.reject(
        Object.assign(new Error('Caption unavailable'), { status: 502 }),
      );
    return metadata(blob, context);
  });
  const hook = setup();
  await add(hook, file(1), file(2));
  await waitFor(() => expect(compositions).toHaveLength(1));
  expect(
    compositions[0].options.references.map((ref) => ref.blob.name),
  ).toEqual(['source-1.png', 'source-2.png']);
  expect(compositions[0].context.reference_images[1].description).toBe('');
  expect(hook.result.current.refs[1].status).toBe('ready');
});
