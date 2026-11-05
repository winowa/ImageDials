import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { useVisibleWatermarks } from './useVisibleWatermarks.js';

const settings = {
  fingerprint: 'content',
  rendering: { analysisVersion: 'v5' },
};
const image = (id, extra = {}) => ({
  id,
  storage_id: 'local-0',
  filename: `${id}.png`,
  sha256: id,
  ...extra,
});
const current = (row) => ({
  ...row,
  print_watermark: {
    position: { corner: 'bottom-left' },
    analysis_version: 'v5',
  },
});
const deferred = () => {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};
const options = (images, analyze) => ({
  images,
  watermark: { settings, visible: true, analyze },
  scope: 'page',
  enabled: true,
});

test('local readiness starts skipped rows without reanalyzing recovered shared rows', async () => {
  const analyze = vi.fn(async (row) => ({ image: current(row) }));
  const props = options(
    [image('shared'), image('private', { visibility: 'private' })],
    analyze,
  );
  props.watermark.localAvailable = false;
  const hook = renderHook((props) => useVisibleWatermarks(props), {
    initialProps: props,
  });
  await waitFor(() => expect(hook.result.current.pending).toBe(0));
  expect(analyze.mock.calls.map(([row]) => row.id)).toEqual(['shared']);
  const ready = {
    ...props,
    watermark: { ...props.watermark, localAvailable: true },
  };
  hook.rerender(ready);
  await waitFor(() =>
    expect(hook.result.current.images[1].print_watermark).toBeTruthy(),
  );
  expect(analyze.mock.calls.map(([row]) => row.id)).toEqual([
    'shared',
    'private',
  ]);
  hook.rerender(props);
  hook.rerender(ready);
  await act(async () => {});
  expect(analyze).toHaveBeenCalledTimes(2);
});

test('24 stale cards recover serially without a batch or full-catalog request; baked and current cards are skipped', async () => {
  let concurrent = 0,
    maximum = 0;
  const analyze = vi.fn(async (row, options) => {
    expect(options.force).toBe(false);
    expect(options.publish).toBe(false);
    concurrent++;
    maximum = Math.max(maximum, concurrent);
    await Promise.resolve();
    concurrent--;
    return { image: current(row) };
  });
  const rows = Array.from({ length: 24 }, (_, i) =>
    image(String(i), {
      has_watermark_analysis: true,
      watermark_preview_status: 'unavailable',
    }),
  );
  const props = options(
    [
      ...rows,
      current(image('ready')),
      image('baked', { derivative_type: 'watermarked' }),
    ],
    analyze,
  );
  const hook = renderHook((props) => useVisibleWatermarks(props), {
    initialProps: props,
  });
  await waitFor(() => expect(analyze).toHaveBeenCalledTimes(24));
  await waitFor(() => expect(hook.result.current.pending).toBe(0));
  expect(maximum).toBe(1);
  expect(
    hook.result.current.images
      .slice(0, 24)
      .every((row) => row.print_watermark?.analysis_version === 'v5'),
  ).toBe(true);
  hook.rerender({ ...props, images: [...props.images] });
  await act(async () => {});
  expect(analyze).toHaveBeenCalledTimes(24);
});

test('failure stays honest and waits for Retry; no rerender retry loop', async () => {
  const analyze = vi
    .fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockImplementation(async (row) => ({ image: current(row) }));
  const props = options([image('one')], analyze);
  const hook = renderHook((props) => useVisibleWatermarks(props), {
    initialProps: props,
  });
  await waitFor(() => expect(hook.result.current.failed).toBe(1));
  hook.rerender({ ...props });
  await act(async () => {});
  expect(analyze).toHaveBeenCalledTimes(1);
  act(() => hook.result.current.retry());
  await waitFor(() => expect(hook.result.current.failed).toBe(0));
  await waitFor(() => expect(analyze).toHaveBeenCalledTimes(2));
});

test.each(['toggle', 'page', 'source', 'settings', 'unmount'])(
  '%s aborts old work and rejects late completion',
  async (change) => {
    const held = deferred();
    const analyze = vi.fn(() => held.promise);
    const props = options([image('one'), image('two')], analyze);
    const hook = renderHook((props) => useVisibleWatermarks(props), {
      initialProps: props,
    });
    await waitFor(() => expect(analyze).toHaveBeenCalledTimes(1));
    const signal = analyze.mock.calls[0][1].signal;
    let next = props;
    if (change === 'unmount') hook.unmount();
    else {
      if (change === 'toggle')
        next = { ...props, watermark: { ...props.watermark, visible: false } };
      if (change === 'page')
        next = {
          ...props,
          images: [current(image('next'))],
          scope: 'search-page',
        };
      if (change === 'source')
        next = {
          ...props,
          images: [current(image('one', { sha256: 'changed' }))],
        };
      if (change === 'settings')
        next = {
          ...props,
          images: [],
          watermark: {
            ...props.watermark,
            settings: { ...settings, fingerprint: 'new' },
          },
        };
      hook.rerender(next);
    }
    expect(signal.aborted).toBe(true);
    await act(async () => held.resolve({ image: current(image('one')) }));
    expect(analyze).toHaveBeenCalledTimes(1);
    if (change !== 'unmount')
      expect(hook.result.current.images).toEqual(next.images);
  },
);

test('a freshly regenerated incoming record outranks the recovered thumbnail', async () => {
  const props = options(
    [image('one')],
    vi.fn(async (row) => ({ image: current(row) })),
  );
  const hook = renderHook((props) => useVisibleWatermarks(props), {
    initialProps: props,
  });
  await waitFor(() =>
    expect(hook.result.current.images[0].print_watermark).toBeTruthy(),
  );
  const changed = current(image('one'));
  changed.print_watermark.position.corner = 'top-right';
  hook.rerender({ ...props, images: [changed] });
  expect(hook.result.current.images[0]).toBe(changed);
});
