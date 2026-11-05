import React, {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { ErrorDetails } from './ErrorDetails.jsx';
import { Disclosure, Icon, Tip } from './ui.jsx';

/** Distance kept between the popover and the viewport edge or its trigger. */
const EDGE_PX = 8;
/** Below this much free height beside the trigger the panel uses the viewport. */
const MIN_ROOM_PX = 200;

const clamp = (value, low, high) => Math.max(low, Math.min(value, high));

function IdeaSkeleton() {
  return (
    <div className="skeleton ideas-skeleton" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <span key={i} style={{ '--i': i }} />
      ))}
    </div>
  );
}

/**
 * Prompt ideas for the current mode, opened from an icon inside the prompt
 * field. The studio warms its per-mode cache after the page paints, independently
 * of this panel. Choosing an idea replaces the prompt and closes the panel.
 *
 * Non-modal dialog: Escape, an outside press, focus moving elsewhere, the close
 * button or the trigger itself dismiss it. It is fixed-positioned so scrolling
 * panes cannot clip it, and fitted to the visible viewport.
 */
export default function IdeasPopover({ studio, onPick }) {
  const { suggestions, draft, inferenceOff } = studio;
  const { status, items, error } = suggestions;
  const loading = status === 'loading';
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const wrap = useRef(null);
  const trigger = useRef(null);
  const panel = useRef(null);
  const id = useId();
  const asset = draft.mode === 'asset-image';

  const place = useCallback(() => {
    const anchor = trigger.current?.getBoundingClientRect();
    const box = panel.current;
    if (!anchor || !box) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Natural height first, so the choice below does not depend on a clamp
    // left by an earlier placement. Nothing paints between these reads.
    const clamped = box.style.maxHeight;
    box.style.maxHeight = 'none';
    const natural = box.offsetHeight;
    box.style.maxHeight = clamped;
    const width = box.offsetWidth;
    const left = clamp(anchor.right - width, EDGE_PX, vw - width - EDGE_PX);
    const roomBelow = vh - anchor.bottom - EDGE_PX * 2;
    const roomAbove = anchor.top - EDGE_PX * 2;
    const below =
      natural <= roomBelow || (natural > roomAbove && roomBelow >= roomAbove);
    const room = below ? roomBelow : roomAbove;
    if (room < MIN_ROOM_PX) {
      // A short viewport (phone landscape, keyboard open): use all of it.
      setPos({ left, top: EDGE_PX, maxHeight: Math.max(vh - EDGE_PX * 2, 96) });
      return;
    }
    const height = Math.min(natural, room);
    setPos({
      left,
      top: below ? anchor.bottom + EDGE_PX : anchor.top - EDGE_PX - height,
      maxHeight: room,
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return undefined;
    place();
    const onScroll = (event) => {
      if (!panel.current?.contains(event.target)) place();
    };
    window.addEventListener('resize', place);
    window.addEventListener('scroll', onScroll, true);
    window.visualViewport?.addEventListener('resize', place);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', onScroll, true);
      window.visualViewport?.removeEventListener('resize', place);
    };
  }, [open, place]);

  // Content changes size (loading, ideas, errors): fit again.
  useLayoutEffect(() => {
    if (open) place();
  }, [open, place, status, items, error]);

  // Focus moves into the panel on open: the first idea once there is one,
  // otherwise the panel itself. Ideas arriving later take focus only from it.
  const placed = useRef(false);
  useEffect(() => {
    if (!open) {
      placed.current = false;
      return;
    }
    const box = panel.current;
    // A hidden (not yet positioned) panel cannot take focus.
    if (!pos || !box || placed.current) return;
    const first = box.querySelector('.idea');
    if (first) {
      placed.current = true;
      first.focus({ preventScroll: true });
    } else if (status === 'ready' || inferenceOff) {
      placed.current = true;
      box.focus({ preventScroll: true });
    } else if (!box.contains(document.activeElement)) {
      box.focus({ preventScroll: true });
    }
  }, [open, pos, items, status, inferenceOff]);

  useEffect(() => {
    if (!open) return undefined;
    const outside = (event) => {
      if (!wrap.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  const close = (restoreFocus = false) => {
    setOpen(false);
    setPos(null);
    if (restoreFocus) trigger.current?.focus();
  };

  const toggle = () => {
    if (open) close();
    else setOpen(true);
  };

  const label = `Prompt ideas for ${asset ? 'asset images' : 'images'}`;

  return (
    <span
      ref={wrap}
      className="ideas-anchor"
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (open && next && !wrap.current?.contains(next)) close();
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !open) return;
        event.stopPropagation();
        close(true);
      }}
    >
      <Tip label="Prompt ideas" hidden={open}>
        <button
          ref={trigger}
          type="button"
          className="icon-btn round"
          aria-label="Prompt ideas"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          data-pinned={open}
          onClick={toggle}
        >
          <Icon name="bulb" />
        </button>
      </Tip>
      {open ? (
        <div
          ref={panel}
          id={id}
          role="dialog"
          aria-label={label}
          aria-busy={loading}
          tabIndex={-1}
          className="popover ideas-popover"
          style={pos ?? { left: 0, top: 0, visibility: 'hidden' }}
        >
          <div className="ideas-head">
            <p className="ideas-intro">No ideas? We got you.</p>
            <Tip label="Refresh ideas">
              <button
                type="button"
                className="icon-btn quiet"
                aria-label="Refresh ideas"
                disabled={loading || inferenceOff}
                onClick={suggestions.refresh}
              >
                <Icon name="refresh" size={18} />
              </button>
            </Tip>
            <Tip label="Close ideas">
              <button
                type="button"
                className="icon-btn quiet"
                aria-label="Close ideas"
                onClick={() => close(true)}
              >
                <Icon name="close" size={18} />
              </button>
            </Tip>
          </div>
          <div className="ideas-body">
            {inferenceOff && !items.length ? (
              <p className="control-status" role="status">
                Ideas need a text model, and none is enabled on the server.
              </p>
            ) : null}
            {error ? (
              <div className="error-text" role="alert">
                <span>
                  {items.length
                    ? 'Ideas could not be refreshed'
                    : 'Ideas could not be loaded'}
                  : {error.message}{' '}
                </span>
                <ErrorDetails error={error} />
                <button
                  type="button"
                  className="link-btn"
                  disabled={loading}
                  onClick={suggestions.refresh}
                >
                  Retry
                </button>
                {error.details ? (
                  <Disclosure title="Details">
                    <pre className="final-prompt">{error.details}</pre>
                  </Disclosure>
                ) : null}
              </div>
            ) : null}
            {items.length ? (
              <ul className="idea-list" data-loading={loading}>
                {items.map((idea) => (
                  <li key={idea}>
                    <button
                      type="button"
                      className="idea"
                      onClick={() => {
                        onPick(idea);
                        close();
                      }}
                    >
                      {idea}
                    </button>
                  </li>
                ))}
              </ul>
            ) : loading ? (
              <>
                <IdeaSkeleton />
                <span className="sr-only" role="status">
                  Loading ideas
                </span>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </span>
  );
}
