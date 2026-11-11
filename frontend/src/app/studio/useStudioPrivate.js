import { SOURCE } from '../../data/storage/cachePolicy.js';
import { ROUTE } from '../routes.js';
import { usePrivateLibrary } from '../../data/storage/usePrivateLibrary.js';
import { usePrivateCreate } from '../../data/storage/usePrivateCreate.js';
import { useCallback } from 'react';
import { usePrivateHistory } from '../../data/storage/privateHistory.js';

/**
 * The browser-private history, its Library and Create windows and the refresh after a private
 * result is stored. It never touches the shared library.
 */
export function useStudioPrivate({ cache, library, policy, route, urls }) {
  // The browser-private history serves private-source images and keeps imports
  // in either source. It never touches the shared library.
  const privateSource = library.source === SOURCE.PRIVATE;
  const sharedSource = library.source === SOURCE.SHARED;
  const privateLibraryRoute = privateSource && route === ROUTE.library;
  const privateCreateRoute = privateSource && route === ROUTE.create;
  const privateLibrary = usePrivateLibrary({
    store: cache.store,
    enabled: privateLibraryRoute,
  });
  const privateCreate = usePrivateCreate({
    store: cache.store,
    enabled: privateCreateRoute,
  });
  const {
    repository: privateCreateRepository,
    window: privateCreateWindow,
    load: loadPrivateCreate,
    exact: exactPrivateCreate,
    byKey: lookupPrivateCreate,
    pinRole: pinPrivateCreateRole,
  } = privateCreate;
  const refreshPrivateCreate = useCallback(
    async ({ key, addedAt } = {}) => {
      if (!privateCreateRoute) return null;
      const first = await loadPrivateCreate({ direction: 'first' });
      const contains = (result) =>
        result?.accepted &&
        result.state?.rows?.some(
          (row) => row.key === key && row.addedAt === addedAt,
        );
      if (!key || contains(first)) return first;
      return loadPrivateCreate({
        direction: 'around',
        identity: { key, addedAt },
        before: 0,
        after: 0,
      });
    },
    [privateCreateRoute, loadPrivateCreate],
  );
  const privateHistory = usePrivateHistory({
    store: cache.store,
    urls,
    limits: policy.cache,
    boundedLibrary: privateLibraryRoute,
    boundedCreate: privateCreateRoute,
    onStored: refreshPrivateCreate,
    enabled: Boolean(cache.store) && (privateSource || sharedSource),
  });
  const {
    add: addPrivate,
    remove: removePrivate,
    retry: retryPrivate,
    admissionBlock: privateAdmissionBlock,
    oldestUnsaved: oldestUnsavedPrivate,
  } = privateHistory;

  return {
    addPrivate,
    exactPrivateCreate,
    loadPrivateCreate,
    lookupPrivateCreate,
    oldestUnsavedPrivate,
    pinPrivateCreateRole,
    privateAdmissionBlock,
    privateCreate,
    privateCreateRepository,
    privateCreateRoute,
    privateCreateWindow,
    privateHistory,
    privateLibrary,
    privateLibraryRoute,
    privateSource,
    removePrivate,
    retryPrivate,
    sharedSource,
  };
}
