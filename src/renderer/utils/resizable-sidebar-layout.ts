export const RESIZABLE_SIDEBAR_MIN_WIDTH = 420;
export const RESIZABLE_MAIN_MIN_WIDTH = 390;
export const RESIZABLE_DIVIDER_WIDTH = 8;

export interface ResizableSidebarWidthConstraints {
  minWidth: number;
  maxWidth: number;
}

export function getResizableSidebarWidthConstraints(
  containerWidth: number,
): ResizableSidebarWidthConstraints {
  const availableWidth = Number.isFinite(containerWidth) ? Math.max(0, containerWidth) : 0;
  const maxWidth = Math.max(0, availableWidth - RESIZABLE_MAIN_MIN_WIDTH - RESIZABLE_DIVIDER_WIDTH);

  return {
    minWidth: Math.min(RESIZABLE_SIDEBAR_MIN_WIDTH, maxWidth),
    maxWidth,
  };
}

export function clampResizableSidebarWidth(width: number, containerWidth: number): number {
  const { minWidth, maxWidth } = getResizableSidebarWidthConstraints(containerWidth);
  const requestedWidth = Number.isFinite(width) ? width : minWidth;
  return Math.min(Math.max(requestedWidth, minWidth), maxWidth);
}
