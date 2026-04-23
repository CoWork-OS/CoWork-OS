export interface RevealableWindow {
  isDestroyed?: () => boolean;
  isMinimized: () => boolean;
  restore: () => void;
  isVisible: () => boolean;
  show: () => void;
  focus: () => void;
}

export function revealWindow(window: RevealableWindow | null | undefined): boolean {
  if (!window) return false;
  if (typeof window.isDestroyed === "function" && window.isDestroyed()) {
    return false;
  }

  if (window.isMinimized()) {
    window.restore();
  }
  if (!window.isVisible()) {
    window.show();
  }
  window.focus();
  return true;
}
