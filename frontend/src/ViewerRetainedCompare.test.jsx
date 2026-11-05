import React, { StrictMode } from 'react';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { deferred } from './cacheTestSupport.js';
import { comparisonSources } from './comparison.js';
import { createUrlLedger } from './objectUrls.js';
import { REF_STATUS } from './references.js';
import Viewer from './Viewer.jsx';

vi.mock('./ui.jsx', async (importOriginal) => ({
  ...(await importOriginal()),
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
    { id: 'upload:pal', sha256: 'pal-sha', role: 'reference' },
  ],
};

const blob = (text = 'x') => new Blob([text], { type: 'image/png' });
const keptItem = (sha, extra = {}) => ({
  sha256: sha,
  name: `${sha}.png`,
  dimensions: { width: 800, height: 600 },
  revision: 1,
  ...extra,
});
const draftRef = (id, sha256) => ({
  id,
  sha256,
  name: `${id.split(':')[1]}.png`,
  blob: blob(id),
  url: `blob:draft-${id}`,
  status: REF_STATUS.ready,
  dimensions: { width: 1024, height: 1024 },
});

let created;
let revoked;
let ledger;
const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;
beforeEach(() => {
  created = [];
  revoked = [];
  let n = 0;
  ledger = createUrlLedger({
    createObjectURL: () => {
      const url = `blob:lease-${(n += 1)}`;
      created.push(url);
      return url;
    },
    revokeObjectURL: (url) => revoked.push(url),
  });
  URL.createObjectURL = vi.fn(() => {
    throw new Error('the shared ledger owns every comparison URL');
  });
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  URL.createObjectURL = originalCreate;
  URL.revokeObjectURL = originalRevoke;
});

const studioWith = ({ kept = [], load, held = () => null, ...rest } = {}) => ({
  job: null,
  generating: null,
  current: result,
  draft: { aspect: '3:2', mode: 'image', prompt: '' },
  discovery: { capabilities: { data: {} }, models: { data: {} } },
  watermark: { visible: false, settings: null },
  editCapability: { enabled: true, maxReferences: 3 },
  addImageReference: vi.fn(),
  referenceReading: null,
  references: { refs: [], heldSource: held },
  retained: {
    find: vi.fn((sha) => kept.find((item) => item.sha256 === sha) ?? null),
    load: load ?? vi.fn(async () => blob('kept')),
  },
  urls: ledger,
  retryStorage: vi.fn(),
  removeImage: vi.fn(),
  ...rest,
});

const more = () => screen.queryByRole('button', { name: 'More actions' });
const openCompare = () => {
  fireEvent.click(more());
  fireEvent.click(screen.getByRole('menuitem', { name: /Compare/ }));
  return screen.getByRole('dialog', { name: 'Compare' });
};

describe('comparisonSources lookups', () => {
  test('offers only recorded sources, never reads a kept Blob, and prefers attached bytes', () => {
    const load = vi.fn();
    const find = vi.fn((sha) => (sha === 'pal-sha' ? keptItem(sha) : null));
    const sources = comparisonSources(
      result,
      [draftRef('upload:base', 'base-sha'), draftRef('upload:x', 'other-sha')],
      { kept: find, load },
    );
    expect(sources.map((s) => [s.id, s.origin, s.matched])).toEqual([
      ['upload:base', 'attached', true],
      ['upload:x', 'attached', false],
      ['kept:pal-sha', 'kept', true],
    ]);
    // Metadata lookups only; the unrelated attached file is never looked up.
    expect(find.mock.calls.map(([sha]) => sha)).toEqual(['pal-sha']);
    expect(load).not.toHaveBeenCalled();
    expect(sources[2].blob).toBeNull();
  });

  test('the result’s own bytes and an unreadable lookup offer nothing', () => {
    const own = { ...result, sha256: 'base-sha' };
    expect(
      comparisonSources(own, [], {
        held: () => ({ blob: blob(), name: 'a.png' }),
        kept: () => null,
      }).map((s) => s.sha256),
    ).toEqual(['pal-sha']);
    expect(comparisonSources(result, [], {})).toEqual([]);
  });

  test('a held source wins over a kept one for the same checksum', () => {
    const sources = comparisonSources(result, [], {
      held: (sha) =>
        sha === 'base-sha' ? { blob: blob(), name: 'held.png' } : null,
      kept: (sha) => keptItem(sha),
      load: vi.fn(),
    });
    expect(sources.map((s) => [s.id, s.origin])).toEqual([
      ['held:base-sha', 'held'],
      ['kept:pal-sha', 'kept'],
    ]);
  });
});

describe('Compare with a source that is not attached', () => {
  test('is offered from kept metadata alone; the Blob is read only after Compare opens', async () => {
    const gate = deferred();
    const load = vi.fn(() => gate.promise);
    const studio = studioWith({ kept: [keptItem('base-sha')], load });
    render(<Viewer studio={studio} onEdit={() => {}} />);
    fireEvent.click(more());
    const item = screen.getByRole('menuitem', { name: /Compare/ });
    expect(item.textContent).toContain('With source base-sha.png');
    expect(load).not.toHaveBeenCalled();
    expect(created).toEqual([]);
    fireEvent.click(item);
    const dialog = screen.getByRole('dialog', { name: 'Compare' });
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    expect(load.mock.calls[0][0]).toBe('base-sha');
    expect(load.mock.calls[0][1].signal.aborted).toBe(false);
    expect(within(dialog).getByText('Loading source…')).toBeTruthy();
    expect(
      within(dialog).getByRole('button', { name: /Hold for source/ }).disabled,
    ).toBe(true);
    // No false comparison while loading: no image URL exists yet.
    expect(created).toEqual([]);
    expect(within(dialog).getByText('Source · 800×600')).toBeTruthy();

    await act(async () => gate.resolve(blob('kept')));
    await waitFor(() => expect(created).toEqual(['blob:lease-1']));
    const before = within(dialog).getByAltText('Source: base-sha.png');
    expect(before.getAttribute('src')).toBe('blob:lease-1');
    // Still decoding until the image reports it loaded.
    fireEvent.load(before);
    expect(within(dialog).queryByText('Loading source…')).toBeNull();
    expect(
      within(dialog).getByRole('button', { name: /Hold for source/ }).disabled,
    ).toBe(false);
    // Nothing was attached or sent anywhere.
    expect(studio.addImageReference).not.toHaveBeenCalled();
    expect(studio.references.refs).toEqual([]);

    // The lease is from the shared ledger and released with the comparison.
    expect(ledger.held('blob:lease-1')).toBe(1);
    fireEvent.click(within(dialog).getByRole('button', { name: /Close/ }));
    expect(revoked).toEqual(['blob:lease-1']);
    expect(ledger.held('blob:lease-1')).toBe(0);
  });

  test('closing while the read is pending aborts it and a late answer leaves no URL', async () => {
    const gate = deferred();
    const load = vi.fn(() => gate.promise);
    render(
      <Viewer
        studio={studioWith({ kept: [keptItem('base-sha')], load })}
        onEdit={() => {}}
      />,
    );
    const dialog = openCompare();
    await waitFor(() => expect(load).toHaveBeenCalled());
    const { signal } = load.mock.calls[0][1];
    fireEvent.click(within(dialog).getByRole('button', { name: /Close/ }));
    expect(signal.aborted).toBe(true);
    await act(async () => gate.resolve(blob('late')));
    expect(created).toEqual([]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('a kept source that is gone says so and shows no source image', async () => {
    const load = vi.fn(async () => null);
    render(
      <Viewer
        studio={studioWith({ kept: [keptItem('base-sha')], load })}
        onEdit={() => {}}
      />,
    );
    const dialog = openCompare();
    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toBe('Source is no longer kept in this browser.');
    expect(created).toEqual([]);
    expect(
      within(dialog).getByRole('button', { name: /Hold for source/ }).disabled,
    ).toBe(true);
  });

  test('an unreadable kept source reports a read failure and no URL is leased', async () => {
    const load = vi.fn(async () => {
      throw new Error('The stored reference bytes are missing.');
    });
    render(
      <Viewer
        studio={studioWith({ kept: [keptItem('base-sha')], load })}
        onEdit={() => {}}
      />,
    );
    const dialog = openCompare();
    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toBe(
      'Source could not be read from this browser.',
    );
    expect(created).toEqual([]);
  });

  test('a kept source removed while it loads aborts the read and leaves an honest empty state', async () => {
    const gate = deferred();
    const load = vi.fn(() => gate.promise);
    const studio = studioWith({ kept: [keptItem('base-sha')], load });
    const { rerender } = render(<Viewer studio={studio} onEdit={() => {}} />);
    openCompare();
    await waitFor(() => expect(load).toHaveBeenCalled());
    const { signal } = load.mock.calls[0][1];
    // Another tab removed the kept copy: it is no longer a source.
    rerender(
      <Viewer
        studio={{
          ...studio,
          retained: { find: () => null, load },
        }}
        onEdit={() => {}}
      />,
    );
    expect(signal.aborted).toBe(true);
    expect(screen.getByText('No source is available to compare.')).toBeTruthy();
    await act(async () => gate.resolve(blob('late')));
    expect(created).toEqual([]);
  });

  test('a source held in this tab opens at once with no read', () => {
    const load = vi.fn();
    const held = vi.fn((sha) =>
      sha === 'base-sha'
        ? { blob: blob('held'), name: 'held.png', dimensions: null }
        : null,
    );
    render(<Viewer studio={studioWith({ held, load })} onEdit={() => {}} />);
    const dialog = openCompare();
    expect(load).not.toHaveBeenCalled();
    expect(created).toEqual(['blob:lease-1']);
    expect(within(dialog).getByAltText('Source: held.png')).toBeTruthy();
    expect(within(dialog).queryByText('Loading source…')).toBeNull();
  });

  test('an attached file that is not the recorded source stays a Reference', () => {
    const studio = studioWith({
      kept: [keptItem('base-sha')],
      references: {
        refs: [draftRef('upload:draft', 'draft-sha')],
        heldSource: () => null,
      },
    });
    render(<Viewer studio={studio} onEdit={() => {}} />);
    fireEvent.click(more());
    const item = screen.getByRole('menuitem', { name: /Compare/ });
    // The recorded kept source is the default; the unrelated file is extra.
    expect(item.textContent).toContain('With source base-sha.png (+1)');
    fireEvent.click(item);
    const dialog = screen.getByRole('dialog', { name: 'Compare' });
    const choose = within(dialog).getByRole('combobox', { name: 'With' });
    expect([...choose.options].map((option) => option.textContent)).toEqual([
      'Reference · draft.png',
      'Source · base-sha.png',
    ]);
    fireEvent.change(choose, { target: { value: 'upload:draft' } });
    expect(within(dialog).getByText('Reference · 1024×1024')).toBeTruthy();
  });

  test('switching sources aborts the earlier read', async () => {
    const first = deferred();
    const load = vi.fn((sha) => (sha === 'base-sha' ? first.promise : null));
    const studio = studioWith({
      kept: [keptItem('base-sha')],
      references: {
        refs: [draftRef('upload:draft', 'draft-sha')],
        heldSource: () => null,
      },
      load,
    });
    render(<Viewer studio={studio} onEdit={() => {}} />);
    const dialog = openCompare();
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    const { signal } = load.mock.calls[0][1];
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'With' }), {
      target: { value: 'upload:draft' },
    });
    expect(signal.aborted).toBe(true);
    await act(async () => first.resolve(blob('stale')));
    // Only the draft reference's own lease exists; the stale answer is dropped.
    expect(created).toEqual(['blob:lease-1']);
    expect(within(dialog).getByAltText('Reference: draft.png')).toBeTruthy();
  });

  test('StrictMode remounting reads once per mount and leaves exactly one lease', async () => {
    const load = vi.fn(async () => blob('kept'));
    render(
      <StrictMode>
        <Viewer
          studio={studioWith({ kept: [keptItem('base-sha')], load })}
          onEdit={() => {}}
        />
      </StrictMode>,
    );
    const dialog = openCompare();
    const liveLeases = () => created.filter((url) => !revoked.includes(url));
    await waitFor(() => expect(liveLeases()).toHaveLength(1));
    // The development remount did not count as the owner removing it.
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.click(within(dialog).getByRole('button', { name: /Close/ }));
    expect(created.every((url) => revoked.includes(url))).toBe(true);
    expect(document.activeElement).toBe(more());
  });
});

describe('focus when the result under a comparison is removed', () => {
  const generating = {
    job: { id: 'job-1', phase: 'running', stage: 'rendering' },
    generating: { aspect: '3:2', dimensions: '1536x1024', mode: 'image' },
    current: null,
  };

  test('lands on the stage, not the page, when the comparison owned focus', async () => {
    const studio = studioWith({ kept: [keptItem('base-sha')] });
    const { rerender } = render(<Viewer studio={studio} onEdit={() => {}} />);
    const dialog = openCompare();
    await waitFor(() =>
      expect(within(dialog).getByAltText('Source: base-sha.png')).toBeTruthy(),
    );
    expect(dialog.contains(document.activeElement)).toBe(true);
    rerender(
      <Viewer studio={{ ...studio, ...generating }} onEdit={() => {}} />,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(more()).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('region', { name: 'Result' }),
      ),
    );
    // Its leases went with it.
    expect(created.every((url) => revoked.includes(url))).toBe(true);
  });

  test('never takes focus the comparison did not hold', async () => {
    const studio = studioWith({ kept: [keptItem('base-sha')] });
    const { rerender } = render(
      <>
        <button type="button">Elsewhere</button>
        <Viewer studio={studio} onEdit={() => {}} />
      </>,
    );
    openCompare();
    const other = screen.getByRole('button', { name: 'Elsewhere' });
    other.focus();
    rerender(
      <>
        <button type="button">Elsewhere</button>
        <Viewer studio={{ ...studio, ...generating }} onEdit={() => {}} />
      </>,
    );
    await act(async () => {});
    expect(document.activeElement).toBe(other);
  });

  test('closing by the person still returns focus to More, not the stage', () => {
    render(
      <Viewer
        studio={studioWith({ kept: [keptItem('base-sha')] })}
        onEdit={() => {}}
      />,
    );
    const trigger = more();
    const dialog = openCompare();
    fireEvent.keyDown(within(dialog).getByRole('slider'), { key: 'Escape' });
    expect(document.activeElement).toBe(trigger);
  });
});

describe('Compare is offered only when a source exists', () => {
  test('no kept, held or attached source adds no Compare or extra toolbar button', () => {
    render(
      <Viewer
        studio={studioWith({ editCapability: null })}
        onEdit={() => {}}
      />,
    );
    expect(more()).toBeNull();
    expect(document.querySelector('.result-actions').children).toHaveLength(3);
  });

  test('a kept source adds Compare inside More only; the toolbar count is unchanged', () => {
    render(
      <Viewer
        studio={studioWith({
          editCapability: null,
          kept: [keptItem('pal-sha')],
        })}
        onEdit={() => {}}
      />,
    );
    expect(document.querySelector('.result-actions').children).toHaveLength(4);
    fireEvent.click(more());
    expect(
      screen.getAllByRole('menuitem').map((item) => item.textContent),
    ).toEqual([expect.stringMatching(/^CompareWith source pal-sha\.png/)]);
  });
});
