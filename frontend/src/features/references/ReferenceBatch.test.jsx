import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { useReferences } from './useReferences.js';
import { api } from '../../data/api/api.js';
import { deferred } from '../../../tests/helpers/cacheTestSupport.js';
import { createUrlLedger } from '../../data/media/objectUrls.js';
const file = (n) => new File([String(n)], `${n}.png`, { type: 'image/png' });
const sha = async (blob) => (await blob.text()).padStart(64, '0');
const draft = { prompt: 'Keep the base', revision: 1, mode: 'image' };
function setup(limit = 10) {
  URL.createObjectURL = vi.fn(() => 'blob:reference');
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(api, 'referenceAnalysis').mockImplementation(async (blob) => ({
    source_sha256: await sha(blob),
    description: 'Caption',
  }));
  vi.spyOn(api, 'referencePrompt').mockResolvedValue({
    suggested_prompt: '',
    warnings: [],
  });
  return renderHook(() =>
    useReferences({
      urls: createUrlLedger(),
      capability: {
        enabled: true,
        maxReferences: limit,
        maxImageBytes: 1000,
        maxTotalBytes: 10000,
      },
      uploads: { import_max_bytes: 1000 },
      getDraft: () => draft,
      setPrompt: vi.fn(),
      getProviderHeader: () => null,
      digest: sha,
    }),
  );
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test('two chooser gestures while the first analysis waits retain every file in chooser order', async () => {
  const hook = setup();
  const gate = deferred();
  vi.mocked(api.referenceAnalysis).mockImplementationOnce(async (blob) => {
    await gate.promise;
    return { source_sha256: await sha(blob), description: 'Base' };
  });
  act(() => hook.result.current.add([file(1), file(2)]));
  await waitFor(() => expect(api.referenceAnalysis).toHaveBeenCalledTimes(1));
  act(() => hook.result.current.add([file(3), file(4)]));
  await act(async () => gate.resolve());
  await waitFor(() =>
    expect(
      hook.result.current.refs.every(
        (ref) => ref.status === 'ready' && !ref.analyzing,
      ),
    ).toBe(true),
  );
  expect(hook.result.current.refs.map((ref) => ref.name)).toEqual([
    '1.png',
    '2.png',
    '3.png',
    '4.png',
  ]);
  expect(api.referencePrompt).toHaveBeenCalledTimes(1);
  expect(
    api.referencePrompt.mock.calls[0][1].references.map((ref) => ref.name),
  ).toEqual(['1.png', '2.png', '3.png', '4.png']);
});

test('overcapacity refuses the whole gesture without changing the attached set', async () => {
  const hook = setup(3);
  act(() => hook.result.current.add([file(1), file(2)]));
  await waitFor(() =>
    expect(
      hook.result.current.refs.every(
        (ref) => ref.status === 'ready' && !ref.analyzing,
      ),
    ).toBe(true),
  );
  act(() => expect(hook.result.current.add([file(3), file(4)])).toBe(0));
  expect(hook.result.current.refs.map((ref) => ref.name)).toEqual([
    '1.png',
    '2.png',
  ]);
  expect(hook.result.current.problem).toContain('2 files not added');
  expect(hook.result.current.problemDiagnostic.category).toBe(
    'reference-validation',
  );
});

test('reordering changes ordered pixel context without changing any original bytes', async () => {
  const hook = setup();
  act(() => hook.result.current.add([file(1), file(2), file(3)]));
  await waitFor(() =>
    expect(
      hook.result.current.refs.every(
        (ref) => ref.status === 'ready' && !ref.analyzing,
      ),
    ).toBe(true),
  );
  const before = hook.result.current.refs.map((ref) => ref.blob);
  act(() => hook.result.current.move(hook.result.current.refs[2].id, -1));
  expect(hook.result.current.refs.map((ref) => ref.name)).toEqual([
    '1.png',
    '3.png',
    '2.png',
  ]);
  expect(hook.result.current.refs.map((ref) => ref.blob)).toEqual([
    before[0],
    before[2],
    before[1],
  ]);
  expect(hook.result.current.proposal).toBeNull();
});

test('byte-identical model copies retain their distinct original lineage through parking', () => {
  const hook = setup();
  const blob = file(1),
    modelSHA = 'c'.repeat(64);
  const originals = [file(7), file(8)];
  const sources = new Map(
    originals.map((original, index) => [
      `same-model:${index}`,
      {
        id: `same-model:${index}`,
        blob,
        sha256: modelSHA,
        prepared: true,
        source: {
          sha256: String(index + 1).repeat(64),
          width: 100,
          height: 100,
        },
        original: { blob: original, sha256: String(index + 1).repeat(64) },
      },
    ]),
  );
  const descriptors = [...sources.values()].map((ref) => ({
    id: ref.id,
    sha256: modelSHA,
    source: ref.source,
    description: 'Existing caption',
  }));
  act(() => hook.result.current.restoreDraft(descriptors, null, sources));
  let parked;
  act(() => {
    parked = hook.result.current.park();
  });
  act(() =>
    hook.result.current.restoreDraft(parked.refs, null, parked.sources),
  );
  expect(hook.result.current.refs.map((ref) => ref.source.sha256)).toEqual([
    '1'.repeat(64),
    '2'.repeat(64),
  ]);
  expect(hook.result.current.refs.map((ref) => ref.original.blob)).toEqual(
    originals,
  );
  expect(api.referenceAnalysis).not.toHaveBeenCalled();
  expect(api.referencePrompt).not.toHaveBeenCalled();
});
