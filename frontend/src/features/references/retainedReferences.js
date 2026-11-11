/**
 * Pure rules for reference originals kept in this browser: byte and usage
 * text, honest failure wording, and the lazy reader that turns a kept file into
 * a Blob only when it is chosen, restored or compared. Nothing here lists,
 * writes or fetches; the store (`referenceAssets.js`) owns storage.
 */
import { REFERENCE_KEEP_REASON as REASON } from '../../data/storage/referenceAssets.js';

const KIB = 1024;
const MIB = KIB * 1024;
const GIB = MIB * 1024;

const rounded = (value) => Math.round(value * 10) / 10;

/** "812 B", "3.4 KiB", "4.2 MiB". */
export function formatBytes(bytes) {
  const value = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (value >= GIB) return `${rounded(value / GIB)} GiB`;
  if (value >= MIB) return `${rounded(value / MIB)} MiB`;
  if (value >= KIB) return `${rounded(value / KIB)} KiB`;
  return `${value} B`;
}

/** "3 of 32 files · 4.2 MiB of 256 MiB". */
export function usageText(usage) {
  if (!usage) return '';
  return `${usage.count} of ${usage.maxRecords} files · ${formatBytes(usage.bytes)} of ${formatBytes(usage.maxBytes)}`;
}

/** "up to 32 files, 256 MiB". */
export const limitText = (usage) =>
  `up to ${usage.maxRecords} files, ${formatBytes(usage.maxBytes)}`;

/** Fraction of the byte or file budget in use (the larger), 0 to 1. */
export function usageFraction(usage) {
  if (!usage) return 0;
  const files = usage.maxRecords > 0 ? usage.count / usage.maxRecords : 0;
  const bytes = usage.maxBytes > 0 ? usage.bytes / usage.maxBytes : 0;
  return Math.min(1, Math.max(0, files, bytes));
}

const STILL_HERE = 'It is still in this draft.';

/**
 * Wording for a refused or failed keep. `retry` offers another attempt (the
 * cause can pass); `manage` points at removing a kept file to make room.
 */
export function keepFailure(reason, usage) {
  switch (reason) {
    case REASON.COUNT:
      return {
        message: `Not kept: ${usage?.maxRecords ?? 'the'} kept files are in use. ${STILL_HERE}`,
        retry: false,
        manage: true,
      };
    case REASON.BYTES:
      return {
        message: `Not kept: it does not fit in the remaining ${formatBytes(
          Math.max(0, (usage?.maxBytes ?? 0) - (usage?.bytes ?? 0)),
        )}. ${STILL_HERE}`,
        retry: false,
        manage: true,
      };
    case REASON.QUOTA:
      return {
        message: `Not kept: the browser has no room to store it. ${STILL_HERE}`,
        retry: true,
        manage: Boolean(usage?.count),
      };
    case REASON.NO_STORAGE:
      return {
        message: `Not kept: this browser is not storing files here. ${STILL_HERE}`,
        retry: false,
        manage: false,
      };
    case REASON.CHANGED:
      return {
        message: `Not kept: kept files changed in another tab. ${STILL_HERE}`,
        retry: true,
        manage: false,
      };
    case REASON.CHECKSUM:
      return {
        message: `Not kept: the file could not be verified. ${STILL_HERE}`,
        retry: true,
        manage: false,
      };
    case REASON.INVALID:
      return {
        message: `Not kept: this file cannot be stored. ${STILL_HERE}`,
        retry: false,
        manage: false,
      };
    default:
      return {
        message: `Not kept: the browser could not store it. ${STILL_HERE}`,
        retry: true,
        manage: false,
      };
  }
}

/** Wording for a refused or failed removal of a kept copy. */
export function removeFailure(reason) {
  switch (reason) {
    case REASON.CHANGED:
      return 'This file changed in another tab. The list was refreshed.';
    case REASON.NO_STORAGE:
      return 'This browser is not storing files here.';
    default:
      return 'The kept copy could not be removed. Try again.';
  }
}

const abortError = () => new DOMException('Aborted', 'AbortError');

/**
 * Reader for one kept original, or null without storage. It resolves
 * `{...metadata, blob}`, or null when nothing is kept under that checksum, and
 * rejects when the stored bytes are unreadable. A signal aborted while the
 * read was in flight rejects with an AbortError so a late answer is dropped.
 * @param {{read: (sha256: string) => Promise<object|null>}|null} store
 */
export function retainedReader(store) {
  if (!store) return null;
  return async (sha256, { signal } = {}) => {
    if (signal?.aborted) throw abortError();
    const entry = await store.read(sha256);
    if (signal?.aborted) throw abortError();
    return entry ?? null;
  };
}

/** A File for kept bytes: upload and display need a name and a type. */
export function keptFile(entry) {
  const type = entry.type || entry.blob?.type || 'image/png';
  return new File([entry.blob], String(entry.name || 'reference'), { type });
}
