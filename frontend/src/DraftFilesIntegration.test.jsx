import React, { useLayoutEffect } from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useStudio } from './studio.js';
import { createDraftReferenceStore } from './draftReferenceStore.js';
import { deferred, imageBlob, memoryDb } from './cacheTestSupport.js';
import {
  fakeLibrary,
  fixtures,
  installApi,
  sizedRecord,
} from './testSupport.js';
import editing from '../../fixtures/api/image-editing.json';

const harness = vi.hoisted(() => ({ store: null }));
// Real persistence hook and real store, with an isolated deterministic database.
vi.mock('./useDraftReferencePersistence.js', async (original) => {
  const actual = await original();
  return {
    ...actual,
    useDraftReferencePersistence: (args) =>
      actual.useDraftReferencePersistence({
        ...args,
        store: harness.store,
        ready: true,
      }),
  };
});
let current;
function Harness() {
  const studio = useStudio();
  useLayoutEffect(() => {
    current = studio;
  });
  return null;
}
const row = (n) => ({
  id: `ref:${n}`,
  name: `reference-${n}.png`,
  sha256: String(n).padStart(64, '0'),
  blob: imageBlob(8),
  prepared: true,
  description: `Exact caption ${n}`,
  dimensions: { width: 4908, height: 6519 },
});
function setup() {
  const api = installApi({
    ...fakeLibrary([sizedRecord('previous', 1152, 768)]).routes,
    'GET /api/app-capabilities': () => ({
      ...fixtures.m1.capabilities,
      image_editing: editing.capabilities,
    }),
  });
  return { api, view: render(<Harness />) };
}
const hydrated = () =>
  waitFor(() => expect(current.draftReferencePersistence.hydrated).toBe(true));
const noInference = (api) =>
  expect(api.calls.filter((call) => call.key.startsWith('POST '))).toHaveLength(
    0,
  );
beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, '', '/');
  URL.createObjectURL = vi.fn(() => 'blob:exact-draft');
  URL.revokeObjectURL = vi.fn();
  harness.store = createDraftReferenceStore(memoryDb());
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('refresh restores exact edit files, order, captions and lineage without selecting an old result or inference', async () => {
  localStorage.setItem('imagedials-create-kind', '"edit"');
  const a = row(1),
    b = row(2);
  a.source = { sha256: 'a'.repeat(64), width: 9816, height: 13038 };
  a.original = { blob: imageBlob(16) };
  await harness.store.save({ attached: [a, b] }, 0);
  const { api, view } = setup();
  await hydrated();
  expect(current.kind).toBe('edit');
  expect(current.references.refs.map((ref) => ref.id)).toEqual([a.id, b.id]);
  expect(current.references.refs[0]).toMatchObject({
    sha256: a.sha256,
    description: a.description,
    dimensions: a.dimensions,
    source: a.source,
  });
  expect(current.references.refs[0].blob.size).toBe(8);
  expect(current.references.refs[0].original.originalFile.size).toBe(16);
  expect(current.current).toBeNull();
  noInference(api);
  view.unmount();
  render(<Harness />);
  await hydrated();
  expect(current.references.refs.map((ref) => ref.sha256)).toEqual([
    a.sha256,
    b.sha256,
  ]);
  expect(current.draft.prompt).toBe('');
  expect(current.current).toBeNull();
  noInference(api);
});

test.each(['text', 'asset'])(
  'refresh in %s parks attached files, Edit restores them, New draft clears both durable sets but retains mode',
  async (tool) => {
    localStorage.setItem('imagedials-create-kind', JSON.stringify(tool));
    await harness.store.save({ attached: [row(1), row(2)] }, 0);
    const { api, view } = setup();
    await hydrated();
    await waitFor(() => expect(current.parkedReferences).toBe(2));
    expect(current.kind).toBe(tool);
    expect(current.references.refs).toEqual([]);
    act(() => current.setKind('edit'));
    expect(current.references.refs.map((ref) => ref.id)).toEqual([
      'ref:1',
      'ref:2',
    ]);
    act(() => current.setKind(tool));
    await waitFor(async () =>
      expect((await harness.store.load()).parked).toHaveLength(2),
    );
    act(() => current.newDraft());
    await hydrated();
    await waitFor(async () => {
      const saved = await harness.store.load();
      expect(saved.attached).toEqual([]);
      expect(saved.parked).toBeNull();
    });
    expect(current.kind).toBe(tool);
    expect(current.parkedReferences).toBe(0);
    view.unmount();
    render(<Harness />);
    await hydrated();
    expect(current.kind).toBe(tool);
    expect(current.parkedReferences).toBe(0);
    expect(current.references.refs).toEqual([]);
    noInference(api);
  },
);

test('New draft fences a pending durable read before it can restore attached or parked files', async () => {
  localStorage.setItem('imagedials-create-kind', '"edit"');
  const old = { epoch: 0, attached: [row(1)], parked: [row(2)] };
  const pending = deferred();
  const store = harness.store;
  harness.store = { ...store, load: vi.fn(() => pending.promise) };
  const { api } = setup();
  act(() => current.newDraft());
  await hydrated();
  await act(async () => pending.resolve(old));
  expect(current.references.refs).toEqual([]);
  expect(current.parkedReferences).toBe(0);
  expect(current.kind).toBe('edit');
  expect((await store.load()).attached).toEqual([]);
  expect((await store.load()).parked).toBeNull();
  noInference(api);
});

test('a mode choice persists immediately while durable hydration is still pending', async () => {
  const pending = deferred();
  const real = harness.store;
  harness.store = { ...real, load: () => pending.promise };
  const { api } = setup();
  act(() => current.setKind('asset'));
  expect(localStorage.getItem('imagedials-create-kind')).toBe('"asset"');
  await act(async () =>
    pending.resolve({ epoch: 0, attached: [row(1)], parked: null }),
  );
  await hydrated();
  expect(current.kind).toBe('asset');
  expect(current.parkedReferences).toBe(1);
  expect(localStorage.getItem('imagedials-create-kind')).toBe('"asset"');
  noInference(api);
});
