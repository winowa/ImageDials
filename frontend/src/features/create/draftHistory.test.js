import { describe, expect, test } from 'vitest';

import {
  createDraftHistory,
  editableTarget,
  historyShortcut,
  referenceSnapshot,
  sameSnapshot,
  settledDynamic,
  shortcutLabels,
} from './draftHistory.js';

const metadata = { source: 'test' };
const snapshot = (overrides = {}) => ({
  draft: { prompt: 'one', mode: 'image', aspect: '3:2', mustHaveTerms: ['x'] },
  entries: [],
  dynamic: { status: 'ready', anchor: 'one', metadata },
  additionalMetadata: [],
  basedOn: null,
  episode: { anchor: 'one', pending: false },
  derivedPrompt: null,
  refs: [],
  proposal: null,
  ...overrides,
});

describe('whole-draft history', () => {
  test('coalesces prompt typing, bounds history, and clears redo after a new edit', () => {
    let now = 0;
    const history = createDraftHistory({ limit: 2, now: () => now });
    const first = snapshot();
    history.record(first, { label: 'Edit prompt', coalesce: 'prompt' });
    now += 500;
    history.record(snapshot({ draft: { ...first.draft, prompt: 'tw' } }), {
      label: 'Edit prompt',
      coalesce: 'prompt',
    });
    expect(history.state().size).toBe(1);
    expect(
      history.undo(snapshot({ draft: { ...first.draft, prompt: 'two' } }))
        .snapshot,
    ).toBe(first);
    expect(history.state().canRedo).toBe(true);
    history.record(snapshot(), { label: 'Change aspect' });
    history.record(snapshot(), { label: 'Change mode' });
    history.record(snapshot(), { label: 'Change aspect' });
    expect(history.state().size).toBe(2);
    expect(history.state().canRedo).toBe(false);
  });

  test('seals coalescing groups on undo and redo and skips unchanged steps', () => {
    const history = createDraftHistory({ now: () => 10 });
    const a = snapshot();
    const b = snapshot({ draft: { ...a.draft, aspect: '1:1' } });
    const c = snapshot({ draft: { ...a.draft, aspect: '2:3' } });
    history.record(a, { label: 'Change aspect' });
    history.record(b, { label: 'Change aspect' });
    expect(history.undo(c).snapshot).toBe(b);
    expect(history.redo(b).snapshot).toBe(c);
  });

  test('snapshot equality covers mode, aspect, terms, controls, metadata, references and proposal state', () => {
    const base = snapshot();
    expect(sameSnapshot(base, snapshot())).toBe(true);
    expect(
      sameSnapshot(
        base,
        snapshot({ draft: { ...base.draft, mode: 'asset-image' } }),
      ),
    ).toBe(false);
    expect(
      sameSnapshot(
        base,
        snapshot({ draft: { ...base.draft, mustHaveTerms: [] } }),
      ),
    ).toBe(false);
    expect(
      sameSnapshot(base, snapshot({ proposal: { kind: 'offered' } })),
    ).toBe(false);
  });

  test('region edits are part of one restorable draft snapshot', () => {
    const before = snapshot({ regionEdit: null });
    const selected = { version: 1, source_sha256: 'a'.repeat(64), shapes: [] };
    const after = snapshot({ regionEdit: selected });
    expect(sameSnapshot(before, after)).toBe(false);
    const history = createDraftHistory();
    history.record(before, { label: 'Select image region' });
    expect(history.undo(after).snapshot.regionEdit).toBeNull();
  });

  test('snapshots references by identity and description without copying their Blob', () => {
    const blob = new Blob(['large original']);
    const ref = {
      id: 'ref',
      name: 'original.png',
      sha256: 'abc',
      description: 'scene',
      blob,
    };
    const held = referenceSnapshot(ref);
    expect(held).not.toHaveProperty('blob');
    expect(held).toMatchObject({
      id: 'ref',
      filename: 'original.png',
      sha256: 'abc',
      description: 'scene',
    });
  });

  test('settles in-flight prompt work to the last stable state', () => {
    expect(
      settledDynamic({ status: 'loading', anchor: 'p', metadata: 7 }),
    ).toEqual({
      status: 'ready',
      anchor: 'p',
      metadata: 7,
      error: null,
    });
    expect(
      settledDynamic({ status: 'error', anchor: null, error: Error('x') }),
    ).toEqual({
      status: 'idle',
      anchor: null,
      error: null,
    });
  });
});

describe('draft shortcuts', () => {
  test('preserves native editable-field undo and ignores dialogs and composition', () => {
    const textarea = document.createElement('textarea');
    const input = document.createElement('input');
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    const button = document.createElement('button');
    dialog.append(button);
    expect(editableTarget(textarea)).toBe(true);
    expect(editableTarget(input)).toBe(true);
    expect(editableTarget(button)).toBe(false);
    expect(
      historyShortcut({ key: 'z', ctrlKey: true, target: textarea }),
    ).toBeNull();
    expect(
      historyShortcut({
        key: 'z',
        ctrlKey: true,
        target: button,
        isComposing: true,
      }),
    ).toBeNull();
    expect(
      historyShortcut({
        key: 'z',
        ctrlKey: true,
        target: button,
        defaultPrevented: true,
      }),
    ).toBeNull();
    expect(
      historyShortcut({ key: 'z', ctrlKey: true, target: button }),
    ).toBeNull();
  });

  test('maps platform undo and redo keys', () => {
    expect(
      historyShortcut({ key: 'z', ctrlKey: true, target: document.body }),
    ).toBe('undo');
    expect(
      historyShortcut({ key: 'y', ctrlKey: true, target: document.body }),
    ).toBe('redo');
    expect(
      historyShortcut(
        { key: 'z', metaKey: true, shiftKey: true, target: document.body },
        { apple: true },
      ),
    ).toBe('redo');
    expect(shortcutLabels({ platform: 'MacIntel' })).toMatchObject({
      undo: '⌘Z',
      redo: '⇧⌘Z',
    });
  });
});
