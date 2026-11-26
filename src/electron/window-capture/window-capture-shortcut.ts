import { BrowserWindow, desktopCapturer, globalShortcut } from "electron";
import { IPC_CHANNELS, type WindowCaptureResult } from "../../shared/types";
import { ChronicleSourceResolver } from "../chronicle/ChronicleSourceResolver";
import { getMacScreenCaptureAccessStatus } from "../computer-use/computer-use-permissions";
import { isTesseractInstalled, runOcrFromImagePath } from "../ipc/image-viewer-ocr";
import { createLogger } from "../utils/logger";
import {
  captureFrontWindow,
  type CapturableWindow,
  type WindowCaptureDeps,
} from "./window-capture";

const logger = createLogger("WindowCaptureShortcut");

/** Cmd+Shift+2: next to the system's Cmd+Shift+3/4/5 screenshot keys, free in macOS itself. */
export const WINDOW_CAPTURE_ACCELERATOR = "CommandOrControl+Shift+2";

function electronDeps(): WindowCaptureDeps {
  return {
    platform: process.platform,
    ownPids: () => [process.pid],
    ownSourceIds: () =>
      BrowserWindow.getAllWindows()
        .filter((window) => !window.isDestroyed())
        .map((window) => window.getMediaSourceId()),
    screenRecordingStatus: () => getMacScreenCaptureAccessStatus(),
    resolveFrontmost: () => ChronicleSourceResolver.resolveFrontmostContext(),
    listWindows: async (thumbnailSize) =>
      (await desktopCapturer.getSources({
        types: ["window"],
        thumbnailSize,
        fetchWindowIcons: false,
      })) as unknown as CapturableWindow[],
    isOcrAvailable: () => isTesseractInstalled(),
    runOcr: (imagePath, maxChars) => runOcrFromImagePath(imagePath, maxChars),
    now: () => Date.now(),
  };
}

/**
 * Registers the window-capture shortcut while it is turned on (macOS only). A press captures
 * the window in front, sends the result to the main window and brings CoWork forward.
 */
export class WindowCaptureShortcut {
  private registered = false;
  private capturing = false;

  constructor(
    private readonly getMainWindow: () => BrowserWindow | null,
    private readonly showMainWindow: () => void,
    private readonly deps: () => WindowCaptureDeps = electronDeps,
  ) {}

  /** Register or unregister to match the setting. */
  apply(enabled: boolean): void {
    if (process.platform !== "darwin") return;
    if (enabled && !this.registered) {
      try {
        this.registered = globalShortcut.register(WINDOW_CAPTURE_ACCELERATOR, () => {
          void this.capture();
        });
        if (!this.registered) {
          logger.warn(`${WINDOW_CAPTURE_ACCELERATOR} is in use by another app`);
        }
      } catch (error) {
        logger.warn("Could not register the window-capture shortcut:", error);
      }
    } else if (!enabled && this.registered) {
      this.dispose();
    }
  }

  dispose(): void {
    if (!this.registered) return;
    try {
      globalShortcut.unregister(WINDOW_CAPTURE_ACCELERATOR);
    } catch {
      // The app is quitting or the shortcut is already gone.
    }
    this.registered = false;
  }

  /** One capture at a time: a held or repeated key does not stack captures. */
  async capture(): Promise<void> {
    if (this.capturing) return;
    this.capturing = true;
    let result: WindowCaptureResult;
    try {
      result = await captureFrontWindow(this.deps());
    } catch (error) {
      logger.warn("Window capture failed:", error);
      result = { ok: false, reason: "failed", message: "Could not capture the window." };
    } finally {
      this.capturing = false;
    }
    const mainWindow = this.getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) return;
    this.showMainWindow();
    mainWindow.webContents.send(IPC_CHANNELS.WINDOW_CAPTURE_RESULT, result);
  }
}
