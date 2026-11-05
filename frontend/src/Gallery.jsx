import React, {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  FILTER_ORIENTATIONS,
  filterByOrientation,
  GALLERY_DEFAULT_SPEED_SECONDS,
  GALLERY_SPEEDS_SECONDS,
  orientationCounts,
  validSpeedSeconds,
} from './browse.js';
import { DEFAULT_CLIENT_POLICY } from './clientPolicy.js';
import {
  approachedEdge,
  clampWindow,
  growEnd,
  growStart,
  initialWindow,
  revealIndex,
} from './galleryFilmstrip.js';
import {
  ANIMATED_EFFECT_IDS,
  legacyEffectsFallback,
  validEffects,
} from './galleryEffects.js';
import { galleryShortcut } from './galleryKeys.js';
import { LAYER_ROLE } from './galleryStage.js';
import { galleryEvents, sanitizeEvent } from './galleryPlayback.js';
import { WINDOW_NEED } from './gallerySession.js';
import { isExactRecord, rememberExact } from './exactRecords.js';
import {
  describeImage,
  imageKey,
  isBakedWatermark,
  isLocalOnly,
  ORIENTATIONS,
} from './imageRecord.js';
import { orientationOf, useMeasuredSizes } from './measure.js';
import { SOURCE } from './cachePolicy.js';
import LibraryGate from './LibraryGate.jsx';
import { EffectPicker, TransitionRings } from './GalleryEffects.jsx';
import {
  motionAllowed,
  usePreference,
  useReducedMotion,
} from './preferences.js';
import { useGalleryFacets } from './useGalleryFacets.js';
import { useGalleryPlayback, usePreloadImage } from './useGalleryPlayback.js';
import { useGallerySession } from './useGallerySession.js';
import { useGalleryStage } from './useGalleryStage.js';
import {
  formatSaved,
  handleStripKeys,
  Icon,
  InfoPopover,
  SavedImg,
  Tip,
} from './ui.jsx';

import './GalleryUsability.css';

/** Pointer travel, in CSS pixels, beyond which a press is a drag rather than a tap. */
const GALLERY_TAP_SLOP_PX = 10;

/** Distance from a filmstrip edge, in viewport widths, that loads the next batch. */
const EDGE_MARGIN_VIEWPORTS = 1;

const ORIENTATION_LABEL = {
  portrait: 'Portrait',
  landscape: 'Landscape',
  square: 'Square',
  unknown: 'Unknown size',
};

const UNSUPPORTED_MESSAGE =
  'This server does not offer bounded gallery sessions, so the shared gallery cannot be shown.';
const STALLED_MESSAGE = 'Several images in a row could not be loaded.';

/**
 * A stored filter from before `unknown` existed that enabled every shape was
 * an "all" filter, so it keeps showing images whose size is not known.
 */
const sanitizeOrientations = (stored, fallback) => {
  if (
    !Array.isArray(stored) ||
    !stored.every((o) => FILTER_ORIENTATIONS.includes(o))
  )
    return fallback;
  const showsAllShapes = ORIENTATIONS.every((o) => stored.includes(o));
  return showsAllShapes && !stored.includes('unknown')
    ? [...stored, 'unknown']
    : stored;
};

/** A step whose window change lands within this time keeps it centred. */
const RECENTER_AFTER_STEP_MS = 1500;

/** Older and browser-private Gallery data has no session readiness flag. */
export const galleryCanRearmLoadedPicture = (sessionReady) =>
  sessionReady !== false;

/** Scroll `strip` so `item` is centred, without scrolling the page. */
function centerInStrip(strip, item, smooth = true) {
  const box = strip.getBoundingClientRect();
  const at = item.getBoundingClientRect();
  strip.scrollTo?.({
    left:
      strip.scrollLeft +
      (at.left - box.left) -
      (strip.clientWidth - at.width) / 2,
    behavior: smooth && motionAllowed() ? 'smooth' : 'auto',
  });
}

function EventChooser({ events, onEvent }) {
  return (
    <div className="gallery-event">
      <label className="inline-field">
        <span>Event</span>
        <select
          className="field"
          value={events.selected ?? ''}
          onChange={(event) => onEvent(sanitizeEvent(event.target.value))}
        >
          <option value="">All events</option>
          {events.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
              {option.active ? ' (active)' : ''} · {option.count}
            </option>
          ))}
        </select>
      </label>
      {events.searchable ? (
        <div className="gallery-event-find">
          <input
            type="search"
            className="field"
            aria-label="Find event"
            placeholder="Find event"
            value={events.query}
            onChange={(event) => events.setQuery(event.target.value)}
          />
          {events.hasMore ? (
            <button
              type="button"
              className="btn"
              disabled={events.loadingMore}
              onClick={events.loadMore}
            >
              More events
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function GalleryPanel({
  counts,
  enabled,
  onToggleOrientation,
  visible,
  total,
  playing,
  canStep,
  onStep,
  onTogglePlaying,
  speedSeconds,
  onSpeed,
  filmstripVisible,
  onToggleFilmstrip,
  onHideChrome,
  hideRef,
  watermarkVisible,
  onToggleWatermark,
  watermarkAvailable,
  events,
  onEvent,
  effectIds,
  onEffects,
  previewPictures,
  reducedMotion,
  chromeHidden,
}) {
  const speedIndex = GALLERY_SPEEDS_SECONDS.indexOf(speedSeconds);
  return (
    <section className="gallery-panel panel" aria-label="Gallery controls">
      <div className="gallery-toggles">
        <button
          ref={hideRef}
          type="button"
          className="btn"
          onClick={onHideChrome}
        >
          <Icon name="eye-off" size={18} />
          Hide controls
          <kbd>H</kbd>
        </button>
        <button
          type="button"
          className="btn"
          aria-pressed={!filmstripVisible}
          onClick={onToggleFilmstrip}
        >
          <Icon name="gallery" size={18} />
          {filmstripVisible ? 'Hide carousel' : 'Show carousel'}
          <kbd>C</kbd>
        </button>
      </div>
      {watermarkAvailable ? (
        <label className="check-row">
          <input
            type="checkbox"
            checked={watermarkVisible}
            onChange={(event) => onToggleWatermark(event.target.checked)}
          />
          <span className="check-label">Watermark</span>
        </label>
      ) : null}
      {events.show ? <EventChooser events={events} onEvent={onEvent} /> : null}
      <fieldset className="check-group">
        <legend>Orientation</legend>
        {FILTER_ORIENTATIONS.filter(
          (orientation) => orientation !== 'unknown' || counts.unknown > 0,
        ).map((orientation) => (
          <label key={orientation} className="check-row">
            <input
              type="checkbox"
              checked={enabled.has(orientation)}
              onChange={() => onToggleOrientation(orientation)}
            />
            <span className="check-label">
              {ORIENTATION_LABEL[orientation]}
            </span>
            <span className="check-count">{counts[orientation]}</span>
          </label>
        ))}
      </fieldset>
      <div className="transport" role="group" aria-label="Slideshow">
        <Tip label="Previous image">
          <button
            type="button"
            className="icon-btn"
            aria-label="Previous image"
            disabled={!canStep}
            onClick={() => onStep(-1)}
          >
            <Icon name="prev" />
          </button>
        </Tip>
        <Tip label={playing ? 'Pause slideshow' : 'Play slideshow'}>
          <button
            type="button"
            className="icon-btn"
            aria-label={playing ? 'Pause slideshow' : 'Play slideshow'}
            aria-pressed={playing}
            disabled={!canStep}
            onClick={onTogglePlaying}
          >
            <Icon name={playing ? 'pause' : 'play'} />
          </button>
        </Tip>
        <Tip label="Next image">
          <button
            type="button"
            className="icon-btn"
            aria-label="Next image"
            disabled={!canStep}
            onClick={() => onStep(1)}
          >
            <Icon name="next" />
          </button>
        </Tip>
        <label className="speed">
          <span className="speed-head">
            <span>Speed</span>
            <output>{speedSeconds} s</output>
          </span>
          <input
            type="range"
            className="slider"
            min={0}
            max={GALLERY_SPEEDS_SECONDS.length - 1}
            step={1}
            value={speedIndex}
            aria-label="Speed"
            aria-valuetext={`${speedSeconds} seconds per image`}
            onChange={(event) =>
              onSpeed(GALLERY_SPEEDS_SECONDS[Number(event.target.value)])
            }
          />
        </label>
      </div>
      {!chromeHidden ? (
        <EffectPicker
          value={effectIds}
          onChange={onEffects}
          pictures={previewPictures}
          reducedMotion={reducedMotion}
        />
      ) : null}
      <p className="gallery-counts">
        <span className="pill">{visible} visible</span>
        <span className="pill">{total} total</span>
      </p>
      {!chromeHidden ? (
        <InfoPopover label="Keyboard shortcuts" informational>
          <dl className="gallery-shortcut-list">
            <div>
              <dt>
                <kbd>←</kbd> <kbd>→</kbd>
              </dt>
              <dd>Navigate</dd>
            </div>
            <div>
              <dt>
                <kbd>Space</kbd> <kbd>H</kbd> <kbd>Esc</kbd>
              </dt>
              <dd>Show or hide controls</dd>
            </div>
            <div>
              <dt>
                <kbd>C</kbd>
              </dt>
              <dd>Show or hide carousel</dd>
            </div>
          </dl>
        </InfoPopover>
      ) : null}
    </section>
  );
}

/**
 * Details of the picture on screen. A summary row shows its display prompt
 * until the exact record (read for the image actually shown) arrives.
 */
function ImageInfo({ image, exact, orientation, measuredSize }) {
  const view = describeImage(exact ?? image);
  const size = view.size ?? measuredSize ?? null;
  const prompt = exact
    ? view.originalPrompt
    : view.originalPrompt || image.display_prompt || '';
  return (
    <aside className="gallery-meta panel" aria-label="Image details">
      <span className="badge">{orientation}</span>
      <h2>{view.title}</h2>
      <p className="meta-line">
        <span>Saved {formatSaved(exact ?? image)}</span>
      </p>
      {size ? (
        <p className="meta-line mono">
          {size.width} × {size.height}
        </p>
      ) : null}
      {prompt && prompt !== view.title ? (
        <p className="prose">{prompt}</p>
      ) : null}
    </aside>
  );
}

/** Choices that persist across visits; Hide UI never rewrites them. */
function useGalleryPreferences() {
  const [enabledList, setEnabledList] = usePreference(
    'gallery-orientations',
    FILTER_ORIENTATIONS,
    sanitizeOrientations,
  );
  const [speedSeconds, setSpeedSeconds] = usePreference(
    'gallery-speed-seconds',
    GALLERY_DEFAULT_SPEED_SECONDS,
    validSpeedSeconds,
  );
  // Playing is the default unless the viewer prefers reduced motion.
  const [playPreference, setPlayPreference] = usePreference(
    'gallery-playing',
    null,
    (stored) => (typeof stored === 'boolean' ? stored : null),
  );
  const [filmstripVisible, setFilmstripVisible] = usePreference(
    'gallery-filmstrip',
    true,
    (stored) => stored !== false,
  );
  const [storedEvent, setStoredEvent] = usePreference(
    'gallery-event',
    null,
    sanitizeEvent,
  );
  // Several transitions run together; the single choice of older versions is
  // read once as the default until a list is saved.
  const [effectsFallback] = useState(legacyEffectsFallback);
  const [effectIds, setEffectIds] = usePreference(
    'gallery-effects',
    effectsFallback,
    validEffects,
  );
  const reducedMotion = useReducedMotion();
  const enabled = useMemo(() => new Set(enabledList), [enabledList]);
  const toggleOrientation = (orientation) =>
    setEnabledList(
      FILTER_ORIENTATIONS.filter((o) =>
        o === orientation ? !enabled.has(o) : enabled.has(o),
      ),
    );
  return {
    enabledList,
    enabled,
    toggleOrientation,
    speedSeconds,
    setSpeedSeconds,
    playPreference,
    setPlayPreference,
    filmstripVisible,
    setFilmstripVisible,
    storedEvent,
    setStoredEvent,
    effectIds,
    setEffectIds,
    reducedMotion,
  };
}

/** Reduced motion starts paused unless the viewer chose to play. */
const playingFor = (prefs, canStep) =>
  (prefs.playPreference ?? !prefs.reducedMotion) && canStep;

/**
 * The capabilities alone choose the source. The shared library is read only
 * through bounded sessions, counts and exact details; the browser-private
 * history (and a source not known yet) never makes a shared request.
 */
export default function Gallery({ studio, seed, onUiHidden }) {
  return studio.source === SOURCE.SHARED ? (
    <SharedGallery studio={studio} onUiHidden={onUiHidden} />
  ) : (
    <LocalGallery studio={studio} seed={seed} onUiHidden={onUiHidden} />
  );
}

// --- Browser-private history -----------------------------------------------------

function LocalGallery({ studio, seed, onUiHidden }) {
  const { images, reloadImages } = studio;
  const policy = (studio.clientPolicy ?? DEFAULT_CLIENT_POLICY).gallery;
  const prefs = useGalleryPreferences();
  const { enabled, enabledList, storedEvent } = prefs;

  // A conditional read: unchanged libraries answer 304 and keep what is shown.
  useEffect(() => {
    reloadImages();
  }, [reloadImages]);

  const measured = useMeasuredSizes(images.items);
  const events = useMemo(
    () =>
      galleryEvents({
        capabilities: studio.discovery?.capabilities?.data,
        items: images.items,
        stored: storedEvent,
      }),
    [studio.discovery?.capabilities?.data, images.items, storedEvent],
  );
  // The choice only narrows what the backend's scope already returned.
  const scoped = useMemo(
    () =>
      events.selected
        ? images.items.filter((i) => i.event_id === events.selected)
        : images.items,
    [images.items, events.selected],
  );
  const counts = useMemo(
    () => orientationCounts(scoped, measured),
    [scoped, measured],
  );
  const list = useMemo(
    () => filterByOrientation(scoped, enabled, measured),
    [scoped, enabled, measured],
  );
  const listKeys = useMemo(() => list.map((i) => describeImage(i).key), [list]);
  const library = useMemo(
    () =>
      images.items.map((i) => {
        const view = describeImage(i);
        return { key: view.key, createdAtMs: view.createdAtMs };
      }),
    [images.items],
  );
  const byKey = useMemo(
    () => new Map(list.map((i) => [describeImage(i).key, i])),
    [list],
  );

  const canStep = list.length > 1;
  const playing = playingFor(prefs, canStep);
  const playback = useGalleryPlayback({
    library,
    eligible: listKeys,
    playing,
    speedSeconds: prefs.speedSeconds,
    holdMs: policy.newImageHoldMs,
    seed,
  });
  const { forget } = playback;
  const orderedImages = useMemo(
    () => playback.order.map((key) => byKey.get(key)).filter(Boolean),
    [playback.order, byKey],
  );
  const image = byKey.get(playback.current) ?? null;
  const index = image ? orderedImages.indexOf(image) : -1;

  // Failures describe one view: another filter starts fresh.
  const viewKey = `${enabledList.join()}|${events.selected}`;
  const viewRef = useRef(viewKey);
  useEffect(() => {
    if (viewRef.current !== viewKey) {
      viewRef.current = viewKey;
      forget();
    }
  }, [viewKey, forget]);

  const filmstrip = useFilmstripWindow({
    total: orderedImages.length,
    index,
    limits: {
      initial: policy.filmstripInitialCount,
      batch: policy.filmstripBatchCount,
    },
  });
  const rows = useMemo(
    () =>
      orderedImages
        .slice(filmstrip.window.start, filmstrip.window.end)
        .map((record) => ({ key: describeImage(record).key, record })),
    [orderedImages, filmstrip.window.start, filmstrip.window.end],
  );

  return (
    <GalleryView
      studio={studio}
      prefs={prefs}
      onUiHidden={onUiHidden}
      gate={{ images, reload: reloadImages }}
      hasLibrary={images.items.length > 0}
      data={{
        rows,
        stripRef: filmstrip.ref,
        onStripScroll: filmstrip.onScroll,
        current: playback.current,
        currentRecord: image,
        index,
        nextRecord: byKey.get(playback.nextKey) ?? null,
        loaded: playback.loaded,
        failed: playback.failed,
        step: playback.step,
        select: playback.select,
        ready: playback.ready,
        unavailable: playback.unavailable,
        canStep,
        playing,
        counts,
        visible: list.length,
        total: images.items.length,
        events,
        previewPictures: list.slice(0, 2),
        orientationOf: (record) => orientationOf(record, measured),
        measuredSize: (record) => measured.get(describeImage(record).key),
        exactFor: () => null,
      }}
    />
  );
}

// --- Shared library: bounded sessions --------------------------------------------

/** The exact record of the image on screen, from a small pool; others are summaries. */
function useExactDetail(record, load) {
  const [pool, setPool] = useState(() => new Map());
  const poolRef = useRef(pool);
  const key = record ? imageKey(record) : null;
  const wanted =
    record && load && !isLocalOnly(record) && !isExactRecord(record);
  useEffect(() => {
    if (!wanted || poolRef.current.has(key)) return undefined;
    const controller = new AbortController();
    load(record, { signal: controller.signal }).then(
      (exact) => {
        if (controller.signal.aborted) return;
        const next = rememberExact(poolRef.current, exact, new Set([key]));
        poolRef.current = next;
        setPool(next);
      },
      () => {
        // The summary stays on show; the next image is read on its own.
      },
    );
    return () => controller.abort();
    // Keyed by identity: a refreshed summary is the same image.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, wanted, load]);
  return key ? (pool.get(key) ?? null) : null;
}

/**
 * Keep the thumbnail at the strip's leading edge still while rows are added or
 * dropped before it. Right after a step the strip is being centred on the new
 * image instead, so it stays centred rather than stopping where it was.
 */
function useStripAnchor(stripRef, rows, current) {
  const anchor = useRef(null);
  const steppedAt = useRef(-Infinity);
  useLayoutEffect(() => {
    steppedAt.current = performance.now();
  }, [current]);
  const remember = useCallback(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const items = strip.querySelectorAll('[data-key]');
    for (const item of items)
      if (item.offsetLeft + item.offsetWidth > strip.scrollLeft) {
        anchor.current = {
          key: item.dataset.key,
          offset: item.offsetLeft - strip.scrollLeft,
        };
        return;
      }
  }, [stripRef]);
  const firstKey = rows[0]?.key ?? null;
  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const selected = strip.querySelector('[aria-current="true"]');
    if (
      selected &&
      performance.now() - steppedAt.current < RECENTER_AFTER_STEP_MS
    ) {
      centerInStrip(strip, selected, false);
      return;
    }
    const held = anchor.current;
    if (!held) return;
    const item = [...strip.querySelectorAll('[data-key]')].find(
      (element) => element.dataset.key === held.key,
    );
    if (item) strip.scrollLeft = item.offsetLeft - held.offset;
  }, [firstKey, stripRef]);
  return remember;
}

function SharedGallery({ studio, onUiHidden }) {
  const policy = (studio.clientPolicy ?? DEFAULT_CLIENT_POLICY).gallery;
  const capabilities = studio.discovery?.capabilities?.data ?? null;
  const shared = capabilities?.shared_library ?? {};
  const supported =
    shared.shuffle_sessions?.enabled === true &&
    shared.paging?.event_facets?.enabled === true;
  const prefs = useGalleryPreferences();
  const changeTick = studio.libraryChangeTick ?? 0;
  const refreshCapabilities = studio.refreshCapabilities;

  const facets = useGalleryFacets({
    active: supported,
    events: capabilities?.events ?? null,
    storedEvent: prefs.storedEvent,
    changeTick,
    onForbidden: refreshCapabilities,
  });
  const { counts, libraryTotal } = facets;
  const visible = prefs.enabledList.reduce(
    (sum, orientation) => sum + (counts[orientation] ?? 0),
    0,
  );
  const allShapes = FILTER_ORIENTATIONS.every((o) => prefs.enabled.has(o));
  const orientations = useMemo(
    () => (allShapes ? null : [...prefs.enabledList].sort()),
    [allShapes, prefs.enabledList],
  );

  const limits = useMemo(
    () => ({
      initial: policy.filmstripInitialCount,
      batch: policy.filmstripBatchCount,
    }),
    [policy.filmstripInitialCount, policy.filmstripBatchCount],
  );
  // Play is decided before the rows exist; the counts say whether it can.
  const [rowCount, setRowCount] = useState(0);
  const canStep = visible > 1 || rowCount > 1;
  const playing = playingFor(prefs, canStep);
  const session = useGallerySession({
    active: supported && facets.settled,
    eventName: facets.events.selected,
    orientations,
    visibleCount: visible,
    revision: facets.revision,
    limits,
    ttlSeconds: shared.shuffle_sessions?.ttl_seconds ?? null,
    capabilities: shared.shuffle_sessions ?? null,
    playing,
    speedSeconds: prefs.speedSeconds,
    holdMs: policy.newImageHoldMs,
    onForbidden: refreshCapabilities,
  });
  const sessionReady = session.status === 'ready' && session.rows.length > 0;
  const canNavigate = sessionReady && (visible > 1 || rowCount > 1);
  if (session.rows.length !== rowCount) setRowCount(session.rows.length);

  const currentRow =
    session.rows.find((row) => row.key === session.current) ?? null;
  const index = currentRow ? session.rows.indexOf(currentRow) : -1;
  const preview = !currentRow ? session.preview : null;
  const currentKey = currentRow?.key ?? (preview ? imageKey(preview) : null);
  const [hasOpened, setHasOpened] = useState(false);
  if (
    !hasOpened &&
    (session.status === 'ready' || session.rows.length > 0 || Boolean(preview))
  )
    setHasOpened(true);

  const stripRef = useRef(null);
  const rememberAnchor = useStripAnchor(
    stripRef,
    session.rows,
    session.current,
  );
  const { loadEdge, hasMore } = session;
  const onStripScroll = useCallback(
    (event) => {
      const element = event.currentTarget;
      rememberAnchor();
      const edge = approachedEdge(
        element,
        element.clientWidth * EDGE_MARGIN_VIEWPORTS,
      );
      if (edge.end && hasMore.forward) loadEdge(WINDOW_NEED.FORWARD);
      if (edge.start && hasMore.backward) loadEdge(WINDOW_NEED.BACKWARD);
    },
    [rememberAnchor, loadEdge, hasMore.forward, hasMore.backward],
  );

  // The effect previews keep the first pictures of the view they opened with.
  const [previewPictures, setPreviewPictures] = useState([]);
  if (!previewPictures.length && session.rows.length)
    setPreviewPictures(session.rows.slice(0, 2).map((row) => row.record));

  const opened = hasOpened || session.status === 'ready' || Boolean(preview);
  const stalled = session.stalled;
  const error = !supported
    ? UNSUPPORTED_MESSAGE
    : (facets.error ?? session.error ?? (stalled ? STALLED_MESSAGE : null));
  // An event or shapes that match nothing still show the gallery's controls.
  // Once shown, the gallery stays while a new event choice is read.
  const hasLibrary = libraryTotal > 0 && opened;
  const gateImages = {
    status: error
      ? 'error'
      : facets.status === 'ready' && (libraryTotal === 0 || opened)
        ? 'ready'
        : 'loading',
    error,
    errorDetail: !supported
      ? null
      : facets.error
        ? facets.errorDetail
        : session.error
          ? session.errorDetail
          : null,
    items: hasLibrary ? session.rows : [],
    keepContent: hasLibrary,
  };
  const { forget, step, retry } = session;
  const reload = useCallback(() => {
    if (!supported) {
      refreshCapabilities?.();
      return;
    }
    if (stalled) {
      forget();
      step(1);
      return;
    }
    studio.reloadImages?.();
    if (session.error) void retry();
  }, [
    supported,
    stalled,
    forget,
    step,
    retry,
    refreshCapabilities,
    studio,
    session.error,
  ]);

  return (
    <GalleryView
      studio={studio}
      prefs={prefs}
      onUiHidden={onUiHidden}
      gate={{ images: gateImages, reload }}
      hasLibrary={hasLibrary}
      data={{
        rows: session.rows,
        stripRef,
        onStripScroll,
        current: currentKey,
        currentRecord: currentRow?.record ?? preview,
        previewKey: preview ? imageKey(preview) : null,
        previewFailed: session.previewFailed,
        sessionReady,
        building: session.status === 'building',
        index,
        nextRecord: session.nextRow?.record ?? null,
        loaded: session.loaded,
        failed: session.failed,
        step: session.step,
        select: session.select,
        ready: session.ready,
        unavailable: session.unavailable,
        canStep: canNavigate,
        playing,
        counts,
        visible,
        total: libraryTotal,
        events: facets.events,
        previewPictures,
        orientationOf: (record) =>
          record.orientation ?? describeImage(record).orientation,
        measuredSize: () => null,
        exactFor: studio.loadLibraryRecord ?? null,
      }}
    />
  );
}

// --- The view ------------------------------------------------------------------

function GalleryView({ studio, prefs, onUiHidden, gate, hasLibrary, data }) {
  const { watermark } = studio;
  const {
    rows,
    current: currentKey,
    currentRecord: image,
    index,
    playing,
    step,
    select,
  } = data;
  const { reducedMotion, effectIds, filmstripVisible, setFilmstripVisible } =
    prefs;
  // Hide UI is a temporary view state: the individual choices (carousel,
  // watermark, filters) are never rewritten by it, so revealing restores them.
  const [chromeHidden, setChromeHidden] = useState(false);
  const hideButton = useRef(null);
  // While hidden the whole stage is the surface that takes focus.
  const surface = useRef(null);
  const revealHint = useId();

  // Which way the change travels, for directional effects.
  const directionRef = useRef({ key: null, index: -1, direction: 1 });
  if (directionRef.current.key !== currentKey) {
    const before = directionRef.current.index;
    directionRef.current = {
      key: currentKey,
      index,
      direction: before >= 0 && index >= 0 && index < before ? -1 : 1,
    };
  }
  const stage = useGalleryStage({
    key: currentKey,
    record: image,
    direction: directionRef.current.direction,
    effectIds,
    reducedMotion,
  });
  const layerElements = useRef(new Map());
  const { ready: markReady, failed: failedKeys, unavailable } = data;
  const markStageReady = stage.ready;
  // Returning to a retained, already decoded layer produces no new image load
  // event. Re-arm from its retained pixels, excluding unavailable placeholders.
  useEffect(() => {
    const picture = layerElements.current.get(currentKey)?.querySelector('img');
    if (
      galleryCanRearmLoadedPicture(data.sessionReady) &&
      currentKey &&
      picture?.complete &&
      picture.naturalWidth > 0 &&
      !failedKeys.includes(currentKey)
    ) {
      markReady(currentKey);
      markStageReady(currentKey, picture);
    }
  }, [currentKey, failedKeys, markReady, data.sessionReady, markStageReady]);
  const layerReady = (key) => {
    markReady(key);
    stage.ready(key, layerElements.current.get(key)?.querySelector('img'));
  };
  const layerFailed = (key) => {
    if (key === data.previewKey) data.previewFailed(key);
    else unavailable(key);
    stage.ready(key, null, true);
  };
  // The details follow the picture the viewer actually sees.
  // Before any picture is visible (first load) they describe the wanted one.
  const visibleRecord = stage.visible?.record ?? image;
  const exact = useExactDetail(visibleRecord, data.exactFor);

  // One upcoming full image while playing, once the featured one is on screen.
  usePreloadImage(
    data.nextRecord,
    playing && data.loaded === currentKey,
    unavailable,
    currentKey,
  );

  useEffect(() => {
    const strip = data.stripRef.current;
    const element = strip?.querySelector('[aria-current="true"]');
    if (element) centerInStrip(strip, element);
    // The window may change without the selection moving; do not recentre then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentKey, filmstripVisible]);

  const toggleChrome = useCallback(
    () => setChromeHidden((hidden) => !hidden),
    [],
  );
  // The shown gallery is what carries the hidden state: while the library is
  // loading or failed there is nothing to reveal it from.
  const uiHidden = chromeHidden && hasLibrary;
  useEffect(() => {
    if (!hasLibrary) setChromeHidden(false);
  }, [hasLibrary]);
  useEffect(() => {
    onUiHidden?.(uiHidden);
    // Leaving the gallery always restores the global header.
    return () => onUiHidden?.(false);
  }, [uiHidden, onUiHidden]);

  // Focus follows the toggle: to the hidden surface when everything else
  // disappears, back to the hide button when the controls return.
  const hiddenBefore = useRef(false);
  useEffect(() => {
    if (hiddenBefore.current === chromeHidden) return;
    hiddenBefore.current = chromeHidden;
    if (chromeHidden) surface.current?.focus({ preventScroll: true });
    else hideButton.current?.focus({ preventScroll: true });
  }, [chromeHidden]);

  // While hidden, an ordinary tap or click anywhere brings everything back.
  // The press is consumed before it reaches its target, so it never activates
  // what lies under it; a drag, swipe or scroll is not a tap.
  useEffect(() => {
    if (!uiHidden) return undefined;
    let press = null;
    const onDown = (event) => {
      if (!event.isPrimary || event.button !== 0) {
        press = { moved: true };
        return;
      }
      press = { id: event.pointerId, x: event.clientX, y: event.clientY };
    };
    const onMove = (event) => {
      if (!press || event.pointerId !== press.id) return;
      const moved = Math.hypot(
        event.clientX - press.x,
        event.clientY - press.y,
      );
      if (moved > GALLERY_TAP_SLOP_PX) press = { ...press, moved: true };
    };
    const onCancel = (event) => {
      if (press && event.pointerId === press.id)
        press = { ...press, moved: true };
    };
    const onScroll = () => {
      if (press) press = { ...press, moved: true };
    };
    const onClick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      // A click without a tracked press (assistive technology) is a tap.
      if (!press?.moved && event.button === 0) setChromeHidden(false);
      press = null;
    };
    const options = { capture: true };
    window.addEventListener('pointerdown', onDown, options);
    window.addEventListener('pointermove', onMove, options);
    window.addEventListener('pointercancel', onCancel, options);
    window.addEventListener('click', onClick, options);
    window.addEventListener('scroll', onScroll, options);
    window.addEventListener('wheel', onScroll, options);
    return () => {
      window.removeEventListener('pointerdown', onDown, options);
      window.removeEventListener('pointermove', onMove, options);
      window.removeEventListener('pointercancel', onCancel, options);
      window.removeEventListener('click', onClick, options);
      window.removeEventListener('scroll', onScroll, options);
      window.removeEventListener('wheel', onScroll, options);
    };
  }, [uiHidden]);

  const shortcuts = useRef(null);
  useLayoutEffect(() => {
    shortcuts.current = {
      next: () => step(1),
      previous: () => step(-1),
      chrome: toggleChrome,
      // The carousel is hidden with the rest; its saved choice stays untouched.
      filmstrip: () => {
        if (!chromeHidden) setFilmstripVisible(!filmstripVisible);
      },
    };
  });
  useEffect(() => {
    // Escape that closes a popover or tooltip belongs to that popover. The
    // capture listener sees the page before any popover has reacted to it.
    let popoverOwnsEscape = false;
    const onCapture = (event) => {
      popoverOwnsEscape =
        event.key === 'Escape' &&
        Boolean(document.querySelector('[role="tooltip"], .popover'));
    };
    const onKeyDown = (event) => {
      const action = galleryShortcut(event);
      if (!action) return;
      if (popoverOwnsEscape && event.key === 'Escape') return;
      event.preventDefault();
      shortcuts.current[action]();
    };
    document.addEventListener('keydown', onCapture, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onCapture, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  return (
    <LibraryGate images={gate.images} reload={gate.reload}>
      <div className="gallery" data-chrome={chromeHidden ? 'hidden' : 'shown'}>
        <div className="gallery-main">
          <div className="gallery-side" inert={chromeHidden}>
            <GalleryPanel
              counts={data.counts}
              enabled={prefs.enabled}
              onToggleOrientation={prefs.toggleOrientation}
              visible={data.visible}
              total={data.total}
              playing={playing}
              canStep={data.canStep}
              onStep={step}
              onTogglePlaying={() => prefs.setPlayPreference(!playing)}
              speedSeconds={prefs.speedSeconds}
              onSpeed={prefs.setSpeedSeconds}
              filmstripVisible={filmstripVisible}
              onToggleFilmstrip={() => setFilmstripVisible(!filmstripVisible)}
              onHideChrome={() => setChromeHidden(true)}
              hideRef={hideButton}
              watermarkVisible={watermark.visible}
              onToggleWatermark={watermark.setVisible}
              watermarkAvailable={
                studio.source !== SOURCE.PRIVATE || Boolean(watermark.settings)
              }
              events={data.events}
              onEvent={prefs.setStoredEvent}
              effectIds={effectIds}
              onEffects={prefs.setEffectIds}
              previewPictures={data.previewPictures}
              reducedMotion={reducedMotion}
              chromeHidden={chromeHidden}
            />
          </div>
          <div
            ref={surface}
            className="gallery-stage"
            tabIndex={chromeHidden ? -1 : undefined}
            role={chromeHidden ? 'group' : undefined}
            aria-label={chromeHidden ? 'Gallery' : undefined}
            aria-describedby={chromeHidden ? revealHint : undefined}
            data-effects={stage.effect?.animated ? stage.effect.id : undefined}
            data-direction={stage.direction}
          >
            {stage.layers.map(({ entry, role }) => (
              <div
                key={entry.key}
                ref={(element) => {
                  if (element) layerElements.current.set(entry.key, element);
                  else layerElements.current.delete(entry.key);
                }}
                className="stage-layer"
                data-role={role}
                data-preview={
                  entry.key === data.previewKey ? 'true' : undefined
                }
                aria-hidden={
                  role === LAYER_ROLE.LOADING || role === LAYER_ROLE.EXITING
                    ? true
                    : undefined
                }
                inert={
                  role === LAYER_ROLE.LOADING || role === LAYER_ROLE.EXITING
                }
              >
                <TransitionRings ids={ANIMATED_EFFECT_IDS}>
                  <SavedImg
                    image={entry.record}
                    className="gallery-img"
                    loading="eager"
                    variant="original"
                    onReady={() => layerReady(entry.key)}
                    onUnavailable={() => layerFailed(entry.key)}
                    watermark={
                      watermark.visible &&
                      watermark.settings &&
                      !isBakedWatermark(entry.record)
                        ? { settings: watermark.settings }
                        : null
                    }
                  />
                </TransitionRings>
              </div>
            ))}
            {!image && !stage.layers.length ? (
              <p className="empty" role="status">
                {data.building && data.visible > 0
                  ? 'Preparing image order…'
                  : 'No images match the selected filters.'}
              </p>
            ) : null}
            {data.previewKey ? (
              <span className="sr-only" role="status">
                Preparing image order…
              </span>
            ) : null}
            {chromeHidden ? (
              <span id={revealHint} className="sr-only">
                Tap or press H to show controls
              </span>
            ) : null}
          </div>
          <div className="gallery-info" inert={chromeHidden}>
            {visibleRecord ? (
              <ImageInfo
                image={visibleRecord}
                exact={exact}
                orientation={data.orientationOf(visibleRecord)}
                measuredSize={data.measuredSize(visibleRecord)}
              />
            ) : null}
          </div>
        </div>
        {filmstripVisible ? (
          <ul
            className="strip"
            inert={chromeHidden}
            aria-label="Images"
            ref={data.stripRef}
            onKeyDown={handleStripKeys}
            onScroll={data.onStripScroll}
          >
            {rows.map(({ key, record }) => {
              const view = describeImage(record);
              return (
                <li key={key} data-key={key}>
                  <button
                    type="button"
                    className="thumb filmstrip-thumb"
                    aria-label={view.title}
                    aria-current={key === currentKey}
                    disabled={data.sessionReady === false}
                    onClick={() => select(key)}
                  >
                    <SavedImg image={record} />
                    <span className="thumb-caption">
                      <span className="thumb-title">{view.title}</span>
                      <small>{data.orientationOf(record)}</small>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    </LibraryGate>
  );
}

/**
 * The private filmstrip's rendered window: grows a batch when the viewer
 * approaches an edge, jumps to the selection when it is far away, and keeps
 * the viewport still when thumbnails are added before it.
 */
function useFilmstripWindow({ total, index, limits }) {
  const strip = useRef(null);
  const [win, setWin] = useState(() => initialWindow(total, limits));
  let next = clampWindow(win, total, limits);
  next = revealIndex(next, index, total, limits);
  if (next.start !== win.start || next.end !== win.end) setWin(next);

  // Thumbnails added before the viewport must not move what is shown.
  const widthBefore = useRef(null);
  useLayoutEffect(() => {
    const element = strip.current;
    if (element && widthBefore.current !== null) {
      element.scrollLeft += element.scrollWidth - widthBefore.current;
    }
    widthBefore.current = null;
  }, [win.start, strip]);

  const onScroll = useCallback(
    (event) => {
      const element = event.currentTarget;
      const edge = approachedEdge(
        element,
        element.clientWidth * EDGE_MARGIN_VIEWPORTS,
      );
      // Thumbnails added or dropped before the viewport shift its content.
      widthBefore.current = element.scrollWidth;
      if (edge.end) setWin((w) => growEnd(w, total, limits));
      if (edge.start && win.start > 0) setWin((w) => growStart(w, limits));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [total, win.start, limits.initial, limits.batch],
  );
  return { window: next, onScroll, ref: strip };
}
