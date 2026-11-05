import { ErrorDetails } from './ErrorDetails.jsx';
import React, {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import { VARIANT_KIND } from './cachePolicy.js';
import {
  describeImage,
  imageKey,
  isBrowserUpload,
  isLocalOnly,
} from './imageRecord.js';
import { STORAGE_STATE } from './privateHistory.js';
import { useVariantLookup } from './variantSrc.js';
import WatermarkMark from './WatermarkMark.jsx';

const PATHS = {
  github:
    'M8 20c-4 1-4-2-6-2m16 4v-4c0-1-.4-2-1-2.5 3-.4 5-1.8 5-5.5 0-1.4-.5-2.5-1.3-3.4.2-.9.2-2-.4-3.1-1.5 0-2.7.8-3.5 1.4a13 13 0 0 0-7.6 0C8.4 4.3 7.2 3.5 5.7 3.5c-.6 1.1-.6 2.2-.4 3.1C4.5 7.5 4 8.6 4 10c0 3.7 2 5.1 5 5.5-.6.5-1 1.5-1 2.5v4',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0-6v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5',
  moon: 'M20 15a8.5 8.5 0 0 1-11-11 8.5 8.5 0 1 0 11 11Z',
  chevron: 'm9 6 6 6-6 6',
  unfold: 'm7 15 5 5 5-5M7 9l5-5 5 5',
  fold: 'm7 20 5-5 5 5M7 4l5 5 5-5',
  prev: 'm15 6-6 6 6 6',
  next: 'm9 6 6 6-6 6',
  play: 'M8 5v14l11-7Z',
  pause: 'M8 5v14M16 5v14',
  download: 'M12 4v11m0 0-4-4m4 4 4-4M5 20h14',
  edit: 'M4 20h4L19 9l-4-4L4 16v4Z',
  trash: 'M5 7h14M10 7V4h4v3m-7 0 1 13h8l1-13',
  spark: 'm12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8Z',
  plus: 'M12 5v14M5 12h14',
  upload: 'M12 16V5m0 0-4 4m4-4 4 4M5 20h14',
  close: 'M6 6l12 12M18 6 6 18',
  warning: 'M12 4 3 20h18L12 4Zm0 6v4m0 3v.01',
  refresh: 'M20 11a8 8 0 1 0-2.3 6M20 4v7h-7',
  info: 'M12 11v5m0-8.5v.01M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z',
  gallery: 'M4 5h3v14H4zM9.5 5h5v14h-5zM17 5h3v14h-3z',
  print: 'M7 9V4h10v5M7 17H5v-6h14v6h-2M7 14h10v6H7z',
  cube: 'm12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Zm0 9 8-4.5M12 12 4 7.5M12 12v9',
  // A four-point AI sparkle with a tall and a square diamond beside it.
  sparkles:
    'M9.5 6.5 11.1 11l4.4 1.6-4.4 1.6-1.6 4.3-1.6-4.3-4.4-1.6L7.9 11ZM17.5 2.5l1.1 2.75-1.1 2.75-1.1-2.75ZM18 14.75l1.75 1.75L18 18.25l-1.75-1.75Z',
  pencil: 'M4 20h4L19 9l-4-4L4 16v4ZM13 7l4 4',
  send: 'M21 3 10 14M21 3l-7 18-4-7-7-4 18-7Z',
  down: 'M12 5v14m0 0-6-6m6 6 6-6',
  undo: 'M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
  check: 'm5 12 5 5 9-10',
  eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Zm10-3a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z',
  'eye-off':
    'M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3 3.9M6.6 6.7A17 17 0 0 0 2 12s3.6 7 10 7a10 10 0 0 0 4.2-.9M9.9 9.9a3 3 0 0 0 4.2 4.2',
  search: 'm21 21-4.3-4.3M17 11a6 6 0 1 1-12 0 6 6 0 0 1 12 0Z',
  stamp: 'M9 4h6v6l3 4H6l3-4V4ZM5 20h14M6 17h12',
  bulb: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.4 1.1 2.2h5c0-.8.4-1.6 1.1-2.2A6 6 0 0 0 12 3Z',
  history: 'M3 12a9 9 0 1 0 3-6.7M3 4v5h5M12 8v4.5l3 1.5',
  bookmark: 'M7 4h10v16l-5-3.5L7 20Z',
  gear: 'M18.82 10.04 21.09 10.56 21.09 13.44 18.82 13.96 18.21 15.44 19.44 17.41 17.41 19.44 15.44 18.21 13.96 18.82 13.44 21.09 10.56 21.09 10.04 18.82 8.56 18.21 6.59 19.44 4.56 17.41 5.79 15.44 5.18 13.96 2.91 13.44 2.91 10.56 5.18 10.04 5.79 8.56 4.56 6.59 6.59 4.56 8.56 5.79 10.04 5.18 10.56 2.91 13.44 2.91 13.96 5.18 15.44 5.79 17.41 4.56 19.44 6.59 18.21 8.56Z M15.2 12a3.2 3.2 0 1 0-6.4 0 3.2 3.2 0 0 0 6.4 0Z',
  library:
    'M7 3h13a1 1 0 0 1 1 1v13M4 7h12a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1Zm-1 10 4-4 3 3 2-2 5 5M12 10h.01',
  palette:
    'M12 3a9 9 0 1 0 0 18c1.1 0 1.8-.8 1.8-1.7 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-.9.8-1.6 1.7-1.6H17a4 4 0 0 0 4-4c0-4.4-4-8.3-9-8.3ZM7.5 11.5v.01M10 7.5v.01M14.5 7.5v.01',
  scan: 'M4 8V5a1 1 0 0 1 1-1h3m8 0h3a1 1 0 0 1 1 1v3M4 16v3a1 1 0 0 0 1 1h3m8 0h3a1 1 0 0 0 1-1v-3M8 12h8',
  braces:
    'M9 4C7 4 6 5 6 7v2c0 1.5-1 3-3 3 2 0 3 1.5 3 3v2c0 2 1 3 3 3M15 4c2 0 3 1 3 3v2c0 1.5 1 3 3 3-2 0-3 1.5-3 3v2c0 2-1 3-3 3',
  copy: 'M9 9h10v11H9zM5 15V4h10',
  expand:
    'M8 3H5a2 2 0 0 0-2 2v3m13-5h3a2 2 0 0 1 2 2v3M3 16v3a2 2 0 0 0 2 2h3m13-5v3a2 2 0 0 1-2 2h-3',
};

export function Icon({ name, size = 20 }) {
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
      className={`icon icon-${name}`}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

/** Styled popover tooltip: hover, keyboard focus and touch focus. */
export function Tip({ label, children, hidden = false }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const wrap = useRef(null);
  const bubble = useRef(null);
  const id = useId();

  useLayoutEffect(() => {
    if (!open || !wrap.current || !bubble.current) return;
    const a = wrap.current.getBoundingClientRect();
    const b = bubble.current.getBoundingClientRect();
    const margin = 8;
    let left = a.left + a.width / 2 - b.width / 2;
    left = Math.max(
      margin,
      Math.min(left, window.innerWidth - b.width - margin),
    );
    let top = a.bottom + 8;
    if (top + b.height > window.innerHeight - margin)
      top = a.top - b.height - 8;
    setPos({ left, top: Math.max(margin, top) });
  }, [open, label]);

  useEffect(() => {
    if (!open) return undefined;
    const close = () => setOpen(false);
    const outside = (event) => {
      if (!wrap.current?.contains(event.target)) close();
    };
    // A hover-opened tooltip has no focus inside it, so its own handler never
    // hears Escape; dismiss it here. It does not stop the event: the focused
    // control (a dialog, say) still receives Escape.
    const escape = (event) => {
      if (event.key !== 'Escape' || hidden) return;
      if (wrap.current?.contains(document.activeElement)) return;
      close();
      setPos(null);
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape, true);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape, true);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open, hidden]);

  const show = () => setOpen(true);
  const hide = () => {
    setOpen(false);
    setPos(null);
  };

  return (
    <span
      ref={wrap}
      className="tip"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open && !hidden) {
          hide();
          event.stopPropagation();
        }
      }}
      aria-describedby={open ? id : undefined}
    >
      {children}
      {open &&
        !hidden &&
        createPortal(
          <span
            ref={bubble}
            id={id}
            role="tooltip"
            className="tip-bubble"
            style={pos ?? { left: 0, top: 0, visibility: 'hidden' }}
          >
            {label}
          </span>,
          document.body,
        )}
    </span>
  );
}

/** Gap between a popover and its trigger, and minimum distance from the viewport edge. */
const POPOVER_OFFSET_PX = 8;
/** Pause before a hover-opened popover closes, so the pointer can cross into it. */
const POPOVER_LEAVE_GRACE_MS = 160;

/**
 * Structured information popover. Opens on hover and keyboard focus, and
 * stays open when pressed or tapped; Escape, an outside press, focus leaving,
 * or pressing the trigger again closes it. The panel is a sibling of the
 * trigger, so its content is reachable in tab order, and fixed-positioned so
 * scrolling containers cannot clip it.
 *
 * `informational` marks a panel that holds text only. Its container then stays
 * out of the Tab order (tabIndex -1: still reachable by a press or tap, and
 * Escape still returns focus to the trigger). Leave it unset for a panel with
 * links, buttons or fields, whose container keeps its existing tab stop.
 * Opening on hover, focus and tap is identical either way.
 */
export function InfoPopover({
  label,
  triggerLabel = null,
  children,
  icon = 'info',
  className,
  triggerClassName = 'icon-btn info-btn',
  iconSize = 18,
  panelClassName = '',
  align = 'start',
  triggerContent = null,
  informational = false,
}) {
  const [state, setState] = useState('closed');
  const [pos, setPos] = useState(null);
  const wrap = useRef(null);
  const trigger = useRef(null);
  const panel = useRef(null);
  const leaveTimer = useRef(null);
  // Set while Escape hands focus back, so that focus does not reopen the panel.
  const returningFocus = useRef(false);
  const id = useId();
  const open = state !== 'closed';

  const place = useCallback(() => {
    if (!trigger.current || !panel.current) return;
    const anchor = trigger.current.getBoundingClientRect();
    // Layout size, so the entrance scale animation cannot skew placement.
    const box = {
      width: panel.current.offsetWidth,
      height: panel.current.offsetHeight,
    };
    const edge = POPOVER_OFFSET_PX;
    const wanted = align === 'end' ? anchor.right - box.width : anchor.left;
    const left = Math.max(
      edge,
      Math.min(wanted, window.innerWidth - box.width - edge),
    );
    const below = anchor.bottom + edge;
    const roomBelow = window.innerHeight - below - edge;
    const roomAbove = anchor.top - edge * 2;
    const flip = roomBelow < box.height && roomAbove > roomBelow;
    const room = flip ? roomAbove : roomBelow;
    setPos({
      left,
      top: flip
        ? Math.max(edge, anchor.top - edge - Math.min(box.height, room))
        : below,
      maxHeight: Math.max(room, 96),
    });
  }, [align]);

  useLayoutEffect(() => {
    if (!open) return undefined;
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, place]);

  useEffect(() => {
    if (!open) return undefined;
    const outside = (event) => {
      if (!wrap.current?.contains(event.target)) setState('closed');
    };
    // A hover-opened panel has no focus inside, so its own handler misses Escape.
    const escape = (event) => {
      if (event.key !== 'Escape') return;
      if (wrap.current?.contains(document.activeElement)) return;
      clearTimeout(leaveTimer.current);
      setState('closed');
      setPos(null);
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape, true);
    };
  }, [open]);

  useEffect(() => () => clearTimeout(leaveTimer.current), []);

  const close = () => {
    clearTimeout(leaveTimer.current);
    setState('closed');
    setPos(null);
  };
  const hoverOpen = () => {
    if (returningFocus.current) return;
    clearTimeout(leaveTimer.current);
    setState((s) => (s === 'closed' ? 'hover' : s));
  };
  const hoverLeave = () => {
    clearTimeout(leaveTimer.current);
    leaveTimer.current = setTimeout(
      () => setState((s) => (s === 'hover' ? 'closed' : s)),
      POPOVER_LEAVE_GRACE_MS,
    );
  };

  return (
    <span
      ref={wrap}
      className={`popover-anchor ${className ?? ''}`}
      onMouseEnter={hoverOpen}
      onMouseLeave={hoverLeave}
      onFocus={(event) => {
        // Focus inside the panel means it is in use: keep it open.
        if (panel.current?.contains(event.target)) {
          clearTimeout(leaveTimer.current);
          setState('pinned');
        } else hoverOpen();
      }}
      onPointerDown={(event) => {
        if (panel.current?.contains(event.target)) {
          clearTimeout(leaveTimer.current);
          setState('pinned');
        }
      }}
      onBlur={(event) => {
        if (!wrap.current?.contains(event.relatedTarget)) close();
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !open) return;
        event.stopPropagation();
        close();
        returningFocus.current = true;
        trigger.current?.focus();
        returningFocus.current = false;
      }}
    >
      <button
        ref={trigger}
        type="button"
        className={triggerClassName}
        aria-label={triggerLabel ?? label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        data-pinned={state === 'pinned'}
        onClick={() => (state === 'pinned' ? close() : setState('pinned'))}
      >
        {triggerContent ?? <Icon name={icon} size={iconSize} />}
      </button>
      {open ? (
        <div
          ref={panel}
          id={id}
          role="dialog"
          aria-label={label}
          tabIndex={informational ? -1 : 0}
          className={`popover ${panelClassName}`.trim()}
          style={pos ?? { left: 0, top: 0, visibility: 'hidden' }}
        >
          {children}
        </div>
      ) : null}
    </span>
  );
}

export function Disclosure({
  title,
  children,
  defaultOpen = false,
  meta,
  onToggle,
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <div className="disclosure" data-open={open}>
      <button
        type="button"
        className="disclosure-head"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          setOpen(!open);
          onToggle?.(!open);
        }}
      >
        <Icon name="chevron" size={18} />
        <span>{title}</span>
        {meta ? <span className="disclosure-meta">{meta}</span> : null}
      </button>
      <div className="disclosure-body" id={id} inert={!open}>
        <div className="disclosure-inner">{children}</div>
      </div>
    </div>
  );
}

export { JsonTree } from './JsonTree.jsx';

export function Segmented({
  legend,
  name,
  value,
  options,
  onChange,
  disabled,
}) {
  return (
    <fieldset className="segmented" disabled={disabled}>
      <legend>{legend}</legend>
      <div className="segmented-track">
        {options.map((o) => (
          <label key={o.value} className="segment">
            <input
              type="radio"
              name={name}
              value={o.value}
              checked={value === o.value}
              onChange={() => onChange(o.value)}
            />
            <span>
              {o.glyph ? (
                <i className="glyph" style={{ aspectRatio: o.glyph }} />
              ) : null}
              {o.label}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

const FOCUSABLE = 'button, a[href], input, select, textarea, [tabindex="0"]';

/**
 * Modal dialog shell: a backdrop that closes on an outside press, Escape to
 * close, and Tab kept inside. The caller returns focus to its opener on close.
 * @param {object} props
 * @param {string} props.label accessible name
 * @param {() => void} props.onClose
 * @param {boolean} [props.locked] ignore every way of closing (work in progress)
 * @param {boolean} [props.pressClosesBackdrop] outside presses close (default true)
 */
export function Modal({
  label,
  onClose,
  locked = false,
  pressClosesBackdrop = true,
  className = '',
  children,
}) {
  const dialog = useRef(null);

  useEffect(() => {
    dialog.current?.focus();
  }, []);

  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      if (!locked) onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const nodes = [...dialog.current.querySelectorAll(FOCUSABLE)].filter(
      (node) => !node.disabled && !node.closest('[inert]'),
    );
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

  return (
    <div
      className="backdrop"
      onPointerDown={(event) =>
        event.target === event.currentTarget &&
        pressClosesBackdrop &&
        !locked &&
        onClose()
      }
    >
      <div
        className={`dialog ${className}`}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        ref={dialog}
        onKeyDown={onKeyDown}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * A saved image from the canonical file route. `variant="thumbnail"` asks for
 * the small JPEG and falls back to the original bytes if that cannot load.
 * With `watermark` ({settings, placement?}) the shared watermark is drawn over
 * the displayed image; the container must be positioned.
 */
export function SavedImg({
  image,
  className,
  loading = 'lazy',
  variant = 'thumbnail',
  watermark = null,
  onReady = undefined,
  onUnavailable = undefined,
}) {
  const [failedUrls, setFailedUrls] = useState([]);
  const imgRef = useRef(null);
  const view = describeImage(image);
  const kind =
    variant === 'original' ? VARIANT_KIND.FULL : VARIANT_KIND.THUMBNAIL;
  const lookup = useVariantLookup(image, kind);
  const privateMedia =
    Number.isFinite(image.local_added_at) &&
    lookup.media?.accepts?.(image) === true;
  const localOnly = privateMedia || isBrowserUpload(image);
  const privateIdentity = privateMedia
    ? JSON.stringify([imageKey(image), image.local_added_at])
    : null;
  const [recovery, setRecovery] = useState({
    identity: null,
    lease: null,
    loading: false,
  });
  const recoveryAttempt = useRef({
    identity: null,
    attempted: false,
    controller: null,
  });
  const localUrl = isBrowserUpload(image)
    ? variant === 'original'
      ? view.originalUrl
      : view.thumbnailUrl
    : '';
  const networkSources = localOnly
    ? localUrl.startsWith('blob:')
      ? [localUrl]
      : []
    : variant === 'original'
      ? [view.originalUrl]
      : [view.thumbnailUrl, view.originalUrl];
  useEffect(() => {
    if (recoveryAttempt.current.identity === privateIdentity) return;
    recoveryAttempt.current.controller?.abort();
    recoveryAttempt.current = {
      identity: privateIdentity,
      attempted: false,
      controller: null,
    };
    setRecovery({ identity: privateIdentity, lease: null, loading: false });
  }, [privateIdentity]);
  useEffect(() => () => recoveryAttempt.current.controller?.abort(), []);
  useEffect(() => () => recovery.lease?.release(), [recovery]);
  // A cached copy that failed to display is dropped and the network takes over.
  const cachedUrl =
    lookup.status === 'hit' && !failedUrls.includes(lookup.url)
      ? lookup.url
      : null;
  const recoveredUrl =
    recovery.identity === privateIdentity
      ? (recovery.lease?.url ?? null)
      : null;
  const pending =
    lookup.status === 'pending' ||
    (recovery.identity === privateIdentity && recovery.loading);
  const src = pending
    ? undefined
    : recoveredUrl && !failedUrls.includes(recoveredUrl)
      ? recoveredUrl
      : [cachedUrl, ...networkSources].find(
          (url) => url && !failedUrls.includes(url),
        );
  const unavailable = !pending && !src;
  const report = useRef(onUnavailable);
  useLayoutEffect(() => {
    report.current = onUnavailable;
  });
  // Reported once every source (cache and network) has failed.
  useEffect(() => {
    if (unavailable) report.current?.();
  }, [unavailable]);
  if (unavailable)
    return (
      <div
        className={`img-missing ${className ?? ''}`}
        role="img"
        aria-label={view.title}
      >
        Image unavailable
      </div>
    );
  const onLoad = () => {
    // Only the network copy of the variant that was asked for is worth keeping.
    if (src === networkSources[0] && lookup.status === 'miss')
      lookup.media.capture(image, kind, src);
    onReady?.(src);
  };
  const onError = () => {
    if (src === cachedUrl) lookup.media.drop(image, kind);
    setFailedUrls((urls) => [...urls, src]);
    const attempt = recoveryAttempt.current;
    if (
      privateIdentity &&
      kind === VARIANT_KIND.THUMBNAIL &&
      attempt.identity === privateIdentity &&
      !attempt.attempted &&
      typeof lookup.media?.recoverThumbnail === 'function'
    ) {
      attempt.attempted = true;
      const controller = new AbortController();
      attempt.controller = controller;
      setRecovery({ identity: privateIdentity, lease: null, loading: true });
      lookup.media
        .recoverThumbnail(image, { signal: controller.signal })
        .then((lease) => {
          if (controller.signal.aborted) {
            lease?.release();
            return;
          }
          setRecovery({ identity: privateIdentity, lease, loading: false });
        })
        .catch(() => {
          if (!controller.signal.aborted)
            setRecovery({
              identity: privateIdentity,
              lease: null,
              loading: false,
            });
        });
    }
  };
  return (
    <>
      <img
        ref={imgRef}
        className={pending ? `${className ?? ''} img-pending` : className}
        src={src}
        alt={image.alt_text || image.title || image.prompt}
        width={view.size?.width}
        height={view.size?.height}
        loading={loading}
        decoding="async"
        onLoad={onLoad}
        onError={onError}
      />
      {watermark ? (
        <WatermarkMark
          image={image}
          imgRef={imgRef}
          settings={watermark.settings}
          placement={watermark.placement}
        />
      ) : null}
    </>
  );
}

/**
 * Explicit delete confirmation that names the image. Failure keeps the
 * confirmation open and shows the reason; cancelling changes nothing.
 */
export function DeleteConfirm({
  image,
  busy,
  error,
  diagnostic,
  onConfirm,
  onCancel,
}) {
  const { title } = describeImage(image);
  const local = isLocalOnly(image);
  const cancel = useRef(null);
  useEffect(() => {
    cancel.current?.focus();
  }, []);
  return (
    <div
      className="confirm"
      role="group"
      aria-label={`${local ? 'Remove' : 'Delete'} ${title}`}
    >
      <p className="confirm-text">
        {local ? (
          <>
            Remove <strong>{title}</strong> from this browser? This cannot be
            undone; nothing is deleted on the server.
            {image.local_storage &&
            image.local_storage.state !== STORAGE_STATE.STORED &&
            image.local_storage.held ? (
              <>
                {' '}
                It is not stored in this browser, so the copy held in this tab
                is lost.
              </>
            ) : null}
          </>
        ) : (
          <>
            Delete <strong>{title}</strong>? This cannot be undone.
          </>
        )}
      </p>
      {error ? (
        <p className="error-text" role="alert">
          <ErrorDetails error={error} diagnostic={diagnostic} />
          {error}
        </p>
      ) : null}
      <div className="confirm-actions">
        <button
          type="button"
          className="btn danger"
          disabled={busy}
          onClick={onConfirm}
        >
          <Icon name="trash" size={18} />
          {local ? 'Remove from browser' : 'Delete'}
        </button>
        <button
          type="button"
          className="btn"
          ref={cancel}
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/** A moment, as milliseconds since the epoch, in the viewer's locale. */
export function formatMoment(milliseconds) {
  const date = new Date(milliseconds);
  if (milliseconds === null || Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

/** When an image was saved, from its normalized view data. */
export const formatSaved = (image) =>
  formatMoment(describeImage(image).createdAtMs);

/** Fraction of a strip's visible width that Page Up/Down scrolls. */
const STRIP_PAGE_FRACTION = 0.9;

/**
 * Keyboard navigation for a horizontal strip of buttons: arrows move focus
 * (which scrolls the focused item into view), Home/End jump to the ends, and
 * Page Up/Down scroll a page. Attach to the scrolling list element.
 */
export function handleStripKeys(event) {
  const strip = event.currentTarget;
  const items = [...strip.querySelectorAll('button:not(:disabled)')];
  const at = items.indexOf(document.activeElement);
  const move = (index) => {
    event.preventDefault();
    items[Math.min(items.length - 1, Math.max(0, index))]?.focus();
  };
  const scrollPage = (direction) => {
    event.preventDefault();
    const calm = window.matchMedia?.(
      '(prefers-reduced-motion: reduce)',
    ).matches;
    strip.scrollBy({
      left: direction * strip.clientWidth * STRIP_PAGE_FRACTION,
      behavior: calm ? 'auto' : 'smooth',
    });
  };
  if (event.key === 'ArrowRight' && at >= 0) move(at + 1);
  else if (event.key === 'ArrowLeft' && at >= 0) move(at - 1);
  else if (event.key === 'Home') move(0);
  else if (event.key === 'End') move(items.length - 1);
  else if (event.key === 'PageDown') scrollPage(1);
  else if (event.key === 'PageUp') scrollPage(-1);
}

export const providerLabel = (value) =>
  value === 'mock' ? 'Mock (not real inference)' : (value ?? 'unknown');
