import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import App from '../../src/app/App.jsx';
import { CONTENT_STORAGE_KEY } from '../../src/features/watermarks/localWatermark.js';
import * as printing from '../../src/features/watermarks/printing.js';
import WatermarkPanel from '../../src/features/watermarks/WatermarkPanel.jsx';
import {
  fakeLibrary,
  fixtures,
  installApi,
  libraryRecord,
} from '../helpers/testSupport.js';

vi.mock('../../src/features/watermarks/printing.js', async (original) => ({
  ...(await original()),
  saveBlob: vi.fn(),
  printBlob: vi.fn(async () => ({ orientation: 'portrait' })),
}));

const { browserSettings } = fixtures;
const VALIDATE = 'POST /api/browser-settings/watermark/validate';
const jobPolicy = { pollIntervalMs: 1, maxConsecutivePollFailures: 3 };
let api;

beforeEach(() => {
  window.history.replaceState(null, '', '/print');
  localStorage.clear();
  vi.clearAllMocks();
  const library = fakeLibrary([libraryRecord({ id: 'one', title: 'One' })]);
  api = installApi({
    ...library.routes,
    [VALIDATE]: (body) => ({
      ...browserSettings.local_watermark,
      ...body,
      fingerprint: `fp-${body.text ?? 'svg'}`,
    }),
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const openSettings = async () => {
  fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
  const dialog = await screen.findByRole('dialog', { name: 'Settings' });
  fireEvent.click(within(dialog).getByRole('tab', { name: 'Watermark' }));
  const edit = await within(dialog).findByRole('button', {
    name: 'Edit watermark',
  });
  await waitFor(() => expect(edit.disabled).toBe(false));
  return { dialog, edit };
};

test('the gear edits this browser’s watermark with the existing editor; the library editor shows the same choice', async () => {
  render(<App jobPolicy={jobPolicy} />);
  const { dialog, edit } = await openSettings();
  const section = () =>
    within(within(dialog).getByRole('group', { name: 'Watermark' }));
  expect(section().getByText('Default')).toBeTruthy();
  fireEvent.click(edit);
  const editor = await screen.findByRole('dialog', { name: 'Watermark' });
  expect(within(editor).getByText('This browser only')).toBeTruthy();
  const text = within(editor).getByRole('textbox');
  fireEvent.change(text, { target: { value: 'Mine' } });
  fireEvent.click(within(editor).getByRole('button', { name: 'Save' }));
  await waitFor(() =>
    expect(screen.queryByRole('dialog', { name: 'Watermark' })).toBeNull(),
  );
  expect(JSON.parse(localStorage.getItem(CONTENT_STORAGE_KEY))).toEqual({
    v: 1,
    type: 'text',
    text: 'Mine',
  });
  // Nothing global was written, and the focus returned to the entry.
  expect(api.calls.some((c) => c.key.startsWith('PUT'))).toBe(false);
  await waitFor(() =>
    expect(document.activeElement).toBe(
      within(dialog).getByRole('button', { name: 'Edit watermark' }),
    ),
  );
  expect(section().getByText('Custom')).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

  // The Library editor opens the same owner's content.
  fireEvent.click(
    await screen.findByRole('button', { name: 'Watermark settings' }),
  );
  const second = await screen.findByRole('dialog', { name: 'Watermark' });
  expect(within(second).getByRole('textbox').value).toBe('Mine');
  // Reset removes the override and shows the server default again.
  fireEvent.click(
    within(second).getByRole('button', { name: /Reset to default/ }),
  );
  await waitFor(() =>
    expect(screen.queryByRole('dialog', { name: 'Watermark' })).toBeNull(),
  );
  expect(localStorage.getItem(CONTENT_STORAGE_KEY)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Watermark settings' }));
  const third = await screen.findByRole('dialog', { name: 'Watermark' });
  expect(within(third).getByRole('textbox').value).toBe(
    browserSettings.defaults.watermark.text,
  );
});

test('Cancel in the editor changes nothing', async () => {
  render(<App jobPolicy={jobPolicy} />);
  const { edit } = await openSettings();
  fireEvent.click(edit);
  const editor = await screen.findByRole('dialog', { name: 'Watermark' });
  fireEvent.change(within(editor).getByRole('textbox'), {
    target: { value: 'Discard' },
  });
  fireEvent.click(within(editor).getByRole('button', { name: 'Cancel' }));
  expect(localStorage.getItem(CONTENT_STORAGE_KEY)).toBeNull();
  expect(api.called(VALIDATE)).toHaveLength(0);
});

// --- panel ---------------------------------------------------------------

const analyzed = {
  id: 'img',
  title: 'Image',
  storage_id: 'local-0',
  filename: 'img.png',
  width: 10,
  height: 10,
  print_watermark: { position: { corner: 'top-left' } },
  print_watermark_key: 'k',
};
const png = new Blob(['prepared'], { type: 'image/png' });

function panel(image, { show = true, prepare, original } = {}) {
  const downloadOriginal = original ?? vi.fn();
  render(
    <WatermarkPanel
      image={image}
      watermark={{
        settings: { fingerprint: 'f' },
        localAvailable: true,
        preparable: true,
        prepare:
          prepare ??
          vi.fn(async () => ({
            blob: png,
            size: { width: 10, height: 10 },
            persistence: { state: 'stored' },
          })),
        analyze: vi.fn(),
        inspect: vi.fn(async () => ({ analyzed: true, prepared: 'stored' })),
      }}
      show={show}
      onShow={() => {}}
      canDownload
      canPrint
      originalName="img.png"
      original={{ busy: false, error: null, download: downloadOriginal }}
    />,
  );
  return { downloadOriginal };
}

test('with the watermark on, Download saves the prepared copy and Download original stays a separate explicit action', async () => {
  const { downloadOriginal } = panel(analyzed);
  fireEvent.click(screen.getByRole('button', { name: 'Download watermarked' }));
  await waitFor(() =>
    expect(printing.saveBlob).toHaveBeenCalledWith(png, 'img-watermarked.png'),
  );
  expect(downloadOriginal).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Download original' }));
  expect(downloadOriginal).toHaveBeenCalledTimes(1);
  expect(printing.saveBlob).toHaveBeenCalledTimes(1);
});

test('a failed prepare shows the error and never downloads the original instead', async () => {
  const { downloadOriginal } = panel(analyzed, {
    prepare: vi.fn(async () => {
      throw new Error('The image details could not be added.');
    }),
  });
  fireEvent.click(screen.getByRole('button', { name: 'Download watermarked' }));
  expect((await screen.findByRole('alert')).textContent).toContain(
    'could not be added',
  );
  expect(printing.saveBlob).not.toHaveBeenCalled();
  expect(downloadOriginal).not.toHaveBeenCalled();
});

test('with the watermark off the only download is the original', () => {
  panel(analyzed, { show: false });
  expect(
    screen.queryByRole('button', { name: 'Download watermarked' }),
  ).toBeNull();
  expect(
    screen.getByRole('button', { name: 'Download original' }),
  ).toBeTruthy();
});

test('a baked copy is labelled truthfully: no second mark, no removal, its own pixels download and print', async () => {
  const baked = { ...analyzed, derivative_type: 'watermarked' };
  const prepare = vi.fn();
  const { downloadOriginal } = panel(baked, { prepare });
  expect(screen.getByText(/part of this image’s pixels/)).toBeTruthy();
  expect(screen.getByRole('checkbox', { name: 'Watermark' }).disabled).toBe(
    true,
  );
  expect(
    screen.queryByRole('button', { name: 'Download watermarked' }),
  ).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Download original' }));
  expect(downloadOriginal).toHaveBeenCalled();
  expect(prepare).not.toHaveBeenCalled();
});
