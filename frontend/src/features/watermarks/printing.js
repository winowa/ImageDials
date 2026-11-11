/**
 * Explicit browser printing of a prepared PNG, and saving it as a file.
 *
 * Printing never opens a window: the image goes into a print-only element of
 * this page, the page waits for the image and fonts to be ready, calls
 * `window.print()` and cleans up when the dialog closes. Only the browser
 * knows whether anything was printed, so nothing here reports a print
 * succeeding.
 */
import {
  classifyOrientation,
  UNKNOWN_ORIENTATION,
} from '../../data/records/imageRecord.js';

export const PRINT_ORIENTATION = {
  portrait: 'portrait',
  landscape: 'landscape',
};
export const PRINTING_ATTRIBUTE = 'data-printing';
export const PRINT_SHEET_CLASS = 'print-sheet';
/** How long a saved file's object URL stays valid for the browser to start it. */
const DOWNLOAD_URL_LIFETIME_MS = 30_000;

/** Landscape only for clearly wide images; square and unknown print portrait. */
export function printOrientation(size) {
  return classifyOrientation(size) === 'landscape'
    ? PRINT_ORIENTATION.landscape
    : PRINT_ORIENTATION.portrait;
}

/** True when the size is known well enough to classify. */
export const hasSize = (size) =>
  classifyOrientation(size) !== UNKNOWN_ORIENTATION;

/** Save a blob through a temporary download link. */
export function saveBlob(blob, filename, doc = document) {
  const url = URL.createObjectURL(blob);
  const link = doc.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  doc.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_URL_LIFETIME_MS);
}

const nextFrame = (win) =>
  new Promise((resolve) => win.requestAnimationFrame(resolve));

/** Wait until `image` has loaded and decoded; reject if it cannot be drawn. */
async function imageReady(image) {
  try {
    await image.decode();
  } catch {
    // `decode` can reject for a load that finished; the size decides.
  }
  if (!(image.naturalWidth > 0))
    throw new Error('The prepared image could not be loaded for printing.');
}

/**
 * Open the browser print dialog for a prepared image.
 *
 * Resolves with the orientation once the dialog has been requested and the
 * page is restored: print DOM removed, scroll position and focus returned.
 * @param {Blob} blob the prepared PNG
 * @param {object} [options]
 * @param {{width: number, height: number}|null} [options.size] the image's
 *   pixel size; probed from the image itself when missing
 * @param {Window} [options.win] injected for tests
 * @returns {Promise<{orientation: string}>}
 */
export async function printBlob(blob, { size = null, win = window } = {}) {
  const doc = win.document;
  const url = URL.createObjectURL(blob);
  const sheet = doc.createElement('div');
  sheet.className = PRINT_SHEET_CLASS;
  const image = doc.createElement('img');
  image.alt = '';
  sheet.append(image);
  const pageRule = doc.createElement('style');
  const scroll = { x: win.scrollX, y: win.scrollY };
  const focused = doc.activeElement;
  const printQuery = win.matchMedia?.('print');
  let afterPrint = null;
  let leftPrintMedia = null;

  const restore = () => {
    if (afterPrint) win.removeEventListener('afterprint', afterPrint);
    if (leftPrintMedia)
      printQuery.removeEventListener('change', leftPrintMedia);
    sheet.remove();
    pageRule.remove();
    doc.documentElement.removeAttribute(PRINTING_ATTRIBUTE);
    URL.revokeObjectURL(url);
    win.scrollTo(scroll.x, scroll.y);
    if (focused?.isConnected) focused.focus({ preventScroll: true });
  };

  try {
    // The sheet is `display: none` outside print, so loading cannot flash it.
    doc.body.append(sheet);
    image.src = url;
    await imageReady(image);
    const measured = hasSize(size)
      ? size
      : { width: image.naturalWidth, height: image.naturalHeight };
    const orientation = printOrientation(measured);
    // Only the two fixed keywords are ever written into the style.
    pageRule.textContent = `@page { size: ${orientation}; margin: 0; }`;
    doc.head.append(pageRule);
    await doc.fonts?.ready;
    doc.documentElement.setAttribute(PRINTING_ATTRIBUTE, orientation);
    await nextFrame(win);
    // The dialog is over on `afterprint`, or when the page leaves print media.
    const closed = new Promise((resolve) => {
      afterPrint = resolve;
      win.addEventListener('afterprint', afterPrint, { once: true });
      if (printQuery?.addEventListener) {
        leftPrintMedia = (event) => event.matches || resolve();
        printQuery.addEventListener('change', leftPrintMedia);
      }
    });
    win.print();
    // Blocking engines return after the dialog; others fire `afterprint` later.
    await closed;
    return { orientation };
  } finally {
    restore();
  }
}
