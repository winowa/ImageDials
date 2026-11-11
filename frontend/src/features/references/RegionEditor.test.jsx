import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import regionFixture from '../../../../fixtures/api/region-editing.json';
import RegionEditor from './RegionEditor.jsx';

const makeBase = (width = 16, height = 12, sha = 'a'.repeat(64)) => ({
  file: new Blob(['synthetic image bytes'], { type: 'image/png' }),
  sha256: sha,
  dimensions: { width, height },
  label: 'Reference one',
});

function installImageUrlMocks() {
  const created = [];
  const revoked = [];
  const create = vi.fn(() => {
    const url = `blob:region-${created.length + 1}`;
    created.push(url);
    return url;
  });
  const revoke = vi.fn((url) => revoked.push(url));
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: create,
    revokeObjectURL: revoke,
  });
  return { created, revoked, create, revoke };
}

async function loadedBaseImage() {
  const image = await screen.findByRole('img', {
    name: /base image for the region edit/i,
  });
  Object.defineProperty(image, 'naturalWidth', {
    configurable: true,
    value: 16,
  });
  Object.defineProperty(image, 'naturalHeight', {
    configurable: true,
    value: 12,
  });
  fireEvent.load(image);
  return image;
}

function firePointer(target, type, { id = 1, x, y, pointerType = 'mouse' }) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries({
    pointerId: id,
    pointerType,
    button: 0,
    clientX: x,
    clientY: y,
  }))
    Object.defineProperty(event, key, { configurable: true, value });
  fireEvent(target, event);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test('a missing or unsupported capability is an honest refusal and acquires no image URL', () => {
  const api = installImageUrlMocks();
  const onClose = vi.fn();
  render(
    <RegionEditor
      base={makeBase()}
      capability={{ ...regionFixture.capability, native_mask: true }}
      onApply={vi.fn()}
      onClose={onClose}
    />,
  );
  expect(screen.getByRole('alert').textContent).toMatch(/does not support/i);
  expect(api.create).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Close region editor' }));
  expect(onClose).toHaveBeenCalledOnce();
});

test('keyboard coordinates create one source-pixel rectangle and Apply commits one wire value', async () => {
  installImageUrlMocks();
  const onApply = vi.fn();
  render(
    <RegionEditor
      base={makeBase()}
      capability={regionFixture.capability}
      onApply={onApply}
      onClose={vi.fn()}
    />,
  );
  await loadedBaseImage();

  fireEvent.click(screen.getByRole('button', { name: 'Enter coordinates' }));
  const setField = (name, value) =>
    fireEvent.change(screen.getByLabelText(name), { target: { value } });
  setField('X', '3');
  setField('Y', '4');
  setField('Width', '6');
  setField('Height', '4');
  fireEvent.click(screen.getByRole('button', { name: 'Add rectangle' }));
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

  await waitFor(() => expect(onApply).toHaveBeenCalledOnce());
  expect(onApply).toHaveBeenCalledWith(regionFixture.selection);
});

test('Cancel leaves the incoming selection unchanged and releases the editor lease on close', () => {
  const api = installImageUrlMocks();
  const leases = [];
  const urls = {
    acquire: vi.fn((file) => {
      const url = api.create(file);
      leases.push(url);
      return url;
    }),
    release: vi.fn((url) => api.revoke(url)),
  };
  const onApply = vi.fn();
  const onClose = vi.fn();
  const incoming = regionFixture.selection;
  const view = render(
    <RegionEditor
      base={makeBase(16, 12, incoming.source_sha256)}
      selection={incoming}
      capability={regionFixture.capability}
      urls={urls}
      onApply={onApply}
      onClose={onClose}
    />,
  );
  expect(screen.getByText('1 area')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(onClose).toHaveBeenCalledOnce();
  expect(onApply).not.toHaveBeenCalled();
  expect(urls.release).toHaveBeenCalledExactlyOnceWith(leases[0]);
  view.unmount();
  expect(urls.release).toHaveBeenCalledOnce();
});

test('Escape closes, returns the close request, and releases its owned URL once', async () => {
  const api = installImageUrlMocks();
  const onClose = vi.fn();
  const view = render(
    <RegionEditor
      base={makeBase()}
      capability={regionFixture.capability}
      onApply={vi.fn()}
      onClose={onClose}
    />,
  );
  await screen.findByRole('img', { name: /base image for the region edit/i });
  const info = screen.getByRole('button', { name: 'Region editing details' });
  act(() => info.focus());
  fireEvent.keyDown(info, { key: 'Tab', shiftKey: true });
  expect(document.activeElement).toBe(
    screen.getByRole('button', { name: 'Cancel' }),
  );
  fireEvent.keyDown(
    screen.getByRole('button', { name: 'Close region editor' }),
    {
      key: 'Escape',
    },
  );
  expect(onClose).toHaveBeenCalledOnce();
  view.unmount();
  expect(api.revoke).toHaveBeenCalledOnce();
});

test('changing source clears local coordinates, shows why, and swaps the owned URL lease', async () => {
  const api = installImageUrlMocks();
  const first = makeBase();
  const onApply = vi.fn();
  const view = render(
    <RegionEditor
      base={first}
      selection={regionFixture.selection}
      capability={regionFixture.capability}
      onApply={onApply}
      onClose={vi.fn()}
    />,
  );
  await waitFor(() => expect(api.create).toHaveBeenCalledOnce());
  view.rerender(
    <RegionEditor
      base={makeBase(20, 12, 'b'.repeat(64))}
      selection={regionFixture.selection}
      capability={regionFixture.capability}
      onApply={onApply}
      onClose={vi.fn()}
    />,
  );
  await waitFor(() => expect(api.create).toHaveBeenCalledTimes(2));
  expect(api.revoke).toHaveBeenCalledExactlyOnceWith('blob:region-1');
  expect((await screen.findByText(/base image changed/i)).textContent).toMatch(
    /base image changed/i,
  );
  expect(screen.getByText('No region selected')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  view.unmount();
  expect(api.revoke).toHaveBeenCalledWith('blob:region-2');
  expect(onApply).not.toHaveBeenCalled();
});

test('a late load from the prior base cannot enable the new source', async () => {
  const api = installImageUrlMocks();
  const view = render(
    <RegionEditor
      base={makeBase()}
      capability={regionFixture.capability}
      onApply={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  const oldImage = await screen.findByRole('img', {
    name: /base image for the region edit/i,
  });
  view.rerender(
    <RegionEditor
      base={makeBase(20, 12, 'b'.repeat(64))}
      capability={regionFixture.capability}
      onApply={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  await waitFor(() => expect(api.create).toHaveBeenCalledTimes(2));
  Object.defineProperty(oldImage, 'naturalWidth', {
    configurable: true,
    value: 16,
  });
  Object.defineProperty(oldImage, 'naturalHeight', {
    configurable: true,
    value: 12,
  });
  fireEvent.load(oldImage);
  expect(document.querySelector('.rgn-stage').getAttribute('data-status')).toBe(
    'loading',
  );
  const current = await screen.findByRole('img', {
    name: /base image for the region edit/i,
  });
  expect(current.getAttribute('src')).toBe('blob:region-2');
});

test('a displayed size that disagrees with oriented base dimensions blocks editing', async () => {
  installImageUrlMocks();
  render(
    <RegionEditor
      base={makeBase()}
      capability={regionFixture.capability}
      onApply={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  const image = await screen.findByRole('img', {
    name: /base image for the region edit/i,
  });
  Object.defineProperty(image, 'naturalWidth', {
    configurable: true,
    value: 12,
  });
  Object.defineProperty(image, 'naturalHeight', {
    configurable: true,
    value: 16,
  });
  fireEvent.load(image);
  expect((await screen.findByRole('alert')).textContent).toMatch(
    /recorded as 16×12/i,
  );
  expect(screen.getByRole('button', { name: 'Apply' }).disabled).toBe(true);
});

test('a cancelled pointer rectangle is discarded rather than applied', async () => {
  installImageUrlMocks();
  const onApply = vi.fn();
  render(
    <RegionEditor
      base={makeBase()}
      capability={regionFixture.capability}
      onApply={onApply}
      onClose={vi.fn()}
    />,
  );
  await loadedBaseImage();
  const surface = document.querySelector('.rgn-surface');
  surface.getBoundingClientRect = () => ({
    left: 10,
    top: 20,
    right: 170,
    bottom: 140,
    width: 160,
    height: 120,
  });
  firePointer(surface, 'pointerdown', { x: 30, y: 40 });
  firePointer(surface, 'pointermove', { x: 100, y: 100 });
  firePointer(surface, 'pointercancel', { x: 100, y: 100 });
  expect(document.querySelector('.rgn-message').textContent).toMatch(
    /unfinished stroke discarded/i,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
  expect(onApply).toHaveBeenCalledWith(null);
});

test('pointer rectangles map the visible image content to source pixels', async () => {
  installImageUrlMocks();
  const onApply = vi.fn();
  render(
    <RegionEditor
      base={makeBase()}
      capability={regionFixture.capability}
      onApply={onApply}
      onClose={vi.fn()}
    />,
  );
  await loadedBaseImage();
  const surface = document.querySelector('.rgn-surface');
  surface.getBoundingClientRect = () => ({
    left: 10,
    top: 20,
    right: 170,
    bottom: 140,
    width: 160,
    height: 120,
  });
  firePointer(surface, 'pointerdown', { x: 30, y: 40 });
  firePointer(surface, 'pointermove', { x: 100, y: 100 });
  firePointer(surface, 'pointerup', { x: 100, y: 100 });
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
  expect(onApply).toHaveBeenCalledWith({
    version: 1,
    source_sha256: 'a'.repeat(64),
    width: 16,
    height: 12,
    shapes: [{ kind: 'rectangle', x: 2, y: 2, width: 8, height: 7 }],
    feather: 0,
  });
});

test('a brush stroke over its point budget is refused without dropping the prior shape', async () => {
  installImageUrlMocks();
  const onApply = vi.fn();
  render(
    <RegionEditor
      base={makeBase(16, 12, regionFixture.selection.source_sha256)}
      selection={regionFixture.selection}
      capability={{ ...regionFixture.capability, max_points: 1 }}
      onApply={onApply}
      onClose={vi.fn()}
    />,
  );
  await loadedBaseImage();
  fireEvent.click(screen.getByRole('radio', { name: 'Brush' }));
  const surface = document.querySelector('.rgn-surface');
  surface.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    right: 160,
    bottom: 120,
    width: 160,
    height: 120,
  });
  firePointer(surface, 'pointerdown', { x: 10, y: 10 });
  firePointer(surface, 'pointermove', { x: 80, y: 80 });
  firePointer(surface, 'pointerup', { x: 80, y: 80 });
  expect(document.querySelector('.rgn-message').textContent).toMatch(
    /stroke was discarded/i,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
  expect(onApply).toHaveBeenCalledWith(regionFixture.selection);
});

test('keyboard undo and redo stay local to the editor', async () => {
  installImageUrlMocks();
  const onApply = vi.fn();
  render(
    <RegionEditor
      base={makeBase()}
      capability={regionFixture.capability}
      onApply={onApply}
      onClose={vi.fn()}
    />,
  );
  await loadedBaseImage();
  fireEvent.click(screen.getByRole('button', { name: 'Enter coordinates' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add rectangle' }));
  const dialog = screen.getByRole('dialog', { name: 'Edit region' });
  fireEvent.keyDown(dialog, { key: 'z', ctrlKey: true });
  expect(screen.getByText('No region selected')).toBeTruthy();
  fireEvent.keyDown(dialog, { key: 'y', ctrlKey: true });
  expect(screen.getByText('1 area')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
  expect(onApply).toHaveBeenCalledWith(
    expect.objectContaining({ shapes: [expect.any(Object)] }),
  );
});
