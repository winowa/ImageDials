import { useMemo, useState } from 'react';
import { LOCAL_ORIGIN, imageKey } from '../../data/records/imageRecord.js';
import { ROUTE } from '../routes.js';
import {
  composeHistory,
  emptyLedger,
  findSelected,
} from '../../features/create/historyLedger.js';
import { isExactRecord } from '../../data/records/exactRecords.js';

/**
 * The Create history strip: stored shared and private pages, imported images and the job ledger composed into one list,
 * plus the head row that an edit link or a fresh completion must keep exactly readable.
 * Extracted from useStudio unchanged; it reads the studio state it is given and owns only the last-head memory.
 */
export function useHistoryStrip({
  createWindow,
  currentId,
  draftReferencePersistence,
  editLink,
  exact,
  generationReveal,
  ledger,
  library,
  privateCreateRoute,
  privateCreateWindow,
  privateHistory,
  privateLibrary,
  privateLibraryRoute,
  privateSource,
  route,
  settledLink,
  sharedSource,
  stageCleared,
}) {
  // Private source: one browser list of generated and imported images.
  // Shared source: the server list remains separate from browser-only imports.
  const images = useMemo(
    () =>
      privateSource
        ? {
            ...library.images,
            items: privateCreateRoute
              ? [...privateHistory.items, ...privateCreateWindow.rows]
              : privateHistory.items,
            status:
              privateHistory.status === 'ready' &&
              (!privateCreateRoute || privateCreateWindow.seq !== null)
                ? 'ready'
                : 'loading',
            error: null,
            watermarkSettings: null,
            watermarkBackfill: null,
            cacheWarning: privateHistory.notice,
          }
        : library.images,
    [
      privateSource,
      privateCreateRoute,
      library.images,
      privateCreateWindow.rows,
      privateCreateWindow.seq,
      privateHistory.items,
      privateHistory.status,
      privateHistory.notice,
    ],
  );
  const importedImages = useMemo(
    () =>
      privateHistory.items.filter(
        (item) => item.local_origin === LOCAL_ORIGIN.IMPORTED,
      ),
    [privateHistory.items],
  );
  // Library is also the removal location for imports in shared mode. Reuse the
  // exact-identity merge without adding provisional jobs or writing to the server.
  const libraryImages = useMemo(() => {
    if (privateLibraryRoute)
      return {
        ...images,
        items: [],
        imported: privateHistory.items.filter(
          (item) => item.local_storage?.state !== 'stored',
        ),
        window: privateLibrary.window,
        paged: true,
        onFirstPage: !privateLibrary.window.pages[0]?.previous_cursor,
      };
    if (route === ROUTE.library && sharedSource) {
      const window = library.libraryWindow;
      const page = window.pages[window.activeIndex] ?? null;
      // A stale cursor returning to the head has no exact position but no
      // previous page either.
      const onFirstPage =
        page?.position === 0 ||
        (page?.position === null &&
          page.previous_cursor === null &&
          page.count > 0);
      return {
        ...images,
        items: page?.images ?? [],
        imported: importedImages,
        window,
        paged: true,
        onFirstPage,
      };
    }
    if (privateSource || importedImages.length === 0) return images;
    return {
      ...images,
      items: composeHistory({
        ledger: emptyLedger,
        stored: images.items,
        imported: importedImages,
      }).items,
    };
  }, [
    route,
    sharedSource,
    privateSource,
    images,
    importedImages,
    library.libraryWindow,
    privateLibraryRoute,
    privateLibrary.window,
    privateHistory.items,
  ]);
  // Create history: bounded summary rows, each represented by its exact record
  // once one is held. A summary is never merged into or taken for a record.
  const windowPages = library.libraryWindow.pages;
  const windowAtHead = windowPages[0]?.previous_cursor === null;
  const windowRows = useMemo(() => {
    if (!createWindow) return [];
    const seen = new Set();
    const rows = [];
    for (const page of windowPages)
      for (const row of page.images) {
        const key = imageKey(row);
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push(exact.get(key) ?? row);
      }
    return rows;
  }, [createWindow, windowPages, exact]);
  const historyReveal =
    generationReveal &&
    generationReveal.selectionKey === currentId &&
    !stageCleared
      ? generationReveal
      : null;
  const composed = useMemo(() => {
    // A selected completion may be outside the loaded catalog window. Keep
    // its exact row available without replacing or scanning that window.
    const withCompletion = (rows) =>
      historyReveal &&
      !rows.some((row) => imageKey(row) === historyReveal.selectionKey)
        ? [historyReveal.record, ...rows]
        : rows;
    if (privateSource)
      return composeHistory({
        ledger,
        stored: withCompletion(
          privateCreateRoute
            ? [...privateHistory.items, ...privateCreateWindow.rows]
            : privateHistory.items,
        ),
      });
    if (createWindow) {
      // A just-saved image leads the head of the catalog until a read lists it.
      const listed = new Set(windowRows.map(imageKey));
      const fresh = windowAtHead
        ? library.images.items.filter((item) => !listed.has(imageKey(item)))
        : [];
      return composeHistory({
        ledger,
        stored: withCompletion([...fresh, ...windowRows]),
        imported: importedImages,
      });
    }
    return composeHistory({
      ledger,
      stored: library.restoreRecord
        ? [library.restoreRecord, ...library.images.items]
        : library.images.items,
      imported: importedImages,
    });
  }, [
    privateSource,
    privateCreateRoute,
    privateCreateWindow.rows,
    createWindow,
    windowAtHead,
    windowRows,
    historyReveal,
    ledger,
    privateHistory.items,
    library.images.items,
    library.restoreRecord,
    importedImages,
  ]);
  const history = composed.items;

  // The newest image is the stage's default. Paging away from the head does not
  // change which image that is.
  const [lastHead, setLastHead] = useState(null);
  const privateWindowAtHead = privateCreateWindow.previous === null;
  const createHistoryWindow = createWindow || privateCreateRoute;
  if (
    createHistoryWindow &&
    (createWindow
      ? windowPages.length > 0 && windowAtHead
      : privateCreateWindow.seq !== null && privateWindowAtHead)
  ) {
    const newest = createWindow
      ? (library.images.items[0] ?? windowPages[0].images[0] ?? null)
      : (privateHistory.items[0] ?? privateCreateWindow.rows[0] ?? null);
    if (newest !== lastHead) setLastHead(newest);
  }
  const headRow = createHistoryWindow ? lastHead : null;
  const headKey = headRow ? imageKey(headRow) : null;
  const linkHeld =
    createHistoryWindow &&
    Boolean(editLink?.target) &&
    settledLink !== editLink.id;
  const needsHead =
    draftReferencePersistence.hydrated &&
    createHistoryWindow &&
    !linkHeld &&
    !currentId &&
    !stageCleared;

  const current = useMemo(() => {
    if (stageCleared) return null;
    const selected = findSelected(composed, currentId);
    if (selected && isExactRecord(selected)) return selected;
    if (currentId) return exact.get(currentId) ?? null;
    if (createHistoryWindow)
      return headKey ? (exact.get(headKey) ?? null) : null;
    return images.items[0] ?? null;
  }, [
    composed,
    createHistoryWindow,
    exact,
    headKey,
    images.items,
    currentId,
    stageCleared,
  ]);

  return {
    createHistoryWindow,
    current,
    headKey,
    headRow,
    history,
    historyReveal,
    images,
    importedImages,
    libraryImages,
    linkHeld,
    needsHead,
    privateWindowAtHead,
    windowAtHead,
    windowPages,
    windowRows,
  };
}
