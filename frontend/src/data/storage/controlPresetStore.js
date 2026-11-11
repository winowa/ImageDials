/** Explicit user presets in the settings store, separate from cache eviction. */
import { STORE } from './cacheDb.js';
import {
  normalizePreset,
  PRESET_LIMITS,
} from '../../features/controls/presets/controlPresets.js';

export const CONTROL_PRESET_KEY = 'controlPresets.v1';
export const CONTROL_PRESET_CHANNEL = 'imagedials-control-presets';
const empty = () => ({ version: 1, sequence: 0, items: [] });
const copy = (value) => JSON.parse(JSON.stringify(value));
const encodedBytes = (value) =>
  new TextEncoder().encode(JSON.stringify(value)).length;
const identity = () =>
  globalThis.crypto?.randomUUID?.() ??
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const refused = (reason) => ({ persisted: false, reason });

function validateState(value) {
  if (value === undefined) return empty();
  if (
    value?.version !== 1 ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 0 ||
    !Array.isArray(value.items) ||
    value.items.length > PRESET_LIMITS.count ||
    encodedBytes(value) > PRESET_LIMITS.bytes
  )
    throw new Error('Stored presets could not be read.');
  const ids = new Set();
  const names = new Set();
  const items = value.items.map((row) => {
    const preset = normalizePreset(row);
    const name = `${preset.mode}:${preset.name.toLocaleLowerCase('en-US')}`;
    if (
      typeof row.id !== 'string' ||
      !row.id ||
      row.id.length > 120 ||
      ids.has(row.id) ||
      names.has(name) ||
      !Number.isSafeInteger(row.revision) ||
      row.revision < 1 ||
      row.revision > value.sequence ||
      !Number.isFinite(row.createdAt) ||
      !Number.isFinite(row.updatedAt)
    )
      throw new Error('Stored presets could not be read.');
    ids.add(row.id);
    names.add(name);
    return {
      ...preset,
      id: row.id,
      revision: row.revision,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  });
  return { version: 1, sequence: value.sequence, items };
}

export function createControlPresetStore(
  db,
  {
    clock = () => Date.now(),
    makeId = identity,
    openChannel = () =>
      typeof BroadcastChannel === 'function'
        ? new BroadcastChannel(CONTROL_PRESET_CHANNEL)
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
        /* Committed already. */
      }
    }
  };
  const connect = () => {
    if (!channel) {
      try {
        channel = openChannel();
        if (channel) channel.onmessage = emit;
      } catch {
        channel = null;
      }
    }
    return channel;
  };
  const announce = () => {
    emit();
    try {
      connect()?.postMessage({ type: 'changed' });
    } catch {
      /* Optional. */
    } finally {
      if (!listeners.size) {
        channel?.close();
        channel = null;
      }
    }
  };
  const read = async (access) =>
    validateState(await access.get(STORE.SETTINGS, CONTROL_PRESET_KEY));
  const write = async (change) => {
    if (!durable()) return refused('no-storage');
    try {
      const result = await db.run(
        [STORE.SETTINGS],
        'readwrite',
        async (access) => {
          const state = await read(access);
          const outcome = change(state);
          if (!outcome.persisted) return outcome;
          if (encodedBytes(state) > PRESET_LIMITS.bytes)
            return refused('byte-limit');
          validateState(state);
          await access.put(STORE.SETTINGS, CONTROL_PRESET_KEY, state);
          return outcome;
        },
      );
      if (result.persisted) announce();
      return result;
    } catch (error) {
      return refused(error?.name === 'QuotaExceededError' ? 'quota' : 'failed');
    }
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
          count: state.items.length,
          bytes: encodedBytes(state),
          maxCount: PRESET_LIMITS.count,
          maxBytes: PRESET_LIMITS.bytes,
        },
      };
    },
    async save(input, { id = null, revision = null } = {}) {
      let preset;
      try {
        preset = normalizePreset(input);
      } catch {
        return refused('invalid');
      }
      return write((state) => {
        const at = id === null ? -1 : state.items.findIndex((p) => p.id === id);
        if (id !== null && (at < 0 || state.items[at].revision !== revision))
          return refused('changed');
        if (
          state.items.some(
            (p, index) =>
              index !== at &&
              p.mode === preset.mode &&
              p.name.toLocaleLowerCase('en-US') ===
                preset.name.toLocaleLowerCase('en-US'),
          )
        )
          return refused('duplicate-name');
        if (at < 0 && state.items.length >= PRESET_LIMITS.count)
          return refused('record-limit');
        const now = clock();
        const entry = {
          ...preset,
          id: id ?? makeId(),
          revision: state.sequence + 1,
          createdAt: at < 0 ? now : state.items[at].createdAt,
          updatedAt: now,
        };
        if (
          !entry.id ||
          state.items.some((p, index) => index !== at && p.id === entry.id)
        )
          return refused('invalid');
        state.sequence += 1;
        if (at < 0) state.items.push(entry);
        else state.items[at] = entry;
        return { persisted: true, entry: copy(entry) };
      });
    },
    async remove(id, { revision } = {}) {
      return write((state) => {
        const at = state.items.findIndex((p) => p.id === id);
        if (at < 0 || state.items[at].revision !== revision)
          return refused('changed');
        state.items.splice(at, 1);
        state.sequence += 1;
        return { persisted: true };
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
