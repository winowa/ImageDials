import { searchImages } from './browse.js';
import {
  PRIVATE_PAGE_METADATA_MAX_BYTES,
  PRIVATE_READ_PAGE_LIMIT,
  PRIVATE_SCAN_METADATA_BYTES,
} from './cacheStore.js';

const abort = () => new DOMException('Search cancelled', 'AbortError');
/** Exact metadata search, retaining only the requested rows and one tail page.
 * Every request rescans rather than keeping catalog-sized matches/checkpoints.
 */
export async function searchPrivatePage(
  store,
  { q, limit, offset = 0, last = false, signal },
) {
  let anchor = null,
    seq = null,
    total = 0;
  let requested = [],
    tail = [],
    requestedBytes = 0,
    tailBytes = 0;
  const bytes = (row) =>
    new TextEncoder().encode(JSON.stringify(row)).byteLength;
  for (;;) {
    if (signal?.aborted) throw abort();
    const slice = await store.scanPrivateSlice({
      anchor,
      maxRows: PRIVATE_READ_PAGE_LIMIT,
      maxBytes: PRIVATE_SCAN_METADATA_BYTES,
    });
    if (signal?.aborted) throw abort();
    if (seq !== null && slice.seq !== seq)
      throw new Error('History changed during search. Retry the search.');
    seq = slice.seq;
    for (const row of slice.rows) {
      if (!searchImages([row.record], q).length) continue;
      const size = bytes(row);
      if (total >= offset && requested.length < limit && !last) {
        requested.push(row);
        requestedBytes += size;
      }
      tail.push(row);
      tailBytes += size;
      while (
        tail.length > limit ||
        (tail.length > 1 && tailBytes > PRIVATE_PAGE_METADATA_MAX_BYTES)
      )
        tailBytes -= bytes(tail.shift());
      if (
        requested.length > 1 &&
        requestedBytes > PRIVATE_PAGE_METADATA_MAX_BYTES
      )
        throw new Error(
          'Matching records exceed the page metadata budget. Choose fewer images per page.',
        );
      total++;
    }
    if (slice.done) break;
    anchor = slice.cursor;
    // Yield between bounded transactions so typing/cancellation stays responsive.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const count = await store.privateCount();
  if (signal?.aborted) throw abort();
  if (count.seq !== seq)
    throw new Error('History changed during search. Retry the search.');
  const useTail = last || (offset >= total && total > 0);
  const rows = useTail ? tail : requested;
  const position = total === 0 ? 0 : useTail ? total - rows.length : offset;
  return {
    rows,
    total,
    position,
    seq,
    next: position + rows.length < total ? position + rows.length : null,
    previous: position > 0 ? Math.max(0, position - limit) : null,
  };
}
