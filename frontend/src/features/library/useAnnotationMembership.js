/**
 * The exact records of a favorite or collection filter's whole stored
 * membership, read with bounded concurrency. Answers are kept for the episode
 * (filter open, same source and scope), so switching between filters reads
 * only members not yet read. Leaving the filter, a source or scope change,
 * or unmounting aborts the pass and drops everything; late answers from an
 * aborted pass are never applied.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';

import {
  MEMBER,
  MEMBERSHIP_CONCURRENCY,
  membershipCounts,
  readMembers,
} from './annotationMembership.js';
import { SOURCE } from '../../data/storage/cachePolicy.js';
import { annotationKey } from '../../data/records/imageAnnotations.js';

const settled = (source) =>
  source === SOURCE.SHARED || source === SOURCE.PRIVATE;

/**
 * @param {{members: Array<object>, enabled: boolean, source: string,
 *   scopeKey: string|null, loadShared?: Function|null,
 *   readPrivate?: Function|null, concurrency?: number}} options
 */
export function useAnnotationMembership({
  members,
  enabled,
  source,
  scopeKey,
  loadShared = null,
  readPrivate = null,
  concurrency = MEMBERSHIP_CONCURRENCY,
}) {
  const [version, bump] = useReducer((n) => n + 1, 0);
  const [retries, retry] = useReducer((n) => n + 1, 0);
  const known = useRef(new Map());
  const episode = useRef(null);
  const readers = useRef({ loadShared, readPrivate });
  useEffect(() => {
    readers.current = { loadShared, readPrivate };
  });

  const active = enabled && settled(source);
  const episodeId = active ? JSON.stringify([source, scopeKey]) : null;
  if (episode.current !== episodeId) {
    // A new episode starts from nothing; no answer carries across sources.
    episode.current = episodeId;
    known.current = new Map();
  }

  const signature = useMemo(
    () => members.map((identity) => annotationKey(identity)).join('\n'),
    [members],
  );
  const latest = useRef(members);
  latest.current = members;

  useEffect(() => {
    if (!episodeId) return undefined;
    const pending = latest.current.filter(
      (identity) => !known.current.has(annotationKey(identity)),
    );
    if (!pending.length) return undefined;
    const controller = new AbortController();
    const map = known.current;
    readMembers(pending, {
      concurrency,
      signal: controller.signal,
      source,
      loadShared: (...args) => readers.current.loadShared?.(...args),
      readPrivate: readers.current.readPrivate
        ? (...args) => readers.current.readPrivate(...args)
        : null,
      onResult: (identity, outcome) => {
        // Only this episode's map; a replaced episode is never written.
        if (known.current !== map) return;
        map.set(annotationKey(identity), outcome);
        bump();
      },
    }).catch(() => {});
    return () => controller.abort();
  }, [episodeId, signature, retries, source, concurrency]);

  const outcomes = known.current;
  const counts = useMemo(
    () => membershipCounts(members, outcomes),
    // `version` marks new answers in the same map.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [members, outcomes, version],
  );

  /** Read again every member that was not shown. */
  const retryUnavailable = useCallback(() => {
    for (const [key, outcome] of known.current)
      if (outcome.status !== MEMBER.READY) known.current.delete(key);
    bump();
    retry();
  }, []);

  /** This tab removed the image: its marks remain, now unavailable. */
  const forget = useCallback((identity) => {
    if (!identity) return;
    known.current.set(annotationKey(identity), { status: MEMBER.MISSING });
    bump();
  }, []);

  return {
    outcomes,
    counts,
    version,
    reading: Boolean(episodeId) && counts.pending > 0,
    waiting: enabled && !settled(source),
    retry: retryUnavailable,
    forget,
  };
}
