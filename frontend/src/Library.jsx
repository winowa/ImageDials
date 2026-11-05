import { ErrorDetails, WarningDetails } from './ErrorDetails.jsx';
import { localDiagnostic } from './diagnostics.js';
import React, {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  LIBRARY_DEFAULT_DENSITY,
  LIBRARY_DEFAULT_PAGE_SIZE,
  LIBRARY_DENSITIES,
  LIBRARY_PAGE_SIZES,
  paginate,
  searchImages,
} from './browse.js';
import { recordControls, selectionSummary } from './controls.js';
import CredentialsPanel from './Credentials.jsx';
import { browserPrintEnabled, downloadEnabled } from './discovery.js';
import { SOURCE } from './cachePolicy.js';
import { annotationKey } from './imageAnnotations.js';
import {
  describeImage,
  imageKey,
  isBakedWatermark,
  isLocalOnly,
} from './imageRecord.js';
import { useCardMotion } from './libraryMotion.js';
import LibraryGate from './LibraryGate.jsx';
import CollectionManager, {
  LibraryAnnotationFilters,
} from './LibraryAnnotations.jsx';
import { ImageAnnotationActions } from './ImageAnnotationActions.jsx';
import { identityOf, useImageAnnotations } from './useImageAnnotations.js';
import { useAnnotationMembership } from './useAnnotationMembership.js';
import { usePreference } from './preferences.js';
import { useOriginalDownload } from './useOriginalDownload.js';
import { MediaContext } from './variantSrc.js';
import {
  DeleteConfirm,
  Disclosure,
  formatSaved,
  Icon,
  Modal,
  SavedImg,
  Tip,
} from './ui.jsx';
import { Facts, fileName } from './Viewer.jsx';
import { ExchangeList } from './LlmExchange.jsx';
import { savedExchanges } from './llmExchange.js';
import { BACKFILL_ACTIVE, watermarkCounts } from './watermark.js';
import { useVisibleWatermarks } from './useVisibleWatermarks.js';
import WatermarkPanel from './WatermarkPanel.jsx';
import WatermarkSettings from './WatermarkSettings.jsx';
import './LibraryToolbar.css';

/** Exact record contents for the persistent selection modal. */
function DetailBody({
  image,
  watermark,
  canDownload,
  canPrint,
  initialShowMark,
  onEdit,
  onDelete,
  onBusyChange,
  deleteDiagnostic,
  annotations,
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deleteError, setDeleteError] = useState(null);
  const deleteOpener = useRef(null);
  // The dialog starts from the grid's choice and then keeps its own.
  const [showMark, setShowMark] = useState(initialShowMark);
  const view = describeImage(image);
  const summary = useMemo(() => selectionSummary(image), [image]);
  const exchanges = useMemo(
    () =>
      savedExchanges(
        image,
        recordControls(image).some((wire) => wire.origin === 'generated'),
      ),
    [image],
  );
  const media = useContext(MediaContext);
  const sources = { media, readLocal: watermark.readLocalOriginal };
  const original = useOriginalDownload(image, fileName(image), sources);
  const panelShown = !(isLocalOnly(image) && !watermark.localAvailable);

  const confirmDelete = async () => {
    setBusy(true);
    onBusyChange(true);
    setDeleteError(null);
    const failure = await onDelete(image);
    // On success the parent removes this dialog.
    setBusy(false);
    onBusyChange(false);
    if (failure) setDeleteError(failure);
  };

  return (
    <>
      <div className="dialog-body">
        <div className="dialog-media">
          <SavedImg
            image={image}
            className="dialog-img"
            loading="eager"
            variant="original"
            watermark={
              showMark && watermark.settings && !isBakedWatermark(image)
                ? { settings: watermark.settings }
                : null
            }
          />
          <div className="dialog-media-actions">
            {canDownload && !panelShown ? (
              <Tip label="Download original">
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="Download original"
                  aria-busy={original.busy}
                  disabled={original.busy}
                  onClick={original.download}
                >
                  <Icon name="download" />
                </button>
              </Tip>
            ) : null}
            <Tip label="Edit in generator">
              <button
                type="button"
                className="icon-btn"
                aria-label="Edit in generator"
                onClick={() => onEdit(image)}
              >
                <Icon name="edit" />
              </button>
            </Tip>
          </div>
          {original.error && !panelShown ? (
            <p className="error-text" role="alert">
              <ErrorDetails error={original.error} />
              The original could not be downloaded. {original.error.message}
            </p>
          ) : null}
          {panelShown ? (
            <WatermarkPanel
              image={image}
              watermark={watermark}
              show={showMark}
              onShow={setShowMark}
              canDownload={canDownload}
              canPrint={canPrint}
              originalName={fileName(image)}
              original={original}
              sources={sources}
            />
          ) : null}
        </div>
        <div className="dialog-side">
          <div className="result">
            <h2>{view.title}</h2>
            <p className="meta-line">
              {isLocalOnly(image) ? (
                <span className="badge">Browser only</span>
              ) : null}
              <span>Saved {formatSaved(image)}</span>
              {view.size ? (
                <span>
                  {view.size.width}×{view.size.height}
                </span>
              ) : null}
            </p>
            <h3 className="mini">Original prompt</h3>
            <p className="prose">{view.originalPrompt}</p>
            {summary.length ? (
              <ul className="summary" aria-label="Selected options">
                {summary.map((s) => (
                  <li key={s.key}>
                    <span>{s.label}</span> {s.value}
                  </li>
                ))}
              </ul>
            ) : null}
            <Disclosure title="Final prompt">
              <pre className="final-prompt">{view.finalPrompt}</pre>
            </Disclosure>
            {exchanges.length ? (
              <Disclosure title="Request and response">
                <ExchangeList exchanges={exchanges} />
              </Disclosure>
            ) : null}
            <Disclosure title="Details">
              <Facts image={image} />
            </Disclosure>
            <CredentialsPanel image={image} {...sources} />
            <div className="detail-annotation-actions">
              <h3 className="mini">Saved in this browser</h3>
              <ImageAnnotationActions image={image} annotations={annotations} />
            </div>
          </div>
          {confirming ? (
            <DeleteConfirm
              image={image}
              busy={busy}
              error={deleteError}
              diagnostic={deleteDiagnostic}
              onConfirm={confirmDelete}
              onCancel={() => {
                setConfirming(false);
                setDeleteError(null);
                requestAnimationFrame(() => deleteOpener.current?.focus());
              }}
            />
          ) : (
            <div className="result-actions">
              <button
                type="button"
                className="btn danger"
                ref={deleteOpener}
                onClick={() => setConfirming(true)}
              >
                <Icon name="trash" size={18} />
                {isLocalOnly(image) ? 'Remove from browser' : 'Delete'}
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

const sanitizeChoice = (choices, fallback) => (stored) =>
  choices.includes(stored) ? stored : fallback;

const LibraryCard = React.memo(function LibraryCard({
  image,
  watermarkVisible,
  watermarkSettings,
  onSelect,
}) {
  const itemView = describeImage(image);
  return (
    <li data-card-key={itemView.key}>
      <button
        type="button"
        className="card"
        onClick={(event) => onSelect(image, event.currentTarget)}
      >
        <span className="card-media">
          <SavedImg
            image={image}
            watermark={
              watermarkVisible && watermarkSettings && !isBakedWatermark(image)
                ? { settings: watermarkSettings }
                : null
            }
          />
        </span>
        <span className="card-title">{itemView.title}</span>
        <span className="card-meta">
          {isLocalOnly(image) ? 'Browser only · ' : ''}
          {formatSaved(image)}
        </span>
      </button>
    </li>
  );
});

/** Bulk analysis progress in words; analysis only, never prepared files. */
export function backfillText(batch) {
  if (!batch) return null;
  const { status, completed_count: done = 0 } = batch;
  const failed = batch.failed_count ?? 0;
  const total = batch.queued_count;
  if (batch.count_pending || total == null) {
    const found = batch.candidate_count;
    if (status === 'failed') return batch.error ?? 'Analysis failed';
    return found == null
      ? 'Preparing analysis'
      : `Preparing analysis, up to ${found} images`;
  }
  if (status === 'queued') return `Analysis queued for ${total} images`;
  if (status === 'running')
    return `Analyzing ${done + failed} of ${total} images`;
  if (status === 'complete') return `Analysis finished for ${done} images`;
  const reason = batch.error ? `: ${batch.error}` : '';
  return `Analysis stopped: ${done} done, ${failed} failed${reason}`;
}

/** The bounded real diagnostics a status carries, as list entries. */
function batchErrors(batch) {
  const entries = batch?.error_sample ? [batch.error_sample] : [];
  return { entries, omitted: batch?.omitted_error_count ?? 0 };
}

/** Watermark controls of the library toolbar. */
function WatermarkTools({
  watermark,
  counts,
  onEdit,
  editorRef,
  bulk,
  recovery,
}) {
  const [queueing, setQueueing] = useState(false);
  const [queueError, setQueueError] = useState(null);
  const batch = watermark.backfill;
  const active = BACKFILL_ACTIVE.has(batch?.status);
  const text =
    active || batch?.status === 'failed' ? backfillText(batch) : null;
  const { entries, omitted } = batchErrors(batch);
  const progressError = watermark.backfillError;

  const queue = async () => {
    setQueueing(true);
    setQueueError(null);
    try {
      await watermark.queueAnalysis({ force: false });
    } catch (error) {
      setQueueError(error);
    }
    setQueueing(false);
  };

  return (
    <div className="wm-tools" role="group" aria-label="Watermarks">
      <label className="check-row">
        <input
          type="checkbox"
          checked={watermark.visible}
          onChange={(event) => watermark.setVisible(event.target.checked)}
        />
        <span className="check-label">Watermarks</span>
      </label>
      <Tip label="Watermark settings">
        <button
          ref={editorRef}
          type="button"
          className="icon-btn"
          aria-label="Watermark settings"
          disabled={!watermark.settings}
          onClick={onEdit}
        >
          <Icon name="stamp" />
        </button>
      </Tip>
      {recovery?.pending ? (
        <span className="count" role="status">
          Refreshing watermarks: {recovery.pending} remaining
        </span>
      ) : null}
      {recovery?.failed ? (
        <span className="error-text" role="status">
          <WarningDetails
            warning={`${recovery.failed} watermark checks failed.`}
          />
          {recovery.failed} watermark checks failed.{' '}
          <button type="button" className="btn" onClick={recovery.retry}>
            Retry watermarks
          </button>
        </span>
      ) : null}
      {bulk ? (
        <>
          <Tip label="Analyze images">
            <button
              type="button"
              className="icon-btn"
              aria-label="Analyze images"
              aria-busy={queueing || active}
              disabled={queueing || active}
              onClick={queue}
            >
              <Icon name="scan" />
            </button>
          </Tip>
          <span className="count wm-counts">
            Watermark check: {counts.analyzed} of {counts.total} {counts.scope}
          </span>
        </>
      ) : null}
      {bulk && (text || queueError || progressError) ? (
        <span
          className={queueError ? 'error-text wm-batch' : 'count wm-batch'}
          role="status"
        >
          {queueError ? (
            <>
              <ErrorDetails error={queueError} />
              {queueError.message}
            </>
          ) : (
            text
          )}
          {!queueError && batch?.status === 'failed' ? (
            <ErrorDetails
              error={batch.error ?? 'Analysis failed'}
              diagnostic={localDiagnostic({
                category: 'reported',
                reason: batch.error ?? 'Analysis failed',
                data: batch,
              })}
            />
          ) : null}
          {!queueError && progressError ? (
            <span className="error-text">
              <WarningDetails
                warning={watermark.backfillErrorDetail ?? progressError}
              />{' '}
              {progressError}
            </span>
          ) : null}
          {!queueError && (entries.length || omitted) ? (
            <Disclosure title="Details">
              <ul className="wm-errors">
                {entries.map((entry) => (
                  <li key={entry.image_id}>
                    <WarningDetails
                      warning={entry.error}
                      diagnostic={localDiagnostic({
                        category: 'reported',
                        reason: entry.error,
                        data: entry,
                      })}
                    />
                    <code>{entry.image_id}</code> {entry.error}
                  </li>
                ))}
                {omitted ? <li>{omitted} more not shown</li> : null}
              </ul>
            </Disclosure>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

/** Measure available grid space, retaining the saved density across rotation. */
function useColumnCapacity(container, columnsControl, search) {
  const [capacity, setCapacity] = useState(LIBRARY_DENSITIES.at(-1));
  useLayoutEffect(() => {
    if (!container) return undefined;
    const measure = () => {
      const style = getComputedStyle(container);
      const width =
        container.clientWidth -
        (parseFloat(style.paddingLeft) || 0) -
        (parseFloat(style.paddingRight) || 0);
      if (width <= 0) return;
      // Match the existing 9rem card minimum and measured CSS grid gap.
      const minimum =
        9 * parseFloat(getComputedStyle(document.documentElement).fontSize);
      const gap = parseFloat(style.columnGap) || 0;
      const next = Math.max(
        1,
        Math.min(
          LIBRARY_DENSITIES.at(-1),
          Math.floor((width + gap) / (minimum + gap)),
        ),
      );
      if (next <= 2 && columnsControl.current?.contains(document.activeElement))
        search.current?.focus({ preventScroll: true });
      setCapacity(next);
    };
    measure();
    const observer =
      typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    observer?.observe(container);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [container, columnsControl, search]);
  return capacity;
}
const imageCount = (count) => `${count} ${count === 1 ? 'image' : 'images'}`;

export default function Library({ studio, onEdit }) {
  const {
    reloadImages,
    loadLibraryWindow,
    loadLibraryRecord,
    libraryScopeKey,
    libraryReplacedRecord,
    watermark,
    retainPrivateRecord,
  } = studio;
  const annotations = useImageAnnotations(studio.imageAnnotations);
  const images = studio.libraryImages ?? studio.images;
  const paged = images.paged === true;
  const window = images.window ?? studio.libraryWindow;
  const [editing, setEditing] = useState(false);
  const editorOpener = useRef(null);
  const [query, setQuery] = useState('');
  const [annotationFilter, setAnnotationFilter] = useState({ kind: 'all' });
  const [manageCollections, setManageCollections] = useState(false);
  const collectionOpener = useRef(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = usePreference(
    'library-page-size',
    LIBRARY_DEFAULT_PAGE_SIZE,
    sanitizeChoice(LIBRARY_PAGE_SIZES, LIBRARY_DEFAULT_PAGE_SIZE),
  );
  const [density, setDensity] = usePreference(
    'library-density',
    LIBRARY_DEFAULT_DENSITY,
    sanitizeChoice(LIBRARY_DENSITIES, LIBRARY_DEFAULT_DENSITY),
  );
  const [openKey, setOpenKey] = useState(null);
  const [selectedSummary, setSelectedSummary] = useState(null);
  const [detailState, setDetailState] = useState({
    status: 'idle',
    record: null,
    error: null,
  });
  const [detailRetry, setDetailRetry] = useState(0);
  const [detailBusy, setDetailBusy] = useState(false);
  const opener = useRef(null);
  const search = useRef(null);
  const columnsControl = useRef(null);
  const [container, setContainer] = useState(null);
  const capacity = useColumnCapacity(container, columnsControl, search);
  const effectiveDensity = Math.min(density, capacity);
  // The final stop can represent a clamped preference, for example 6 at 5.
  const densityChoices = LIBRARY_DENSITIES.filter(
    (value, index) => index === 0 || LIBRARY_DENSITIES[index - 1] < capacity,
  );
  const activeDetailKey = useRef(null);
  const detailController = useRef(null);
  const detailClose = useRef(null);
  // Card that takes focus when the opener was removed by a confirmed delete.
  const survivorKey = useRef(null);
  const selectCard = useCallback((item, button) => {
    detailController.current?.abort();
    detailController.current = new AbortController();
    opener.current = button;
    setSelectedSummary(item);
    activeDetailKey.current = imageKey(item);
    setDetailRetry(0);
    setDetailState(
      isLocalOnly(item)
        ? { status: 'ready', record: item, error: null }
        : { status: 'loading', record: null, error: null },
    );
    setOpenKey(imageKey(item));
  }, []);

  const binding = useMemo(
    () => ({ q: query, limit: pageSize }),
    [query, pageSize],
  );
  const normalizedQuery = query.trim().split(/\s+/).filter(Boolean).join(' ');
  const activeAnnotationFilter = useMemo(
    () =>
      annotations.status === 'ready' &&
      annotationFilter.kind === 'collection' &&
      !annotations.collections.some(
        (collection) => collection.id === annotationFilter.id,
      )
        ? { kind: 'all' }
        : annotationFilter,
    [annotations.status, annotations.collections, annotationFilter],
  );
  const getAnnotationMembers = annotations.members;
  const annotationMembers = useMemo(
    () => getAnnotationMembers(activeAnnotationFilter),
    [getAnnotationMembers, activeAnnotationFilter],
  );
  const loadExactShared = useCallback(
    (summary, options) => loadLibraryRecord(summary, options),
    [loadLibraryRecord],
  );
  const readExactPrivate = useCallback(
    (key) => studio.imageAnnotations?.readPrivateDetail?.(key),
    [studio.imageAnnotations],
  );
  const membership = useAnnotationMembership({
    members: annotationMembers,
    enabled: activeAnnotationFilter.kind !== 'all',
    source: studio.source,
    scopeKey: libraryScopeKey,
    loadShared: loadExactShared,
    readPrivate: readExactPrivate,
  });
  const showAnnotationFilters =
    images.items.length > 0 ||
    annotations.images.length > 0 ||
    annotations.collections.length > 0 ||
    activeAnnotationFilter.kind !== 'all';
  const memberRows = annotationMembers.flatMap((identity) => {
    const result = membership.outcomes.get(annotationKey(identity));
    return result?.status === 'ready' ? [result.record] : [];
  });
  const serverPage =
    paged &&
    window.binding.q === normalizedQuery &&
    window.binding.limit === pageSize
      ? (window.pages[window.activeIndex] ?? null)
      : null;
  const windowMatches =
    paged &&
    window.binding.q === normalizedQuery &&
    window.binding.limit === pageSize;
  const windowError = windowMatches ? window.error : null;
  // Waiting for the new query, or returning from a range deletions emptied.
  const settling =
    paged &&
    !windowError &&
    (window.pending !== null ||
      !serverPage ||
      (serverPage.count === 0 && serverPage.total > 0));
  // The previous rows stay while a query settles, marked busy, so a search
  // neither blanks the grid nor presents old rows as the new result.
  const [held, setHeld] = useState(null);
  if (
    serverPage?.count > 0 &&
    (held?.page !== serverPage || held?.scope !== libraryScopeKey)
  )
    setHeld({ page: serverPage, scope: libraryScopeKey });
  const heldPage = held?.scope === libraryScopeKey ? held.page : null;
  // A conditional bounded read: unchanged pages answer 304 and keep what is shown.
  useEffect(() => {
    let timer = null;
    if (activeAnnotationFilter.kind !== 'all') return undefined;
    if (paged) {
      timer = setTimeout(
        () => loadLibraryWindow({ direction: 'first', binding }),
        query ? 250 : 0,
      );
    } else reloadImages();
    return () => clearTimeout(timer);
  }, [
    paged,
    binding,
    query,
    reloadImages,
    loadLibraryWindow,
    libraryScopeKey,
    activeAnnotationFilter.kind,
  ]);

  const matches = useMemo(() => {
    if (activeAnnotationFilter.kind !== 'all')
      return searchImages(memberRows, query);
    if (!paged) return searchImages(images.items, query);
    const imports = images.onFirstPage
      ? searchImages(images.imported ?? [], query)
      : [];
    const rows = settling ? heldPage?.images : serverPage?.images;
    return [...imports, ...(rows ?? [])];
  }, [
    paged,
    activeAnnotationFilter.kind,
    memberRows,
    images.items,
    images.imported,
    images.onFirstPage,
    query,
    serverPage,
    settling,
    heldPage,
  ]);
  const initialCounts = useMemo(() => {
    const base = watermarkCounts(
      studio.source === SOURCE.PRIVATE
        ? matches
        : matches.filter((image) => !isLocalOnly(image)),
      watermark.settings?.rendering,
    );
    return {
      ...base,
      scope:
        paged && activeAnnotationFilter.kind === 'all'
          ? 'on this page'
          : 'in results',
    };
  }, [
    matches,
    paged,
    studio.source,
    activeAnnotationFilter.kind,
    watermark.settings?.rendering,
  ]);
  // The page is clamped whenever results or page size change.
  const baseView =
    paged && activeAnnotationFilter.kind === 'all'
      ? { items: matches, page: 1, pageCount: 1 }
      : paginate(matches, page, pageSize);
  const recovery = useVisibleWatermarks({
    images: baseView.items,
    watermark,
    scope: [
      libraryScopeKey,
      normalizedQuery,
      page,
      pageSize,
      activeAnnotationFilter,
      serverPage?.cursor,
    ],
    enabled:
      !windowError &&
      (!settling || (serverPage && window.pending?.direction === 'refresh')),
  });
  const view = { ...baseView, items: recovery.images };
  const visibleCounts = watermarkCounts(
    view.items,
    watermark.settings?.rendering,
  );
  const originalVisibleCounts = watermarkCounts(
    baseView.items,
    watermark.settings?.rendering,
  );
  const counts = {
    ...initialCounts,
    analyzed:
      initialCounts.analyzed +
      visibleCounts.analyzed -
      originalVisibleCounts.analyzed,
  };
  const cardKeys = view.items.map((item) => imageKey(item));
  const { attachList, findCard, prepareExit, discardExit } = useCardMotion(
    cardKeys,
    effectiveDensity,
  );
  const selected =
    selectedSummary && describeImage(selectedSummary).key === openKey
      ? selectedSummary
      : null;
  useEffect(
    () => (selected ? retainPrivateRecord?.(selected) : undefined),
    [selected, retainPrivateRecord],
  );
  const searching = query.trim() !== '';
  const importCount =
    paged && !settling
      ? Math.max(0, matches.length - (serverPage?.images.length ?? 0))
      : 0;
  const pageImages = paged
    ? {
        ...images,
        items: matches,
        status: windowError ? 'error' : serverPage ? 'ready' : 'loading',
        error: windowError?.message ?? null,
        errorDetail: windowError,
        keepContent:
          matches.length > 0 ||
          searching ||
          annotations.images.length > 0 ||
          annotations.collections.length > 0 ||
          manageCollections ||
          Boolean(heldPage && (settling || windowError)),
      }
    : {
        ...images,
        keepContent:
          matches.length > 0 ||
          searching ||
          annotations.images.length > 0 ||
          annotations.collections.length > 0 ||
          manageCollections,
      };

  // A collection filter is read from the complete private membership index,
  // not from the currently visible page. Its errors and missing records remain
  // counted separately from the images that can still be shown.
  if (activeAnnotationFilter.kind !== 'all') {
    pageImages.items = matches;
    pageImages.keepContent = true;
    pageImages.status = 'ready';
    pageImages.error = null;
  }

  useEffect(() => {
    if (!selected || isLocalOnly(selected)) return undefined;
    const key = describeImage(selected).key;
    const controller = detailController.current;
    loadLibraryRecord(selected, { signal: controller?.signal })
      .then((record) => {
        if (activeDetailKey.current === key)
          setDetailState({ status: 'ready', record, error: null });
      })
      .catch((error) => {
        if (error?.name !== 'AbortError' && activeDetailKey.current === key)
          setDetailState({ status: 'error', record: null, error });
      });
    return () => {
      if (activeDetailKey.current !== key) controller?.abort();
    };
  }, [selected, detailRetry, loadLibraryRecord]);

  // An analysis or prepared-file result for the open image reaches its dialog.
  const [appliedRecord, setAppliedRecord] = useState(null);
  if (libraryReplacedRecord !== appliedRecord) {
    setAppliedRecord(libraryReplacedRecord);
    if (
      libraryReplacedRecord &&
      detailState.status === 'ready' &&
      describeImage(libraryReplacedRecord).key === openKey
    )
      setDetailState({
        status: 'ready',
        record: libraryReplacedRecord,
        error: null,
      });
  }

  const open =
    detailState.status === 'ready' && selected ? detailState.record : null;

  const closeDetail = () => {
    activeDetailKey.current = null;
    detailController.current?.abort();
    detailController.current = null;
    setDetailBusy(false);
    setOpenKey(null);
    setSelectedSummary(null);
    setDetailState({ status: 'idle', record: null, error: null });
    const survivor = survivorKey.current;
    survivorKey.current = null;
    requestAnimationFrame(() => {
      const card =
        survivor === null ? null : findCard(survivor)?.querySelector('button');
      (opener.current?.isConnected
        ? opener.current
        : (card ?? search.current)
      )?.focus();
    });
  };

  return (
    <LibraryGate images={pageImages} reload={reloadImages}>
      <div className="library library-usability" ref={setContainer}>
        <div className="toolbar">
          <div className="search-field">
            <label className="inline-field grow">
              <span>Search</span>
              <span className="search-box">
                <Icon name="search" size={18} />
                <input
                  ref={search}
                  className="field"
                  type="search"
                  value={query}
                  placeholder="Prompt, title, control…"
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setPage(1);
                  }}
                />
              </span>
            </label>
            {searching ? (
              <Tip label="Clear search">
                <button
                  type="button"
                  className="icon-btn quiet"
                  aria-label="Clear search"
                  onClick={() => {
                    setQuery('');
                    setPage(1);
                    search.current?.focus();
                  }}
                >
                  <Icon name="close" size={18} />
                </button>
              </Tip>
            ) : null}
          </div>
          {showAnnotationFilters ? (
            <LibraryAnnotationFilters
              annotations={annotations}
              value={activeAnnotationFilter}
              onChange={(next) => {
                setAnnotationFilter(next);
                setPage(1);
              }}
              onManage={(trigger) => {
                collectionOpener.current = trigger;
                setManageCollections(true);
              }}
            />
          ) : null}
          {capacity > 2 ? (
            <label
              className="inline-field library-columns"
              ref={columnsControl}
            >
              <span>Columns</span>
              <span className="density">
                <input
                  type="range"
                  className="slider"
                  aria-label="Columns"
                  min={0}
                  max={densityChoices.length - 1}
                  step={1}
                  value={Math.min(
                    densityChoices.length - 1,
                    LIBRARY_DENSITIES.indexOf(density),
                  )}
                  aria-valuetext={`${effectiveDensity} columns`}
                  onChange={(event) =>
                    setDensity(densityChoices[Number(event.target.value)])
                  }
                />
                <output>{effectiveDensity}</output>
              </span>
            </label>
          ) : null}
          <label className="inline-field">
            <span>Per page</span>
            <select
              className="field"
              value={pageSize}
              onChange={(event) => {
                setPageSize(Number(event.target.value));
                setPage(1);
              }}
            >
              {LIBRARY_PAGE_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>
          {studio.source === SOURCE.PRIVATE &&
          !watermark.localAvailable ? null : (
            <WatermarkTools
              recovery={recovery}
              watermark={watermark}
              counts={counts}
              bulk={studio.source !== SOURCE.PRIVATE}
              editorRef={editorOpener}
              onEdit={() => setEditing(true)}
            />
          )}
          <span className="count" aria-live="polite">
            {activeAnnotationFilter.kind !== 'all'
              ? `${matches.length} ${matches.length === 1 ? 'available image' : 'available images'}${searching ? ` matching “${query.trim()}”` : ''} · ${membership.counts.members} saved`
              : windowError
                ? 'Unavailable'
                : settling
                  ? 'Loading…'
                  : paged
                    ? `${imageCount(serverPage?.total ?? 0)}${importCount ? ` · ${importCount} in this browser` : ''}`
                    : searching
                      ? `${matches.length} of ${imageCount(images.items.length)}`
                      : imageCount(images.items.length)}
          </span>
        </div>
        {activeAnnotationFilter.kind !== 'all' ? (
          <div className="membership-status" aria-live="polite">
            {membership.waiting ? (
              <span>Waiting for the Library source…</span>
            ) : null}
            {membership.reading ? (
              <span>
                Reading saved membership · {membership.counts.pending} remaining
              </span>
            ) : null}
            {membership.counts.unavailable ||
            membership.counts.elsewhere ||
            membership.counts.errors ? (
              <span>
                {membership.counts.unavailable
                  ? `${membership.counts.unavailable} unavailable`
                  : ''}
                {membership.counts.elsewhere
                  ? `${membership.counts.unavailable ? ' · ' : ''}${membership.counts.elsewhere} in the other Library source`
                  : ''}
                {membership.counts.errors ? (
                  <WarningDetails
                    warning={`${membership.counts.errors} saved members could not be read.`}
                  />
                ) : null}
                {membership.counts.errors
                  ? `${membership.counts.unavailable || membership.counts.elsewhere ? ' · ' : ''}${membership.counts.errors} could not be read`
                  : ''}
                {membership.counts.errors || membership.counts.unavailable ? (
                  <button
                    type="button"
                    className="link-btn"
                    onClick={membership.retry}
                  >
                    Retry unavailable
                  </button>
                ) : null}
              </span>
            ) : null}
            {!membership.reading && membership.counts.members ? (
              <span>
                {membership.counts.ready} of {membership.counts.members} saved
                members available
              </span>
            ) : null}
          </div>
        ) : null}
        {windowError && activeAnnotationFilter.kind === 'all' ? (
          <p className="alert" role="status">
            <WarningDetails warning={windowError} />
            {studio.source === SOURCE.PRIVATE
              ? windowError.message
              : 'Cached pages and searches are partial; images outside this window may not be available offline.'}
          </p>
        ) : null}
        {matches.length ? (
          <ul
            className="cards"
            ref={attachList}
            aria-busy={
              activeAnnotationFilter.kind !== 'all'
                ? membership.reading
                : settling
            }
            style={{ '--density': effectiveDensity }}
          >
            {view.items.map((item) => {
              const key = imageKey(item);
              return (
                <LibraryCard
                  key={key}
                  image={item}
                  watermarkVisible={watermark.visible}
                  watermarkSettings={watermark.settings}
                  onSelect={selectCard}
                />
              );
            })}
          </ul>
        ) : activeAnnotationFilter.kind !== 'all' &&
          annotations.status === 'loading' ? (
          <p className="empty" role="status">
            Loading favorites and collections…
          </p>
        ) : activeAnnotationFilter.kind !== 'all' &&
          (membership.reading || membership.waiting) ? (
          <p className="empty" role="status">
            {membership.waiting
              ? 'Waiting for the Library source…'
              : 'Loading saved collection images…'}
          </p>
        ) : activeAnnotationFilter.kind !== 'all' &&
          membership.counts.members === 0 ? (
          <p className="empty" role="status">
            No images in{' '}
            {activeAnnotationFilter.kind === 'favorites'
              ? 'Favorites'
              : 'this collection'}{' '}
            yet.
          </p>
        ) : activeAnnotationFilter.kind !== 'all' &&
          membership.counts.ready === 0 ? (
          <div className="empty" role="status">
            <p>No saved members are available in this Library source.</p>
            {membership.counts.errors || membership.counts.unavailable ? (
              <button type="button" className="btn" onClick={membership.retry}>
                Retry unreadable images
              </button>
            ) : null}
          </div>
        ) : activeAnnotationFilter.kind !== 'all' && searching ? (
          <div className="empty" role="status">
            <p>No available saved images match “{query.trim()}”.</p>
            <button type="button" className="btn" onClick={() => setQuery('')}>
              Clear search
            </button>
          </div>
        ) : settling ? (
          <p className="empty" role="status">
            Loading saved images…
          </p>
        ) : windowError ? null : !searching ? (
          <p className="empty" role="status">
            {paged && serverPage?.total === 0
              ? 'No saved images yet.'
              : 'No images on this page.'}
          </p>
        ) : (
          <div className="empty" role="status">
            <p>No saved images match “{query.trim()}”.</p>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setQuery('');
                setPage(1);
              }}
            >
              Show all images
            </button>
          </div>
        )}
        {paged &&
        activeAnnotationFilter.kind === 'all' &&
        serverPage &&
        !settling ? (
          <nav className="pager" aria-label="Library pages">
            <button
              type="button"
              className="btn"
              disabled={
                window.pending !== null ||
                (window.activeIndex <= 0 && !serverPage.previous_cursor)
              }
              onClick={() =>
                loadLibraryWindow({ direction: 'backward', binding })
              }
            >
              Previous
            </button>
            <span className="count">
              {serverPage.count === 0
                ? `0 of ${serverPage.total}`
                : serverPage.position === null
                  ? `Showing ${serverPage.count} of ${serverPage.total}`
                  : `${serverPage.position + 1}–${serverPage.position + serverPage.count} of ${serverPage.total}`}
            </span>
            <button
              type="button"
              className="btn"
              disabled={
                window.pending !== null ||
                (window.activeIndex >= window.pages.length - 1 &&
                  !serverPage.next_cursor)
              }
              onClick={() =>
                loadLibraryWindow({ direction: 'forward', binding })
              }
            >
              Next
            </button>
            {serverPage.next_cursor ? (
              <button
                type="button"
                className="btn"
                disabled={window.pending !== null}
                onClick={() =>
                  loadLibraryWindow({ direction: 'last', binding })
                }
              >
                Last
              </button>
            ) : null}
          </nav>
        ) : null}
        {(!paged || activeAnnotationFilter.kind !== 'all') &&
        view.pageCount > 1 ? (
          <nav className="pager" aria-label="Pages">
            <button
              type="button"
              className="btn"
              disabled={view.page <= 1}
              onClick={() => setPage(view.page - 1)}
            >
              Previous
            </button>
            <span className="count">
              Page {view.page} of {view.pageCount}
            </span>
            <button
              type="button"
              className="btn"
              disabled={view.page >= view.pageCount}
              onClick={() => setPage(view.page + 1)}
            >
              Next
            </button>
          </nav>
        ) : null}
        {selected ? (
          <Modal
            label={describeImage(selected).title}
            onClose={closeDetail}
            locked={detailBusy}
          >
            {/* One bar for every state, so focus survives the bytes arriving. */}
            <div className="dialog-bar">
              <Tip label="Close">
                <button
                  ref={detailClose}
                  type="button"
                  className="icon-btn"
                  aria-label="Close details"
                  onClick={closeDetail}
                >
                  <Icon name="close" />
                </button>
              </Tip>
            </div>
            {open ? (
              <DetailBody
                key={openKey}
                image={open}
                watermark={watermark}
                initialShowMark={watermark.visible}
                canDownload={downloadEnabled(studio.discovery.capabilities)}
                canPrint={browserPrintEnabled(studio.discovery.capabilities)}
                annotations={annotations}
                onBusyChange={setDetailBusy}
                deleteDiagnostic={studio.images.removeErrorDetail?.diagnostic}
                onEdit={(image) => {
                  studio.rememberRecordForRestore(image);
                  closeDetail();
                  onEdit(image);
                }}
                onDelete={async (image) => {
                  const key = imageKey(image);
                  // Exit motion is prepared now and only plays if the
                  // removal is confirmed; a failure discards it.
                  prepareExit(key);
                  const failure = await studio.removeImage(image);
                  if (failure) {
                    discardExit();
                    return failure;
                  }
                  membership.forget(identityOf(image));
                  const at = cardKeys.indexOf(key);
                  survivorKey.current =
                    cardKeys[at + 1] ?? cardKeys[at - 1] ?? null;
                  opener.current = null;
                  closeDetail();
                  return failure;
                }}
              />
            ) : (
              <div className="dialog-side">
                {detailState.status === 'loading' ? (
                  <p role="status">Loading image details…</p>
                ) : detailState.status === 'error' ? (
                  <div role="alert">
                    <p className="error-text">
                      <ErrorDetails error={detailState.error} />
                      {detailState.error.message}
                    </p>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        detailClose.current?.focus();
                        setDetailState({
                          status: 'loading',
                          record: null,
                          error: null,
                        });
                        setDetailRetry((retry) => retry + 1);
                      }}
                    >
                      Retry
                    </button>
                  </div>
                ) : null}
              </div>
            )}
          </Modal>
        ) : null}
        {editing && watermark.settings ? (
          <WatermarkSettings
            settings={watermark.settings}
            images={matches}
            onSave={watermark.saveSettings}
            onReset={watermark.resetSettings}
            custom={watermark.local.custom}
            onClose={() => {
              setEditing(false);
              requestAnimationFrame(() => editorOpener.current?.focus());
            }}
          />
        ) : null}
        {manageCollections ? (
          <CollectionManager
            annotations={annotations}
            onClose={() => {
              setManageCollections(false);
              requestAnimationFrame(() => collectionOpener.current?.focus());
            }}
          />
        ) : null}
      </div>
    </LibraryGate>
  );
}
