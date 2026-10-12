export interface FloatingPosition {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
}

/** Keep a body-portaled menu inside the viewport, opening above when space below runs out. */
export function getFloatingPosition(
  anchor: Pick<DOMRect, "right" | "bottom" | "top">,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
): FloatingPosition {
  const padding = 12;
  const gap = 8;
  const width = Math.min(size.width, Math.max(0, viewport.width - padding * 2));
  const maxHeight = Math.max(0, viewport.height - padding * 2);
  const height = Math.min(size.height, maxHeight);
  const below = anchor.bottom + gap;
  const above = anchor.top - gap - height;
  return {
    left: Math.max(padding, Math.min(anchor.right - width, viewport.width - width - padding)),
    top: Math.max(
      padding,
      Math.min(
        below + height <= viewport.height - padding ? below : above,
        viewport.height - height - padding,
      ),
    ),
    width,
    maxHeight,
  };
}
