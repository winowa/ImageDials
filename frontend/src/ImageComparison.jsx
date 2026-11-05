import React, {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import {
  aspectsDiffer,
  clampView,
  defaultSourceId,
  dividerForKey,
  dividerFromPoint,
  FIT_VIEW,
  fitBox,
  panBy,
  sizeText,
  sourceLabel,
  viewForKey,
  viewTransform,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEP,
  zoomAt,
} from './comparison.js';
import { describeImage } from './imageRecord.js';
import { Icon, SavedImg } from './ui.jsx';
import { ErrorDetails } from './ErrorDetails.jsx';
import { localDiagnostic, preserveError } from './diagnostics.js';
import './ImageComparison.css';

const FOCUSABLE =
  'button:not(:disabled), select:not(:disabled), [tabindex="0"], [role="slider"]';
/** Zoom reached by a double click on the image. */
const DOUBLE_CLICK_ZOOM = 2.5;
/** Wheel delta (pixels) that changes zoom by a factor of e. */
const WHEEL_PIXELS_PER_E = 600;
const LINE_HEIGHT_PX = 16;

function MinusGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      aria-hidden="true"
      className="icon"
    >
      <path d="M5 12h14" />
    </svg>
  );
}

/** Two panes split by a divider, for the Compare action. */
export function CompareGlyph({ size = 18 }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="icon icon-compare"
    >
      <path d="M12 3v18M9 5H5a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h4m6-14h4a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1h-4" />
    </svg>
  );
}

const naturalSize = (img) =>
  img?.naturalWidth > 0 && img?.naturalHeight > 0
    ? { width: img.naturalWidth, height: img.naturalHeight }
    : null;

const pointerDistance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const pointerMid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/**
 * Before/after comparison of a result with one source. Both are the original
 * bytes: the result through the saved-image reader, the source from a Blob
 * already held in memory, or, for a source kept in this browser, read once the
 * comparison is open. Nothing is attached to the draft, nothing is sent to a
 * model, and neither image is painted or changed.
 *
 * @param {object} props
 * @param {object} props.image the saved result
 * @param {ReturnType<import('./comparison.js').comparisonSources>} props.sources
 * @param {() => void} props.onClose the caller returns focus to its opener
 * @param {ReturnType<import('./objectUrls.js').createUrlLedger>} [props.urls]
 *   the shared URL ledger the comparison leases its source URL from
 * @param {() => void} [props.restoreFocus] called when the owner removes the
 *   comparison (a new generation, another image) while it held focus and the
 *   opener is gone; never called after the person closes it
 */
export default function ImageComparison({
  image,
  sources,
  onClose,
  urls = null,
  restoreFocus = null,
}) {
  const titleId = useId();
  const selectId = useId();
  const dialog = useRef(null);
  const stage = useRef(null);
  const frameRef = useRef(null);
  const handle = useRef(null);
  const afterLayer = useRef(null);
  const closeButton = useRef(null);
  const [chosenId, setChosenId] = useState(() => defaultSourceId(sources));
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const [view, setView] = useState(FIT_VIEW);
  const [divider, setDivider] = useState(50);
  const [peek, setPeek] = useState(false);
  const [gesture, setGesture] = useState(null);
  const [afterNatural, setAfterNatural] = useState(null);
  const [before, setBefore] = useState({ blob: null, status: 'loading' });
  // A source kept in this browser is read only now, once, for the shown source.
  const [loaded, setLoaded] = useState(null);
  const beforeImage = useRef(null);
  const closing = useRef(false);
  const mounted = useRef(false);
  const focusFallback = useRef(restoreFocus);
  const loader = useRef(null);
  // The object URL this component created for the shown reference.
  const ownedUrl = useRef(null);
  const pointers = useRef(new Map());
  const pinch = useRef(null);
  const peekPointer = useRef(null);

  const chosen = sources.find((s) => s.id === chosenId) ?? null;
  const fallbackId = defaultSourceId(sources);
  const source = chosen ?? sources.find((s) => s.id === fallbackId) ?? null;
  // A chosen reference was removed from the draft while comparing.
  const replaced = Boolean(chosenId) && !chosen;
  const sourceId = source?.id ?? null;
  const lazy = Boolean(source && !source.blob && source.load);
  const loadedHere = loaded?.id === sourceId ? loaded : null;
  const loadStatus = lazy ? (loadedHere?.status ?? 'loading') : 'ready';
  const sourceBlob = source?.blob ?? loadedHere?.blob ?? null;

  const afterSize = describeImage(image).size ?? afterNatural;
  const beforeSize =
    (before.blob === sourceBlob ? before.natural : null) ??
    source?.dimensions ??
    null;
  const frame = fitBox(stageSize, afterSize ?? beforeSize);
  const frameRefSize = useRef(frame);
  useLayoutEffect(() => {
    frameRefSize.current = frame;
  });
  const shown = clampView(view, frame);
  const label = sourceLabel(source);
  const beforeStatus =
    !sourceBlob && !lazy
      ? 'missing'
      : lazy && loadStatus !== 'ready'
        ? loadStatus
        : before.blob === sourceBlob
          ? before.status
          : 'loading';

  useLayoutEffect(() => {
    loader.current = source?.load ?? null;
    focusFallback.current = restoreFocus;
  });

  const close = useCallback(() => {
    closing.current = true;
    onClose();
  }, [onClose]);

  // When the owner removes this comparison (a new generation replaces the
  // result, another image is chosen) while it held focus, focus would fall to
  // the page. The fallback is chosen by the owner; focus held elsewhere is
  // never taken. The check waits one microtask so a development remount
  // (StrictMode) does not count as removal.
  useLayoutEffect(() => {
    mounted.current = true;
    const node = dialog.current;
    return () => {
      mounted.current = false;
      const owned = Boolean(node?.contains(document.activeElement));
      if (!owned || closing.current) return;
      queueMicrotask(() => {
        if (!mounted.current) focusFallback.current?.();
      });
    };
  }, []);

  // Read a kept source's bytes now that the comparison is open. A source
  // removed, replaced or closed meanwhile aborts the read; its answer is
  // dropped, so no earlier file is ever shown as the current one.
  useEffect(() => {
    if (!lazy || !sourceId) return undefined;
    const controller = new AbortController();
    const id = sourceId;
    Promise.resolve()
      .then(() => loader.current?.({ signal: controller.signal }))
      .then(
        (blob) => {
          if (controller.signal.aborted) return;
          setLoaded(
            blob?.size
              ? { id, status: 'ready', blob }
              : { id, status: 'missing', blob: null },
          );
        },
        (error) => {
          if (controller.signal.aborted || error?.name === 'AbortError') return;
          setLoaded({
            id,
            status: 'error',
            blob: null,
            error: preserveError(error),
          });
        },
      );
    return () => controller.abort();
  }, [lazy, sourceId]);

  // Show the source through an object URL leased here: from the shared
  // ledger when the owner supplies one, else created directly. It is released
  // when the shown Blob changes or the comparison closes. The draft's own URL
  // for the same file is never retained, released or reused.
  useEffect(() => {
    const node = beforeImage.current;
    if (!sourceBlob || !node) return undefined;
    let url;
    try {
      url = urls ? urls.acquire(sourceBlob) : URL.createObjectURL(sourceBlob);
    } catch (cause) {
      let active = true;
      queueMicrotask(() => {
        if (active)
          setBefore({
            blob: sourceBlob,
            status: 'error',
            natural: null,
            diagnostic: localDiagnostic({
              category: 'reference-preview',
              reason: 'The browser could not create a comparison preview URL.',
              cause,
            }),
          });
      });
      return () => {
        active = false;
      };
    }
    ownedUrl.current = url;
    node.setAttribute('src', url);
    return () => {
      if (ownedUrl.current === url) ownedUrl.current = null;
      node.removeAttribute('src');
      if (urls) urls.release(url);
      else URL.revokeObjectURL(url);
    };
  }, [sourceBlob, sourceId, urls]);

  // Measure the stage now and whenever it resizes (window, rotation).
  useLayoutEffect(() => {
    const node = stage.current;
    if (!node) return undefined;
    let prev = { width: 0, height: 0 };
    const measure = () => {
      const next = { width: node.clientWidth, height: node.clientHeight };
      if (prev.width === next.width && prev.height === next.height) return;
      // Keep the same part of the image in view as the frame resizes.
      if (prev.width && prev.height) {
        const sx = next.width / prev.width;
        const sy = next.height / prev.height;
        setView((v) => ({ ...v, x: v.x * sx, y: v.y * sy }));
      }
      prev = next;
      setStageSize(next);
    };
    measure();
    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(measure);
      observer.observe(node);
      return () => observer.disconnect();
    }
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  useEffect(() => {
    (handle.current ?? closeButton.current ?? dialog.current)?.focus();
  }, []);

  // Wheel zoom needs a non-passive listener to keep the page from scrolling.
  useEffect(() => {
    const node = stage.current;
    if (!node) return undefined;
    const wheel = (event) => {
      event.preventDefault();
      // Nothing to zoom while no reference is shown.
      if (!frameRef.current) return;
      const box = frameRef.current.getBoundingClientRect();
      const pixels =
        event.deltaMode === 1 ? event.deltaY * LINE_HEIGHT_PX : event.deltaY;
      const factor = Math.exp(-pixels / WHEEL_PIXELS_PER_E);
      const point = { x: event.clientX - box.left, y: event.clientY - box.top };
      setView((v) =>
        zoomAt(
          clampView(v, frameRefSize.current),
          v.zoom * factor,
          frameRefSize.current,
          point,
        ),
      );
    };
    node.addEventListener('wheel', wheel, { passive: false });
    return () => node.removeEventListener('wheel', wheel);
  }, []);

  // A hold that the page loses (window switch) ends the peek.
  useEffect(() => {
    if (!peek) return undefined;
    const end = () => setPeek(false);
    window.addEventListener('blur', end);
    return () => window.removeEventListener('blur', end);
  }, [peek]);

  const framePoint = (event) => {
    const box = frameRef.current?.getBoundingClientRect();
    return box
      ? { x: event.clientX - box.left, y: event.clientY - box.top }
      : { x: 0, y: 0 };
  };

  const restartGesture = (current) => {
    const list = [...pointers.current.values()];
    if (list.length >= 2) {
      pinch.current = {
        type: 'pinch',
        distance: Math.max(1, pointerDistance(list[0], list[1])),
        mid: pointerMid(list[0], list[1]),
        view: current,
      };
      setGesture('pinch');
    } else if (list.length === 1) {
      pinch.current = { type: 'pan', start: list[0], view: current };
      setGesture('pan');
    } else {
      pinch.current = null;
      setGesture(null);
    }
  };

  const onStagePointerDown = (event) => {
    if (event.target.closest('button, .diagnostic-popover')) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    pointers.current.set(event.pointerId, framePoint(event));
    restartGesture(shown);
  };

  const onStagePointerMove = (event) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, framePoint(event));
    const g = pinch.current;
    if (!g) return;
    const list = [...pointers.current.values()];
    if (g.type === 'pinch' && list.length >= 2) {
      const mid = pointerMid(list[0], list[1]);
      const zoomed = zoomAt(
        g.view,
        (g.view.zoom * pointerDistance(list[0], list[1])) / g.distance,
        frame,
        g.mid,
      );
      setView(panBy(zoomed, mid.x - g.mid.x, mid.y - g.mid.y, frame));
    } else if (g.type === 'pan' && list.length === 1) {
      setView(
        panBy(g.view, list[0].x - g.start.x, list[0].y - g.start.y, frame),
      );
    }
  };

  const onStagePointerEnd = (event) => {
    if (!pointers.current.delete(event.pointerId)) return;
    restartGesture(shown);
  };

  const onStageKey = (event) => {
    if (event.target !== event.currentTarget) return;
    const next = viewForKey(event.key, shown, frame);
    if (!next) return;
    event.preventDefault();
    setView(next);
  };

  const onDoubleClick = (event) => {
    if (event.target.closest('button, .diagnostic-popover')) return;
    setView(
      shown.zoom > ZOOM_MIN
        ? FIT_VIEW
        : zoomAt(shown, DOUBLE_CLICK_ZOOM, frame, framePoint(event)),
    );
  };

  const onHandlePointerDown = (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.currentTarget.focus();
    setGesture('divider');
    setDivider(
      dividerFromPoint(
        event.clientX,
        frameRef.current?.getBoundingClientRect(),
      ),
    );
  };
  const onHandlePointerMove = (event) => {
    if (gesture !== 'divider') return;
    setDivider(
      dividerFromPoint(
        event.clientX,
        frameRef.current?.getBoundingClientRect(),
      ),
    );
  };
  const onHandlePointerEnd = (event) => {
    event.stopPropagation();
    if (gesture === 'divider') setGesture(null);
  };
  const onHandleKey = (event) => {
    const next = dividerForKey(event.key, divider);
    if (next === null) return;
    event.preventDefault();
    event.stopPropagation();
    setDivider(next);
  };

  const startPeek = (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    peekPointer.current = event.pointerId;
    setPeek(true);
  };
  const endPeek = (event) => {
    if (event && peekPointer.current !== event.pointerId) return;
    peekPointer.current = null;
    setPeek(false);
  };
  const onPeekKeyDown = (event) => {
    if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) {
      event.preventDefault();
      setPeek(true);
    }
  };
  const onPeekKeyUp = (event) => {
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      setPeek(false);
    }
  };

  const onDialogKey = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const nodes = [...dialog.current.querySelectorAll(FOCUSABLE)];
    if (!nodes.length) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === dialog.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const onAfterReady = useCallback(() => {
    const size = naturalSize(afterLayer.current?.querySelector('img'));
    if (size) setAfterNatural(size);
  }, []);

  // A late event from a URL that is no longer shown is ignored.
  const onBeforeLoad = (event) => {
    const node = event.currentTarget;
    if (!ownedUrl.current || node.getAttribute('src') !== ownedUrl.current)
      return;
    setBefore({
      blob: sourceBlob,
      status: 'ready',
      natural: naturalSize(node),
    });
  };
  const onBeforeError = (event) => {
    const node = event.currentTarget;
    if (!ownedUrl.current || node.getAttribute('src') !== ownedUrl.current)
      return;
    setBefore({ blob: sourceBlob, status: 'error', natural: null });
  };

  const zoomBy = (factor) =>
    setView((v) => zoomAt(clampView(v, frame), v.zoom * factor, frame));

  const measured = frame.width > 0 && frame.height > 0;
  const ratioSize = afterSize ?? beforeSize;
  const frameStyle = {
    ...(measured
      ? { width: `${frame.width}px`, height: `${frame.height}px` }
      : {
          width: '100%',
          aspectRatio: ratioSize
            ? `${ratioSize.width} / ${ratioSize.height}`
            : undefined,
        }),
    '--cmp-split': `${peek ? 100 : divider}%`,
  };
  const transform = viewTransform(shown);
  const beforeText = [label, sizeText(beforeSize)].filter(Boolean).join(' · ');
  const afterText = ['Result', sizeText(afterSize)].filter(Boolean).join(' · ');
  const roundedDivider = Math.round(divider);

  return createPortal(
    <div
      className="cmp-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <section
        ref={dialog}
        className="cmp-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onDialogKey}
      >
        <header className="cmp-bar">
          <h2 id={titleId} className="cmp-title">
            Compare
          </h2>
          {sources.length > 1 ? (
            <span className="cmp-choose">
              <label htmlFor={selectId}>With</label>
              <select
                id={selectId}
                className="field cmp-select"
                value={source?.id ?? ''}
                onChange={(event) => {
                  setChosenId(event.target.value);
                  setBefore({ blob: null, status: 'loading' });
                  setPeek(false);
                }}
              >
                {sources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {`${sourceLabel(s)} · ${s.name}`}
                  </option>
                ))}
              </select>
            </span>
          ) : null}
          <button
            ref={closeButton}
            type="button"
            className="icon-btn cmp-close"
            aria-label="Close comparison"
            onClick={close}
          >
            <Icon name="close" size={20} />
          </button>
        </header>
        {replaced && source ? (
          <p className="cmp-note" role="status">
            {`The chosen reference was removed. Showing ${label.toLowerCase()} ${source.name}.`}
          </p>
        ) : null}
        <div
          ref={stage}
          className="cmp-stage"
          data-gesture={gesture ?? undefined}
          data-zoomed={shown.zoom > ZOOM_MIN}
          tabIndex={source ? 0 : -1}
          role="group"
          aria-label="Comparison image"
          aria-describedby={source ? `${titleId}-keys` : undefined}
          onKeyDown={source ? onStageKey : undefined}
          onPointerDown={source ? onStagePointerDown : undefined}
          onPointerMove={onStagePointerMove}
          onPointerUp={onStagePointerEnd}
          onPointerCancel={onStagePointerEnd}
          onLostPointerCapture={onStagePointerEnd}
          onDoubleClick={source ? onDoubleClick : undefined}
        >
          <span id={`${titleId}-keys`} className="sr-only">
            Arrow keys pan, plus and minus zoom, 0 fits.
          </span>
          {source ? (
            <div
              ref={frameRef}
              className="cmp-frame"
              style={frameStyle}
              data-peek={peek}
            >
              <div className="cmp-layer" ref={afterLayer}>
                <div className="cmp-content" style={{ transform }}>
                  <SavedImg
                    image={image}
                    className="cmp-img"
                    loading="eager"
                    variant="original"
                    onReady={onAfterReady}
                  />
                </div>
              </div>
              <div className="cmp-layer cmp-before">
                <div className="cmp-content" style={{ transform }}>
                  <img
                    key={sourceId}
                    ref={beforeImage}
                    className="cmp-img"
                    alt={`${label}: ${source.name}`}
                    data-state={beforeStatus}
                    draggable={false}
                    onLoad={onBeforeLoad}
                    onError={onBeforeError}
                  />
                </div>
                {beforeStatus === 'error' ? (
                  <span className="cmp-missing" role="alert">
                    {lazy
                      ? loadedHere?.error?.network || loadedHere?.error?.status
                        ? `${label} could not be loaded.`
                        : `${label} could not be read from this browser.`
                      : `${label} could not be displayed.`}
                    <ErrorDetails
                      error={
                        lazy && loadStatus === 'error'
                          ? loadedHere?.error
                          : undefined
                      }
                      diagnostic={
                        (lazy && loadStatus === 'error'
                          ? loadedHere?.error?.diagnostic
                          : null) ??
                        (before.blob === sourceBlob
                          ? before.diagnostic
                          : null) ??
                        localDiagnostic({
                          category: 'reference-preview',
                          reason:
                            'The browser could not decode the comparison source.',
                        })
                      }
                      label="Comparison source error details"
                    />
                  </span>
                ) : beforeStatus === 'missing' ? (
                  <span className="cmp-missing" role="alert">
                    {lazy
                      ? `${label} is no longer kept in this browser.`
                      : `${label} file is unavailable in this browser.`}
                    <ErrorDetails
                      diagnostic={localDiagnostic({
                        category: 'reference-storage',
                        reason:
                          'The comparison source file is unavailable in this browser.',
                      })}
                      label="Missing comparison source details"
                    />
                  </span>
                ) : lazy && beforeStatus === 'loading' ? (
                  <span className="cmp-missing" role="status">
                    {`Loading ${label.toLowerCase()}…`}
                  </span>
                ) : null}
              </div>
              <span className="cmp-tag cmp-tag-before">{beforeText}</span>
              <span className="cmp-tag cmp-tag-after">{afterText}</span>
              <div
                ref={handle}
                className="cmp-handle"
                role="slider"
                tabIndex={0}
                aria-label="Divider"
                aria-orientation="horizontal"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={roundedDivider}
                aria-valuetext={`${roundedDivider}% ${label.toLowerCase()}, ${100 - roundedDivider}% result`}
                data-dragging={gesture === 'divider'}
                onPointerDown={onHandlePointerDown}
                onPointerMove={onHandlePointerMove}
                onPointerUp={onHandlePointerEnd}
                onPointerCancel={onHandlePointerEnd}
                onLostPointerCapture={onHandlePointerEnd}
                onKeyDown={onHandleKey}
              >
                <span className="cmp-handle-line" aria-hidden="true" />
                <span className="cmp-handle-grip" aria-hidden="true" />
              </div>
            </div>
          ) : (
            <p className="cmp-empty" role="status">
              No source is available to compare.
            </p>
          )}
        </div>
        <footer className="cmp-tools">
          <div className="cmp-zoom" role="group" aria-label="Zoom">
            <button
              type="button"
              className="icon-btn"
              aria-label="Zoom out"
              disabled={!source || shown.zoom <= ZOOM_MIN}
              onClick={() => zoomBy(1 / ZOOM_STEP)}
            >
              <MinusGlyph />
            </button>
            <output className="cmp-zoom-value" aria-live="polite">
              {`${Math.round(shown.zoom * 100)}%`}
            </output>
            <button
              type="button"
              className="icon-btn"
              aria-label="Zoom in"
              disabled={!source || shown.zoom >= ZOOM_MAX}
              onClick={() => zoomBy(ZOOM_STEP)}
            >
              <Icon name="plus" size={18} />
            </button>
            <button
              type="button"
              className="btn"
              disabled={
                !source || (shown.zoom === 1 && shown.x === 0 && shown.y === 0)
              }
              onClick={() => setView(FIT_VIEW)}
            >
              Fit
            </button>
          </div>
          {source ? (
            <button
              type="button"
              className="btn cmp-peek"
              aria-pressed={peek}
              disabled={lazy && loadStatus !== 'ready'}
              onPointerDown={startPeek}
              onPointerUp={endPeek}
              onPointerCancel={endPeek}
              onLostPointerCapture={endPeek}
              onKeyDown={onPeekKeyDown}
              onKeyUp={onPeekKeyUp}
              onBlur={() => setPeek(false)}
              onContextMenu={(event) => event.preventDefault()}
              onClick={(event) => event.preventDefault()}
            >
              <Icon name="eye" size={18} />
              {`Hold for ${label.toLowerCase()}`}
            </button>
          ) : null}
          {source && aspectsDiffer(beforeSize, afterSize) ? (
            <p className="cmp-note">
              Different aspect ratios, fitted separately
            </p>
          ) : null}
        </footer>
      </section>
    </div>,
    document.body,
  );
}
