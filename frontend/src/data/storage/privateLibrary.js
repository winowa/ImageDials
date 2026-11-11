import { PRIVATE_WATERMARKED_KIND, VARIANT_KIND } from './cachePolicy.js';
import { createPrivateCatalog } from './privateCatalog.js';
import { PRIVATE_READ_PAGE_LIMIT } from './cachePrivate.js';
import {
  BROWSER_UPLOAD_STORAGE_TYPE,
  imageKey,
  LOCAL_ORIGIN,
} from '../records/imageRecord.js';
import { preparedPipelineCurrent } from '../../features/watermarks/privateWatermark.js';
import { preparedNotStored } from './privateHistory.js';
import { searchPrivatePage } from './privateSearch.js';

export const PRIVATE_ACTION_METADATA_MAX_BYTES = 1024 * 1024;

export function privateLibraryView(row) {
  const analysis = row.watermark?.analysis;
  return {
    ...row.record,
    ...(row.origin === LOCAL_ORIGIN.IMPORTED
      ? { storage_type: BROWSER_UPLOAD_STORAGE_TYPE }
      : {}),
    ...(analysis
      ? {
          width: analysis.dimensions.width,
          height: analysis.dimensions.height,
          print_watermark: analysis.print_watermark,
          print_watermark_key: analysis.print_watermark_key,
        }
      : {}),
    image_url: '',
    local_thumbnail_url: '',
    local_origin: row.origin,
    local_added_at: row.addedAt,
    local_watermark: {
      prepared:
        row.hasPrepared && preparedPipelineCurrent(row.watermark?.prepared)
          ? 'stored'
          : null,
    },
    local_storage: {
      state: row.hasFull ? 'stored' : 'not-stored',
      held: false,
      message: 'The original bytes are not stored in this browser.',
    },
  };
}

/** Library-only consumer. Windows, active identities and media are independent. */
export function createPrivateLibrary(store, { onRecord = () => {} } = {}) {
  const catalog = createPrivateCatalog(store);
  const active = new Map();
  let ticket = 0;
  let controller = null;
  let page = null;
  let knownSeq = null;
  let binding = { q: '', limit: 24 };
  const idOf = (handle) => JSON.stringify([handle.key, handle.addedAt]);
  const handleFor = (record) =>
    Number.isFinite(record?.local_added_at)
      ? {
          key: imageKey(record),
          addedAt: record.local_added_at,
          origin: record.local_origin,
        }
      : null;
  async function detail(handle) {
    const row = await store.readPrivateDetail(handle.key);
    return row?.addedAt === handle.addedAt ? row : null;
  }
  const host = {
    handleFor,
    isListed: (handle) => !active.get(idOf(handle))?.missing,
    async load(handle) {
      const entry = active.get(idOf(handle));
      if (!entry) throw new Error('The private image action is not pinned.');
      const row = await detail(handle);
      const bytes = row
        ? new TextEncoder().encode(JSON.stringify(row)).byteLength
        : 0;
      const otherBytes = [...active.values()].reduce(
        (sum, item) => sum + (item === entry ? 0 : (item.bytes ?? 0)),
        0,
      );
      if (otherBytes + bytes > PRIVATE_ACTION_METADATA_MAX_BYTES)
        throw new Error(
          'Active private image metadata exceeds the action budget. Close an image and retry.',
        );
      entry.bytes = bytes;
      entry.missing = !row;
      entry.row = row;
      if (row) onRecord(privateLibraryView(row));
    },
    current(handle) {
      const row = active.get(idOf(handle))?.row;
      return row ? { watermark: row.watermark, wire: row.record } : null;
    },
    retain(handle, role = 'watermark-action') {
      const pinned = catalog.pin(handle, role);
      if (!pinned.accepted)
        throw new Error(
          'Too many private image actions are active. Close an image and retry.',
        );
      const id = idOf(handle);
      let entry = active.get(id);
      if (!entry) {
        entry = {
          counts: new Map(),
          identity: { key: handle.key, addedAt: handle.addedAt },
          row: null,
          missing: false,
        };
        active.set(id, entry);
      }
      entry.counts.set(role, (entry.counts.get(role) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const count = entry.counts.get(role) - 1;
        if (count) entry.counts.set(role, count);
        else {
          entry.counts.delete(role);
          catalog.unpin(handle, role);
        }
        if (!entry.counts.size) active.delete(id);
      };
    },
    async readOriginal(handle) {
      const release = host.retain(handle);
      try {
        return await store.readPrivateMedia(
          handle.key,
          { addedAt: handle.addedAt },
          VARIANT_KIND.FULL,
        );
      } finally {
        release();
      }
    },
    async readPrepared(handle) {
      const row = await detail(handle);
      if (!preparedPipelineCurrent(row?.watermark?.prepared)) return null;
      return store.readPrivateMedia(
        handle.key,
        { addedAt: handle.addedAt },
        PRIVATE_WATERMARKED_KIND,
      );
    },
    persistenceOf: () => ({ state: 'stored' }),
    async saveAnalysis(handle, state) {
      if (!(await detail(handle))) return { listed: false };
      const result = await store.savePrivateWatermark(
        handle.key,
        { addedAt: handle.addedAt },
        state,
      );
      await host.load(handle);
      if (!host.isListed(handle)) return { listed: false };
      return result.persisted
        ? { state: 'stored' }
        : preparedNotStored(result.reason);
    },
    async savePrepared(handle, state, blob) {
      if (!(await detail(handle))) return { listed: false };
      const result = await store.savePrivatePrepared(
        handle.key,
        { addedAt: handle.addedAt },
        state,
        blob,
      );
      await host.load(handle);
      if (!host.isListed(handle)) return { listed: false };
      return result.persisted
        ? { state: 'stored' }
        : preparedNotStored(result.reason);
    },
  };
  return {
    host,
    catalog,
    cancel() {
      ticket++;
      controller?.abort();
    },
    async refreshPins() {
      for (const entry of active.values()) {
        const row = await detail(entry.identity);
        entry.missing = !row;
        if (!row) {
          entry.row = null;
          entry.bytes = 0;
        } else onRecord(privateLibraryView(row));
        // Identity confirmation does not retain another full metadata snapshot.
        // The next action load revalidates analysis and its byte budget.
      }
    },
    async remove(record) {
      const handle = handleFor(record);
      if (!handle) return 'The private image identity is unavailable.';
      const row = await detail(handle);
      if (!row) return 'The image was removed or replaced in this browser.';
      const result = await store.removePrivate(handle.key, handle.addedAt, {
        requireIncarnation: true,
      });
      if (!result.removed)
        return (
          (result.reason === 'changed'
            ? 'The image was removed or replaced in this browser.'
            : null) ??
          result.error?.message ??
          'The image could not be removed from this browser.'
        );
      const entry = active.get(idOf(handle));
      if (entry) {
        entry.missing = true;
        entry.row = null;
      }
      return null;
    },
    async load(intent = {}) {
      controller?.abort();
      controller = new AbortController();
      const mine = ++ticket;
      const nextBinding = {
        q: String(intent.binding?.q ?? binding.q)
          .trim()
          .split(/\s+/)
          .filter(Boolean)
          .join(' '),
        limit: intent.binding?.limit ?? binding.limit,
      };
      if (
        !Number.isInteger(nextBinding.limit) ||
        nextBinding.limit < 1 ||
        nextBinding.limit > PRIVATE_READ_PAGE_LIMIT
      )
        throw new RangeError('Invalid private Library page size.');
      const same =
        nextBinding.q === binding.q && nextBinding.limit === binding.limit;
      const direction = same ? (intent.direction ?? 'first') : 'first';
      const old = same ? page : null;
      binding = nextBinding;
      let result;
      if (binding.q) {
        const offset =
          direction === 'forward'
            ? (old?.next_cursor ?? 0)
            : direction === 'backward'
              ? (old?.previous_cursor ?? 0)
              : direction === 'refresh'
                ? (old?.position ?? 0)
                : 0;
        const found = await searchPrivatePage(store, {
          ...binding,
          offset,
          last: direction === 'last',
          signal: controller.signal,
        });
        result = {
          ...found,
          next_cursor: found.next,
          previous_cursor: found.previous,
        };
      } else {
        const anchor =
          direction === 'forward'
            ? old?.next_cursor
            : direction === 'backward'
              ? old?.previous_cursor
              : direction === 'refresh'
                ? old?.request?.anchor
                : null;
        const edge =
          direction === 'last'
            ? 'oldest'
            : direction === 'refresh'
              ? (old?.request?.edge ?? 'newest')
              : 'newest';
        const move =
          direction === 'backward'
            ? 'newer'
            : direction === 'refresh'
              ? (old?.request?.direction ?? 'older')
              : 'older';
        const request = { anchor, edge, direction: move, limit: binding.limit };
        let rows = await store.readPrivatePage(request);
        let count = await catalog.count();
        if (!rows.rows.length && count.count > 0 && rows.seq === count.seq) {
          Object.assign(request, {
            anchor: null,
            edge: 'oldest',
            direction: 'older',
          });
          rows = await store.readPrivatePage(request);
          count = await catalog.count();
        }
        if (rows.seq !== count.seq)
          throw new Error('History changed while loading. Retry the page.');
        result = {
          ...rows,
          total: count.count,
          position: !rows.previous
            ? 0
            : !rows.next
              ? count.count - rows.rows.length
              : null,
          next_cursor: rows.next,
          previous_cursor: rows.previous,
          request,
        };
      }
      if (mine !== ticket) return null;
      if (knownSeq !== null && result.seq < knownSeq)
        throw new Error('History changed while loading. Retry the page.');
      knownSeq = result.seq;
      page = {
        ...result,
        images: result.rows.map(privateLibraryView),
        count: result.rows.length,
      };
      return {
        binding: { ...binding },
        pages: [page],
        activeIndex: 0,
        pending: null,
        error: null,
        complete: false,
      };
    },
  };
}
