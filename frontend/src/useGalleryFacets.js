import { preserveError } from './diagnostics.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from './api.js';

/** Event names read per facet page (the server allows up to 200). */
export const EVENT_FACET_PAGE_LIMIT = 100;
/** Most event choices held for the chooser; older pages are dropped first. */
export const EVENT_OPTION_LIMIT = 300;
/** Typing pause before an event-name search is sent. */
export const EVENT_SEARCH_DEBOUNCE_MS = 250;

const HTTP_BAD_REQUEST = 400;
const HTTP_FORBIDDEN = 403;
const EMPTY_COUNTS = Object.freeze({
  landscape: 0,
  portrait: 0,
  square: 0,
  unknown: 0,
});

const FORBIDDEN_MESSAGE = 'The library refused the request.';
const UNREADABLE_MESSAGE = 'The event counts were unreadable.';

const aborted = (error) => error?.name === 'AbortError';

function validFacets(facets) {
  return (
    facets &&
    typeof facets === 'object' &&
    Array.isArray(facets.events) &&
    Number.isInteger(facets.total_images) &&
    Number.isInteger(facets.revision) &&
    facets.orientation_counts &&
    typeof facets.orientation_counts === 'object' &&
    (facets.next_cursor === null || typeof facets.next_cursor === 'string')
  );
}

const countsOf = (facets) => ({
  ...EMPTY_COUNTS,
  ...facets?.orientation_counts,
});

/** Merge a page of choices into what is held, keeping at most the limit. */
function mergeChoices(held, events, { replaceHead }) {
  const byName = new Map();
  const ordered = replaceHead ? [...events, ...held] : [...held, ...events];
  for (const event of ordered)
    if (event && typeof event.name === 'string' && !byName.has(event.name))
      byName.set(event.name, event);
  const merged = [...byName.values()];
  return merged.length > EVENT_OPTION_LIMIT
    ? merged.slice(merged.length - EVENT_OPTION_LIMIT)
    : merged;
}

/**
 * Event choices and exact counts for the shared Gallery, from the bounded
 * event-facet endpoint. Nothing here reads image records.
 *
 * - The head page (all events in scope, optionally searched) supplies the
 *   choices and the scope's total; further pages are read on request and the
 *   held choices stay bounded.
 * - A stored choice is honoured only when the configured scope lists it, or
 *   (without a configured scope) when the server counts images for it; it is
 *   read once more for its own orientation counts.
 * - Every `changeTick` (the library change stream, polling or Retry)
 *   revalidates both reads with their ETags; an unchanged library is a 304.
 *
 * @param {object} options
 * @param {boolean} options.active shared source with the facet capability
 * @param {object|null} options.events capabilities.events
 * @param {string|null} options.storedEvent the remembered choice
 * @param {number} options.changeTick
 * @param {() => void} [options.onForbidden]
 */
export function useGalleryFacets({
  active,
  events: eventCapabilities,
  storedEvent,
  changeTick,
  onForbidden,
}) {
  const configured = useMemo(() => {
    const names = eventCapabilities?.gallery_event_names;
    if (Array.isArray(names) && names.length) return names;
    const activeName = eventCapabilities?.active_event_name;
    return activeName ? [activeName] : [];
  }, [eventCapabilities]);
  const activeName = eventCapabilities?.active_event_name ?? null;

  const [query, setQueryNow] = useState('');
  const [sentQuery, setSentQuery] = useState('');
  const [head, setHead] = useState(null);
  const [choices, setChoices] = useState([]);
  const [moreCursor, setMoreCursor] = useState(null);
  /** `for`: the candidate this answer is about. */
  const [selected, setSelected] = useState({
    for: null,
    name: null,
    facets: null,
  });
  const [error, setError] = useState(null);
  const [errorDetail, setErrorDetail] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const etags = useRef({
    head: null,
    headQuery: null,
    selected: null,
    selectedFor: null,
  });
  const forbidden = useRef(onForbidden);
  const queryNow = useRef(sentQuery);
  useEffect(() => {
    forbidden.current = onForbidden;
    queryNow.current = sentQuery;
  });

  // Searching waits for a pause in typing.
  useEffect(() => {
    if (query === sentQuery) return undefined;
    const timer = setTimeout(
      () => setSentQuery(query),
      EVENT_SEARCH_DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [query, sentQuery]);

  const fail = useCallback((failure) => {
    setErrorDetail(preserveError(failure));
    if (failure.status === HTTP_FORBIDDEN) forbidden.current?.();
    setError(
      failure.status === HTTP_FORBIDDEN ? FORBIDDEN_MESSAGE : failure.message,
    );
  }, []);

  // The head page: choices, the scope's total and the revision.
  useEffect(() => {
    if (!active) return undefined;
    const controller = new AbortController();
    const sameQuery = etags.current.headQuery === sentQuery;
    api
      .libraryEventFacets(
        { limit: EVENT_FACET_PAGE_LIMIT, q: sentQuery },
        {
          etag: sameQuery ? etags.current.head : null,
          signal: controller.signal,
        },
      )
      .then(
        (result) => {
          if (controller.signal.aborted) return;
          if (result.notModified) {
            setError(null);
            return;
          }
          if (!validFacets(result.facets)) throw new Error(UNREADABLE_MESSAGE);
          etags.current.head = result.etag;
          etags.current.headQuery = sentQuery;
          setHead(result.facets);
          setChoices((held) =>
            mergeChoices(sameQuery ? held : [], result.facets.events, {
              replaceHead: true,
            }),
          );
          setMoreCursor((cursor) =>
            sameQuery && cursor !== null ? cursor : result.facets.next_cursor,
          );
          setError(null);
        },
        (failure) => {
          if (!aborted(failure) && !controller.signal.aborted) fail(failure);
        },
      )
      .catch((failure) => {
        if (!controller.signal.aborted) fail(failure);
      });
    return () => controller.abort();
  }, [active, sentQuery, changeTick, fail]);

  // The stored choice: whether it may be honoured, and its own counts.
  const candidate =
    typeof storedEvent === 'string' && storedEvent
      ? !configured.length || configured.includes(storedEvent)
        ? storedEvent
        : null
      : null;
  useEffect(() => {
    if (!active) return undefined;
    if (!candidate) return undefined;
    const controller = new AbortController();
    const same = etags.current.selectedFor === candidate;
    api
      .libraryEventFacets(
        { limit: 1, eventName: candidate },
        {
          etag: same ? etags.current.selected : null,
          signal: controller.signal,
        },
      )
      .then(
        (result) => {
          if (controller.signal.aborted || result.notModified) return;
          if (!validFacets(result.facets)) throw new Error(UNREADABLE_MESSAGE);
          etags.current.selected = result.etag;
          etags.current.selectedFor = candidate;
          const listed = result.facets.events.find((e) => e.name === candidate);
          // Without a configured scope, a name with no images is not a choice.
          const valid = configured.length ? true : (listed?.count ?? 0) > 0;
          setSelected({
            for: candidate,
            name: valid ? candidate : null,
            facets: result.facets,
          });
        },
        (failure) => {
          if (aborted(failure) || controller.signal.aborted) return;
          // Outside the scope or not a valid name: never broadened, not chosen.
          if (failure.status === HTTP_BAD_REQUEST) {
            setSelected({ for: candidate, name: null, facets: null });
            return;
          }
          fail(failure);
        },
      )
      .catch((failure) => {
        if (!controller.signal.aborted) fail(failure);
      });
    return () => controller.abort();
  }, [active, candidate, configured, changeTick, fail]);

  const selectedName =
    candidate && selected.for === candidate ? selected.name : null;
  // The session waits for this: the chosen event decides its scope.
  const settled = head !== null && (!candidate || selected.for === candidate);
  const status = settled ? 'ready' : error ? 'error' : 'loading';

  const loadMore = useCallback(async () => {
    if (!moreCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const result = await api.libraryEventFacets({
        limit: EVENT_FACET_PAGE_LIMIT,
        q: sentQuery,
        cursor: moreCursor,
      });
      if (!validFacets(result.facets)) throw new Error(UNREADABLE_MESSAGE);
      // A page of an earlier search does not join the current one.
      if (queryNow.current !== sentQuery) return;
      setChoices((held) =>
        mergeChoices(held, result.facets.events, { replaceHead: false }),
      );
      setMoreCursor(result.facets.next_cursor);
    } catch (failure) {
      if (queryNow.current !== sentQuery) return;
      // A cursor from an older query is refused; start that list again.
      if (failure.status === HTTP_BAD_REQUEST) setMoreCursor(null);
      else fail(failure);
    } finally {
      setLoadingMore(false);
    }
  }, [moreCursor, loadingMore, sentQuery, fail]);

  const options = useMemo(() => {
    const list = choices.map((event) => ({
      value: event.name,
      label: event.name,
      count: event.count,
      active: event.name === activeName,
    }));
    // The chosen event stays offered while the list shows other names.
    if (selectedName && !list.some((option) => option.value === selectedName))
      list.unshift({
        value: selectedName,
        label: selectedName,
        count: selected.facets?.total_images ?? 0,
        active: selectedName === activeName,
      });
    return list;
  }, [choices, activeName, selectedName, selected.facets]);

  const searchable = Boolean(sentQuery || query || head?.next_cursor);
  // While a new choice is being read the previous scope's counts stay, so
  // nothing on screen jumps to the all-events numbers in between.
  const [lastScope, setLastScope] = useState(null);
  const settledScope = selectedName ? selected.facets : head;
  if (settled && lastScope !== settledScope) setLastScope(settledScope);
  const scopeFacets = settled ? settledScope : (lastScope ?? head);
  return {
    status,
    error,
    errorDetail,
    settled,
    revision: head?.revision ?? null,
    /** Total in the exact event scope used by the current Gallery session. */
    total: scopeFacets?.total_images ?? 0,
    /**
     * Every image in the configured scope, whatever event is chosen: zero
     * means an empty library, not a choice that matches nothing.
     */
    libraryTotal: head?.total_images ?? 0,
    /** Orientation counts of the chosen event (or the whole scope). */
    counts: countsOf(scopeFacets),
    events: {
      show: options.length > 1 || searchable,
      options,
      // The chooser shows a new choice at once; the session waits for it.
      selected: settled ? selectedName : candidate,
      searchable,
      query,
      setQuery: setQueryNow,
      hasMore: Boolean(moreCursor),
      loadingMore,
      loadMore,
    },
  };
}
