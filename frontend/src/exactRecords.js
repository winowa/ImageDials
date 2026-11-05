/**
 * Full saved records versus bounded summaries. A summary (or an incomplete
 * stored copy) identifies and displays an image but never restores or submits
 * one; only its exact record does. The small pool here keeps those exact records
 * apart from summary rows, and never evicts one the stage or draft still uses.
 */
import { imageKey, isLocalOnly } from './imageRecord.js';

/** Exact records held in memory beyond the ones in use. */
export const EXACT_RECORD_POOL_LIMIT = 12;

/** Whether this item can be restored as it is, with nothing fetched. */
export function isExactRecord(record) {
  if (!record || typeof record !== 'object') return false;
  // Summary rows identify and display an image but never restore its draft,
  // even when a local-only marker is also present.
  if (
    record.listing_kind === 'summary-page' ||
    record.metadata_complete === false ||
    record.local_summary === true
  )
    return false;
  if (record.client_pending || isLocalOnly(record)) return true;
  const prompt = record.original_prompt ?? record.prompt;
  return (
    typeof prompt === 'string' &&
    (Object.hasOwn(record, 'selected_controls') ||
      Object.hasOwn(record, 'original_selected_controls') ||
      Array.isArray(record.categories))
  );
}

/** A new pool with `record` as the most recently used, oldest unused ones gone. */
export function rememberExact(
  pool,
  record,
  pinned = new Set(),
  limit = EXACT_RECORD_POOL_LIMIT,
) {
  const key = imageKey(record);
  const next = new Map(pool);
  next.delete(key);
  next.set(key, record);
  for (const candidate of next.keys()) {
    if (next.size <= limit) break;
    if (candidate !== key && !pinned.has(candidate)) next.delete(candidate);
  }
  return next;
}
