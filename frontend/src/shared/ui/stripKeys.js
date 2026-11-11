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
