import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';

import { describeImage } from '../../data/records/imageRecord.js';
import { Icon } from '../../shared/ui/ui.jsx';
import { SavedImg } from '../../data/media/SavedImg.jsx';
import './FullImageView.css';

/** Delay before retrying focus after browsers finish their native fullscreen exit. */
const FULLSCREEN_FOCUS_RESTORE_DELAY_MS = 100;

function cancelFocusRestore(frame, timer) {
  if (frame.current !== null) window.cancelAnimationFrame(frame.current);
  if (timer.current !== null) window.clearTimeout(timer.current);
  frame.current = null;
  timer.current = null;
}

/** Opens the selected saved image at its source dimensions and aspect ratio. */
export default function FullImageView({ image, watermark = null }) {
  const [open, setOpen] = useState(false);
  const [native, setNative] = useState(false);
  const frame = useRef(null);
  const trigger = useRef(null);
  const close = useRef(null);
  const wasOpen = useRef(false);
  const requestId = useRef(0);
  const restoreFrame = useRef(null);
  const restoreTimer = useRef(null);
  const view = describeImage(image);
  const ratio = view.size
    ? `${view.size.width} / ${view.size.height}`
    : undefined;

  const restoreTriggerFocus = () => {
    cancelFocusRestore(restoreFrame, restoreTimer);
    const forRequest = requestId.current;
    const returnFocus = () => {
      cancelFocusRestore(restoreFrame, restoreTimer);
      const active = document.activeElement;
      if (
        requestId.current === forRequest &&
        trigger.current?.isConnected &&
        (active === document.body ||
          active === frame.current ||
          active === close.current)
      )
        trigger.current.focus();
    };
    restoreFrame.current = window.requestAnimationFrame(returnFocus);
    restoreTimer.current = window.setTimeout(
      returnFocus,
      FULLSCREEN_FOCUS_RESTORE_DELAY_MS,
    );
  };

  useEffect(() => {
    if (!open) return undefined;
    const escape = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        requestId.current += 1;
        if (document.fullscreenElement === frame.current) {
          document.exitFullscreen().then(
            () => {
              setOpen(false);
              restoreTriggerFocus();
            },
            () => {
              setOpen(false);
              restoreTriggerFocus();
            },
          );
        } else {
          setOpen(false);
        }
      }
    };
    const fullscreen = () => {
      if (document.fullscreenElement === frame.current) setNative(true);
      else if (native) {
        setOpen(false);
        restoreTriggerFocus();
      }
    };
    document.addEventListener('keydown', escape);
    document.addEventListener('fullscreenchange', fullscreen);
    return () => {
      document.removeEventListener('keydown', escape);
      document.removeEventListener('fullscreenchange', fullscreen);
    };
  }, [open, native]);

  useEffect(
    () => () => {
      requestId.current += 1;
      cancelFocusRestore(restoreFrame, restoreTimer);
    },
    [],
  );

  useLayoutEffect(() => {
    if (open) {
      wasOpen.current = true;
      close.current?.focus();
      return undefined;
    }
    if (wasOpen.current) {
      wasOpen.current = false;
      trigger.current?.focus();
    }
    return undefined;
  }, [open]);

  const show = async () => {
    cancelFocusRestore(restoreFrame, restoreTimer);
    const mine = ++requestId.current;
    flushSync(() => setOpen(true));
    setNative(false);
    // Native fullscreen needs to be called directly from the user gesture.
    const target = frame.current;
    if (!target?.requestFullscreen) return;
    try {
      await target.requestFullscreen();
      if (requestId.current !== mine) {
        if (document.fullscreenElement === target) {
          await document.exitFullscreen().catch(() => {});
        }
        return;
      }
      setNative(document.fullscreenElement === target);
    } catch {
      // The enlarged accessible dialog is the supported fallback.
    }
  };

  const dismiss = async () => {
    requestId.current += 1;
    if (document.fullscreenElement === frame.current) {
      try {
        await document.exitFullscreen();
        setOpen(false);
        restoreTriggerFocus();
      } catch {
        setOpen(false);
        restoreTriggerFocus();
      }
    } else {
      setOpen(false);
    }
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="btn"
        onClick={show}
        aria-label="View image full screen"
      >
        <Icon name="expand" size={18} />
        Full view
      </button>
      {open
        ? createPortal(
            <div
              className="full-image-backdrop"
              data-native={native}
              onPointerDown={(event) => {
                if (event.target === event.currentTarget && !native) dismiss();
              }}
            >
              <section
                ref={frame}
                className="full-image-view"
                role="dialog"
                aria-modal="true"
                aria-label={image.title || 'Full image view'}
                tabIndex={-1}
                style={{
                  aspectRatio: ratio,
                  '--full-image-ratio': view.size
                    ? view.size.width / view.size.height
                    : 1,
                }}
                onKeyDown={(event) => {
                  // Close is the only control: keep focus on it.
                  if (event.key !== 'Tab') return;
                  event.preventDefault();
                  close.current?.focus();
                }}
              >
                <button
                  ref={close}
                  type="button"
                  className="full-image-close"
                  aria-label="Close full image view"
                  onClick={dismiss}
                >
                  <Icon name="close" size={20} />
                </button>
                <SavedImg
                  image={image}
                  className="full-image"
                  loading="eager"
                  variant="original"
                  watermark={watermark}
                />
              </section>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
