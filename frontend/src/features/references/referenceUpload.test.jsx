import { createHash } from 'node:crypto';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { useReferences } from './useReferences.js';
import { createUrlLedger } from '../../data/media/objectUrls.js';
import { referenceDescriptors, buildEditForm } from './references.js';
import { referenceHeaderSize, prepareReference } from './referenceUpload.js';
import { api } from '../../data/api/api.js';

const sha = async (blob) =>
  createHash('sha256')
    .update(Buffer.from(await blob.arrayBuffer()))
    .digest('hex');
function png(width, height) {
  const bytes = new Uint8Array(24);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x89504e47);
  view.setUint32(4, 0x0d0a1a0a);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return new File([bytes], `${width}.png`, { type: 'image/png' });
}
const original = () => png(6000, 4000);
const copy = () => png(1200, 800);
const small = () => png(400, 300);
const capability = {
  enabled: true,
  maxReferences: 10,
  maxImageBytes: 32000000,
  maxTotalBytes: 64000000,
};
const uploads = { max_decoded_pixels: 1000000, import_max_bytes: 32000000 };
const draft = { prompt: 'Make it warm', mode: 'image', revision: 1 };
function harness(extra = {}) {
  return renderHook(() =>
    useReferences({
      urls: createUrlLedger(),
      capability,
      uploads,
      getDraft: () => draft,
      getProviderHeader: () => null,
      setPrompt: vi.fn(),
      digest: sha,
      ...extra,
    }),
  );
}
async function response(file) {
  const derived = copy();
  return new Response(await derived.arrayBuffer(), {
    status: 200,
    headers: {
      'Content-Type': 'image/png',
      'X-Source-SHA256': await sha(file),
      'X-Source-Width': '6000',
      'X-Source-Height': '4000',
      'X-Adapted-SHA256': await sha(derived),
      'X-Adapted-Width': '1200',
      'X-Adapted-Height': '800',
    },
  });
}
function install() {
  vi.spyOn(api, 'referencePrompt').mockResolvedValue({
    suggested_prompt: null,
    warnings: [],
  });
  vi.spyOn(api, 'referenceAnalysis').mockImplementation(async (file) => ({
    source_sha256: await sha(file),
    description: 'A scene',
    dimensions: await referenceHeaderSize(file),
    suggested_prompt: '',
  }));
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation((_url, init) => response(init.body.get('file')));
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test('ordinary bytes stay identical; header inspection requests no conversion', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  const file = small();
  expect((await prepareReference(file, uploads)).blob).toBe(file);
  expect(fetch).not.toHaveBeenCalled();
});

test('one ordered batch adapts only oversized pixels and generation binds exact copies and source lineage', async () => {
  const fetch = install();
  const { result } = harness();
  const large = original(),
    little = small();
  act(() => result.current.add([large, little]));
  await waitFor(() =>
    expect(
      result.current.refs.every((r) => r.status === 'ready' && !r.analyzing),
    ).toBe(true),
  );
  expect(fetch).toHaveBeenCalledTimes(1);
  const refs = result.current.refs;
  expect(refs.map((r) => r.name)).toEqual([large.name, little.name]);
  expect(refs[0].dimensions).toEqual({ width: 1200, height: 800 });
  expect(refs[0].original.originalFile).toBe(large);
  expect(refs[0].sha256).toBe(await sha(copy()));
  expect(refs[0].source.sha256).toBe(await sha(large));
  expect(refs[0].sha256).not.toBe(refs[0].source.sha256);
  expect(refs[1].blob).toBe(little);
  const form = buildEditForm(
    { reference_images: referenceDescriptors(refs) },
    refs,
  );
  expect(await sha(form.get('reference_1'))).toBe(await sha(copy()));
  expect(await sha(form.get('reference_2'))).toBe(await sha(little));
});

test('count rejects the entire gesture before any conversion or analysis', () => {
  const fetch = install();
  const { result } = harness({
    capability: { ...capability, maxReferences: 1 },
  });
  act(() => result.current.add([original(), small()]));
  expect(result.current.refs).toHaveLength(0);
  expect(result.current.problem).toMatch(/2 files not added/);
  expect(fetch).not.toHaveBeenCalled();
  expect(api.referenceAnalysis).not.toHaveBeenCalled();
});

test('new draft cancels conversion and cannot resurrect any queued files', async () => {
  install();
  let finish;
  globalThis.fetch.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { result } = harness();
  const file = original();
  act(() => result.current.add([file, small()]));
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  act(() => result.current.clear());
  await act(async () => finish(await response(file)));
  expect(result.current.refs).toHaveLength(0);
  expect(api.referenceAnalysis).not.toHaveBeenCalled();
});

test('park and undo retain the original and derived identity without compounding conversion', async () => {
  const fetch = install();
  const { result } = harness();
  const file = original();
  act(() => result.current.add([file]));
  await waitFor(() => expect(result.current.refs[0]?.status).toBe('ready'));
  let parked;
  act(() => {
    parked = result.current.park();
  });
  act(() =>
    result.current.restoreDraft(parked.refs, parked.proposal, parked.sources),
  );
  expect(result.current.refs[0].original.originalFile).toBe(file);
  expect(result.current.refs[0].source.sha256).toBe(await sha(file));
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('kept original recovery rederives and verifies the recorded model checksum without inference', async () => {
  const fetch = install();
  const file = original();
  const sourceHash = await sha(file);
  const { result } = harness({
    readRetained: async (hash) =>
      hash === sourceHash ? { blob: file, name: file.name } : null,
  });
  act(() =>
    result.current.restore([
      {
        id: 'upload:restored',
        sha256: createHash('sha256')
          .update(Buffer.from(new Uint8Array(0)))
          .digest('hex'),
        source: { sha256: sourceHash, width: 6000, height: 4000 },
        description: 'Old description',
      },
    ]),
  );
  await waitFor(() => expect(result.current.refs[0].status).toBe('missing'));
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(api.referenceAnalysis).not.toHaveBeenCalled();
});

test('unknown headers fall back from pixel 413 to adaptation before analysis retries', async () => {
  install();
  const unknown = new File(['unknown headers'], 'odd.png', {
    type: 'image/png',
  });
  vi.mocked(api.referenceAnalysis).mockRejectedValueOnce(
    Object.assign(new Error('Image exceeds the decoded pixel limit'), {
      status: 413,
    }),
  );
  const { result } = harness();
  act(() => result.current.add([unknown, small()]));
  await waitFor(() =>
    expect(
      result.current.refs.every((r) => r.status === 'ready' && !r.analyzing),
    ).toBe(true),
  );
  expect(api.referenceAnalysis).toHaveBeenCalledTimes(3);
  expect(result.current.refs[0].original.originalFile).toBe(unknown);
});

test('no local crypto preserves source checksum inspection and exact adapted model identity', async () => {
  install();
  vi.spyOn(api, 'inspectReference').mockImplementation(async (file) => ({
    source_sha256: await sha(file),
  }));
  const file = original();
  const sourceHash = await sha(file);
  const modelHash = await sha(copy());
  const { result } = harness({ digest: async () => null });
  act(() =>
    result.current.restore([
      {
        id: 'missing',
        sha256: modelHash,
        source: { sha256: sourceHash, width: 6000, height: 4000 },
      },
    ]),
  );
  await act(async () => result.current.reattach('missing', file));
  expect(result.current.refs[0].status).toBe('ready');
  expect(result.current.refs[0].sha256).toBe(modelHash);
  expect(result.current.refs[0].original.originalFile).toBe(file);
  expect(api.inspectReference).toHaveBeenCalledTimes(1);
  expect(api.referenceAnalysis).not.toHaveBeenCalled();
});

test('failed conversion retains original; remaining files complete and hard rejection stays an error', async () => {
  install();
  globalThis.fetch.mockResolvedValue(
    new Response(
      JSON.stringify({
        detail: 'Image is larger than this server can prepare',
      }),
      { status: 413 },
    ),
  );
  const file = original();
  const { result } = harness();
  act(() => result.current.add([file, small()]));
  await waitFor(() => expect(result.current.refs[1]?.status).toBe('ready'));
  expect(result.current.refs[0].status).toBe('error');
  expect(result.current.refs[0].blob).toBe(file);
  expect(result.current.refs[0].analysisError).toMatch(
    /larger than this server/,
  );
});

test('an original parked before conversion finishes prepares from original on restore', async () => {
  install();
  let finish;
  globalThis.fetch.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { result } = harness();
  const file = original();
  act(() => result.current.add([file]));
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  let parked;
  act(() => {
    parked = result.current.park();
  });
  act(() =>
    result.current.restoreDraft(parked.refs, parked.proposal, parked.sources),
  );
  await waitFor(() => expect(result.current.refs[0]?.status).toBe('ready'));
  await act(async () => finish(await response(file)));
  expect(result.current.refs[0].original.originalFile).toBe(file);
  expect(result.current.refs[0].sha256).toBe(await sha(copy()));
});

test('a repeated pixel-limit rejection has only one automatic adaptation retry', async () => {
  install();
  const odd = new File(['unknown headers'], 'odd.png', { type: 'image/png' });
  const adaptedHash = await sha(odd);
  globalThis.fetch.mockResolvedValue(
    new Response(null, {
      status: 204,
      headers: {
        'X-Source-SHA256': adaptedHash,
        'X-Source-Width': '400',
        'X-Source-Height': '300',
      },
    }),
  );
  vi.mocked(api.referenceAnalysis).mockRejectedValue(
    Object.assign(new Error('Image exceeds the decoded pixel limit'), {
      status: 413,
    }),
  );
  const { result } = harness();
  act(() => result.current.add([odd]));
  await waitFor(() => expect(result.current.refs[0]?.status).toBe('error'));
  expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  expect(api.referenceAnalysis).toHaveBeenCalledTimes(2);
});
