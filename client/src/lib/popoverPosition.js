/** Fit a menu to the visible viewport, preferring space below its trigger. */
export function getPopoverPosition({
  anchor, menuWidth, menuHeight, viewport, align = 'start', gap = 4,
}) {
  const inset = 8;
  const leftEdge = (viewport.left || 0) + inset;
  const topEdge = (viewport.top || 0) + inset;
  const maxWidth = Math.max(0, viewport.width - inset * 2);
  const rightEdge = leftEdge + maxWidth;
  const bottomEdge = topEdge + Math.max(0, viewport.height - inset * 2);
  const belowTop = Math.max(topEdge, Math.min(bottomEdge, anchor.bottom + gap));
  const aboveBottom = Math.max(topEdge, Math.min(bottomEdge, anchor.top - gap));
  const below = bottomEdge - belowTop;
  const above = aboveBottom - topEdge;
  const openAbove = menuHeight > below && above > below;
  const maxHeight = openAbove ? above : below;
  const width = Math.min(menuWidth, maxWidth);
  const alignedLeft = align === 'end' ? anchor.right - width : anchor.left;

  return {
    left: Math.max(leftEdge, Math.min(alignedLeft, rightEdge - width)),
    top: openAbove ? aboveBottom - Math.min(menuHeight, maxHeight) : belowTop,
    maxHeight,
    maxWidth,
  };
}
