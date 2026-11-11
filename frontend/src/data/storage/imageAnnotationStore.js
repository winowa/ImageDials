/** Durable user annotations; cache trimming and image deletion never own these. */
import { STORE } from './cacheDb.js';
import {
  ANNOTATION_LIMITS,
  annotationKey,
  normalizeAnnotationIdentity,
} from '../records/imageAnnotations.js';

export const IMAGE_ANNOTATION_KEY = 'imageAnnotations.v1';
export const IMAGE_ANNOTATION_CHANNEL = 'imagedials-image-annotations';
const empty = () => ({ version: 1, sequence: 0, collections: [], images: [] });
const copy = (v) => JSON.parse(JSON.stringify(v));
const bytes = (v) => new TextEncoder().encode(JSON.stringify(v)).length;
const refused = (reason) => ({ persisted: false, reason });
const makeIdentity = () =>
  globalThis.crypto?.randomUUID?.() ??
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const normalizeName = (value) => {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    Array.from(value.trim()).length > ANNOTATION_LIMITS.name
  )
    throw new Error('Use a collection name of 1–60 characters.');
  return value.trim();
};
const folded = (name) => name.toLocaleLowerCase('en-US');
function normalize(value) {
  if (value === undefined) return empty();
  if (
    value?.version !== 1 ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 0 ||
    !Array.isArray(value.collections) ||
    !Array.isArray(value.images) ||
    value.collections.length > ANNOTATION_LIMITS.collections ||
    value.images.length > ANNOTATION_LIMITS.images ||
    bytes(value) > ANNOTATION_LIMITS.bytes
  )
    throw new Error('Stored image collections could not be read.');
  const ids = new Set(),
    names = new Set(),
    images = new Set();
  const validRevision = (r) =>
    Number.isSafeInteger(r) && r > 0 && r <= value.sequence;
  const collections = value.collections.map((row) => {
    const name = normalizeName(row.name);
    if (
      typeof row.id !== 'string' ||
      !row.id ||
      row.id.length > 120 ||
      ids.has(row.id) ||
      names.has(folded(name)) ||
      !validRevision(row.revision)
    )
      throw new Error('Stored image collections could not be read.');
    ids.add(row.id);
    names.add(folded(name));
    return { id: row.id, name, revision: row.revision };
  });
  const rows = value.images.map((row) => {
    const identity = normalizeAnnotationIdentity(row.identity),
      key = annotationKey(identity);
    if (
      images.has(key) ||
      typeof row.favorite !== 'boolean' ||
      !Array.isArray(row.collections) ||
      row.collections.length > ids.size ||
      new Set(row.collections).size !== row.collections.length ||
      row.collections.some((id) => !ids.has(id)) ||
      !validRevision(row.revision)
    )
      throw new Error('Stored image collections could not be read.');
    images.add(key);
    return {
      identity,
      favorite: row.favorite,
      collections: [...row.collections],
      revision: row.revision,
    };
  });
  return { version: 1, sequence: value.sequence, collections, images: rows };
}

export function createImageAnnotationStore(
  db,
  {
    makeId = makeIdentity,
    openChannel = () =>
      typeof BroadcastChannel === 'function'
        ? new BroadcastChannel(IMAGE_ANNOTATION_CHANNEL)
        : null,
  } = {},
) {
  const listeners = new Set();
  let channel = null;
  const durable = () => Boolean(db) && db.open !== false;
  const emit = () => {
    for (const fn of listeners) {
      try {
        fn();
      } catch {
        /* Already committed. */
      }
    }
  };
  const connect = () => {
    try {
      if (!channel) {
        channel = openChannel();
        if (channel) channel.onmessage = emit;
      }
    } catch {
      channel = null;
    }
    return channel;
  };
  const announce = () => {
    emit();
    try {
      connect()?.postMessage({ type: 'changed' });
    } catch {
      /* Optional cross-tab channel. */
    } finally {
      if (!listeners.size) {
        channel?.close();
        channel = null;
      }
    }
  };
  const read = async (access) =>
    normalize(await access.get(STORE.SETTINGS, IMAGE_ANNOTATION_KEY));
  const change = async (operation) => {
    if (!durable()) return refused('no-storage');
    try {
      const result = await db.run(
        [STORE.SETTINGS],
        'readwrite',
        async (access) => {
          const state = await read(access);
          if (state.sequence === Number.MAX_SAFE_INTEGER)
            return refused('failed');
          const result = operation(state);
          if (!result.persisted) return result;
          if (state.images.length > ANNOTATION_LIMITS.images)
            return refused('record-limit');
          if (bytes(state) > ANNOTATION_LIMITS.bytes)
            return refused('byte-limit');
          normalize(state);
          await access.put(STORE.SETTINGS, IMAGE_ANNOTATION_KEY, state);
          return result;
        },
      );
      if (result.persisted) announce();
      return result;
    } catch (error) {
      return refused(error?.name === 'QuotaExceededError' ? 'quota' : 'failed');
    }
  };
  const imageChange = async (raw, operation) => {
    let identity;
    try {
      identity = normalizeAnnotationIdentity(raw);
    } catch {
      return refused('invalid');
    }
    return change((state) => {
      const key = annotationKey(identity);
      let row = state.images.find(
        (item) => annotationKey(item.identity) === key,
      );
      const fresh = !row;
      if (!row)
        row = {
          identity,
          favorite: false,
          collections: [],
          revision: state.sequence + 1,
        };
      const reason = operation(row, state);
      if (reason) return refused(reason);
      state.sequence += 1;
      row.revision = state.sequence;
      if (!row.favorite && !row.collections.length)
        state.images = state.images.filter(
          (item) => annotationKey(item.identity) !== key,
        );
      else if (fresh) state.images.push(row);
      return { persisted: true, entry: copy(row) };
    });
  };
  return {
    get durable() {
      return durable();
    },
    async list() {
      if (!durable()) return { ...empty(), durable: false };
      const state = await db.run([STORE.SETTINGS], 'readonly', read);
      return {
        ...copy(state),
        durable: true,
        usage: {
          images: state.images.length,
          collections: state.collections.length,
          bytes: bytes(state),
          maxImages: ANNOTATION_LIMITS.images,
          maxCollections: ANNOTATION_LIMITS.collections,
          maxBytes: ANNOTATION_LIMITS.bytes,
        },
      };
    },
    async createCollection(raw) {
      let name;
      try {
        name = normalizeName(raw);
      } catch {
        return refused('invalid');
      }
      return change((state) => {
        if (state.collections.some((c) => folded(c.name) === folded(name)))
          return refused('duplicate-name');
        if (state.collections.length >= ANNOTATION_LIMITS.collections)
          return refused('collection-limit');
        const entry = { id: makeId(), name, revision: ++state.sequence };
        state.collections.push(entry);
        return { persisted: true, entry: copy(entry) };
      });
    },
    async renameCollection(id, raw, { revision } = {}) {
      let name;
      try {
        name = normalizeName(raw);
      } catch {
        return refused('invalid');
      }
      return change((state) => {
        const row = state.collections.find((c) => c.id === id);
        if (!row || row.revision !== revision) return refused('changed');
        if (
          state.collections.some(
            (c) => c.id !== id && folded(c.name) === folded(name),
          )
        )
          return refused('duplicate-name');
        row.name = name;
        row.revision = ++state.sequence;
        return { persisted: true, entry: copy(row) };
      });
    },
    async removeCollection(id, { revision } = {}) {
      return change((state) => {
        const row = state.collections.find((c) => c.id === id);
        if (!row || row.revision !== revision) return refused('changed');
        state.sequence += 1;
        state.collections = state.collections.filter((c) => c.id !== id);
        for (const image of state.images)
          if (image.collections.includes(id)) {
            image.collections = image.collections.filter((c) => c !== id);
            image.revision = state.sequence;
          }
        state.images = state.images.filter(
          (image) => image.favorite || image.collections.length,
        );
        return { persisted: true };
      });
    },
    setFavorite(identity, value) {
      if (typeof value !== 'boolean')
        return Promise.resolve(refused('invalid'));
      return imageChange(identity, (row) => {
        row.favorite = value;
      });
    },
    setMembership(identity, collectionId, value) {
      if (typeof value !== 'boolean')
        return Promise.resolve(refused('invalid'));
      return imageChange(identity, (row, state) => {
        if (!state.collections.some((c) => c.id === collectionId))
          return 'changed';
        row.collections = row.collections.filter((id) => id !== collectionId);
        if (value) row.collections.push(collectionId);
      });
    },
    subscribe(fn) {
      listeners.add(fn);
      connect();
      return () => {
        listeners.delete(fn);
        if (!listeners.size) {
          channel?.close();
          channel = null;
        }
      };
    },
  };
}
