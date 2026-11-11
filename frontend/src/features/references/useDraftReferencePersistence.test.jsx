import { useState } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import {
  deferred,
  memoryDb,
  imageBlob,
} from '../../../tests/helpers/cacheTestSupport.js';
import { createDraftReferenceStore } from '../../data/storage/draftReferenceStore.js';
import {
  useDraftReferencePersistence,
  restoredReferenceDraft,
} from './useDraftReferencePersistence.js';
const row = (n) => ({
  id: `ref:${n}`,
  name: `${n}.png`,
  sha256: String(n).padStart(64, '0'),
  blob: imageBlob(),
  prepared: true,
  description: `Caption ${n}`,
});
const setup = (store, ready = true) =>
  renderHook(
    ({ enabled }) => {
      const [refs, setRefs] = useState([]);
      const [parked, setParked] = useState(null);
      const references = {
        refs,
        restoreDraft: (descriptors, _proposal, sources) =>
          setRefs(
            descriptors.map((item) => ({ ...item, ...sources.get(item.id) })),
          ),
      };
      const persistence = useDraftReferencePersistence({
        references,
        parked,
        onRestoreParked: setParked,
        store,
        ready: enabled,
      });
      return { refs, setRefs, parked, setParked, ...persistence };
    },
    { initialProps: { enabled: ready } },
  );
afterEach(cleanup);

test('hydrates exact files without analysis and automatically saves attached and parked changes', async () => {
  const store = createDraftReferenceStore(memoryDb());
  await store.save({ attached: [row(1)], parked: { refs: [row(2)] } }, 0);
  const hook = setup(store);
  await waitFor(() => expect(hook.result.current.hydrated).toBe(true));
  expect(hook.result.current.refs[0].sha256).toBe(row(1).sha256);
  expect(hook.result.current.parked.sources.get('ref:2').blob.size).toBe(8);
  act(() => hook.result.current.setRefs([row(3)]));
  await waitFor(async () =>
    expect((await store.load()).attached[0].id).toBe('ref:3'),
  );
  expect((await store.load()).parked[0].id).toBe('ref:2');
});

test('New draft invalidates a pending hydration and clears stored files', async () => {
  const load = deferred();
  const store = {
    durable: true,
    load: () => load.promise,
    clear: vi.fn(async () => ({ cleared: true, epoch: 1 })),
    save: vi.fn(async () => ({ persisted: true })),
  };
  const hook = setup(store);
  await act(async () => {
    await hook.result.current.clear();
    hook.result.current.setRefs([]);
  });
  await act(async () =>
    load.resolve({ epoch: 0, attached: [row(1)], parked: [row(2)] }),
  );
  expect(hook.result.current.refs).toEqual([]);
  expect(hook.result.current.parked).toBeNull();
  expect(store.clear).toHaveBeenCalledOnce();
  expect(
    store.save.mock.calls.every(
      ([snapshot, epoch]) => !snapshot.attached.length && epoch === 1,
    ),
  ).toBe(true);
});

test('clear before database opens fences pending reads and writes', async () => {
  const store = createDraftReferenceStore(memoryDb());
  await store.save({ attached: [row(1)] }, 0);
  const hook = setup(store, false);
  await act(async () => hook.result.current.clear());
  hook.rerender({ enabled: true });
  await waitFor(() => expect(hook.result.current.hydrated).toBe(true));
  expect((await store.load()).attached).toEqual([]);
  expect(hook.result.current.refs).toEqual([]);
});

test('live gestures during hydration win over stored state', async () => {
  const load = deferred();
  const store = {
    durable: true,
    load: () => load.promise,
    save: vi.fn(async () => ({ persisted: true })),
  };
  const hook = setup(store);
  act(() => hook.result.current.setRefs([row(3)]));
  await act(async () =>
    load.resolve({ epoch: 0, attached: [row(1)], parked: [row(2)] }),
  );
  expect(hook.result.current.refs[0].id).toBe('ref:3');
  expect(hook.result.current.parked).toBeNull();
});

test('storage quota notice leaves live files safe and includes local diagnostics', async () => {
  const store = {
    durable: true,
    load: async () => ({ epoch: 0, attached: [] }),
    save: async () => ({ persisted: false, reason: 'quota' }),
  };
  const hook = setup(store);
  await waitFor(() => expect(hook.result.current.hydrated).toBe(true));
  act(() => hook.result.current.setRefs([row(1)]));
  await waitFor(() =>
    expect(hook.result.current.notice?.diagnostic.category).toBe(
      'reference-storage',
    ),
  );
  expect(hook.result.current.refs[0].blob.size).toBe(8);
});

test('restored originals retain original bytes and source dimensions', () => {
  const input = {
    ...row(1),
    source: { width: 120, height: 80 },
    original: { blob: imageBlob(20) },
  };
  const restored = restoredReferenceDraft([input]);
  expect(restored.sources.get(input.id).original.originalFile).toBe(
    input.original.blob,
  );
  expect(restored.sources.get(input.id).original.dimensions).toEqual({
    width: 120,
    height: 80,
  });
});

test('a failed hydration never overwrites unreadable persisted files with an empty draft', async () => {
  const store = {
    durable: true,
    load: async () => {
      throw new Error('storage read denied');
    },
    save: vi.fn(async () => ({ persisted: true })),
  };
  const hook = setup(store);
  await waitFor(() => expect(hook.result.current.hydrated).toBe(true));
  expect(hook.result.current.notice.diagnostic.category).toBe(
    'reference-storage',
  );
  expect(store.save).not.toHaveBeenCalled();
});

test('a synchronous live reference gesture fences hydration before its render effect arrives', async () => {
  const pending = deferred();
  const live = { current: [] };
  const references = { refs: live.current, live, restoreDraft: vi.fn() };
  const store = {
    durable: true,
    load: () => pending.promise,
    save: vi.fn(async () => ({ persisted: true })),
  };
  const hook = renderHook(() =>
    useDraftReferencePersistence({ references, store }),
  );
  live.current = [row(2)];
  await act(async () =>
    pending.resolve({ epoch: 0, attached: [row(1)], parked: null }),
  );
  expect(hook.result.current.hydrated).toBe(true);
  expect(references.restoreDraft).not.toHaveBeenCalled();
});
