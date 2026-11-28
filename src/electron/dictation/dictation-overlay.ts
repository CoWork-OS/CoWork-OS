/**
 * The dictation overlay window: a pill near the bottom of the screen that never takes focus,
 * so the app in front keeps its text cursor and receives the paste.
 *
 * The page lives in its own in-memory session that may use the microphone (audio only) and
 * nothing else. That session answers one file: URL from memory, so the page is a secure
 * context (a data: URL is not, and cannot record) and never exists on disk to be swapped.
 */
import { BrowserWindow, screen, session, type Session } from "electron";
import { createLogger } from "../utils/logger";
import type { DictationOverlayLike, DictationView } from "./dictation-controller";
import {
  DICTATION_OVERLAY_HEIGHT,
  DICTATION_OVERLAY_WIDTH,
  buildDictationOverlayHtml,
  parseDictationAction,
  type DictationOverlayAction,
} from "./dictation-overlay-html";

const logger = createLogger("Dictation");

const OVERLAY_PARTITION = "cowork-dictation-overlay";
/** Served from memory by the overlay session; nothing is read from this path on disk. */
export const DICTATION_OVERLAY_URL = "file:///cowork-dictation/overlay.html";
const BOTTOM_MARGIN = 72;

let configuredSession: Session | null = null;

/** Is this the overlay page? Only the overlay uses this session, so its URL is enough. */
function isOverlayPage(contents: Electron.WebContents | null | undefined): boolean {
  return Boolean(
    contents && !contents.isDestroyed() && contents.getURL() === DICTATION_OVERLAY_URL,
  );
}

/** The overlay's session, set up once per run (the setting can be turned off and on). */
function overlaySession(): Session {
  if (configuredSession) return configuredSession;
  const overlay = session.fromPartition(OVERLAY_PARTITION);
  // The only page this session can load: anything else is refused.
  if (!overlay.protocol.isProtocolHandled("file")) {
    overlay.protocol.handle("file", (request) =>
      request.url === DICTATION_OVERLAY_URL
        ? new Response(buildDictationOverlayHtml(), {
            headers: { "content-type": "text/html; charset=utf-8" },
          })
        : new Response("Not found", { status: 404 }),
    );
  }
  // The page may record audio and do nothing else that needs a permission.
  overlay.setPermissionRequestHandler((contents, permission, callback, details) => {
    const mediaTypes = (details as { mediaTypes?: string[] }).mediaTypes ?? [];
    callback(
      permission === "media" &&
        isOverlayPage(contents) &&
        mediaTypes.length > 0 &&
        mediaTypes.every((type) => type === "audio"),
    );
  });
  overlay.setPermissionCheckHandler(
    (contents, permission, _origin, details) =>
      permission === "media" &&
      isOverlayPage(contents) &&
      (details as { mediaType?: string }).mediaType === "audio",
  );
  configuredSession = overlay;
  return overlay;
}

export class DictationOverlay implements DictationOverlayLike {
  private window: BrowserWindow | null = null;
  private loading: Promise<void> | null = null;

  constructor(private readonly onAction: (action: DictationOverlayAction) => void) {}

  async show(view: DictationView): Promise<void> {
    const win = await this.ensureWindow();
    if (!win) return;
    await this.run(
      win,
      `window.__dictation.setState(${JSON.stringify(view.state)}, ${JSON.stringify(view.message)})`,
    );
    if (!win.isVisible()) {
      win.setBounds(this.bounds());
      // showInactive: the app in front stays active and keeps its text cursor.
      win.showInactive();
    }
  }

  async start(): Promise<{ ok: boolean; error?: string }> {
    const win = await this.ensureWindow();
    if (!win) return { ok: false, error: "Error" };
    const result = (await this.run(win, "window.__dictation.start()")) as {
      ok?: unknown;
      error?: unknown;
    } | null;
    if (result && result.ok === true) return { ok: true };
    return { ok: false, error: typeof result?.error === "string" ? result.error : "Error" };
  }

  async stop(): Promise<Uint8Array | null> {
    const win = this.window;
    if (!win || win.isDestroyed()) return null;
    const audio = await this.run(win, "window.__dictation.stop()");
    // Only bytes are accepted back from the page.
    return audio instanceof Uint8Array ? audio : null;
  }

  async cancel(): Promise<void> {
    const win = this.window;
    if (!win || win.isDestroyed()) return;
    await this.run(win, "window.__dictation.cancel()");
  }

  hide(): void {
    const win = this.window;
    if (win && !win.isDestroyed() && win.isVisible()) win.hide();
  }

  destroy(): void {
    const win = this.window;
    this.window = null;
    this.loading = null;
    if (win && !win.isDestroyed()) win.destroy();
  }

  private async run(win: BrowserWindow, script: string): Promise<unknown> {
    try {
      return await win.webContents.executeJavaScript(script, true);
    } catch (error) {
      logger.warn(
        `Dictation overlay script failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /** Bottom centre of the display the pointer is on, above the Dock. */
  private bounds(): Electron.Rectangle {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const area = display.workArea;
    return {
      x: Math.round(area.x + (area.width - DICTATION_OVERLAY_WIDTH) / 2),
      y: Math.round(area.y + area.height - DICTATION_OVERLAY_HEIGHT - BOTTOM_MARGIN),
      width: DICTATION_OVERLAY_WIDTH,
      height: DICTATION_OVERLAY_HEIGHT,
    };
  }

  private isOverlay(contents: Electron.WebContents | null | undefined): boolean {
    const win = this.window;
    return Boolean(contents && win && !win.isDestroyed() && contents === win.webContents);
  }

  private async ensureWindow(): Promise<BrowserWindow | null> {
    if (this.window && !this.window.isDestroyed()) {
      await this.loading;
      return this.window;
    }
    const isMac = process.platform === "darwin";
    const win = new BrowserWindow({
      ...this.bounds(),
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      alwaysOnTop: true,
      ...(isMac ? { type: "panel" as const } : {}),
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        session: overlaySession(),
        // Keeps the level meter and the recorder running while the app is in the background.
        backgroundThrottling: false,
        spellcheck: false,
      },
    });
    this.window = win;
    win.setAlwaysOnTop(true, "floating");
    if (isMac) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.webContents.on("will-navigate", (event) => event.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("console-message", (details) => {
      if (!this.isOverlay(win.webContents) || !isOverlayPage(win.webContents)) return;
      const action = parseDictationAction(details.message);
      if (action) this.onAction(action);
    });
    win.on("closed", () => {
      if (this.window === win) {
        this.window = null;
        this.loading = null;
      }
    });

    this.loading = win.loadURL(DICTATION_OVERLAY_URL).catch((error) => {
      logger.warn(
        `Could not load the dictation overlay: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.destroy();
    });
    await this.loading;
    return this.window && !this.window.isDestroyed() ? this.window : null;
  }
}
