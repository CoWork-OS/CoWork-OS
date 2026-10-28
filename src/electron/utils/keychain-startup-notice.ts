import { BrowserWindow } from "electron";

const NOTICE_DELAY_MS = 2000;
const NOTICE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
    <title>Waiting for macOS Keychain</title>
    <style>
      body { margin: 0; padding: 26px; font: 14px -apple-system, BlinkMacSystemFont, sans-serif; color: #252525; background: #fff; }
      h1 { margin: 0 0 12px; font-size: 19px; }
      p { margin: 0 0 12px; line-height: 1.45; }
      @media (prefers-color-scheme: dark) { body { color: #f1f1f1; background: #272729; } }
    </style>
  </head>
  <body>
    <h1>Waiting for macOS Keychain</h1>
    <p>CoWork OS needs access to its encrypted settings to finish starting. Check for a macOS Keychain prompt and respond to continue.</p>
    <p>Your settings remain encrypted while you wait.</p>
  </body>
</html>`;

/** Show status while macOS waits for the person to respond to its Keychain prompt. */
export function showKeychainStartupNotice(): () => void {
  const window = new BrowserWindow({
    width: 480,
    height: 210,
    title: "Waiting for macOS Keychain",
    show: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    closable: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.once("ready-to-show", () => {
    if (!window.isDestroyed()) window.show();
  });
  void window
    .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(NOTICE_HTML)}`)
    .catch((error) => console.warn("Could not show the Keychain startup notice:", error));
  return () => {
    if (!window.isDestroyed()) window.destroy();
  };
}

/**
 * Keep startup gated on the original operation. The notice is only a status indication:
 * it neither changes Keychain access nor substitutes a less protected storage path.
 */
export async function withKeychainStartupNotice<T>(
  operation: () => Promise<T>,
  options: {
    enabled: boolean;
    show: () => () => void;
    onError?: (error: unknown) => void;
    delayMs?: number;
  },
): Promise<T> {
  if (!options.enabled) return operation();
  let closeNotice: (() => void) | undefined;
  const timer = setTimeout(() => {
    try {
      closeNotice = options.show();
    } catch (error) {
      options.onError?.(error);
    }
  }, options.delayMs ?? NOTICE_DELAY_MS);
  try {
    return await operation();
  } finally {
    clearTimeout(timer);
    closeNotice?.();
  }
}
