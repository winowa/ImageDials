import React, {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import { placePopover } from './popoverPlacement.js';
import { Icon } from './ui.jsx';
import './ResultMenu.css';

const EDGE_PX = 8;

/**
 * Whether any part of `node` is visible through every scrolling ancestor and
 * the viewport. A menu whose trigger has scrolled out of its pane closes
 * instead of floating over unrelated content.
 */
export function anchorVisible(node) {
  if (!node?.isConnected) return false;
  const rect = node.getBoundingClientRect();
  let top = rect.top;
  let bottom = rect.bottom;
  let left = rect.left;
  let right = rect.right;
  const clip = (box) => {
    top = Math.max(top, box.top);
    bottom = Math.min(bottom, box.bottom);
    left = Math.max(left, box.left);
    right = Math.min(right, box.right);
  };
  for (let el = node.parentElement; el; el = el.parentElement) {
    if (el === document.body || el === document.documentElement) break;
    const style = getComputedStyle(el);
    const overflow = `${style.overflow} ${style.overflowX} ${style.overflowY}`;
    if (!/(auto|scroll|hidden|clip)/.test(overflow)) continue;
    const box = el.getBoundingClientRect();
    // An unmeasured box carries no clipping evidence.
    if (box.width || box.height) clip(box);
  }
  clip({
    top: 0,
    left: 0,
    bottom: window.innerHeight,
    right: window.innerWidth,
  });
  // A zero-size rect (jsdom, display:none) has no clipping evidence; only a
  // rect that had size and lost it all to clipping counts as hidden.
  if (rect.width === 0 && rect.height === 0) return true;
  return bottom > top && right > left;
}

/**
 * Contextual result actions behind one "More" menu button. Items that do not
 * apply are left out by the caller, which renders no menu when none apply.
 * Keyboard: Enter, Space or arrow keys open; arrows, Home and End move;
 * Escape closes and returns focus; Tab closes and continues from the trigger.
 * An outside press or the trigger closes it too.
 *
 * The list is portaled to `document.body` and positioned in viewport
 * coordinates: an ancestor with a transform, containment or its own stacking
 * context (a sticky scrolling pane, an animating row) would otherwise become
 * its containing block, misplace it, or let neighbouring layers such as the
 * split handle sit above it. It follows its trigger through page and pane
 * scrolling, resizing and rotation, and closes once the trigger scrolls out
 * of view.
 *
 * `compact` renders an icon-only trigger (`triggerIcon`) for a row's own
 * actions; `label` is then its accessible name.
 *
 * An item with a boolean `checked` is a single choice among the menu's
 * checkable items (`menuitemradio`); its mark shows the current choice.
 * `triggerClassName` replaces the trigger's button classes (a control joined
 * to another button) without changing its behavior.
 *
 * @param {{items: Array<{id: string, label: string,
 *   icon?: string|import('react').ReactNode,
 *   hint?: string, disabled?: boolean, busy?: boolean, checked?: boolean,
 *   onSelect: () => void}>, label?: string, compact?: boolean,
 *   triggerIcon?: import('react').ReactNode, triggerClassName?: string,
 *   heading?: string}} props
 * The ref exposes `focus()` for returning focus to the trigger.
 */
const ResultMenu = forwardRef(function ResultMenu(
  {
    items,
    label = 'More actions',
    compact = false,
    triggerIcon = null,
    triggerClassName = null,
    heading = null,
    hoverFocus = false,
  },
  ref,
) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const positioned = pos !== null;
  const trigger = useRef(null);
  const menu = useRef(null);
  const wrap = useRef(null);
  // Which item takes focus once the menu is shown: 'first' or 'last'.
  const initial = useRef('first');
  const passive = useRef(false);
  const hoverTimer = useRef(null);
  const suppressFocus = useRef(false);
  useEffect(() => () => clearTimeout(hoverTimer.current), []);
  const headingId = useId();
  const id = useId();
  const busy = items.some((item) => item.busy);

  useImperativeHandle(ref, () => ({
    focus: () => {
      suppressFocus.current = true;
      trigger.current?.focus();
      suppressFocus.current = false;
    },
  }));

  const nodes = () =>
    menu.current
      ? [
          ...menu.current.querySelectorAll(
            '[role="menuitem"], [role="menuitemradio"]',
          ),
        ]
      : [];

  const close = useCallback((returnFocus) => {
    clearTimeout(hoverTimer.current);
    setOpen(false);
    setPos(null);
    if (returnFocus) {
      suppressFocus.current = true;
      trigger.current?.focus({ preventScroll: true });
      suppressFocus.current = false;
    }
  }, []);

  const place = useCallback(() => {
    if (!trigger.current || !menu.current) return;
    if (!anchorVisible(trigger.current)) {
      const hadFocus = menu.current.contains(document.activeElement);
      setOpen(false);
      setPos(null);
      if (hadFocus) trigger.current.focus({ preventScroll: true });
      return;
    }
    // Copy the fields explicitly: a DOMRect's values are prototype getters,
    // so spreading one yields an empty object and NaN coordinates.
    const rect = trigger.current.getBoundingClientRect();
    const anchor = {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
    };
    const box = {
      width: menu.current.offsetWidth,
      height: menu.current.offsetHeight,
    };
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    // Right-align with the trigger, as the actions row ends there.
    const right = { ...anchor, left: anchor.right - box.width };
    const placed = placePopover(right, box, viewport, EDGE_PX);
    setPos({ ...placed, side: placed.top < anchor.top ? 'above' : 'below' });
  }, []);

  useLayoutEffect(() => {
    if (!open) return undefined;
    place();
    const viewport = window.visualViewport;
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    viewport?.addEventListener('resize', place);
    viewport?.addEventListener('scroll', place);
    // Content above the trigger can grow or shrink without any scroll event.
    const observer =
      typeof ResizeObserver === 'function' ? new ResizeObserver(place) : null;
    observer?.observe(document.body);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      viewport?.removeEventListener('resize', place);
      viewport?.removeEventListener('scroll', place);
      observer?.disconnect();
    };
  }, [open, place]);

  useLayoutEffect(() => {
    // Browsers refuse focus while the measuring portal is visibility:hidden.
    // Wait for its coordinates to commit; repositioning must not steal focus.
    if (!open || !positioned || passive.current) return;
    const list = nodes();
    const checked = list.find(
      (node) => node.getAttribute('aria-checked') === 'true',
    );
    const target =
      checked ?? (initial.current === 'last' ? list.at(-1) : list[0]);
    target?.focus({ preventScroll: true });
  }, [open, positioned]);

  useEffect(() => {
    if (!open) return undefined;
    // The list lives in a portal, so it is checked separately from the
    // trigger's wrapper.
    const outside = (event) => {
      if (wrap.current?.contains(event.target)) return;
      if (menu.current?.contains(event.target)) return;
      close(false);
    };
    const escape = (event) => {
      if (hoverFocus && event.key === 'Escape')
        close(
          wrap.current?.contains(document.activeElement) ||
            menu.current?.contains(document.activeElement),
        );
    };
    document.addEventListener('keydown', escape);
    document.addEventListener('pointerdown', outside);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open, close, hoverFocus]);

  if (!items.length) return null;

  const show = (which) => {
    clearTimeout(hoverTimer.current);
    const wasPassive = passive.current;
    passive.current = false;
    if (open && wasPassive) {
      const list = nodes();
      (which === 'last' ? list.at(-1) : list[0])?.focus({
        preventScroll: true,
      });
    }
    initial.current = which;
    setOpen(true);
  };

  const onTriggerKey = (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      show('first');
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      show('last');
    }
  };

  const onMenuKey = (event) => {
    const list = nodes();
    const at = list.indexOf(document.activeElement);
    const move = (index) => {
      event.preventDefault();
      list[(index + list.length) % list.length]?.focus();
    };
    switch (event.key) {
      case 'ArrowDown':
        move(at + 1);
        break;
      case 'ArrowUp':
        move(at - 1);
        break;
      case 'Home':
        move(0);
        break;
      case 'End':
        move(list.length - 1);
        break;
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        close(true);
        break;
      case 'Tab':
        // The portaled list sits at the end of the document; hand focus back
        // to the trigger first so the browser's Tab moves on from there.
        trigger.current?.focus({ preventScroll: true });
        close(false);
        break;
      default:
    }
  };

  const choose = (item) => {
    if (item.disabled || item.busy) return;
    close(true);
    item.onSelect();
  };

  return (
    <span
      className="result-menu"
      ref={wrap}
      onMouseEnter={() => {
        if (hoverFocus) {
          clearTimeout(hoverTimer.current);
          if (!open) {
            passive.current = true;
            setOpen(true);
          }
        }
      }}
      onMouseLeave={() => {
        if (hoverFocus && passive.current)
          hoverTimer.current = setTimeout(() => {
            if (passive.current) close(false);
          }, 200);
      }}
      onFocus={(event) => {
        if (menu.current?.contains(event.target)) passive.current = false;
        if (hoverFocus && !open && !suppressFocus.current) {
          passive.current = true;
          setOpen(true);
        }
      }}
      onBlur={(event) => {
        if (
          hoverFocus &&
          !wrap.current?.contains(event.relatedTarget) &&
          !menu.current?.contains(event.relatedTarget)
        )
          close(false);
      }}
      onKeyDown={(event) => {
        if (hoverFocus && event.key === 'Escape') {
          event.stopPropagation();
          close(true);
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        className={`${
          triggerClassName ?? (compact ? 'icon-btn quiet' : 'btn')
        } result-menu-trigger`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-busy={busy || undefined}
        aria-label={label}
        data-open={open}
        data-compact={compact || undefined}
        onClick={() =>
          open && !passive.current ? close(false) : show('first')
        }
        onKeyDown={onTriggerKey}
      >
        {compact ? (
          triggerIcon
        ) : (
          <>
            More
            <span className="result-menu-chevron" aria-hidden="true">
              <Icon name="chevron" size={16} />
            </span>
          </>
        )}
      </button>
      {open
        ? createPortal(
            <div
              ref={menu}
              id={id}
              role="menu"
              aria-label={heading ? undefined : label}
              aria-labelledby={heading ? headingId : undefined}
              className="result-menu-list"
              data-side={pos?.side}
              style={
                pos
                  ? { left: pos.left, top: pos.top, maxHeight: pos.maxHeight }
                  : { left: 0, top: 0, visibility: 'hidden' }
              }
              onMouseEnter={() => clearTimeout(hoverTimer.current)}
              onMouseLeave={() => {
                if (hoverFocus && passive.current)
                  hoverTimer.current = setTimeout(() => {
                    if (passive.current) close(false);
                  }, 200);
              }}
              onPointerDown={(event) => {
                passive.current = false;
                event.stopPropagation();
              }}
              onClick={(event) => event.stopPropagation()}
              onKeyDown={onMenuKey}
            >
              {heading ? (
                <span className="result-menu-heading" id={headingId}>
                  {heading}
                </span>
              ) : null}
              {items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role={
                    typeof item.checked === 'boolean'
                      ? 'menuitemradio'
                      : 'menuitem'
                  }
                  aria-checked={
                    typeof item.checked === 'boolean' ? item.checked : undefined
                  }
                  tabIndex={-1}
                  className="result-menu-item"
                  aria-disabled={item.disabled || item.busy || undefined}
                  aria-busy={item.busy || undefined}
                  onClick={() => choose(item)}
                >
                  {typeof item.checked === 'boolean' ? (
                    <span className="result-menu-check" aria-hidden="true">
                      <Icon name="check" size={18} />
                    </span>
                  ) : null}
                  {typeof item.icon === 'string' ? (
                    <Icon name={item.icon} size={18} />
                  ) : (
                    (item.icon ?? null)
                  )}
                  <span className="result-menu-text">
                    <span>{item.label}</span>
                    {item.hint ? (
                      <span className="result-menu-hint">{item.hint}</span>
                    ) : null}
                  </span>
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </span>
  );
});

export default ResultMenu;
