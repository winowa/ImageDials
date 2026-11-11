import { useLocalWatermark } from '../../features/watermarks/localWatermark.js';
import { useCallback, useLayoutEffect, useMemo, useState } from 'react';
import { createSharedPreparedHost } from '../../features/watermarks/sharedPreparedHost.js';
import { fetchBlob } from '../../data/api/api.js';
import { ROUTE } from '../routes.js';
import { useWatermark } from '../../features/watermarks/watermark.js';
import { createVariantMedia } from '../../data/media/variantMedia.js';
import { createPrivateMedia } from '../../data/media/privateMedia.js';
import { hasSharedMedia, imageKey } from '../../data/records/imageRecord.js';

/**
 * Watermark ownership, media sources for shared and private images, and the library-reload
 * wiring that depends on the active source and route.
 */
export function useStudioMedia({
  cache,
  discovery,
  exactRef,
  library,
  loadPrivateCreate,
  privateCreateRepository,
  privateCreateRoute,
  privateHistory,
  privateLibrary,
  privateLibraryRoute,
  reloadImages,
  route,
  sharedSource,
  urls,
}) {
  // One watermark owner. The content is this browser's own; browser-only
  // images are prepared through the private history, shared originals through
  // a host that keeps rebuildable copies in bounded browser storage.
  const localWatermark = useLocalWatermark({
    store: cache.store,
    ready: cache.ready,
  });
  const [sharedHost] = useState(() => createSharedPreparedHost({ fetchBlob }));
  const pagedSurface =
    sharedSource && (route === ROUTE.library || route === ROUTE.create);
  const createWindow = sharedSource && route === ROUTE.create;
  const privateRepository = privateLibrary.repository;
  const loadPrivateLibrary = privateLibrary.load;
  const retainPrivateRecord = useCallback(
    (record) => {
      const handle = privateRepository?.host.handleFor(record);
      return handle
        ? privateRepository.host.retain(handle, 'selected')
        : undefined;
    },
    [privateRepository],
  );
  const reloadLibraryImages = useCallback(
    () =>
      privateCreateRoute
        ? loadPrivateCreate({ direction: 'refresh' })
        : privateLibraryRoute
          ? loadPrivateLibrary({ direction: 'refresh' })
          : reloadImages(),
    [
      privateCreateRoute,
      loadPrivateCreate,
      privateLibraryRoute,
      loadPrivateLibrary,
      reloadImages,
    ],
  );
  const localHost = useMemo(() => {
    const boundedLibrary = privateLibrary.repository?.host;
    const boundedCreate = privateCreateRepository?.host;
    const fallback = privateHistory.watermarkHost;
    if (!boundedLibrary && !boundedCreate) return fallback;
    const hostFor = (value) => {
      if (privateCreateRoute && value?.local_added_at !== undefined)
        return boundedCreate ?? fallback;
      return value?.local_added_at !== undefined || value?.boundedPrivate
        ? (boundedLibrary ?? fallback)
        : fallback;
    };
    return Object.fromEntries(
      [
        'isListed',
        'current',
        'readOriginal',
        'readPrepared',
        'persistenceOf',
        'saveAnalysis',
        'savePrepared',
        'load',
        'retain',
      ]
        .map((method) => [
          method,
          (handle, ...args) => hostFor(handle)[method]?.(handle, ...args),
        ])
        .concat([
          [
            'handleFor',
            (record) => {
              const host = hostFor(record);
              const handle = host.handleFor(record);
              return handle &&
                (host === boundedLibrary || host === boundedCreate)
                ? { ...handle, boundedPrivate: true }
                : handle;
            },
          ],
        ]),
    );
  }, [
    privateLibrary.repository,
    privateCreateRepository,
    privateCreateRoute,
    privateHistory.watermarkHost,
  ]);
  const watermark = useWatermark({
    images: library.images,
    reload: reloadImages,
    replace: library.replace,
    local: localWatermark,
    capabilities: discovery.capabilities.data,
    localHost,
    sharedHost,
    observeSharedBatch: route === ROUTE.library && sharedSource,
    batchCheck: library.libraryWindow.revision,
  });
  const media = useMemo(
    () =>
      cache.store?.durable && sharedSource
        ? createVariantMedia({
            store: cache.store,
            urls,
            fetchBlob,
          })
        : null,
    [cache.store, sharedSource, urls],
  );
  const privateMedia = useMemo(
    () =>
      cache.store ? createPrivateMedia({ store: cache.store, urls }) : null,
    [cache.store, urls],
  );
  const displayMedia = useMemo(
    () => ({
      accepts: (record) =>
        privateMedia?.accepts(record) ||
        Boolean(media && hasSharedMedia(record)),
      peek: (record, kind) =>
        (privateMedia?.accepts(record) ? privateMedia : media)?.peek(
          record,
          kind,
        ),
      lease: (record, kind, options) =>
        (privateMedia?.accepts(record) ? privateMedia : media)?.lease(
          record,
          kind,
          options,
        ) ?? Promise.resolve(null),
      recoverThumbnail: (record, options) =>
        privateMedia?.accepts(record)
          ? (privateMedia.recoverThumbnail?.(record, options) ??
            Promise.resolve(null))
          : Promise.resolve(null),
      capture: (record, ...args) => media?.capture(record, ...args),
      drop: (record, kind) =>
        (privateMedia?.accepts(record) ? privateMedia : media)?.drop(
          record,
          kind,
        ),
      blob: (record, kind) =>
        media?.blob(record, kind) ?? Promise.resolve(null),
    }),
    [privateMedia, media],
  );
  useLayoutEffect(() => {
    sharedHost.bind({
      store: cache.store,
      isListed: (key) =>
        (pagedSurface
          ? [
              ...library.libraryWindow.pages.flatMap((page) => page.images),
              ...library.images.items,
              ...exactRef.current.values(),
            ]
          : library.images.items
        ).some((item) => imageKey(item) === key),
      media,
    });
  });

  return {
    createWindow,
    displayMedia,
    loadPrivateLibrary,
    localHost,
    pagedSurface,
    privateRepository,
    reloadLibraryImages,
    retainPrivateRecord,
    sharedHost,
    watermark,
  };
}
