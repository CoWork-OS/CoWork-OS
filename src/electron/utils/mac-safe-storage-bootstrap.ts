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

/**
 * Chromium's `--use-mock-keychain` (Playwright's Electron loader adds it with its other
 * test switches) makes safeStorage use a fixed mock key instead of the OS keychain, so
 * settings encrypted by a normal launch read as a keychain key change.
 */
export const MOCK_KEYCHAIN_SWITCH = "use-mock-keychain";

export function keychainMismatchMessage(mockKeychain: boolean, acceptEnv: string): string {
  if (mockKeychain) {
    return (
      `Launched with --${MOCK_KEYCHAIN_SWITCH}, so the real Keychain is not in use and existing ` +
      "settings cannot be read; changes will not be saved. When driving the app with Playwright, " +
      "pass executablePath to _electron.launch (see scripts/qa/electron-launch.mjs) to keep the real " +
      `Keychain, or use a disposable profile. ${acceptEnv} is ignored for mock-keychain launches.`
    );
  }
  return `The OS keychain key differs from the one that encrypted existing settings. Settings changes will not be saved until the original keychain access is restored, or relaunch with ${acceptEnv}=1 to archive unreadable settings and continue with the current key.`;
}

/** Never archive real settings in favour of a mock key. */
export function shouldAdoptNewKeychainKey(
  acceptEnvValue: string | undefined,
  mockKeychain: boolean,
): boolean {
  return acceptEnvValue === "1" && !mockKeychain;
}
