import {
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { api } from '../../data/api/api.js';
import * as printing from './printing.js';
import { useWatermark } from './watermark.js';
import WatermarkPanel from './WatermarkPanel.jsx';

vi.mock('./printing.js', async (original) => ({
  ...(await original()),
  saveBlob: vi.fn(),
  printBlob: vi.fn(async () => ({ orientation: 'portrait' })),
}));

const imported = {
  id: 'imp',
  title: 'Imported',
  storage_type: 'browser-upload',
  local_origin: 'imported',
  image_url: 'blob:preview',
  width: 10,
  height: 10,
};
const analyzed = {
  ...imported,
  print_watermark: { position: { corner: 'top-left' } },
  print_watermark_key: 'k',
  local_watermark: { prepared: 'stored' },
};

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

function panel(image, watermark) {
  return render(
    <WatermarkPanel
      image={image}
      watermark={{
        settings: { fingerprint: 'f' },
        localAvailable: true,
        preparable: true,
        ...watermark,
      }}
      show
      onShow={() => {}}
      canDownload
      canPrint
      originalName="imp.png"
    />,
  );
}

test('Download and Print consume the same prepared PNG; the prepared size picks the orientation', async () => {
  const png = new Blob(['png'], { type: 'image/png' });
  const prepare = vi.fn(async () => ({
    blob: png,
    size: { width: 300, height: 100 },
    persistence: { state: 'stored' },
  }));
  panel(analyzed, { prepare, analyze: vi.fn() });
  expect(screen.getByText('Saved in this browser')).toBeTruthy();
  expect(screen.getByText('Corner top left')).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: /Download watermarked/ }));
  await waitFor(() =>
    expect(printing.saveBlob).toHaveBeenCalledWith(png, 'imp-watermarked.png'),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Print' }));
  await waitFor(() => expect(printing.printBlob).toHaveBeenCalled());
  expect(printing.printBlob.mock.calls[0][0]).toBe(png);
  expect(printing.printBlob.mock.calls[0][1]).toEqual({
    size: { width: 300, height: 100 },
  });
  expect(screen.queryByRole('alert')).toBeNull();
});

test('a prepared image the browser could not keep is still used and the panel says so', async () => {
  const png = new Blob(['png'], { type: 'image/png' });
  const prepare = vi.fn(async () => ({
    blob: png,
    size: { width: 10, height: 10 },
    persistence: {
      state: 'not-stored',
      message: 'This browser has no space left to keep the prepared image.',
    },
  }));
  panel(imported, { prepare, analyze: vi.fn() });
  expect(screen.getByText('None')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /Download watermarked/ }));
  await waitFor(() => expect(printing.saveBlob).toHaveBeenCalled());
  expect(
    await screen.findByText(
      /Not saved in this browser\. This browser has no space/,
    ),
  ).toBeTruthy();
});

test('an action failure is shown as an error and nothing is saved or printed', async () => {
  const prepare = vi.fn(async () => {
    throw new Error('The original bytes of this image are not stored here.');
  });
  panel(imported, { prepare, analyze: vi.fn() });
  fireEvent.click(screen.getByRole('button', { name: 'Print' }));
  expect((await screen.findByRole('alert')).textContent).toContain(
    'not stored here',
  );
  expect(printing.printBlob).not.toHaveBeenCalled();
});

const localOwner = (settings, extra = {}) => ({
  settings,
  custom: false,
  refresh: vi.fn(async () => settings),
  save: vi.fn(async () => ({ persisted: true })),
  reset: vi.fn(async () => settings),
  ...extra,
});

test('settings come from this browser; saving them never writes the shared settings or reloads the library', async () => {
  const settings = { fingerprint: 'f1', rendering: {}, limits: {} };
  const shared = vi.spyOn(api, 'saveWatermarkSettings');
  const local = localOwner(settings);
  const reload = vi.fn();
  const { result } = renderHook(() =>
    useWatermark({
      images: { watermarkBackfill: null },
      reload,
      replace: vi.fn(),
      local,
      capabilities: { watermark: { transient_analysis_enabled: true } },
      localHost: {},
      sharedHost: {},
    }),
  );
  expect(result.current.settings).toBe(settings);
  expect(result.current.localAvailable).toBe(true);
  expect(result.current.preparable).toBe(true);
  await result.current.saveSettings({ type: 'text', text: 'x' });
  expect(local.save).toHaveBeenCalledWith({ type: 'text', text: 'x' });
  expect(shared).not.toHaveBeenCalled();
  expect(reload).not.toHaveBeenCalled();
});

test('a browser-only image never reaches a shared-library route; a shared image still uses the library analysis', async () => {
  const shared = vi.spyOn(api, 'analyzeWatermark').mockResolvedValue({
    image: { id: 's', storage_id: 'a', filename: 'b.png' },
  });
  const upload = vi.spyOn(api, 'uploadPrintReady');
  const backfill = vi.spyOn(api, 'queueWatermarkBackfill');
  const replace = vi.fn();
  // A host that knows no entries: the service refuses before any call.
  const host = { handleFor: () => null };
  const { result } = renderHook(() =>
    useWatermark({
      images: { watermarkBackfill: null },
      reload: vi.fn(),
      replace,
      local: localOwner({ fingerprint: 'f' }),
      capabilities: { watermark: { transient_analysis_enabled: true } },
      localHost: host,
      sharedHost: host,
    }),
  );
  await expect(result.current.prepare(imported)).rejects.toMatchObject({
    stage: 'removed',
  });
  await expect(result.current.analyze(imported)).rejects.toMatchObject({
    stage: 'removed',
  });
  expect(shared).not.toHaveBeenCalled();
  expect(upload).not.toHaveBeenCalled();
  expect(backfill).not.toHaveBeenCalled();

  await result.current.analyze({ storage_id: 'a', filename: 'b.png' });
  expect(shared).toHaveBeenCalledTimes(1);
  expect(replace).toHaveBeenCalled();
});

test('a baked copy is never prepared again', async () => {
  const { result } = renderHook(() =>
    useWatermark({
      images: { watermarkBackfill: null },
      reload: vi.fn(),
      replace: vi.fn(),
      local: localOwner({ fingerprint: 'f' }),
      capabilities: { watermark: { transient_analysis_enabled: true } },
      localHost: { handleFor: () => ({}) },
      sharedHost: { handleFor: () => ({}) },
    }),
  );
  await expect(
    result.current.prepare({ ...imported, derivative_type: 'watermarked' }),
  ).rejects.toMatchObject({ stage: 'baked' });
});

test('the local branch stays off when the server does not offer transient analysis', () => {
  const { result } = renderHook(() =>
    useWatermark({
      images: { watermarkBackfill: null },
      reload: vi.fn(),
      replace: vi.fn(),
      local: localOwner(null),
      capabilities: { watermark: { transient_analysis_enabled: false } },
      localHost: {},
      sharedHost: {},
    }),
  );
  expect(result.current.localAvailable).toBe(false);
  expect(result.current.preparable).toBe(false);
});

test('focus returns to the button that started an action once it finishes', async () => {
  const prepare = vi.fn(async () => ({
    blob: new Blob(['png']),
    size: { width: 10, height: 10 },
    persistence: { state: 'stored' },
  }));
  panel(imported, { prepare, analyze: vi.fn() });
  const print = screen.getByRole('button', { name: 'Print' });
  print.focus();
  fireEvent.click(print);
  await waitFor(() => expect(printing.printBlob).toHaveBeenCalled());
  await waitFor(() => expect(document.activeElement).toBe(print));
});
