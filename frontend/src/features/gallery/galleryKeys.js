/**
 * Gallery shortcuts as a pure decision, so the rules that keep them from
 * hijacking other controls are testable without a DOM walk.
 */

/** Elements with their own keyboard handling: text, sliders, menus, dialogs. */
const OWN_KEYS =
  'input:not([type="checkbox"]), select, textarea, [contenteditable], [role="dialog"], [role="slider"], [role="listbox"], [role="menu"]';
/** Elements that Space activates; Space there must still do that. */
const SPACE_ACTIVATES =
  'button, a[href], summary, input[type="checkbox"], [role="button"], [role="checkbox"], [role="switch"], [role="tab"]';

/** @returns {'previous'|'next'|'chrome'|'filmstrip'|null} */
export function galleryShortcut(event) {
  if (
    event.defaultPrevented ||
    event.isComposing ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey
  )
    return null;
  const target = event.target;
  if (target?.closest?.(OWN_KEYS)) return null;
  switch (event.key) {
    case 'ArrowRight':
      return 'next';
    case 'ArrowLeft':
      return 'previous';
    case ' ':
    case 'Spacebar':
      return target?.closest?.(SPACE_ACTIVATES) ? null : 'chrome';
    case 'Escape':
    case 'h':
    case 'H':
      return 'chrome';
    case 'c':
    case 'C':
      return 'filmstrip';
    default:
      return null;
  }
}
