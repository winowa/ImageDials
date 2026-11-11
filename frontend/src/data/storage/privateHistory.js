/**
 * The private browser history: images generated while the shared library is
 * off, and imported images. They live in this browser only.
 *
 * Each entry is a persisted WIRE snapshot (never rewritten, so false, 0, null
 * and unknown fields round-trip) plus its stored bytes. What the screens get
 * is a DISPLAY view: the snapshot with client-only markers (`local_origin`,
 * `local_thumbnail_url`, `local_storage`) and the URLs to show. No blob URL is
 * ever persisted.
 *
 * URLs. An entry's display URLs are fixed when it enters the list (a hydrated
 * blob URL, the import's preview URL, or the server URL of a fresh result) and
 * are never swapped while it is shown. Object URLs the entry owns are released
 * by an effect AFTER the list that no longer shows them has committed.
 *
 * Persistence. A fresh result is shown at once from its server URL; its
 * original bytes are then fetched, checked against `sha256` when
 * `crypto.subtle` exists, thumbnailed, and admitted to durable storage in one
 * transaction (an import commits its row and file together). Every step
 * re-checks that the entry is still listed under the same `addedAt`, so a late
 * write cannot bring back a removed entry. Nothing older is ever pruned: only a
 * confirmed removal deletes an original.
 *
 * Volatile pool. An entry that is not durably stored takes one of a bounded
 * number of slots in this tab (a URL-only result included) and, when the bytes
 * fit the pool's byte budget, holds its original Blob. Only a durable commit or
 * a confirmed removal frees a slot; Download never does. A URL-only entry is
 * labelled as such and never as a held copy. New private generation and new
 * imports are refused while no slot is free, before any provider call.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { fetchBlob as networkFetchBlob } from '../api/api.js';
import {
  planVolatileSlot,
  PRIVATE_WATERMARKED_KIND,
  VARIANT_KIND,
} from './cachePolicy.js';
import {
  BROWSER_UPLOAD_STORAGE_TYPE,
  imageKey,
  LOCAL_ORIGIN,
} from '../records/imageRecord.js';
import { makeThumbnail, sha256Hex } from '../media/privateThumbnail.js';
import { preparedPipelineCurrent } from '../../features/watermarks/privateWatermark.js';

export const STORAGE_STATE = Object.freeze({
  /** The bytes are being stored. */
  SAVING: 'saving',
  /** The original (and thumbnail) are stored in this browser. */
  STORED: 'stored',
  /** This browser has no usable storage: the entry lasts until the tab closes. */
  MEMORY: 'memory',
  /** Storing failed; `reason` says why and `retryable` whether trying again can help. */
  NOT_STORED: 'not-stored',
});

export const VOLATILE_NOTICE =
  'This browser is not keeping history on disk. Images last until this tab closes.';
export const READ_FAILED_NOTICE =
  'The history stored in this browser could not be read.';
export const PARTIAL_NOTICE =
  'Some images could not be stored in this browser and will be lost when this tab closes.';
export const LINK_ONLY_NOTICE =
  'Some images are not stored in this browser and are available only from their server link.';
export const VISIBILITY_EVENT = 'visibilitychange';

/** Why new private work is refused while the pool of unstored images is full. */
export const poolFullMessage = (limit, action) =>
  `${limit} images are not stored in this browser. Remove one from the Library before ${action}.`;
/** Some places are free, but fewer than a group of variations needs. */
export const poolShortMessage = (free, count, action) =>
  `Only ${free} of the ${count} images can be kept until this browser stores them. Choose fewer images or remove one from the Library before ${action}.`;
export const IMPORT_TOO_LARGE_MESSAGE =
  'This image does not fit the memory kept for images that are not stored in this browser. Remove one from the Library first.';

const NOT_STORED_MESSAGE = {
  fetch: 'The image could not be downloaded to store it here.',
  unreadable: 'The image could not be read, so it was not stored here.',
  checksum: 'The image did not match its checksum, so it was not stored here.',
  oversize: 'The image is larger than the space kept for history here.',
  quota: 'This browser has no space left to store the image.',
  'record-limit': 'The history kept in this browser is full.',
  'byte-limit': 'The history kept in this browser has no space left.',
  deleted: 'The image was removed.',
  'removal-fenced':
    'This copy is older than removals made in this browser, so it cannot be stored. Import it again to store it.',
  failed: 'The image could not be stored in this browser.',
};
const messageFor = (reason) =>
  NOT_STORED_MESSAGE[reason] ?? NOT_STORED_MESSAGE.failed;

const PREPARED_NOT_STORED_MESSAGE = {
  oversize:
    'There is no room left in the history here to keep the prepared image.',
  quota: 'This browser has no space left to keep the prepared image.',
  deleted: 'The image was removed.',
  'not-listed': 'The image was removed.',
  changed: 'The watermark changed while the prepared image was being saved.',
  failed: 'The prepared image could not be saved in this browser.',
};
export const preparedNotStored = (reason) => ({
  state: STORAGE_STATE.NOT_STORED,
  reason,
  message:
    PREPARED_NOT_STORED_MESSAGE[reason] ?? PREPARED_NOT_STORED_MESSAGE.failed,
});

/** Reasons that trying again cannot change. */
const FINAL_REASONS = new Set(['checksum', 'oversize', 'removal-fenced']);

const storing = { state: STORAGE_STATE.SAVING };
/** `held`: this tab holds the original bytes (otherwise only a server link remains). */
const notStored = (reason, retryable, held) => ({
  state: STORAGE_STATE.NOT_STORED,
  reason,
  message: messageFor(reason),
  retryable: retryable && !FINAL_REASONS.has(reason),
  held,
});
const inMemory = (held) => ({ state: STORAGE_STATE.MEMORY, held });

/** One-line status of an entry for the screen, or null when nothing needs saying. */
export function storageLabel(storage) {
  if (!storage) return null;
  if (storage.state === STORAGE_STATE.STORED) return 'Stored in this browser';
  if (storage.state === STORAGE_STATE.SAVING) return 'Storing in this browser…';
  if (storage.state === STORAGE_STATE.MEMORY)
    return storage.held === false
      ? 'Not kept in this browser. Only the server link remains.'
      : 'Held in this tab only. Lost when the tab closes.';
  return `Not stored in this browser. ${storage.message} ${
    storage.held
      ? 'A copy is held in this tab only.'
      : 'Only the server link remains.'
  }`;
}

/** Entries that take a slot of the volatile pool: everything not durably stored. */
const occupiesSlot = (entry) => entry.storage.state !== STORAGE_STATE.STORED;
const holdsBytes = (entry) => occupiesSlot(entry) && Boolean(entry.original);

/** Slots and held bytes in use, ignoring `exceptKey`. */
function poolUsage(list, exceptKey = null) {
  let slots = 0;
  let bytes = 0;
  for (const entry of list) {
    if (entry.key === exceptKey || !occupiesSlot(entry)) continue;
    slots += 1;
    if (entry.original) bytes += entry.original.size;
  }
  return { slots, bytes };
}

/** The display view of an entry. */
function viewOf(entry) {
  const imported = entry.origin === LOCAL_ORIGIN.IMPORTED;
  const mark = entry.watermark;
  return {
    ...entry.wire,
    ...(mark
      ? {
          // The analyzed original is the truth about its pixel size.
          width: mark.analysis.dimensions.width,
          height: mark.analysis.dimensions.height,
          print_watermark: mark.analysis.print_watermark,
          print_watermark_key: mark.analysis.print_watermark_key,
          local_watermark: {
            prepared: preparedPipelineCurrent(mark.prepared)
              ? entry.preparedMemory
                ? STORAGE_STATE.MEMORY
                : STORAGE_STATE.STORED
              : null,
          },
        }
      : {}),
    ...(imported ? { storage_type: BROWSER_UPLOAD_STORAGE_TYPE } : {}),
    ...(entry.storage.state === STORAGE_STATE.STORED
      ? { local_added_at: entry.addedAt }
      : {}),
    image_url: entry.fullUrl ?? (imported ? '' : entry.wire.image_url),
    ...(entry.thumbUrl ? { local_thumbnail_url: entry.thumbUrl } : {}),
    local_origin: entry.origin,
    local_storage: entry.storage,
  };
}

const withView = (entry) => ({ ...entry, view: viewOf(entry) });
const sameAdd = (entry, key, addedAt) =>
  entry.key === key && entry.addedAt === addedAt;

/** The in-memory entry for a stored row (hydration and cross-tab reads). */
function entryFromRow(row, urls) {
  const key = imageKey(row.record);
  const fullUrl = row.full ? urls.acquire(row.full) : null;
  const thumbUrl = row.thumbnail ? urls.acquire(row.thumbnail) : null;
  const mediaBytes = (row.full?.size ?? 0) + (row.thumbnail?.size ?? 0);
  return withView({
    key,
    addedAt: row.addedAt,
    origin: row.origin,
    wire: row.record,
    owned: [fullUrl, thumbUrl].filter(Boolean),
    fullUrl,
    thumbUrl,
    watermark: row.watermark,
    preparedBytes: row.preparedBytes,
    original: null,
    bytes: mediaBytes + row.preparedBytes,
    storedAtTick: 0,
    // A row without bytes is a record kept for recovery: a generated one is
    // fetched again, and neither holds a copy here.
    storage: row.full
      ? { state: STORAGE_STATE.STORED }
      : notStored('failed', row.origin === LOCAL_ORIGIN.GENERATED, false),
  });
}

/**
 * @param {object} options
 * @param {ReturnType<typeof import('./cacheStore.js').createCacheStore>|null} options.store
 * @param {ReturnType<typeof import('../media/objectUrls.js').createUrlLedger>} options.urls
 * @param {{privateRecordLimit: number, privateMaxBytes: number,
 *   privateVolatileRecordLimit: number, privateVolatileMaxBytes: number}} options.limits
 * @param {boolean} options.enabled false until the source is resolved to private or shared
 * @param {(url: string) => Promise<Blob>} [options.fetchBlob]
 * @param {(blob: Blob) => Promise<Blob|null>} [options.thumbnail]
 * @param {(blob: Blob) => Promise<string|null>} [options.digest]
 */
export function usePrivateHistory({
  store,
  urls,
  limits,
  enabled,
  boundedLibrary = false,
  boundedCreate = false,
  onStored = () => {},
  fetchBlob = networkFetchBlob,
  thumbnail = makeThumbnail,
  digest = sha256Hex,
}) {
  const [entries, setEntries] = useState([]);
  const [loadedFor, setLoadedFor] = useState(null);
  const loaded =
    loadedFor?.store === store &&
    loadedFor.boundedLibrary === boundedLibrary &&
    loadedFor.boundedCreate === boundedCreate;
  const [readFailed, setReadFailed] = useState(false);
  const live = useRef({
    entries: [],
    limits,
    store,
    enabled,
    boundedLibrary,
    boundedCreate,
    onStored,
  });
  const alive = useRef(true);
  const lastAddedAt = useRef(0);
  /** Counts durable commits, so a cross-tab read cannot drop a newer one. */
  const tick = useRef(0);
  const promoting = useRef(false);

  useLayoutEffect(() => {
    live.current.limits = limits;
    live.current.store = store;
    live.current.enabled = enabled;
    live.current.boundedLibrary = boundedLibrary;
    live.current.boundedCreate = boundedCreate;
    live.current.onStored = onStored;
  });
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /** Replace the list; `live` is current before React renders it. */
  const commit = useCallback((next) => {
    live.current.entries = next;
    setEntries(next);
  }, []);

  const patch = useCallback(
    (key, addedAt, change) => {
      const next = live.current.entries.map((entry) =>
        sameAdd(entry, key, addedAt)
          ? withView({ ...entry, ...change(entry) })
          : entry,
      );
      commit(next);
    },
    [commit],
  );

  const isListed = useCallback(
    (key, addedAt) =>
      alive.current &&
      live.current.entries.some((entry) => sameAdd(entry, key, addedAt)),
    [],
  );

  /** A prepared PNG the store gave up to make room: the entry will rebuild it. */
  const releasePrepared = useCallback(
    (keys) => {
      for (const key of keys ?? []) {
        const entry = live.current.entries.find((e) => e.key === key);
        if (!entry?.watermark) continue;
        patch(key, entry.addedAt, (e) => ({
          watermark: { ...e.watermark, prepared: null },
          preparedMemory: null,
          preparedBytes: 0,
          bytes: e.bytes - e.preparedBytes,
        }));
      }
    },
    [patch],
  );

  /**
   * Make an entry durable: obtain its original (held, imported or fetched and
   * verified), thumbnail it and admit it in one transaction. Without durable
   * storage, or when admission is refused, the original is held in this tab if
   * the pool's byte budget allows and the entry says exactly what it has.
   * Resolves true only when the original is durably stored.
   */
  const persist = useCallback(
    async (start) => {
      const { key, origin, wire } = start;
      let addedAt = start.addedAt;
      const listed = () => isListed(key, addedAt);
      const unsaved = (reason, retryable, full, extraBytes = 0) => {
        if (!listed()) return;
        const now = live.current;
        const imported = origin === LOCAL_ORIGIN.IMPORTED;
        let hold = false;
        if (full)
          hold =
            imported ||
            planVolatileSlot(poolUsage(now.entries, key), full.size, now.limits)
              .hold === true;
        patch(key, addedAt, (entry) => ({
          original: hold ? full : null,
          bytes: (hold ? full.size : 0) + extraBytes + entry.preparedBytes,
          storage: now.store?.durable
            ? notStored(reason, retryable, hold)
            : inMemory(hold),
        }));
      };

      if (live.current.store?.durable)
        patch(key, addedAt, () => ({ storage: storing }));
      let full = start.original;
      if (!full && origin === LOCAL_ORIGIN.GENERATED) {
        try {
          full = await fetchBlob(wire.image_url);
        } catch {
          unsaved('fetch', true, null);
          return false;
        }
        if (!listed()) return false;
        if (!full.size || (full.type && !full.type.startsWith('image/'))) {
          unsaved('unreadable', true, null);
          return false;
        }
        const expected = wire.sha256;
        if (typeof expected === 'string' && expected) {
          // `null` means this origin has no crypto.subtle: nothing is verified.
          const actual = await digest(full).catch(() => null);
          if (!listed()) return false;
          if (actual !== null && actual !== expected.toLowerCase()) {
            unsaved('checksum', false, null);
            return false;
          }
        }
      }
      if (!full) {
        unsaved('failed', false, null);
        return false;
      }
      const small = await thumbnail(full).catch(() => null);
      if (!listed()) return false;
      const { store: current } = live.current;
      if (!current?.durable) {
        unsaved('failed', false, full);
        return false;
      }
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const admitted = await current.admitPrivate({
          record: wire,
          origin,
          addedAt,
          full,
          thumbnail: small,
        });
        if (!listed()) return false;
        releasePrepared(admitted.preparedReleased);
        if (!admitted.persisted) {
          unsaved(
            admitted.reason ?? 'failed',
            admitted.reason !== 'deleted',
            full,
            small?.size ?? 0,
          );
          return false;
        }
        if (admitted.duplicate) {
          // Another tab stored this image first: adopt its identity, never
          // overwrite it, and attach our bytes to that row.
          const stored = await current.readPrivate(key).catch(() => null);
          if (!listed()) return false;
          const previous = addedAt;
          addedAt = admitted.addedAt;
          lastAddedAt.current = Math.max(lastAddedAt.current, addedAt);
          patch(key, previous, () => ({ addedAt, origin: admitted.origin }));
          if (stored?.full) break;
          continue;
        }
        break;
      }
      tick.current += 1;
      const storedTick = tick.current;
      patch(key, addedAt, (entry) => ({
        original: null,
        storedAtTick: storedTick,
        bytes: full.size + (small?.size ?? 0) + entry.preparedBytes,
        storage: { state: STORAGE_STATE.STORED },
      }));
      try {
        const adopted = await live.current.onStored?.({ key, addedAt });
        const visible = adopted?.accepted
          ? adopted.state?.rows?.some(
              (row) => row.key === key && row.addedAt === addedAt,
            )
          : false;
        if (live.current.boundedCreate && visible) {
          const currentEntry = live.current.entries.find((entry) =>
            sameAdd(entry, key, addedAt),
          );
          if (currentEntry?.storage.state === STORAGE_STATE.STORED)
            commit(
              live.current.entries.filter(
                (entry) => !sameAdd(entry, key, addedAt),
              ),
            );
        }
      } catch {
        // A failed catalog refresh keeps the stored row in the independent
        // pool. The next successful Create read can adopt it safely.
      }
      return true;
    },
    [commit, digest, fetchBlob, isListed, patch, releasePrepared, thumbnail],
  );

  /** Store held entries oldest first, one at a time; stop at the first refusal. */
  const promote = useCallback(async () => {
    if (promoting.current || !live.current.store?.durable) return;
    promoting.current = true;
    try {
      for (;;) {
        const next = live.current.entries
          .filter(
            (entry) =>
              entry.original &&
              entry.storage.state === STORAGE_STATE.NOT_STORED &&
              entry.storage.retryable,
          )
          .sort((a, b) => a.addedAt - b.addedAt)[0];
        if (!next || !alive.current) break;
        if (!(await persist(next))) break;
      }
    } finally {
      promoting.current = false;
    }
  }, [persist]);

  // Show what is stored. Nothing is ever dropped for a lowered limit: every
  // row is listed, and the limits only refuse NEW admission. Entries added
  // before the database answered stay; a generated entry stored without bytes
  // is tried once.
  useEffect(() => {
    if (!enabled || !store) return undefined;
    if (boundedLibrary || boundedCreate) {
      // The list remains the independent unsaved pool, never a catalog window.
      commit(live.current.entries.filter(occupiesSlot));
      setLoadedFor({ store, boundedLibrary, boundedCreate });
      return undefined;
    }
    let cancelled = false;
    (async () => {
      let stored = [];
      let unreadable = false;
      try {
        stored = await store.loadPrivate();
      } catch {
        unreadable = true;
      }
      if (cancelled) return;
      const memory = live.current.entries;
      const known = new Set(memory.map((entry) => entry.key));
      const hydrated = stored
        .filter((row) => !known.has(imageKey(row.record)))
        .map((row) => entryFromRow(row, urls));
      lastAddedAt.current = Math.max(
        lastAddedAt.current,
        ...hydrated.map((entry) => entry.addedAt),
      );
      commit([...memory, ...hydrated].sort((a, b) => b.addedAt - a.addedAt));
      setReadFailed(unreadable);
      setLoadedFor({ store, boundedLibrary, boundedCreate });
      for (const entry of hydrated)
        if (
          entry.origin === LOCAL_ORIGIN.GENERATED &&
          entry.storage.state === STORAGE_STATE.NOT_STORED &&
          entry.wire.image_url
        )
          persist(entry);
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, store, urls, commit, persist, boundedLibrary, boundedCreate]);

  /**
   * Reconcile with what other tabs committed: show new rows, drop only STORED
   * entries whose identity vanished (and that did not commit after this read
   * began), and adopt a stored copy of an image this tab only holds. Then try
   * to store what is held, since another tab may have freed room.
   */
  const sync = useCallback(async () => {
    const { store: current } = live.current;
    if (
      !current?.durable ||
      !alive.current ||
      !live.current.enabled ||
      live.current.boundedLibrary ||
      live.current.boundedCreate
    )
      return;
    const started = tick.current;
    let rows;
    try {
      rows = await current.loadPrivate();
    } catch {
      return;
    }
    if (
      !alive.current ||
      !live.current.enabled ||
      live.current.boundedLibrary ||
      live.current.boundedCreate ||
      live.current.store !== current
    )
      return;
    const byKey = new Map(rows.map((row) => [imageKey(row.record), row]));
    const kept = [];
    for (const entry of live.current.entries) {
      const row = byKey.get(entry.key);
      byKey.delete(entry.key);
      if (entry.storage.state === STORAGE_STATE.STORED) {
        if (row?.addedAt === entry.addedAt || entry.storedAtTick > started)
          kept.push(entry);
      } else if (row?.full && entry.storage.state !== STORAGE_STATE.SAVING) {
        kept.push(
          withView({
            ...entry,
            addedAt: row.addedAt,
            origin: row.origin,
            original: null,
            bytes: row.full.size + (row.thumbnail?.size ?? 0),
            storage: { state: STORAGE_STATE.STORED },
          }),
        );
      } else kept.push(entry);
    }
    const added = [...byKey.values()].map((row) => entryFromRow(row, urls));
    lastAddedAt.current = Math.max(
      lastAddedAt.current,
      ...added.map((entry) => entry.addedAt),
    );
    commit([...kept, ...added].sort((a, b) => b.addedAt - a.addedAt));
    promote();
  }, [commit, promote, urls]);

  useEffect(() => {
    if (!enabled || !store?.durable || boundedLibrary || boundedCreate)
      return undefined;
    const unsubscribe = store.onPrivateChange(sync);
    const onVisible = () => {
      if (document.visibilityState === 'visible') sync();
    };
    document.addEventListener(VISIBILITY_EVENT, onVisible);
    return () => {
      unsubscribe();
      document.removeEventListener(VISIBILITY_EVENT, onVisible);
    };
  }, [enabled, store, sync, boundedLibrary, boundedCreate]);

  // Release object URLs only after the list that dropped them has committed.
  const held = useRef(new Set());
  useEffect(() => {
    const now = new Set(entries.flatMap((entry) => entry.owned));
    for (const url of held.current) if (!now.has(url)) urls.release(url);
    held.current = now;
  }, [entries, urls]);
  useEffect(
    () => () => {
      for (const url of held.current) urls.release(url);
      held.current = new Set();
    },
    [urls],
  );

  // An original held only in this tab is lost when the tab closes. The browser
  // decides whether to show its own confirmation; a hidden or backgrounded tab
  // can still be discarded without any prompt.
  const guarded = entries.some(holdsBytes);
  useEffect(() => {
    if (!guarded) return undefined;
    const warn = (event) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [guarded]);

  /**
   * Why new private work must not start, or null. Checked before any provider
   * call. A free slot is reserved for the one result a tab can have in flight;
   * an import also needs its bytes to fit the pool because it has no server link.
   * A group of variations reserves one place per image before it is sent;
   * nothing held is ever evicted to make room.
   */
  const admissionBlock = useCallback((action, bytes = null, slots = 1) => {
    const { entries: list, limits: budget } = live.current;
    const used = poolUsage(list);
    const plan = planVolatileSlot(used, bytes, budget, slots);
    if (!plan.slot) {
      const free = budget.privateVolatileRecordLimit - used.slots;
      return slots > 1 && free > 0
        ? poolShortMessage(free, slots, action)
        : poolFullMessage(budget.privateVolatileRecordLimit, action);
    }
    if (bytes !== null && !plan.hold) return IMPORT_TOO_LARGE_MESSAGE;
    return null;
  }, []);

  /** Key of the oldest image that is not durably stored, or null. */
  const oldestUnsaved = useCallback(
    () =>
      live.current.entries
        .filter(occupiesSlot)
        .sort((a, b) => a.addedAt - b.addedAt)[0]?.key ?? null,
    [],
  );

  /**
   * Add an image and show it now. Returns its display view, or null when an
   * import has no safe place in the pool (nothing is added or changed).
   * A generated result is never refused here: an unexpected accepted result
   * is kept, at worst as a server link, without displacing any held original.
   * @param {object} record the wire snapshot, stored unchanged
   * @param {{origin: 'generated'|'imported', blob?: Blob, url?: string}} source
   *   an import brings its file and the preview URL that already shows it
   */
  const add = useCallback(
    (record, { origin, blob = null, url = null }) => {
      const key = imageKey(record);
      const existing = live.current.entries.find((entry) => entry.key === key);
      if (existing) return existing.view;
      const imported = origin === LOCAL_ORIGIN.IMPORTED;
      if (imported && (!blob || admissionBlock('importing', blob.size)))
        return null;
      lastAddedAt.current = Math.max(Date.now(), lastAddedAt.current + 1);
      const durable = Boolean(live.current.store?.durable);
      if (url) urls.retain(url);
      const entry = withView({
        key,
        addedAt: lastAddedAt.current,
        origin,
        wire: record,
        owned: url ? [url] : [],
        fullUrl: url,
        thumbUrl: null,
        watermark: null,
        preparedBytes: 0,
        original: imported ? blob : null,
        bytes: imported ? blob.size : 0,
        storedAtTick: 0,
        storage: durable || !imported ? storing : inMemory(true),
      });
      commit([entry, ...live.current.entries]);
      (async () => {
        // A generated result records its row first so a page that closes while
        // the original is fetched can recover it; an import commits row and
        // file together inside `persist`.
        if (durable && !imported) {
          const admitted = await live.current.store.admitPrivate({
            record,
            origin,
            addedAt: entry.addedAt,
          });
          if (!isListed(key, entry.addedAt)) return;
          releasePrepared(admitted.preparedReleased);
        }
        await persist(entry);
      })();
      return entry.view;
    },
    [admissionBlock, commit, isListed, persist, releasePrepared, urls],
  );

  /**
   * Remove one image from this browser only; the server is never contacted. A
   * durable store that cannot confirm the removal keeps the entry. A confirmed
   * removal frees its slot, so held entries are offered storage again.
   * @returns {Promise<string|null>} an error message, or null when removed
   */
  const remove = useCallback(
    async (record) => {
      const key = imageKey(record);
      const entry = live.current.entries.find((e) => e.key === key);
      if (!entry) return null;
      const outcome = await live.current.store.removePrivate(
        key,
        entry.addedAt,
        { requireIncarnation: entry.storage.state === STORAGE_STATE.STORED },
      );
      if (!outcome.removed)
        return (
          outcome.error?.message ??
          'The image could not be removed from this browser.'
        );
      commit(
        live.current.entries.filter((e) => !sameAdd(e, key, entry.addedAt)),
      );
      promote();
      return null;
    },
    [commit, promote],
  );

  /**
   * Try again to store an entry that is not stored: it uses the bytes held in
   * this tab, fetches a generated result again, and re-admits a missing row.
   */
  const retry = useCallback(
    (record) => {
      const entry = live.current.entries.find(
        (e) => e.key === imageKey(record),
      );
      if (
        entry?.storage.state === STORAGE_STATE.NOT_STORED &&
        entry.storage.retryable
      )
        persist(entry);
    },
    [persist],
  );

  // --- Watermark host for the private prepare service ----------------------

  const entryOf = (handle) =>
    live.current.entries.find((entry) =>
      sameAdd(entry, handle.key, handle.addedAt),
    );

  const watermarkHost = useMemo(() => {
    return {
      /** Identity token of the entry now showing `record`, or null. */
      handleFor(record) {
        const entry = live.current.entries.find(
          (e) => e.key === imageKey(record),
        );
        return entry
          ? {
              key: entry.key,
              addedAt: entry.addedAt,
              origin: entry.origin,
              watermark: entry.watermark,
            }
          : null;
      },
      isListed: (handle) => isListed(handle.key, handle.addedAt),
      current(handle) {
        const entry = entryOf(handle);
        return entry ? { watermark: entry.watermark, wire: entry.wire } : null;
      },
      /**
       * The original bytes. An import has only its local copy: its wire
       * `image_url` is never fetched. A fresh result may be fetched from the
       * server URL it arrived with, checked against its checksum.
       */
      async readOriginal(handle, { signal } = {}) {
        const entry = entryOf(handle);
        if (!entry) return null;
        if (entry.original) return entry.original;
        const { store: current } = live.current;
        if (current?.durable) {
          const stored = await current.readPrivateMedia(
            handle.key,
            { addedAt: handle.addedAt },
            VARIANT_KIND.FULL,
          );
          if (stored) return stored;
        }
        if (entry.origin !== LOCAL_ORIGIN.GENERATED || !entry.wire.image_url)
          return null;
        const fetched = await fetchBlob(entry.wire.image_url, { signal });
        const expected = entry.wire.sha256;
        if (typeof expected === 'string' && expected) {
          const actual = await digest(fetched).catch(() => null);
          if (actual !== null && actual !== expected.toLowerCase())
            throw new Error('The downloaded image did not match its checksum.');
        }
        return fetched;
      },
      async readPrepared(handle) {
        const entry = entryOf(handle);
        if (!preparedPipelineCurrent(entry?.watermark?.prepared)) return null;
        if (entry.preparedMemory) return entry.preparedMemory;
        const { store: current } = live.current;
        if (!current?.durable) return null;
        return current.readPrivateMedia(
          handle.key,
          { addedAt: handle.addedAt },
          PRIVATE_WATERMARKED_KIND,
        );
      },
      persistenceOf(handle) {
        const entry = entryOf(handle);
        if (!preparedPipelineCurrent(entry?.watermark?.prepared)) return null;
        return {
          state: entry.preparedMemory
            ? STORAGE_STATE.MEMORY
            : STORAGE_STATE.STORED,
        };
      },
      /** Keep a fresh analysis (and drop the prepared file it made stale). */
      async saveAnalysis(handle, state) {
        if (!isListed(handle.key, handle.addedAt)) return { listed: false };
        patch(handle.key, handle.addedAt, (entry) => ({
          watermark: state,
          preparedMemory: null,
          preparedBytes: 0,
          bytes: entry.bytes - entry.preparedBytes,
        }));
        const { store: current } = live.current;
        if (!current?.durable) return { state: STORAGE_STATE.MEMORY };
        const result = await current.savePrivateWatermark(
          handle.key,
          { addedAt: handle.addedAt },
          state,
        );
        if (!isListed(handle.key, handle.addedAt)) return { listed: false };
        return result.persisted
          ? { state: STORAGE_STATE.STORED }
          : preparedNotStored(result.reason ?? 'failed');
      },
      /** Keep the one prepared PNG; refuse it rather than prune other copies. */
      async savePrepared(handle, state, blob) {
        if (!isListed(handle.key, handle.addedAt)) return { listed: false };
        const { store: current, limits: budget } = live.current;
        const keep = (entry, extra) => ({
          watermark: extra ? state : { ...state, prepared: null },
          preparedMemory: extra === 'memory' ? blob : null,
          preparedBytes: extra ? blob.size : 0,
          bytes: entry.bytes - entry.preparedBytes + (extra ? blob.size : 0),
        });
        if (!current?.durable) {
          const total = live.current.entries.reduce(
            (sum, entry) => sum + entry.bytes,
            0,
          );
          const own = entryOf(handle)?.preparedBytes ?? 0;
          if (total - own + blob.size > budget.privateMaxBytes) {
            patch(handle.key, handle.addedAt, (entry) => keep(entry, null));
            return preparedNotStored('oversize');
          }
          patch(handle.key, handle.addedAt, (entry) => keep(entry, 'memory'));
          return { state: STORAGE_STATE.MEMORY };
        }
        const result = await current.savePrivatePrepared(
          handle.key,
          { addedAt: handle.addedAt },
          state,
          blob,
        );
        if (!isListed(handle.key, handle.addedAt)) return { listed: false };
        if (result.persisted) {
          patch(handle.key, handle.addedAt, (entry) => keep(entry, 'stored'));
          return { state: STORAGE_STATE.STORED };
        }
        patch(handle.key, handle.addedAt, (entry) => keep(entry, null));
        return preparedNotStored(result.reason ?? 'failed');
      },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [digest, fetchBlob, isListed, patch]);

  const items = useMemo(() => entries.map((entry) => entry.view), [entries]);
  const status = !enabled || !store ? 'idle' : loaded ? 'ready' : 'loading';
  const durable = Boolean(store?.durable);
  const unsaved = entries.filter(occupiesSlot);
  let notice = null;
  if (store && !durable) notice = VOLATILE_NOTICE;
  else if (readFailed) notice = READ_FAILED_NOTICE;
  else if (
    unsaved.some((entry) => entry.storage.state !== STORAGE_STATE.SAVING)
  )
    notice = unsaved.some((entry) => entry.original)
      ? PARTIAL_NOTICE
      : LINK_ONLY_NOTICE;
  return {
    items,
    // Library uses its separate metadata window; this list is only the pool.
    complete: !boundedLibrary && !boundedCreate,
    status,
    durable,
    notice,
    add,
    remove,
    retry,
    watermarkHost,
    /** Images not durably stored (each takes a slot of the pool). */
    unsavedCount: unsaved.length,
    admissionBlock,
    oldestUnsaved,
  };
}
