/** Exact image identities for browser-private favorites and collections. */
import { imageKey, isLocalOnly } from './imageRecord.js';

export const ANNOTATION_LIMITS = Object.freeze({
  images: 2048,
  collections: 32,
  name: 60,
  bytes: 512 * 1024,
});
const string = (value) =>
  typeof value === 'string' && value.length > 0 && value.length <= 512;

/** No title/prompt matching: local identities include their exact incarnation. */
export function normalizeAnnotationIdentity(value) {
  if (!value || !string(value.key))
    throw new Error('This image has no saved identity.');
  if (value.source === 'private' && Number.isFinite(value.addedAt))
    return { source: 'private', key: value.key, addedAt: value.addedAt };
  if (value.source === 'shared' && string(value.imageId))
    return { source: 'shared', key: value.key, imageId: value.imageId };
  throw new Error('This image has no saved identity.');
}

export function annotationIdentity(record) {
  if (!record || record.provisional || record.client_pending)
    throw new Error('Choose a saved image first.');
  const key = imageKey(record);
  if (key === 'undefined' || key === 'null')
    throw new Error('This image has no saved identity.');
  return normalizeAnnotationIdentity(
    isLocalOnly(record)
      ? { source: 'private', key, addedAt: record.local_added_at }
      : { source: 'shared', key, imageId: record.image_id ?? record.id },
  );
}

export const annotationKey = (identity) => {
  const value = normalizeAnnotationIdentity(identity);
  return JSON.stringify(
    value.source === 'private'
      ? [value.source, value.key, value.addedAt]
      : [value.source, value.key, value.imageId],
  );
};

/** This is the whole stored membership, never just a cached Library page. */
export function annotationMembers(
  state,
  { favorite = false, collectionId = null } = {},
) {
  return state.images
    .filter(
      (item) =>
        (!favorite || item.favorite) &&
        (collectionId === null || item.collections.includes(collectionId)),
    )
    .map((item) => ({ ...item.identity }));
}
