import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { REF_STATUS } from '../references/references.js';
import Viewer from './Viewer.jsx';

vi.mock('../../data/media/SavedImg.jsx', () => ({
  SavedImg: ({ image, className }) => (
    <img className={className} alt={image.alt_text} />
  ),
}));

const result = {
  id: 'result-7',
  title: 'Lighthouse in fog',
  alt_text: 'A lighthouse in fog',
  sha256: 'result-sha',
  provider: 'mock',
  model: 'mock-model',
  created_at: '2026-11-02T10:00:00Z',
  width: 1536,
  height: 1024,
  generation_type: 'image-edit',
  reference_images: [
    { id: 'upload:base', sha256: 'base-sha', role: 'base', filename: 'a.png' },
  ],
};

const ref = (id, sha256, extra = {}) => ({
  id,
  sha256,
  name: `${id.split(':')[1]}.png`,
  blob: new Blob([id], { type: 'image/png' }),
  url: `blob:draft-${id}`,
  status: REF_STATUS.ready,
  dimensions: { width: 1024, height: 1024 },
  ...extra,
});

const studioWith = (overrides = {}) => ({
  job: null,
  generating: null,
  current: result,
  draft: { aspect: '3:2', mode: 'image', prompt: '' },
  discovery: { capabilities: { data: {} }, models: { data: {} } },
  watermark: { visible: false, settings: null },
  editCapability: { enabled: true, maxReferences: 3 },
  addImageReference: vi.fn(),
  referenceReading: null,
  references: { refs: [] },
  retryStorage: vi.fn(),
  removeImage: vi.fn(),
  ...overrides,
});

const more = () => screen.queryByRole('button', { name: 'More actions' });
const actions = () => document.querySelector('.result-actions');

let revoked;
const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;
beforeEach(() => {
  revoked = [];
  let n = 0;
  URL.createObjectURL = vi.fn(() => `blob:compare-${(n += 1)}`);
  URL.revokeObjectURL = vi.fn((url) => revoked.push(url));
});
afterEach(() => {
  URL.createObjectURL = originalCreate;
  URL.revokeObjectURL = originalRevoke;
});

describe('Result More menu', () => {
  test('keeps the primary actions and adds no More button when nothing applies', () => {
    render(
      <Viewer
        studio={studioWith({ editCapability: null })}
        onEdit={() => {}}
      />,
    );
    const row = within(actions());
    expect(row.getByRole('button', { name: 'Reuse settings' })).toBeTruthy();
    expect(
      row.getByRole('button', { name: 'View image full screen' }),
    ).toBeTruthy();
    expect(row.getByText('Download')).toBeTruthy();
    expect(more()).toBeNull();
    expect(screen.queryByText('Use as reference')).toBeNull();
  });

  test('promotes Edit image next to Reuse settings without duplicating More', () => {
    const studio = studioWith();
    render(<Viewer studio={studio} onEdit={() => {}} />);
    expect(screen.getByRole('button', { name: 'Reuse settings' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Edit image' }));
    expect(studio.addImageReference).toHaveBeenCalledWith(result);
    expect(more()).toBeNull();
  });

  test('shows why Edit image is unavailable and does not act', () => {
    const studio = studioWith({
      editCapability: { enabled: true, maxReferences: 1 },
      references: { refs: [ref('upload:x', 'result-sha')] },
    });
    render(<Viewer studio={studio} onEdit={() => {}} />);
    const item = screen.getByRole('button', { name: 'Edit image' });
    expect(item.getAttribute('aria-disabled')).toBe('true');
    fireEvent.mouseEnter(item.parentElement);
    expect(screen.getByText('Limit of 1 reached')).toBeTruthy();
    fireEvent.click(item);
    expect(studio.addImageReference).not.toHaveBeenCalled();
    expect(more()).toBeNull();
  });

  test('menu keyboard: arrows open and move, Escape returns focus', () => {
    render(
      <Viewer
        studio={studioWith({
          references: { refs: [ref('upload:base', 'base-sha')] },
        })}
        onEdit={() => {}}
      />,
    );
    const trigger = more();
    fireEvent.keyDown(trigger, { key: 'ArrowUp' });
    const items = screen.getAllByRole('menuitem');
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0], { key: 'End' });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0], { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('Compare from the result', () => {
  test('compares with the recorded source and returns focus to More on close', () => {
    const base = ref('upload:base', 'base-sha');
    render(
      <Viewer
        studio={studioWith({
          references: { refs: [ref('upload:draft', 'draft-sha'), base] },
        })}
        onEdit={() => {}}
      />,
    );
    // Nothing opens until Compare is chosen.
    expect(screen.queryByRole('dialog')).toBeNull();
    const trigger = more();
    fireEvent.click(trigger);
    const compare = screen.getByRole('menuitem', { name: /Compare/ });
    expect(compare.textContent).toContain('With source base.png (+1)');
    fireEvent.click(compare);
    const dialog = screen.getByRole('dialog', { name: 'Compare' });
    expect(within(dialog).getByText('Source · 1024×1024')).toBeTruthy();
    expect(within(dialog).getByText('Result · 1536×1024')).toBeTruthy();
    expect(within(dialog).getByRole('combobox', { name: 'With' }).value).toBe(
      'upload:base',
    );
    fireEvent.keyDown(within(dialog).getByRole('slider'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    // The comparison's own URL is released; the draft's URL is never touched.
    expect(revoked).toEqual(['blob:compare-1']);
  });

  test('an unrelated draft reference is offered as a reference, not as the source', () => {
    render(
      <Viewer
        studio={studioWith({
          current: { ...result, generation_type: 'text' },
          references: { refs: [ref('upload:draft', 'draft-sha')] },
        })}
        onEdit={() => {}}
      />,
    );
    fireEvent.click(more());
    const compare = screen.getByRole('menuitem', { name: /Compare/ });
    expect(compare.textContent).toContain('With reference draft.png');
    fireEvent.click(compare);
    expect(screen.getByText('Reference · 1024×1024')).toBeTruthy();
    expect(screen.queryByText(/^Source/)).toBeNull();
  });

  test('removing the reference while comparing leaves an honest empty state', () => {
    const studio = studioWith({
      references: { refs: [ref('upload:base', 'base-sha')] },
    });
    const { rerender } = render(<Viewer studio={studio} onEdit={() => {}} />);
    fireEvent.click(more());
    fireEvent.click(screen.getByRole('menuitem', { name: /Compare/ }));
    rerender(
      <Viewer
        studio={{ ...studio, references: { refs: [] } }}
        onEdit={() => {}}
      />,
    );
    expect(screen.getByText('No source is available to compare.')).toBeTruthy();
    expect(revoked).toEqual(['blob:compare-1']);
    fireEvent.click(screen.getByRole('button', { name: 'Close comparison' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
