import React, { StrictMode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import editing from '../../../../fixtures/api/image-editing.json';
import { api } from '../../data/api/api.js';
import {
  deferred,
  memoryChannels,
  memoryDb,
  quotaError,
} from '../../../tests/helpers/cacheTestSupport.js';
import { createUrlLedger } from '../../data/media/objectUrls.js';
import { sha256Hex } from '../../data/media/privateThumbnail.js';
import { createReferenceAssetsStore } from '../../data/storage/referenceAssets.js';
import { REF_STATUS } from './references.js';
import { retainedReader } from './retainedReferences.js';
import { useReferences } from './useReferences.js';
import { useRetainedReferences } from './useRetainedReferences.js';

vi.mock('../../data/api/api.js', async (original) => {
  const actual = await original();
  return {
    ...actual,
    api: {
      ...actual.api,
      referenceAnalysis: vi.fn(),
      inspectReference: vi.fn(),
    },
  };
});

const bytesOf = (base64) =>
  Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
const fixture = (index) =>
  new File(
    [bytesOf(editing.files[index].base64)],
    editing.files[index].filename,
    {
      type: 'image/png',
    },
  );
const SHA = (index) => editing.files[index].sha256;
const capability = {
  enabled: true,
  maxReferences: 3,
  maxImageBytes: 1 << 20,
  maxTotalBytes: 4 << 20,
};
const uploads = {
  image_mime_types: ['image/png', 'image/jpeg', 'image/webp'],
  import_max_bytes: 1 << 20,
};
const LIMITS = { referenceRecordLimit: 3, referenceMaxBytes: 1 << 20 };

let revoked;
let leased;
beforeEach(() => {
  revoked = [];
  leased = 0;
  api.referenceAnalysis.mockReset();
  api.inspectReference.mockReset();
  api.referenceAnalysis.mockImplementation(async (blob, context, options) => ({
    source_sha256: await sha256Hex(blob),
    description: `Described ${options.name}`,
    suggested_prompt: '',
    dimensions: { width: 40, height: 24 },
    revision: context.revision,
  }));
});
afterEach(() => vi.restoreAllMocks());

function setup({
  db = memoryDb(),
  channels = memoryChannels(),
  limits = LIMITS,
  store = null,
  strict = false,
  ready = true,
  withReader = true,
  readSaved = null,
} = {}) {
  const owner =
    store ??
    createReferenceAssetsStore(db, {
      getLimits: () => limits,
      openChannel: channels,
    });
  const another = () =>
    createReferenceAssetsStore(db, {
      getLimits: () => limits,
      openChannel: channels,
    });
  const urls = createUrlLedger({
    createObjectURL: () => `blob:ref-${(leased += 1)}`,
    revokeObjectURL: (url) => revoked.push(url),
  });
  const hook = renderHook(
    (props) => {
      const references = useReferences({
        urls,
        capability,
        uploads,
        getDraft: () => ({ prompt: '', mode: 'image', revision: 0 }),
        setPrompt: () => {},
        getProviderHeader: () => null,
        readRetained: props.reader,
        readSaved,
      });
      const retained = useRetainedReferences({
        store: props.store,
        ready: props.ready,
        references,
        capability,
      });
      return { references, retained };
    },
    {
      initialProps: {
        store: owner,
        ready,
        reader: withReader ? retainedReader(owner) : null,
      },
      ...(strict ? { wrapper: StrictMode } : {}),
    },
  );
  const now = () => hook.result.current;
  return { db, owner, another, urls, hook, now };
}

const listed = (ctx) =>
  waitFor(() => expect(ctx.now().retained.status).toBe('ready'));
const attach = async (ctx, file) => {
  await act(async () => {
    ctx.now().references.add([file]);
  });
  await waitFor(() => {
    const last = ctx.now().references.refs.at(-1);
    expect(last.description).not.toBe('');
    expect(last.analyzing).toBe(false);
  });
  return ctx.now().references.refs.at(-1);
};
const keep = (ctx, id) =>
  act(async () => {
    await ctx.now().retained.keep(id);
  });
const keepFile = async (store, index, extra = {}) => {
  const ticket = await store.beginKeep();
  return store.keep(ticket, {
    sha256: SHA(index),
    blob: fixture(index),
    name: editing.files[index].filename,
    description: `Stored ${index}`,
    dimensions: { width: 40, height: 24 },
    ...extra,
  });
};

describe('keeping a reference', () => {
  test('happens only on the explicit action, takes its ticket first and stores allowlisted fields', async () => {
    const ctx = setup();
    const read = vi.spyOn(ctx.owner, 'read');
    const begin = vi.spyOn(ctx.owner, 'beginKeep');
    const save = vi.spyOn(ctx.owner, 'keep');
    await listed(ctx);
    const ref = await attach(ctx, fixture(0));
    // Attaching, describing and hashing keep nothing.
    expect(begin).not.toHaveBeenCalled();
    expect(ctx.now().retained.items).toEqual([]);

    await keep(ctx, ref.id);
    expect(begin.mock.invocationCallOrder[0]).toBeLessThan(
      save.mock.invocationCallOrder[0],
    );
    const [, candidate] = save.mock.calls[0];
    expect(Object.keys(candidate).sort()).toEqual([
      'blob',
      'description',
      'dimensions',
      'name',
      'sha256',
    ]);
    expect(candidate).toMatchObject({
      sha256: SHA(0),
      name: 'color-1.png',
      description: 'Described color-1.png',
      dimensions: { width: 40, height: 24 },
    });
    expect(ctx.now().retained.items.map((item) => item.sha256)).toEqual([
      SHA(0),
    ]);
    expect(ctx.now().retained.find(SHA(0))).toMatchObject({ bytes: 98 });
    expect(ctx.now().retained.keeps).toEqual({});
    // Listing is metadata only; the Blob was never read to build it.
    expect(read).not.toHaveBeenCalled();
  });

  test.each([
    ['the browser reports no room', 'quota', /no room to store it/, true],
    ['the limit is reached', 'record-limit', /files are in use/, false],
    ['it does not fit', 'byte-limit', /does not fit/, false],
  ])(
    'when %s the file stays in the draft and is reported as not kept',
    async (_name, reason, message, retry) => {
      const ctx = setup();
      await listed(ctx);
      const ref = await attach(ctx, fixture(0));
      vi.spyOn(ctx.owner, 'keep').mockResolvedValueOnce({
        persisted: false,
        reason,
      });
      await keep(ctx, ref.id);
      const state = ctx.now().retained.keeps[ref.id];
      expect(state).toMatchObject({ status: 'failed', reason, retry });
      expect(state.message).toMatch(/^Not kept: /);
      expect(state.message).toMatch(message);
      expect(state.message).toMatch(/still in this draft/);
      // Nothing lost: bytes, URL and description are exactly as before.
      const same = ctx.now().references.refs[0];
      expect(same.blob).toBe(ref.blob);
      expect(same.url).toBe(ref.url);
      expect(ctx.urls.held(ref.url)).toBe(1);
      expect(revoked).toEqual([]);
      expect(ctx.now().retained.items).toEqual([]);
    },
  );

  test('a denied ticket or a thrown save reports not kept, and Retry can then succeed', async () => {
    const ctx = setup();
    await listed(ctx);
    const ref = await attach(ctx, fixture(0));
    vi.spyOn(ctx.owner, 'beginKeep').mockRejectedValueOnce(quotaError());
    await keep(ctx, ref.id);
    expect(ctx.now().retained.keeps[ref.id]).toMatchObject({
      status: 'failed',
      retry: true,
      error: { message: expect.any(String) },
      diagnostic: { kind: 'local' },
    });
    expect(ctx.now().references.refs).toHaveLength(1);
    await keep(ctx, ref.id);
    expect(ctx.now().retained.keeps).toEqual({});
    expect(ctx.now().retained.find(SHA(0))).toBeTruthy();
  });

  test('without browser storage nothing is kept and the draft is untouched', async () => {
    const ctx = setup({ store: createReferenceAssetsStore(null) });
    await waitFor(() => expect(ctx.now().retained.status).toBe('idle'));
    expect(ctx.now().retained.available).toBe(false);
    const ref = await attach(ctx, fixture(0));
    await keep(ctx, ref.id);
    expect(ctx.now().retained.keeps[ref.id]).toMatchObject({
      status: 'failed',
      reason: 'no-storage',
      retry: false,
    });
    expect(ctx.now().references.refs[0].blob).toBe(ref.blob);
  });

  test('a removal in another tab fences a pending save; Retry takes a fresh ticket', async () => {
    const ctx = setup();
    await listed(ctx);
    const ref = await attach(ctx, fixture(0));
    const other = ctx.another();
    const entry = (await keepFile(other, 1)).entry;
    const real = ctx.owner.keep.bind(ctx.owner);
    vi.spyOn(ctx.owner, 'keep').mockImplementationOnce(async (ticket, file) => {
      // The other tab removes a file after this save took its ticket.
      await other.remove(entry.sha256, { revision: entry.revision });
      return real(ticket, file);
    });
    await keep(ctx, ref.id);
    expect(ctx.now().retained.keeps[ref.id]).toMatchObject({
      status: 'failed',
      reason: 'changed',
      retry: true,
    });
    expect(ctx.now().references.refs).toHaveLength(1);
    expect(ctx.now().retained.find(SHA(0))).toBeNull();
    await keep(ctx, ref.id);
    expect(ctx.now().retained.keeps).toEqual({});
    expect(ctx.now().retained.find(SHA(0))).toBeTruthy();
  });

  test('a second request for the same reference while saving is ignored', async () => {
    const ctx = setup();
    await listed(ctx);
    const ref = await attach(ctx, fixture(0));
    const gate = deferred();
    const real = ctx.owner.keep.bind(ctx.owner);
    const save = vi
      .spyOn(ctx.owner, 'keep')
      .mockImplementation(async (...args) => {
        await gate.promise;
        return real(...args);
      });
    let first;
    await act(async () => {
      first = ctx.now().retained.keep(ref.id);
    });
    await waitFor(() =>
      expect(ctx.now().retained.keeps[ref.id].status).toBe('saving'),
    );
    await act(async () => {
      await ctx.now().retained.keep(ref.id);
    });
    gate.resolve();
    await act(async () => {
      await first;
    });
    expect(save).toHaveBeenCalledTimes(1);
  });
});

describe('the kept-file list', () => {
  test('is metadata only, ordered newest first, and starts with nothing attached', async () => {
    const ctx = setup();
    await keepFile(ctx.owner, 0, { description: 'one' });
    await keepFile(ctx.owner, 1, { description: 'two' });
    const read = vi.spyOn(ctx.owner, 'read');
    await act(async () => {
      await ctx.now().retained.refresh();
    });
    await listed(ctx);
    expect(ctx.now().retained.items).toHaveLength(2);
    expect(ctx.now().retained.usage).toMatchObject({ count: 2, maxRecords: 3 });
    // Neither a fresh start nor the listing attaches or reads a file.
    expect(ctx.now().references.refs).toEqual([]);
    expect(read).not.toHaveBeenCalled();
    expect(api.referenceAnalysis).not.toHaveBeenCalled();
  });

  test('an older listing that finishes late never replaces a newer one', async () => {
    const ctx = setup();
    await listed(ctx);
    const slow = deferred();
    const real = ctx.owner.list.bind(ctx.owner);
    const list = vi.spyOn(ctx.owner, 'list');
    list.mockImplementationOnce(() => slow.promise);
    let older;
    await act(async () => {
      older = ctx.now().retained.refresh();
    });
    await keepFile(ctx.owner, 0);
    list.mockImplementation(real);
    await act(async () => {
      await ctx.now().retained.refresh();
    });
    expect(ctx.now().retained.items).toHaveLength(1);
    await act(async () => {
      slow.resolve({ durable: true, items: [], usage: { count: 0 } });
      await older;
    });
    expect(ctx.now().retained.items).toHaveLength(1);
  });

  test('an unreadable list is reported, never shown as an empty success', async () => {
    const ctx = setup();
    await listed(ctx);
    vi.spyOn(ctx.owner, 'list').mockRejectedValueOnce(new Error('blocked'));
    await act(async () => {
      await ctx.now().retained.refresh();
    });
    expect(ctx.now().retained).toMatchObject({
      status: 'error',
      error: 'blocked',
      failure: { message: 'blocked', diagnostic: { reason: 'blocked' } },
      items: [],
    });
  });

  test('follows another tab’s keep and removal, and visibility, then stops', async () => {
    const channels = memoryChannels();
    const ctx = setup({ channels });
    await listed(ctx);
    const other = ctx.another();
    const added = await keepFile(other, 0);
    await waitFor(() =>
      expect(ctx.now().retained.items.map((i) => i.sha256)).toEqual([SHA(0)]),
    );
    await other.remove(SHA(0), { revision: added.entry.revision });
    await waitFor(() => expect(ctx.now().retained.items).toEqual([]));

    // Where no channel exists a returning tab still catches up.
    const quiet = other.keep.bind(other);
    const ticket = await other.beginKeep();
    await quiet(ticket, {
      sha256: SHA(1),
      blob: fixture(1),
      name: 'x.png',
    });
    const list = vi.spyOn(ctx.owner, 'list');
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(list).toHaveBeenCalled();
    ctx.hook.unmount();
    list.mockClear();
    await keepFile(other, 0);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(list).not.toHaveBeenCalled();
    delete document.visibilityState;
  });

  test('StrictMode remounting leaves one live subscription and a correct list', async () => {
    const ctx = setup({ strict: true });
    await listed(ctx);
    const list = vi.spyOn(ctx.owner, 'list');
    await keepFile(ctx.another(), 0);
    await waitFor(() => expect(ctx.now().retained.items).toHaveLength(1));
    // One change refreshed once: the remount left a single subscription.
    expect(list).toHaveBeenCalledTimes(1);
  });
});

describe('removing a kept copy', () => {
  test('uses the confirmed revision and leaves the attached reference untouched', async () => {
    const ctx = setup();
    await listed(ctx);
    const ref = await attach(ctx, fixture(0));
    await keep(ctx, ref.id);
    const item = ctx.now().retained.find(SHA(0));
    let outcome;
    await act(async () => {
      outcome = await ctx.now().retained.remove(item);
    });
    expect(outcome).toEqual({ removed: true });
    expect(ctx.now().retained.items).toEqual([]);
    expect(ctx.now().retained.usage).toMatchObject({ count: 0, bytes: 0 });
    // The draft still holds the exact file, its URL and its description.
    const same = ctx.now().references.refs[0];
    expect(same.blob).toBe(ref.blob);
    expect(same.url).toBe(ref.url);
    expect(same.description).toBe('Described color-1.png');
    expect(ctx.urls.held(ref.url)).toBe(1);
    expect(revoked).toEqual([]);
  });

  test('a stale confirmation cannot remove a newer copy', async () => {
    const ctx = setup();
    await keepFile(ctx.owner, 0);
    await listed(ctx);
    await waitFor(() => expect(ctx.now().retained.items).toHaveLength(1));
    const shown = ctx.now().retained.find(SHA(0));
    // Another tab replaces the file while the confirmation is open.
    const other = ctx.another();
    await other.remove(SHA(0), { revision: shown.revision });
    await keepFile(other, 0, { description: 'new copy' });
    let outcome;
    await act(async () => {
      outcome = await ctx.now().retained.remove(shown);
    });
    expect(outcome.removed).toBe(false);
    expect(outcome.message).toMatch(/changed in another tab/);
    expect(ctx.now().retained.find(SHA(0))).toMatchObject({
      description: 'new copy',
    });
  });
});

describe('choosing a kept file again', () => {
  test('attaches it without an upload or description, reading its bytes only now', async () => {
    const ctx = setup();
    await keepFile(ctx.owner, 0, { description: 'Stored lamp' });
    await listed(ctx);
    await waitFor(() => expect(ctx.now().retained.items).toHaveLength(1));
    const read = vi.spyOn(ctx.owner, 'read');
    expect(read).not.toHaveBeenCalled();
    let result;
    await act(async () => {
      result = await ctx.now().retained.pick(ctx.now().retained.items[0]);
    });
    expect(result.ok).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
    const [ref] = ctx.now().references.refs;
    expect(ref).toMatchObject({
      sha256: SHA(0),
      description: 'Stored lamp',
      status: REF_STATUS.ready,
      name: 'color-1.png',
      dimensions: { width: 40, height: 24 },
    });
    expect(ref.id).toMatch(/^upload:/);
    expect(ref.blob.size).toBe(98);
    expect(ctx.urls.held(ref.url)).toBe(1);
    // Neither a model call nor the existing checksum helper ran.
    expect(api.referenceAnalysis).not.toHaveBeenCalled();
    expect(api.inspectReference).not.toHaveBeenCalled();
    expect(ctx.now().references.proposal).toBeNull();
  });

  test('refuses a file already in the draft, a full draft, and a vanished file', async () => {
    const ctx = setup();
    await keepFile(ctx.owner, 0);
    await keepFile(ctx.owner, 1);
    await listed(ctx);
    await waitFor(() => expect(ctx.now().retained.items).toHaveLength(2));
    const item = (sha) => ctx.now().retained.find(sha);
    await act(async () => {
      await ctx.now().retained.pick(item(SHA(0)));
    });
    let again;
    await act(async () => {
      again = await ctx.now().retained.pick(item(SHA(0)));
    });
    expect(again).toEqual({
      ok: false,
      reason: 'That image is already a reference.',
    });
    expect(ctx.now().references.refs).toHaveLength(1);

    // Another tab removes it between listing and choosing.
    const gone = item(SHA(1));
    await ctx.another().remove(SHA(1), { revision: gone.revision });
    let missing;
    await act(async () => {
      missing = await ctx.now().retained.pick(gone);
    });
    expect(missing).toEqual({
      ok: false,
      reason: 'That kept file is no longer available.',
    });
    expect(ctx.now().references.refs).toHaveLength(1);
  });

  test('a kept file saved without a description is described like any new reference', async () => {
    const ctx = setup();
    await keepFile(ctx.owner, 0, { description: '' });
    await listed(ctx);
    await waitFor(() => expect(ctx.now().retained.items).toHaveLength(1));
    await act(async () => {
      await ctx.now().retained.pick(ctx.now().retained.items[0]);
    });
    await waitFor(() =>
      expect(ctx.now().references.refs[0].description).toBe(
        'Described color-1.png',
      ),
    );
    expect(api.referenceAnalysis).toHaveBeenCalledTimes(1);
  });
});

describe('restoring a saved edit', () => {
  const descriptor = (index, extra = {}) => ({
    id: `upload:saved-${index}`,
    sha256: SHA(index),
    filename: editing.files[index].filename,
    description: `Saved ${index}`,
    role: index === 0 ? 'base' : 'reference',
    ...extra,
  });

  test('recovers exact originals by checksum with no model or network call', async () => {
    const ctx = setup();
    await keepFile(ctx.owner, 0);
    await listed(ctx);
    const read = vi.spyOn(ctx.owner, 'read');
    act(() => {
      ctx.now().references.restore([descriptor(0), descriptor(1)]);
    });
    expect(ctx.now().references.refs.map((r) => r.status)).toEqual([
      REF_STATUS.resolving,
      REF_STATUS.resolving,
    ]);
    await waitFor(() =>
      expect(ctx.now().references.refs.map((r) => r.status)).toEqual([
        REF_STATUS.ready,
        REF_STATUS.missing,
      ]),
    );
    const [first, second] = ctx.now().references.refs;
    expect(first.blob.size).toBe(98);
    // The saved description wins; the stored one is not substituted.
    expect(first.description).toBe('Saved 0');
    expect(ctx.urls.held(first.url)).toBe(1);
    expect(second).toMatchObject({ status: REF_STATUS.missing, blob: null });
    // One lookup per slot, by checksum; only the kept one returned bytes.
    expect(read.mock.calls.map(([sha]) => sha)).toEqual([SHA(0), SHA(1)]);
    expect(api.referenceAnalysis).not.toHaveBeenCalled();
    expect(api.inspectReference).not.toHaveBeenCalled();
    expect(ctx.now().references.proposal).toBeNull();
  });

  test('a stored file with other bytes never fills the slot', async () => {
    // A store that trusts the claimed checksum (as on plain HTTP).
    const db = memoryDb();
    const trusting = createReferenceAssetsStore(db, {
      getLimits: () => LIMITS,
      digest: async () => null,
      openChannel: () => null,
    });
    const ctx = setup({ db, store: trusting });
    await keepFile(trusting, 0, { blob: fixture(1) });
    await listed(ctx);
    act(() => {
      ctx.now().references.restore([descriptor(0)]);
    });
    await waitFor(() =>
      expect(ctx.now().references.refs[0].status).toBe(REF_STATUS.missing),
    );
    expect(ctx.now().references.refs[0].blob).toBeNull();
    expect(leased).toBe(0);
  });

  test('a late read after the slot was cleared changes nothing and leases nothing', async () => {
    const ctx = setup();
    await keepFile(ctx.owner, 0);
    await listed(ctx);
    const gate = deferred();
    const real = ctx.owner.read.bind(ctx.owner);
    const signals = [];
    vi.spyOn(ctx.owner, 'read').mockImplementation(async (sha) => {
      await gate.promise;
      signals.push(sha);
      return real(sha);
    });
    act(() => {
      ctx.now().references.restore([descriptor(0)]);
    });
    act(() => {
      ctx.now().references.clear();
    });
    await act(async () => gate.resolve());
    expect(ctx.now().references.refs).toEqual([]);
    expect(leased).toBe(0);
  });

  test('a slot missing before kept files were readable is filled once they are', async () => {
    const db = memoryDb();
    const owner = createReferenceAssetsStore(db, {
      getLimits: () => LIMITS,
      openChannel: () => null,
    });
    await keepFile(owner, 0);
    const ctx = setup({ db, store: owner, ready: false, withReader: false });
    act(() => {
      ctx.now().references.restore([descriptor(0)]);
    });
    expect(ctx.now().references.refs[0].status).toBe(REF_STATUS.missing);
    ctx.hook.rerender({
      store: owner,
      ready: true,
      reader: retainedReader(owner),
    });
    await waitFor(() =>
      expect(ctx.now().references.refs[0].status).toBe(REF_STATUS.ready),
    );
    expect(ctx.now().references.refs[0].blob.size).toBe(98);
    expect(api.referenceAnalysis).not.toHaveBeenCalled();
  });

  test('a saved image is the fallback when nothing is kept', async () => {
    const blob = fixture(0);
    const readSaved = vi.fn(async () => blob);
    const ctx = setup({ readSaved });
    await listed(ctx);
    act(() => {
      ctx.now().references.restore([descriptor(0, { id: 'image:stored-one' })]);
    });
    await waitFor(() =>
      expect(ctx.now().references.refs[0].status).toBe(REF_STATUS.ready),
    );
    expect(readSaved).toHaveBeenCalledTimes(1);
  });
});

describe('sources held in this tab', () => {
  test('failed kept-file reads retain their original diagnostic', async () => {
    const ctx = setup();
    await listed(ctx);
    await keepFile(ctx.owner, 0);
    await act(async () => ctx.now().retained.refresh());
    const item = ctx.now().retained.find(SHA(0));
    const cause = new Error('The stored file could not be opened.');
    vi.spyOn(ctx.owner, 'read').mockRejectedValueOnce(cause);
    let result;
    await act(async () => {
      result = await ctx.now().retained.pick(item);
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        message: cause.message,
        diagnostic: {
          kind: 'local',
          cause: { name: 'Error', message: cause.message },
        },
      },
    });
    expect(ctx.now().references.refs).toEqual([]);
  });

  test('a thrown kept-file removal settles as a failure with diagnostics', async () => {
    const ctx = setup();
    await listed(ctx);
    await keepFile(ctx.owner, 0);
    await act(async () => ctx.now().retained.refresh());
    const item = ctx.now().retained.find(SHA(0));
    const cause = new Error('The removal transaction was aborted.');
    vi.spyOn(ctx.owner, 'remove').mockRejectedValueOnce(cause);
    let result;
    await act(async () => {
      result = await ctx.now().retained.remove(item);
    });
    expect(result).toMatchObject({
      removed: false,
      message: expect.any(String),
      error: { message: cause.message, diagnostic: { kind: 'local' } },
    });
    expect(ctx.now().retained.find(SHA(0))).toBeTruthy();
  });

  test('are looked up by checksum without exposing or changing the memory', async () => {
    const ctx = setup();
    await listed(ctx);
    const ref = await attach(ctx, fixture(0));
    const held = ctx.now().references.heldSource(SHA(0));
    expect(held.blob).toBe(ref.blob);
    expect(held).toMatchObject({ name: 'color-1.png' });
    expect(ctx.now().references.heldSource('unknown')).toBeNull();
    expect(ctx.now().references.heldSource(undefined)).toBeNull();
    held.name = 'changed';
    expect(ctx.now().references.heldSource(SHA(0)).name).toBe('color-1.png');
  });
});
