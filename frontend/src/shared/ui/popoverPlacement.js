/**
 * Where a fixed-position popover goes so it stays inside the viewport.
 *
 * @param {{left: number, top: number, right: number, bottom: number}} anchor
 * @param {{width: number, height: number}} box the popover's layout size
 * @param {{width: number, height: number}} viewport
 * @param {number} edge gap to the anchor and minimum gap to the viewport edge
 * @returns {{left: number, top: number, maxHeight: number}}
 */
export function placePopover(anchor, box, viewport, edge = 8) {
  const width = Math.min(box.width, viewport.width - edge * 2);
  const left = Math.max(
    edge,
    Math.min(anchor.left, viewport.width - width - edge),
  );
  const below = anchor.bottom + edge;
  const roomBelow = viewport.height - below - edge;
  const roomAbove = anchor.top - edge * 2;
  const flip = roomBelow < box.height && roomAbove > roomBelow;
  const room = Math.max(flip ? roomAbove : roomBelow, 96);
  const height = Math.min(box.height, room);
  const top = flip ? Math.max(edge, anchor.top - edge - height) : below;
  return { left, top, maxHeight: room };
}
