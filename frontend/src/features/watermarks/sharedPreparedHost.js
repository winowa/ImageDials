/**
 * The host that lets the local prepare service work on SHARED-library
 * originals. The originals stay server-owned: they are only read (from the
 * variant cache or the canonical file route) and are never copied into the
 * private history. What is kept per image is a rebuildable analysis and one
 * prepared PNG made with this browser's watermark content, in bounded browser
 * storage (see `localWatermarkStore.js`); nothing is sent to shared storage.
 *
 * The analysis state of a handle is read once per image (`load`) and held in
 * memory; the PNG is read only when it is needed.
 */
import {
  STORAGE_STATE,
  preparedNotStored,
} from '../../data/storage/privateHistory.js';
import { preparedPipelineCurrent } from './privateWatermark.js';
import { imageKey } from '../../data/records/imageRecord.js';
import { readOriginalBytes } from '../../data/media/originalBytes.js';

/**
 * The page binds its live collaborators with `bind` after every render
 * (the database opens late and the list changes), so the host never holds a
 * stale store or list.
 * @param {object} [deps]
 * @param {Function} [deps.fetchBlob] network reads
 */
export function createSharedPreparedHost({ fetchBlob } = {}) {
  let live = { store: null, isListed: () => false, media: null };
  const store = () => live.store?.local ?? null;
  const isListed = (key) => live.isListed(key);
  const media = () => live.media;
  /** imageKey -> analysis state loaded for this tab (null: none stored). */
  const states = new Map();
  const loaded = new Set();
  /** imageKey -> true when the PNG exists only in this tab's memory. */
  const volatile = new Set();
  const ADDED_AT = 0;

  const keep = async (handle, state, blob) => {
    const local = store();
    if (!local) return preparedNotStored('failed');
    const result = await local.writePrepared(handle.key, { state, blob });
    if (!isListed(handle.key)) {
      await local.deletePrepared(handle.key);
      return { listed: false };
    }
    if (result.persisted) {
      volatile[result.memory ? 'add' : 'delete'](handle.key);
      return {
        state: result.memory ? STORAGE_STATE.MEMORY : STORAGE_STATE.STORED,
      };
    }
    return preparedNotStored(result.reason ?? 'failed');
  };

  return {
    /** @param {{store: object|null, isListed: (key: string) => boolean, media: object|null}} next */
    bind(next) {
      live = next;
    },
    handleFor(record) {
      const key = imageKey(record);
      return {
        key,
        addedAt: ADDED_AT,
        origin: 'shared',
        record,
        watermark: states.get(key) ?? null,
      };
    },
    isListed: (handle) => isListed(handle.key),
    /** Read the stored analysis of this image once per tab. */
    async load(handle) {
      if (loaded.has(handle.key)) return;
      const row = await store()?.readPrepared(handle.key);
      if (!loaded.has(handle.key)) {
        loaded.add(handle.key);
        if (row?.state) states.set(handle.key, row.state);
      }
    },
    current(handle) {
      return { watermark: states.get(handle.key) ?? null, wire: handle.record };
    },
    readOriginal: (handle, { signal } = {}) =>
      readOriginalBytes(handle.record, { signal, media: media(), fetchBlob }),
    async readPrepared(handle) {
      const state = states.get(handle.key);
      if (!preparedPipelineCurrent(state?.prepared)) return null;
      const row = await store()?.readPrepared(handle.key);
      return row?.blob ?? null;
    },
    persistenceOf(handle) {
      if (!preparedPipelineCurrent(states.get(handle.key)?.prepared))
        return null;
      return {
        state: volatile.has(handle.key)
          ? STORAGE_STATE.MEMORY
          : STORAGE_STATE.STORED,
      };
    },
    /** Keep a fresh analysis; the PNG made for an older one goes with it. */
    async saveAnalysis(handle, state) {
      if (!isListed(handle.key)) return { listed: false };
      states.set(handle.key, state);
      return keep(handle, state, null);
    },
    /** Keep the one prepared PNG; a refused write never prunes anything else. */
    async savePrepared(handle, state, blob) {
      if (!isListed(handle.key)) return { listed: false };
      const outcome = await keep(handle, state, blob);
      if (
        outcome.state === STORAGE_STATE.NOT_STORED ||
        outcome.listed === false
      )
        states.set(handle.key, { ...state, prepared: null });
      else states.set(handle.key, state);
      return outcome;
    },
    /** The image was deleted: forget its copy now. */
    async purge(key) {
      states.delete(key);
      loaded.delete(key);
      volatile.delete(key);
      await store()?.deletePrepared(key);
    },
    /** Inspect without preparing: `{analyzed, prepared: 'stored'|'memory'|null}`. */
    async inspect(record) {
      const handle = this.handleFor(record);
      await this.load(handle);
      const state = states.get(handle.key);
      return {
        analyzed: Boolean(state?.analysis?.print_watermark_key),
        prepared: preparedPipelineCurrent(state?.prepared)
          ? volatile.has(handle.key)
            ? STORAGE_STATE.MEMORY
            : STORAGE_STATE.STORED
          : null,
      };
    },
  };
}
