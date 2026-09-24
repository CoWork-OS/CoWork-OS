import { BrowserWindow } from "electron";

interface DisposableWindow {
  loadURL(url: string): Promise<void>;
  destroy(): void;
}

type BootstrapWindowFactory = () => DisposableWindow;

/**
 * Prime Electron's macOS app-specific Keychain service before safeStorage is
 * first used. Electron updates the service name after creating a BrowserWindow;
 * calling safeStorage first can otherwise use Chromium's generic key and make
 * existing CoWork settings appear unreadable.
 */
export async function primeMacSafeStorageContext(
  platform: NodeJS.Platform = process.platform,
  createBootstrapWindow: BootstrapWindowFactory = () =>
    new BrowserWindow({ show: false, width: 1, height: 1 }),
): Promise<boolean> {
  if (platform !== "darwin") {
    return false;
  }

  const bootstrapWindow = createBootstrapWindow();
  try {
    await bootstrapWindow.loadURL("data:text/html,<html><body></body></html>");
  } finally {
    bootstrapWindow.destroy();
  }
  return true;
}
