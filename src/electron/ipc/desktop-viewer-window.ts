import type { BrowserWindow } from "electron";

export type DesktopViewerWindow = Pick<
  BrowserWindow,
  "isDestroyed" | "isMinimized" | "restore" | "show" | "focus" | "loadURL"
> & { webContents: Pick<BrowserWindow["webContents"], "getURL"> };

/**
 * Brings an already open desktop viewer to the front instead of opening a second one.
 * A minimized viewer is restored first: focus() alone leaves it in the Dock.
 * Returns false when there is no live viewer to reuse.
 */
export async function reuseDesktopViewer(
  existing: DesktopViewerWindow | undefined,
  url: string,
): Promise<boolean> {
  if (!existing || existing.isDestroyed()) return false;
  if (existing.webContents.getURL() !== url) await existing.loadURL(url);
  if (existing.isMinimized()) existing.restore();
  existing.show();
  existing.focus();
  return true;
}
