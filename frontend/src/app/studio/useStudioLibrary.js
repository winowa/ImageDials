import { useCacheStore } from '../../data/storage/useCacheStore.js';
import {
  SOURCE,
  scopeKeyOf,
  selectSource,
} from '../../data/storage/cachePolicy.js';
import { useMemo } from 'react';
import { useLibrary } from '../../features/library/library.js';
import { ROUTE } from '../routes.js';
import { CREATE_HISTORY_BINDING } from './constants.js';

/**
 * The cache store and the saved-image library bound to the current route and source.
 * The shared library, private history and exact-record reads keep their own owners.
 */
export function useStudioLibrary({
  discovery,
  fallback,
  policy,
  route,
  sharedLibrary,
  syncTiming,
}) {
  const cache = useCacheStore(policy.cache);
  // Capabilities alone choose the source; until the cache has opened nothing
  // is requested, so the stored list can be shown first.
  const capabilitiesSource = selectSource(discovery.capabilities);
  const scopeKey = useMemo(
    () => scopeKeyOf(discovery.capabilities.data),
    [discovery.capabilities.data],
  );
  const library = useLibrary({
    source: cache.ready ? capabilitiesSource : SOURCE.PENDING,
    scopeKey,
    store: cache.store,
    refreshCapabilities: discovery.reload,
    paged: route === ROUTE.library || route === ROUTE.create,
    surface: route,
    retainWindow: route === ROUTE.create,
    windowBinding: route === ROUTE.create ? CREATE_HISTORY_BINDING : undefined,
    // The shared Gallery reads bounded sessions itself; it gets change ticks.
    sessionSurface: route === ROUTE.gallery,
    sync: {
      enabled: true,
      timing: syncTiming,
      pollMs: sharedLibrary?.polling_enabled === false ? null : fallback.pollMs,
      pauseOnPointer: fallback.pauseOnPointer,
    },
  });
  const {
    insert: insertImage,
    reload: reloadImages,
    remove: deleteImage,
    loadLibraryRecord: loadRecord,
    loadLibraryRecordById: loadRecordById,
  } = library;

  return {
    cache,
    deleteImage,
    insertImage,
    library,
    loadRecord,
    loadRecordById,
    reloadImages,
    scopeKey,
  };
}
