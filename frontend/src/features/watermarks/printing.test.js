import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import {
  PRINT_ORIENTATION,
  PRINT_SHEET_CLASS,
  PRINTING_ATTRIBUTE,
  printBlob,
  printOrientation,
  saveBlob,
} from './printing.js';

let natural;
let revoked;

beforeEach(() => {
  natural = { width: 600, height: 400 };
  revoked = [];
  URL.createObjectURL = vi.fn(() => 'blob:print-1');
  URL.revokeObjectURL = vi.fn((url) => revoked.push(url));
  HTMLImageElement.prototype.decode = vi.fn(async () => {});
  Object.defineProperty(HTMLImageElement.prototype, 'naturalWidth', {
    configurable: true,
    get: () => natural.width,
  });
  Object.defineProperty(HTMLImageElement.prototype, 'naturalHeight', {
    configurable: true,
    get: () => natural.height,
  });
  window.scrollTo = vi.fn();
});
afterEach(() => {
  document.body.replaceChildren();
  document.head.querySelectorAll('style').forEach((style) => style.remove());
  document.documentElement.removeAttribute(PRINTING_ATTRIBUTE);
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete document.fonts;
});

const blob = new Blob(['png'], { type: 'image/png' });

test('orientation follows the dimensions; square and unknown print portrait', () => {
  expect(printOrientation({ width: 1800, height: 1200 })).toBe('landscape');
  expect(printOrientation({ width: 1200, height: 1800 })).toBe('portrait');
  expect(printOrientation({ width: 1200, height: 1200 })).toBe('portrait');
  expect(printOrientation({ width: 1000, height: 960 })).toBe('portrait');
  expect(printOrientation(null)).toBe(PRINT_ORIENTATION.portrait);
});

/** Observe the page at the moment the dialog is requested. */
function stubPrint({ afterwards = 'async' } = {}) {
  const seen = {};
  vi.spyOn(window, 'print').mockImplementation(() => {
    const sheet = document.querySelector(`.${PRINT_SHEET_CLASS}`);
    seen.sheet = Boolean(sheet);
    seen.src = sheet?.querySelector('img')?.getAttribute('src');
    seen.page = [...document.head.querySelectorAll('style')]
      .map((style) => style.textContent)
      .find((text) => text.includes('@page'));
    seen.attribute = document.documentElement.getAttribute(PRINTING_ATTRIBUTE);
    if (afterwards === 'sync') window.dispatchEvent(new Event('afterprint'));
    else setTimeout(() => window.dispatchEvent(new Event('afterprint')), 0);
  });
  return seen;
}

test.each(['async', 'sync'])(
  'the dialog opens with the loaded image on the print sheet and the page is restored (%s afterprint)',
  async (afterwards) => {
    const seen = stubPrint({ afterwards });
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    Object.defineProperty(window, 'scrollX', { configurable: true, value: 12 });
    Object.defineProperty(window, 'scrollY', {
      configurable: true,
      value: 340,
    });

    const outcome = await printBlob(blob, {
      size: { width: 1800, height: 1200 },
    });

    expect(outcome).toEqual({ orientation: 'landscape' });
    expect(window.print).toHaveBeenCalledTimes(1);
    expect(seen).toEqual({
      sheet: true,
      src: 'blob:print-1',
      page: '@page { size: landscape; margin: 0; }',
      attribute: 'landscape',
    });
    // The image had loaded and decoded before the dialog was requested.
    expect(HTMLImageElement.prototype.decode).toHaveBeenCalledTimes(1);
    // Everything print-specific is gone and the person's place is restored.
    expect(document.querySelector(`.${PRINT_SHEET_CLASS}`)).toBeNull();
    expect(document.head.textContent).not.toContain('@page');
    expect(document.documentElement.hasAttribute(PRINTING_ATTRIBUTE)).toBe(
      false,
    );
    expect(revoked).toEqual(['blob:print-1']);
    expect(window.scrollTo).toHaveBeenCalledWith(12, 340);
    expect(document.activeElement).toBe(opener);
  },
);

test('missing dimensions are probed from the image; square prints portrait', async () => {
  const seen = stubPrint();
  natural = { width: 900, height: 600 };
  expect((await printBlob(blob)).orientation).toBe('landscape');
  expect(seen.page).toBe('@page { size: landscape; margin: 0; }');
  natural = { width: 800, height: 800 };
  expect((await printBlob(blob, { size: null })).orientation).toBe('portrait');
  expect(seen.page).toBe('@page { size: portrait; margin: 0; }');
});

test('printing waits for fonts and never calls print before the image has loaded', async () => {
  let fontsReady;
  document.fonts = {
    ready: new Promise((resolve) => {
      fontsReady = resolve;
    }),
  };
  let decoded;
  HTMLImageElement.prototype.decode = vi.fn(
    () =>
      new Promise((resolve) => {
        decoded = resolve;
      }),
  );
  stubPrint();
  const printing = printBlob(blob, { size: { width: 10, height: 20 } });
  await Promise.resolve();
  expect(window.print).not.toHaveBeenCalled();
  decoded();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(window.print).not.toHaveBeenCalled();
  fontsReady();
  await printing;
  expect(window.print).toHaveBeenCalledTimes(1);
});

test('an image that cannot load opens no dialog and leaves the page clean', async () => {
  natural = { width: 0, height: 0 };
  HTMLImageElement.prototype.decode = vi.fn(async () => {
    throw new Error('decode failed');
  });
  vi.spyOn(window, 'print');
  await expect(printBlob(blob)).rejects.toThrow(
    /could not be loaded for printing/,
  );
  expect(window.print).not.toHaveBeenCalled();
  expect(document.querySelector(`.${PRINT_SHEET_CLASS}`)).toBeNull();
  expect(revoked).toEqual(['blob:print-1']);
});

test('print media never reaches the screen layout: the sheet is hidden until printing', async () => {
  stubPrint();
  const printing = printBlob(blob, { size: { width: 10, height: 20 } });
  // While preparing, the sheet exists but carries no print-state attribute.
  await Promise.resolve();
  expect(document.documentElement.hasAttribute(PRINTING_ATTRIBUTE)).toBe(false);
  await printing;
});

test('saving a file uses a temporary link and releases its URL later', () => {
  vi.useFakeTimers();
  const clicked = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(
    function () {
      clicked.push({ href: this.href, download: this.download });
    },
  );
  saveBlob(blob, 'bird-watermarked.png');
  expect(clicked).toEqual([
    { href: 'blob:print-1', download: 'bird-watermarked.png' },
  ]);
  expect(document.querySelector('a[download]')).toBeNull();
  expect(revoked).toEqual([]);
  vi.runAllTimers();
  expect(revoked).toEqual(['blob:print-1']);
});
