/**
 * Exact reads of the images a favorite or collection filter names. Every
 * stored member is read by its own identity: shared images through the exact
 * `/record` reader (key AND image id must match), browser-private images by
 * key AND the incarnation they were marked in. Nothing is matched by title or
 * prompt, and a member that cannot be read stays unavailable; it is never
 * dropped or rebuilt from another record.
 */
import { SOURCE } from '../../data/storage/cachePolicy.js';
import { annotationKey } from '../../data/records/imageAnnotations.js';
import { imageKey, LOCAL_ORIGIN } from '../../data/records/imageRecord.js';
import { privateLibraryView } from '../../data/storage/privateLibrary.js';

/** Bounded parallel metadata reads; original bytes are never read here. */
export const MEMBERSHIP_CONCURRENCY = 4;

export const MEMBER = Object.freeze({
  READY: 'ready',
  /** Deleted or removed from this browser. */
  MISSING: 'missing',
  /** The same path now holds a different image. */
  REPLACED: 'replaced',
  /** Kept by the other library source; not shown in this one. */
  ELSEWHERE: 'elsewhere',
  /** Not read (network, storage or unreadable answer); can be retried. */
  ERROR: 'error',
});

const abortError = () => new DOMException('Aborted', 'AbortError');
const isAbort = (error) => error?.name === 'AbortError';

/**
 * The minimal summary the exact shared reader accepts for a stored identity:
 * its storage key splits at the last slash (a storage id may itself contain
 * slashes; a file name cannot). Null when no summary can reproduce the key.
 */
export function sharedSummary(identity) {
  const { key, imageId } = identity;
  const at = key.lastIndexOf('/');
  const summary =
    at > 0 && at < key.length - 1
      ? {
          id: imageId,
          image_id: imageId,
          storage_id: key.slice(0, at),
          filename: key.slice(at + 1),
        }
      : { id: imageId, image_id: imageId };
  return imageKey(summary) === key ? summary : null;
}

/**
 * One member's exact record, or why it cannot be shown in `source`.
 * Rejects only with an AbortError.
 */
export async function readMember(
  identity,
  { source, loadShared, readPrivate, signal } = {},
) {
  if (signal?.aborted) throw abortError();
  if (identity.source === 'shared') {
    if (source !== SOURCE.SHARED || typeof loadShared !== 'function')
      return { status: MEMBER.ELSEWHERE };
    const summary = sharedSummary(identity);
    if (!summary)
      return {
        status: MEMBER.ERROR,
        error: new Error('This saved image identity cannot be read.'),
      };
    let record;
    try {
      record = await loadShared(summary, { signal });
    } catch (error) {
      if (isAbort(error) || signal?.aborted) throw abortError();
      if (error?.status === 404 || error?.status === 410)
        return { status: MEMBER.MISSING };
      return { status: MEMBER.ERROR, error };
    }
    if (signal?.aborted) throw abortError();
    // The reader checks the key; the image id is the other half of the identity.
    if (
      !record ||
      imageKey(record) !== identity.key ||
      (record.image_id ?? record.id) !== identity.imageId
    )
      return { status: MEMBER.REPLACED };
    return { status: MEMBER.READY, record };
  }
  if (typeof readPrivate !== 'function')
    return {
      status: MEMBER.ERROR,
      error: new Error('Browser storage is unavailable.'),
    };
  let row;
  try {
    row = await readPrivate(identity.key);
  } catch (error) {
    if (signal?.aborted) throw abortError();
    return { status: MEMBER.ERROR, error };
  }
  if (signal?.aborted) throw abortError();
  if (!row) return { status: MEMBER.MISSING };
  if (row.addedAt !== identity.addedAt) return { status: MEMBER.REPLACED };
  // The shared Library lists browser imports beside the server's images, not
  // images generated while the browser kept its own history.
  if (source === SOURCE.SHARED && row.origin !== LOCAL_ORIGIN.IMPORTED)
    return { status: MEMBER.ELSEWHERE };
  if (source !== SOURCE.SHARED && source !== SOURCE.PRIVATE)
    return { status: MEMBER.ELSEWHERE };
  return { status: MEMBER.READY, record: privateLibraryView(row) };
}

/**
 * Read `identities` in order with at most `concurrency` reads in flight.
 * `onResult(identity, outcome)` hears each answer until `signal` aborts;
 * nothing is reported after that.
 */
export async function readMembers(
  identities,
  { concurrency = MEMBERSHIP_CONCURRENCY, signal, onResult, ...options } = {},
) {
  let next = 0;
  const worker = async () => {
    while (!signal?.aborted && next < identities.length) {
      const identity = identities[next];
      next += 1;
      let outcome;
      try {
        outcome = await readMember(identity, { ...options, signal });
      } catch (error) {
        if (signal?.aborted || isAbort(error)) return;
        outcome = { status: MEMBER.ERROR, error };
      }
      if (signal?.aborted) return;
      onResult?.(identity, outcome);
    }
  };
  const lanes = Math.max(1, Math.min(concurrency, identities.length));
  await Promise.all(Array.from({ length: lanes }, worker));
}

/** Counts that keep stored membership distinct from what can be shown. */
export function membershipCounts(members, outcomes) {
  const counts = {
    members: members.length,
    ready: 0,
    unavailable: 0,
    elsewhere: 0,
    errors: 0,
    pending: 0,
  };
  for (const identity of members) {
    const outcome = outcomes.get(annotationKey(identity));
    if (!outcome) counts.pending += 1;
    else if (outcome.status === MEMBER.READY) counts.ready += 1;
    else if (outcome.status === MEMBER.ELSEWHERE) counts.elsewhere += 1;
    else if (outcome.status === MEMBER.ERROR) counts.errors += 1;
    else counts.unavailable += 1;
  }
  return counts;
}
