import { expect, test } from 'vitest';
import {
  annotationIdentity,
  annotationKey,
  annotationMembers,
  normalizeAnnotationIdentity,
} from './imageAnnotations.js';

test('shared list and detail records use exact storage identity despite different record aliases', () => {
  const base = { storage_id: 'local', filename: 'one.png', id: 'saved' };
  const summary = annotationIdentity(base);
  const detail = annotationIdentity({
    ...base,
    id: 'alias',
    image_id: 'saved',
  });
  expect(annotationKey(summary)).toBe(annotationKey(detail));
  expect(detail).toEqual({
    source: 'shared',
    key: 'local/one.png',
    imageId: 'saved',
  });
});

test('private replacement never inherits annotations for the old incarnation', () => {
  const row = { id: 'local', local_origin: 'imported', local_added_at: 1 };
  expect(annotationKey(annotationIdentity(row))).not.toBe(
    annotationKey(annotationIdentity({ ...row, local_added_at: 2 })),
  );
});

test('a different shared image at the same storage path has a different identity', () => {
  const record = { storage_id: 'local', filename: 'one.png', image_id: 'old' };
  expect(annotationKey(annotationIdentity(record))).not.toBe(
    annotationKey(annotationIdentity({ ...record, image_id: 'replacement' })),
  );
});

test('pending jobs and private rows without an incarnation are not saved-image identities', () => {
  expect(() => annotationIdentity({ id: 'job', client_pending: {} })).toThrow();
  expect(() =>
    annotationIdentity({ id: 'local', local_origin: 'imported' }),
  ).toThrow();
  expect(() => annotationIdentity({})).toThrow();
});

test('identity allowlist excludes prompt, wire URLs and arbitrary fields', () => {
  expect(
    normalizeAnnotationIdentity({
      source: 'shared',
      key: 'store/file',
      imageId: 'id',
      prompt: 'not kept',
      image_url: 'not kept',
    }),
  ).toEqual({ source: 'shared', key: 'store/file', imageId: 'id' });
});

test('membership filtering works over complete stored membership without needing any image page', () => {
  const a = { source: 'shared', key: 'a', imageId: 'a' },
    b = { source: 'private', key: 'b', addedAt: 1 };
  const state = {
    images: [
      { identity: a, favorite: true, collections: ['c'] },
      { identity: b, favorite: false, collections: ['c'] },
    ],
  };
  expect(annotationMembers(state, { favorite: true })).toEqual([a]);
  expect(annotationMembers(state, { collectionId: 'c' })).toEqual([a, b]);
  expect(
    annotationMembers(state, { favorite: true, collectionId: 'missing' }),
  ).toEqual([]);
});
