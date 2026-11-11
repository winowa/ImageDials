/**
 * The current draft's references, kept in this browser across reloads.
 *
 * Separate from explicitly kept originals (`referenceAssets.js`): clearing the
 * draft never touches a kept copy, and keeping a file never depends on this.
 * Rows live in the cache database's `settings` store under one namespace:
 *
 *   draftReferences.state         {version, epoch, media, manifest}
 *   draftReferences.media.<sha>   Blob (model copy or original, by checksum)
 *
 * - Every save and clear is one transaction: the manifest and the blobs it
 *   names commit together, and blobs no longer named are deleted with it.
 * - `clear()` advances the epoch in the same transaction that deletes, and a
 *   save carries the epoch it was planned under; a save planned before a
 *   clear is refused, so a late write cannot bring cleared files back.
 * - A byte budget bounds the stored set. Model copies are stored first, in
 *   order; originals of prepared copies only while room remains.
 * - A quota failure falls back to the manifest plus blobs already stored, so
 *   a reload restores the live order with honest "attach again" slots rather
 *   than an earlier set.
 * - Nothing here uploads, describes or proposes.
 */
import { STORE } from './cacheDb.js';
import { sha256Hex } from '../media/privateThumbnail.js';
import { preserveError } from '../../shared/diagnostics/diagnostics.js';

export const DRAFT_REFERENCE_STATE_KEY = 'draftReferences.state';
export const DRAFT_REFERENCE_MEDIA_PREFIX = 'draftReferences.media.';
export const DRAFT_REFERENCE_VERSION = 1;
export const DRAFT_REFERENCE_MAX_BYTES = 256 * 1024 * 1024;
export const DRAFT_REFERENCE_REASON = Object.freeze({
  NO_STORAGE: 'no-storage',
  CHANGED: 'changed',
  QUOTA: 'quota',
  FAILED: 'failed',
});

const HASH = /^[a-f0-9]{64}$/;
const TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const TABLES = [STORE.SETTINGS];
const mediaKey = (sha) => `${DRAFT_REFERENCE_MEDIA_PREFIX}${sha}`;
const isQuota = (error) => error?.name === 'QuotaExceededError';
const dims = (value) =>
  Number.isSafeInteger(value?.width) &&
  value.width > 0 &&
  Number.isSafeInteger(value?.height) &&
  value.height > 0
    ? { width: value.width, height: value.height }
    : null;
const usableBlob = (blob) =>
  Boolean(blob?.size) && Number.isSafeInteger(blob.size);
const text = (value, limit = 8192) =>
  typeof value === 'string' ? value.slice(0, limit) : '';

/** Plain, structured-clone-safe metadata for one reference. */
function describe(ref) {
  const sha256 = HASH.test(ref?.sha256 ?? '') ? ref.sha256 : null;
  const source =
    ref?.source && HASH.test(ref.source.sha256 ?? '') && dims(ref.source)
      ? {
          sha256: ref.source.sha256,
          ...dims(ref.source),
          ...(Number.isSafeInteger(ref.source.max_normalized_bytes)
            ? { max_normalized_bytes: ref.source.max_normalized_bytes }
            : {}),
        }
      : null;
  return {
    id: String(ref.id),
    name: text(ref.name, 255) || 'reference',
    sha256,
    mediaId: sha256 ?? `pending:${String(ref.id)}`,
    description: text(ref.description),
    ...(typeof ref.role === 'string' ? { role: ref.role } : {}),
    dimensions: dims(ref.dimensions),
    prepared: Boolean(ref.prepared),
    ...(source ? { source } : {}),
    analysisError: text(ref.analysisError, 1024) || null,
    type: TYPES.has(ref?.blob?.type ?? ref?.type)
      ? (ref.blob?.type ?? ref.type)
      : null,
    bytes: usableBlob(ref?.blob) ? ref.blob.size : (ref.bytes ?? ref.size ?? 0),
    original:
      source && ref.original
        ? {
            sha256: source.sha256,
            type: TYPES.has(ref.original.blob?.type ?? ref.original.type)
              ? (ref.original.blob?.type ?? ref.original.type)
              : null,
            bytes: ref.original.blob?.size ?? ref.original.bytes ?? 0,
          }
        : null,
  };
}

/**
 * Plan which blobs a snapshot stores within `maxBytes`: every model copy in
 * order (attached first, then parked), then originals while room remains.
 * Pure; exported for tests.
 * @returns {{media: Map<string, Blob>, attached: object[], parked: object[]|null, omitted: number, originalsOmitted: number}}
 */
export function planDraftSnapshot({ attached = [], parked = null }, maxBytes) {
  const media = new Map();
  let bytes = 0;
  let omitted = 0;
  let originalsOmitted = 0;
  const admit = (sha, blob) => {
    if (media.has(sha)) return true;
    if (bytes + blob.size > maxBytes) return false;
    media.set(sha, blob);
    bytes += blob.size;
    return true;
  };
  const rows = (list, sources = null) =>
    list.map((descriptor) => {
      const ref = { ...descriptor, ...sources?.get(descriptor.id) };
      const row = describe(ref);
      row.stored = false;
      if (row.type && usableBlob(ref.blob)) {
        row.stored = admit(row.mediaId, ref.blob);
        if (!row.stored) omitted += 1;
      } else omitted += 1;
      return { row, ref };
    });
  const live = rows(attached);
  const held = parked ? rows(parked.refs ?? [], parked.sources) : null;
  for (const { row, ref } of [...live, ...(held ?? [])]) {
    if (!row.original) continue;
    row.original.stored =
      Boolean(row.original.type) &&
      usableBlob(ref.original.blob) &&
      admit(row.original.sha256, ref.original.blob);
    if (!row.original.stored) originalsOmitted += 1;
  }
  return {
    media,
    bytes,
    attached: live.map(({ row }) => row),
    parked: held ? held.map(({ row }) => row) : null,
    omitted,
    originalsOmitted,
  };
}

/**
 * @param {object|null} db the cache database (`cacheDb.js`), or null
 * @param {{maxBytes?: number}} [options]
 */
export function createDraftReferenceStore(
  db,
  { maxBytes = DRAFT_REFERENCE_MAX_BYTES } = {},
) {
  const durable = () => Boolean(db) && db.open !== false;
  const readState = (access) =>
    access.get(STORE.SETTINGS, DRAFT_REFERENCE_STATE_KEY);
  const blank = (epoch) => ({
    version: DRAFT_REFERENCE_VERSION,
    epoch,
    media: [],
    manifest: null,
  });

  /** Write `plan` under `epoch`; `existingOnly` stores no new blobs. */
  const write = (plan, epoch, { existingOnly = false } = {}) =>
    db.run(TABLES, 'readwrite', async (access) => {
      const state = (await readState(access)) ?? blank(0);
      if (state.epoch !== epoch)
        return {
          persisted: false,
          reason: DRAFT_REFERENCE_REASON.CHANGED,
          epoch: state.epoch,
        };
      const kept = new Set();
      for (const [sha, blob] of plan.media) {
        const key = mediaKey(sha);
        const present = await access.has(STORE.SETTINGS, key);
        if (!present && existingOnly) continue;
        if (!present) await access.put(STORE.SETTINGS, key, blob);
        kept.add(sha);
      }
      const mark = (row) => ({
        ...row,
        stored: row.stored && kept.has(row.mediaId ?? row.sha256),
        original: row.original
          ? {
              ...row.original,
              stored: row.original.stored && kept.has(row.original.sha256),
            }
          : null,
      });
      const attached = plan.attached.map(mark);
      const parked = plan.parked ? plan.parked.map(mark) : null;
      for (const sha of state.media ?? [])
        if (!kept.has(sha)) await access.delete(STORE.SETTINGS, mediaKey(sha));
      const empty = !attached.length && !parked?.length;
      await access.put(STORE.SETTINGS, DRAFT_REFERENCE_STATE_KEY, {
        version: DRAFT_REFERENCE_VERSION,
        epoch,
        media: [...kept],
        manifest: empty ? null : { attached, parked },
      });
      const all = [...attached, ...(parked ?? [])];
      return {
        persisted: true,
        epoch,
        omitted: all.filter((row) => !row.stored).length,
        originalsOmitted: all.filter(
          (row) => row.original && !row.original.stored,
        ).length,
      };
    });

  return {
    get durable() {
      return durable();
    },

    /**
     * The stored draft: `{epoch, attached, parked}` with a Blob (or null) on
     * every row and its original, or `{epoch, attached: [], parked: null}`.
     * Rejects when storage cannot be read.
     */
    async load() {
      if (!durable()) return null;
      return db.run(TABLES, 'readonly', async (access) => {
        const state = await readState(access);
        if (!state || state.version !== DRAFT_REFERENCE_VERSION)
          return { epoch: state?.epoch ?? 0, attached: [], parked: null };
        const read = async (row) => {
          const blob = row.stored
            ? ((await access.get(
                STORE.SETTINGS,
                mediaKey(row.mediaId ?? row.sha256),
              )) ?? null)
            : null;
          const original = row.original?.stored
            ? ((await access.get(
                STORE.SETTINGS,
                mediaKey(row.original.sha256),
              )) ?? null)
            : null;
          return {
            ...row,
            blob: blob?.size === row.bytes ? blob : null,
            original: row.original
              ? {
                  ...row.original,
                  blob: original?.size === row.original.bytes ? original : null,
                }
              : null,
          };
        };
        const manifest = state.manifest;
        const attached = [];
        for (const row of manifest?.attached ?? [])
          attached.push(await read(row));
        let parked = null;
        if (manifest?.parked) {
          parked = [];
          for (const row of manifest.parked) parked.push(await read(row));
        }
        return { epoch: state.epoch, attached, parked };
      });
    },

    /**
     * Store `{attached, parked}` (live reference objects) under `epoch`.
     * @returns {Promise<{persisted: true, epoch: number, omitted: number,
     *   originalsOmitted: number, fallback?: boolean}|{persisted: false,
     *   reason: string, epoch?: number}>}
     */
    async save(snapshot, epoch) {
      if (!durable())
        return { persisted: false, reason: DRAFT_REFERENCE_REASON.NO_STORAGE };
      // Persist files even while adaptation/analysis is in flight. Hashing
      // exact bytes here never calls an analysis or inference endpoint.
      const identify = async (ref) => ({
        ...ref,
        sha256: ref.sha256 ?? (ref.blob ? await sha256Hex(ref.blob) : null),
      });
      let identified;
      try {
        const attached = await Promise.all(
          (snapshot.attached ?? []).map(identify),
        );
        const parked = snapshot.parked
          ? {
              ...snapshot.parked,
              refs: await Promise.all(
                (snapshot.parked.refs ?? []).map((ref) =>
                  identify({ ...ref, ...snapshot.parked.sources?.get(ref.id) }),
                ),
              ),
              sources: null,
            }
          : null;
        identified = { attached, parked };
      } catch (error) {
        return {
          persisted: false,
          reason: DRAFT_REFERENCE_REASON.FAILED,
          error: preserveError(error),
        };
      }
      const plan = planDraftSnapshot(identified, maxBytes);
      try {
        return await write(plan, epoch);
      } catch (error) {
        if (!isQuota(error))
          return {
            persisted: false,
            reason: DRAFT_REFERENCE_REASON.FAILED,
            error: preserveError(error),
          };
      }
      try {
        const result = await write(plan, epoch, { existingOnly: true });
        return result.persisted
          ? { ...result, fallback: true, reason: DRAFT_REFERENCE_REASON.QUOTA }
          : result;
      } catch (error) {
        return {
          persisted: false,
          reason: DRAFT_REFERENCE_REASON.QUOTA,
          error: preserveError(error),
        };
      }
    },

    /**
     * Delete every stored draft reference and advance the epoch, in one
     * transaction. Never touches kept originals.
     * @returns {Promise<{cleared: true, epoch: number}|{cleared: false, reason: string}>}
     */
    async clear() {
      if (!durable())
        return { cleared: false, reason: DRAFT_REFERENCE_REASON.NO_STORAGE };
      try {
        return await db.run(TABLES, 'readwrite', async (access) => {
          const state = (await readState(access)) ?? blank(0);
          for (const sha of state.media ?? [])
            await access.delete(STORE.SETTINGS, mediaKey(sha));
          const epoch =
            (Number.isSafeInteger(state.epoch) ? state.epoch : 0) + 1;
          await access.put(
            STORE.SETTINGS,
            DRAFT_REFERENCE_STATE_KEY,
            blank(epoch),
          );
          return { cleared: true, epoch };
        });
      } catch (error) {
        return {
          cleared: false,
          error: preserveError(error),
          reason: isQuota(error)
            ? DRAFT_REFERENCE_REASON.QUOTA
            : DRAFT_REFERENCE_REASON.FAILED,
        };
      }
    },
  };
}
