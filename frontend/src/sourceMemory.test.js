import { expect, test } from 'vitest';
import { SOURCE_MEMORY_MAX_BYTES, trimSourceMemory } from './useReferences.js';

test('recovery aliases count exact blobs once and evict oldest detached sources', () => {
  const store = new Map();
  const sources = Array.from({ length: 9 }, () => ({
    blob: { size: SOURCE_MEMORY_MAX_BYTES / 8 },
  }));
  sources.forEach((source, index) => {
    store.set(`id-${index}`, source);
    store.set(`hash-${index}`, source);
  });
  trimSourceMemory(store, []);
  expect(store.has('id-0')).toBe(false);
  expect(store.has('hash-0')).toBe(false);
  expect(store.size).toBe(16);
  expect(store.get('hash-8')).toBe(sources[8]);
});

test('attached model bytes and original bytes stay protected until detached', () => {
  const original = { size: SOURCE_MEMORY_MAX_BYTES };
  const attached = { blob: { size: 1024 }, original: { blob: original } };
  const detached = { blob: { size: 1024 } };
  const store = new Map([
    ['attached', attached],
    ['original', { blob: original }],
    ['detached', detached],
  ]);
  trimSourceMemory(store, [attached]);
  expect(store.get('attached')).toBe(attached);
  expect(store.get('original').blob).toBe(original);
  expect(store.has('detached')).toBe(false);
  trimSourceMemory(store, []);
  expect(store.has('attached')).toBe(false);
  expect(store.get('original').blob).toBe(original);
});
