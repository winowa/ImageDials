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

import KeptReferencesDialog from './KeptReferences.jsx';
import { deferred } from './cacheTestSupport.js';
import { createUrlLedger } from './objectUrls.js';
import { ReferenceItem } from './References.jsx';

const item = (extra = {}) => ({
  id: 'upload:a',
  name: 'lamp.png',
  status: 'ready',
  sha256: 'sha-a',
  blob: new Blob(['a'], { type: 'image/png' }),
  url: 'blob:draft-a',
  analyzing: false,
  ...extra,
});
const keptEntry = (extra = {}) => ({
  sha256: 'sha-a',
  name: 'lamp.png',
  description: 'A brass lamp',
  dimensions: { width: 40, height: 24 },
  type: 'image/png',
  bytes: 1536,
  savedAt: Date.UTC(2026, 10, 2),
  revision: 4,
  ...extra,
});
const retainedWith = (extra = {}) => ({
  ready: true,
  available: true,
  status: 'ready',
  error: null,
  items: [],
  usage: { count: 0, bytes: 0, sequence: 0, maxRecords: 32, maxBytes: 1 << 28 },
  find: () => null,
  keeps: {},
  attached: new Set(),
  addBlock: null,
  refresh: vi.fn(),
  keep: vi.fn(),
  dismissKeep: vi.fn(),
  remove: vi.fn(async () => ({ removed: true })),
  pick: vi.fn(async () => ({ ok: true })),
  load: vi.fn(async () => new Blob(['kept'], { type: 'image/png' })),
  ...extra,
});
const refsApi = () => ({
  move: vi.fn(),
  remove: vi.fn(),
  retryAnalysis: vi.fn(),
  reattach: vi.fn(),
});

const renderItem = (props = {}) => {
  const references = refsApi();
  const retained =
    props.retained === undefined ? retainedWith() : props.retained;
  const utils = render(
    <ReferenceItem
      item={props.item ?? item()}
      index={props.index ?? 0}
      count={props.count ?? 1}
      references={references}
      retained={retained}
      {...(props.rest ?? {})}
    />,
  );
  return { ...utils, references, retained };
};
const open = (n = 1) => {
  const trigger = screen.getByRole('button', {
    name: `Actions for reference ${n}`,
  });
  fireEvent.click(trigger);
  return trigger;
};
const labels = () =>
  screen
    .getAllByRole('menuitem')
    .map((node) => node.textContent.replace(/\s+/g, ' ').trim());

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:preview-1');
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => cleanup());

test('a base reference alone offers keep and remove; ends omit impossible moves', () => {
  const { unmount } = renderItem();
  open();
  expect(labels()).toEqual(['Keep in this browser', 'Remove from draft']);
  unmount();

  renderItem({ index: 1, count: 3 });
  open(2);
  expect(labels()).toEqual([
    'Keep in this browser',
    'Move earlier',
    'Move later',
    'Remove from draft',
  ]);
  cleanup();
  renderItem({ index: 2, count: 3 });
  open(3);
  expect(labels()).toEqual([
    'Keep in this browser',
    'Move earlier',
    'Remove from draft',
  ]);
});

test('reordering by keyboard keeps focus on the actions button', () => {
  const { references } = renderItem({ index: 1, count: 3 });
  const trigger = screen.getByRole('button', {
    name: 'Actions for reference 2',
  });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  const items = screen.getAllByRole('menuitem');
  expect(document.activeElement).toBe(items[0]);
  fireEvent.keyDown(items[0], { key: 'ArrowDown' });
  expect(document.activeElement.textContent).toMatch(/^Move earlier/);
  fireEvent.click(document.activeElement);
  expect(references.move).toHaveBeenCalledWith('upload:a', -1);
  expect(screen.queryByRole('menu')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

test('the menu is dismissed by Escape, an outside press and the trigger', () => {
  renderItem();
  const trigger = open();
  fireEvent.keyDown(screen.getAllByRole('menuitem')[0], { key: 'Escape' });
  expect(screen.queryByRole('menu')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  fireEvent.click(trigger);
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole('menu')).toBeNull();
  fireEvent.click(trigger);
  fireEvent.click(trigger);
  expect(screen.queryByRole('menu')).toBeNull();
});

test('the trigger is a 44px control with no native title tooltip', () => {
  renderItem();
  const trigger = screen.getByRole('button', {
    name: 'Actions for reference 1',
  });
  expect(trigger.className).toMatch(/icon-btn/);
  expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  expect(document.querySelector('[title]')).toBeNull();
});

test('Keep starts only from its menu item and reports why it cannot', () => {
  const { retained } = renderItem();
  expect(retained.keep).not.toHaveBeenCalled();
  open();
  fireEvent.click(
    screen.getByRole('menuitem', { name: /^Keep in this browser/ }),
  );
  expect(retained.keep).toHaveBeenCalledWith('upload:a');
  cleanup();

  renderItem({ retained: retainedWith({ available: false }) });
  open();
  const blocked = screen.getByRole('menuitem', {
    name: /^Keep in this browser/,
  });
  expect(blocked.getAttribute('aria-disabled')).toBe('true');
  expect(blocked.textContent).toContain('Browser storage unavailable');
  cleanup();

  const { retained: describing } = renderItem({
    item: item({ analyzing: true }),
  });
  open();
  const waiting = screen.getByRole('menuitem', {
    name: /^Keep in this browser/,
  });
  expect(waiting.textContent).toContain('Wait for the description');
  fireEvent.click(waiting);
  expect(describing.keep).not.toHaveBeenCalled();
});

test('no Keep item before storage opens or for a file that is not ready', () => {
  renderItem({ retained: retainedWith({ ready: false }) });
  open();
  expect(labels()).toEqual(['Remove from draft']);
  cleanup();
  renderItem({ item: item({ status: 'missing', blob: null }) });
  open();
  expect(labels()).toEqual(['Remove from draft']);
});

test('a kept reference shows it, offers removal of the copy, and says the draft file stays', () => {
  const kept = keptEntry();
  renderItem({
    retained: retainedWith({ find: (sha) => (sha === 'sha-a' ? kept : null) }),
  });
  expect(screen.getByText('Kept in this browser')).toBeTruthy();
  open();
  expect(labels()).toEqual([
    'Remove kept copyThe draft keeps its file',
    'Remove from draftThe kept copy stays',
  ]);
});

test('removing the kept copy asks first, cancels with Escape, and reports a refusal', async () => {
  const kept = keptEntry();
  const remove = vi
    .fn()
    .mockResolvedValueOnce({
      removed: false,
      message: 'This file changed in another tab. The list was refreshed.',
    })
    .mockResolvedValueOnce({ removed: true });
  renderItem({
    retained: retainedWith({ find: () => kept, remove }),
  });
  const trigger = open();
  fireEvent.click(screen.getByRole('menuitem', { name: /^Remove kept copy/ }));
  const group = screen.getByRole('group', {
    name: 'Remove kept copy of lamp.png',
  });
  expect(remove).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(
    within(group).getByRole('button', { name: 'Cancel' }),
  );

  // Escape backs out without touching storage.
  fireEvent.keyDown(group, { key: 'Escape' });
  expect(screen.queryByRole('group', { name: /Remove kept copy/ })).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  expect(remove).not.toHaveBeenCalled();

  open();
  fireEvent.click(screen.getByRole('menuitem', { name: /^Remove kept copy/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Remove kept copy' }));
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toMatch(/changed in another tab/);
  expect(remove).toHaveBeenCalledWith(kept);
  fireEvent.click(screen.getByRole('button', { name: 'Remove kept copy' }));
  await waitFor(() =>
    expect(
      screen.queryByRole('group', { name: /Remove kept copy/ }),
    ).toBeNull(),
  );
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});

test('saving and failure states show beside the file, with Retry, Kept files and Dismiss as they apply', () => {
  renderItem({
    retained: retainedWith({ keeps: { 'upload:a': { status: 'saving' } } }),
  });
  expect(screen.getByRole('status').textContent).toBe('Keeping…');
  open();
  const busy = screen.getByRole('menuitem', { name: /^Keep in this browser/ });
  expect(busy.getAttribute('aria-disabled')).toBe('true');
  expect(busy.getAttribute('aria-busy')).toBe('true');
  cleanup();

  const failed = retainedWith({
    keeps: {
      'upload:a': {
        status: 'failed',
        message: 'Not kept: no room. It is still in this draft.',
        retry: true,
        manage: true,
      },
    },
  });
  const onManage = vi.fn();
  render(
    <ReferenceItem
      item={item()}
      index={0}
      count={1}
      references={refsApi()}
      retained={failed}
      onManage={onManage}
    />,
  );
  expect(screen.getByRole('alert').textContent).toMatch(/^Not kept: no room/);
  fireEvent.click(
    screen.getByRole('button', { name: 'Retry keeping lamp.png' }),
  );
  expect(failed.keep).toHaveBeenCalledWith('upload:a');
  fireEvent.click(screen.getByRole('button', { name: 'Kept files' }));
  expect(onManage).toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole('button', { name: 'Dismiss message for lamp.png' }),
  );
  expect(failed.dismissKeep).toHaveBeenCalledWith('upload:a');
});

test('Remove from draft is routed through the list so focus can move', () => {
  const onRemove = vi.fn();
  const { references } = renderItem({ rest: { onRemove } });
  open();
  fireEvent.click(screen.getByRole('menuitem', { name: /^Remove from draft/ }));
  expect(onRemove).toHaveBeenCalledWith('upload:a');
  expect(references.remove).not.toHaveBeenCalled();
});

// --- The kept-files dialog ------------------------------------------------

const ledger = () => {
  let n = 0;
  const created = [];
  const released = [];
  const urls = createUrlLedger({
    createObjectURL: () => {
      const url = `blob:lease-${(n += 1)}`;
      created.push(url);
      return url;
    },
    revokeObjectURL: (url) => released.push(url),
  });
  return { urls, created, released };
};

test('the dialog lists metadata and loads a preview only when a row is opened', async () => {
  const { urls, created, released } = ledger();
  const retained = retainedWith({
    items: [
      keptEntry(),
      keptEntry({
        sha256: 'sha-b',
        name: 'bowl.png',
        description: '',
        dimensions: null,
        revision: 5,
      }),
    ],
    usage: {
      count: 2,
      bytes: 3072,
      sequence: 5,
      maxRecords: 32,
      maxBytes: 1 << 28,
    },
  });
  render(
    <KeptReferencesDialog retained={retained} urls={urls} onClose={() => {}} />,
  );
  expect(screen.getByText('2 of 32 files · 3 KiB of 256 MiB')).toBeTruthy();
  expect(retained.load).not.toHaveBeenCalled();
  expect(created).toEqual([]);
  const toggle = screen.getByRole('button', { name: 'lamp.png, preview' });
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(toggle);
  const image = await screen.findByAltText('Preview of lamp.png');
  expect(image.getAttribute('src')).toBe('blob:lease-1');
  expect(retained.load).toHaveBeenCalledTimes(1);
  expect(retained.load.mock.calls[0][0]).toBe('sha-a');
  expect(screen.getByText('A brass lamp')).toBeTruthy();
  fireEvent.click(toggle);
  await waitFor(() => expect(released).toEqual(['blob:lease-1']));
  expect(urls.held('blob:lease-1')).toBe(0);
});

test('collapsing, or closing, a row while its preview loads aborts it and leases nothing', async () => {
  const { urls, created } = ledger();
  const gate = deferred();
  const retained = retainedWith({
    items: [keptEntry()],
    load: vi.fn(() => gate.promise),
  });
  const { unmount } = render(
    <KeptReferencesDialog retained={retained} urls={urls} onClose={() => {}} />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'lamp.png, preview' }));
  await waitFor(() => expect(retained.load).toHaveBeenCalled());
  const { signal } = retained.load.mock.calls[0][1];
  unmount();
  expect(signal.aborted).toBe(true);
  await act(async () => gate.resolve(new Blob(['late'])));
  expect(created).toEqual([]);
});

test('a preview for a file that is gone, or unreadable, says so', async () => {
  const { urls } = ledger();
  const gone = retainedWith({
    items: [keptEntry()],
    load: vi.fn(async () => null),
  });
  const first = render(
    <KeptReferencesDialog retained={gone} urls={urls} onClose={() => {}} />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'lamp.png, preview' }));
  expect((await screen.findByRole('alert')).textContent).toBe(
    'This file is no longer kept.',
  );
  first.unmount();
  const broken = retainedWith({
    items: [keptEntry()],
    load: vi.fn(async () => {
      throw new Error('missing');
    }),
  });
  render(
    <KeptReferencesDialog retained={broken} urls={urls} onClose={() => {}} />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'lamp.png, preview' }));
  expect((await screen.findByRole('alert')).textContent).toBe(
    'The kept file could not be read.',
  );
});

test('Add attaches the file and closes; a refusal stays in the row', async () => {
  const onClose = vi.fn();
  const pick = vi
    .fn()
    .mockResolvedValueOnce({
      ok: false,
      reason: 'That image is already a reference.',
    })
    .mockResolvedValueOnce({ ok: true });
  const retained = retainedWith({ items: [keptEntry()], pick });
  render(
    <KeptReferencesDialog retained={retained} urls={null} onClose={onClose} />,
  );
  const add = screen.getByRole('button', { name: 'Add lamp.png to the draft' });
  fireEvent.click(add);
  expect((await screen.findByRole('alert')).textContent).toBe(
    'That image is already a reference.',
  );
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.click(add);
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(pick).toHaveBeenCalledWith(retained.items[0]);
});

test('Add is unavailable for a file in the draft or when the draft is full', () => {
  const retained = retainedWith({
    items: [keptEntry()],
    attached: new Set(['sha-a']),
  });
  const { rerender } = render(
    <KeptReferencesDialog retained={retained} urls={null} onClose={() => {}} />,
  );
  expect(
    screen.getByRole('button', { name: 'Add lamp.png to the draft' }).disabled,
  ).toBe(true);
  expect(screen.getByText('In draft')).toBeTruthy();
  rerender(
    <KeptReferencesDialog
      retained={retainedWith({
        items: [keptEntry()],
        addBlock: 'Limit of 4 references reached.',
      })}
      urls={null}
      onClose={() => {}}
    />,
  );
  expect(screen.getByText('Limit of 4 references reached.')).toBeTruthy();
  expect(
    screen.getByRole('button', { name: 'Add lamp.png to the draft' }).disabled,
  ).toBe(true);
});

test('states: empty, reading, unreadable with Retry; Escape and Close dismiss', () => {
  const onClose = vi.fn();
  const { rerender } = render(
    <KeptReferencesDialog
      retained={retainedWith()}
      urls={null}
      onClose={onClose}
    />,
  );
  expect(screen.getByText('No files kept.')).toBeTruthy();
  rerender(
    <KeptReferencesDialog
      retained={retainedWith({ status: 'loading', usage: null })}
      urls={null}
      onClose={onClose}
    />,
  );
  expect(screen.getByRole('status').textContent).toBe('Reading kept files…');
  const refresh = vi.fn();
  rerender(
    <KeptReferencesDialog
      retained={retainedWith({
        status: 'error',
        error: 'blocked',
        usage: null,
        refresh,
      })}
      urls={null}
      onClose={onClose}
    />,
  );
  expect(screen.getByRole('alert').textContent).toContain('blocked');
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(refresh).toHaveBeenCalled();
  fireEvent.keyDown(screen.getByRole('dialog', { name: 'Kept references' }), {
    key: 'Escape',
  });
  expect(onClose).toHaveBeenCalledTimes(1);
  fireEvent.click(
    screen.getByRole('button', { name: 'Close kept references' }),
  );
  expect(onClose).toHaveBeenCalledTimes(2);
  expect(document.querySelector('[title]')).toBeNull();
});
