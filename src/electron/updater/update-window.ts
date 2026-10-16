/**
 * The small window the update prompt draws in. One window is reused for every
 * state; it resizes to its content and sits near the top of the main window.
 */

import { BrowserWindow, nativeTheme, screen } from "electron";
import { getDesktopIconImage } from "../branding";
import { createLogger } from "../utils/logger";
import type { UpdateWindowView } from "./update-prompt";
import {
  buildUpdateWindowHtml,
  parseUpdateWindowMessage,
  type UpdateWindowAction,
  type UpdateWindowState,
} from "./update-window-html";

const log = createLogger("UpdateWindow");

/** Widths of the two Sparkle layouts: the prompt and the compact status window. */
const PROMPT_WIDTH = 540;
const STATUS_WIDTH = 420;
const INITIAL_HEIGHT = 150;
/** Distance from the top of the main window's content. */
const TOP_OFFSET = 64;

function widthFor(state: UpdateWindowState): number {
  return state.view === "progress" || state.view === "ready" ? STATUS_WIDTH : PROMPT_WIDTH;
}

export class UpdateWindow implements UpdateWindowView {
  private window: BrowserWindow | null = null;
  private loaded: Promise<void> | null = null;
  private state: UpdateWindowState | null = null;
  private height = INITIAL_HEIGHT;

  constructor(
    private readonly options: {
      appName: string;
      getAnchorWindow: () => BrowserWindow | null;
      onAction: (action: UpdateWindowAction) => void;
      onClosed: () => void;
    },
  ) {}

  isOpen(): boolean {
    return Boolean(this.window && !this.window.isDestroyed());
  }

  show(state: UpdateWindowState): void {
    const firstShow = !this.isOpen();
    const widthChanged = !this.state || widthFor(this.state) !== widthFor(state);
    this.state = state;
    const win = this.ensureWindow();
    // Always closable: closing mid-download keeps it going, and the window returns
    // at Ready to Install. Electron can drop a hidden title bar's traffic lights
    // when it first shows, so ask for them explicitly.
    if (process.platform === "darwin") win.setWindowButtonVisibility(true);
    if (widthChanged && !firstShow) this.resize(widthFor(state), this.height, true);
    void this.loaded?.then(() => {
      if (win.isDestroyed() || this.state !== state) return;
      win.webContents
        .executeJavaScript(`window.__setUpdateState(${JSON.stringify(state)})`)
        .catch((error) => log.warn("Could not render update window", error));
    });
  }

  close(): void {
    const win = this.window;
    this.window = null;
    this.loaded = null;
    this.state = null;
    if (win && !win.isDestroyed()) win.destroy();
  }

  private ensureWindow(): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) return this.window;
    const isMac = process.platform === "darwin";
    const width = this.state ? widthFor(this.state) : PROMPT_WIDTH;
    const win = new BrowserWindow({
      width,
      height: INITIAL_HEIGHT,
      ...this.position(width),
      useContentSize: true,
      show: false,
      title: "Software Update",
      resizable: false,
      maximizable: false,
      minimizable: true,
      fullscreenable: false,
      ...(isMac
        ? { titleBarStyle: "hidden" as const, trafficLightPosition: { x: 12, y: 10 } }
        : {}),
      autoHideMenuBar: true,
      // Matches the page background so the window never flashes the other theme.
      backgroundColor: nativeTheme.shouldUseDarkColors ? "#2a2a2c" : "#ffffff",
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        // Data: URLs cannot load a preload; clicks arrive as console messages.
      },
    });
    this.window = win;
    this.height = INITIAL_HEIGHT;

    const icon = getDesktopIconImage();
    const iconDataUrl =
      icon && !icon.isEmpty() ? icon.resize({ width: 128, height: 128 }).toDataURL() : undefined;
    const html = buildUpdateWindowHtml({
      appName: this.options.appName,
      iconDataUrl,
      drawsTitleBar: isMac,
    });

    // The page never navigates and never opens windows.
    win.webContents.on("will-navigate", (event) => event.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("console-message", (details) => {
      const parsed = parseUpdateWindowMessage(details.message);
      if (!parsed) return;
      if (parsed.kind === "height") {
        this.height = parsed.height;
        const state = this.state;
        if (state) this.resize(widthFor(state), parsed.height, false);
        if (!win.isVisible() && !win.isDestroyed()) win.show();
        return;
      }
      this.options.onAction(parsed.action);
    });
    win.on("closed", () => {
      if (this.window !== win) return;
      this.window = null;
      this.loaded = null;
      this.state = null;
      this.options.onClosed();
    });

    this.loaded = win
      .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
      .catch((error) => log.warn("Could not load update window", error));
    return win;
  }

  private resize(width: number, height: number, recenter: boolean): void {
    const win = this.window;
    if (!win || win.isDestroyed()) return;
    win.setContentSize(width, height);
    if (recenter) {
      const { x, y } = this.position(width);
      win.setPosition(x, y);
    }
  }

  /** Horizontally centred on the main window near its top, or on the active display. */
  private position(width: number): { x: number; y: number } {
    const anchor = this.options.getAnchorWindow();
    if (anchor && !anchor.isDestroyed() && anchor.isVisible() && !anchor.isMinimized()) {
      const bounds = anchor.getBounds();
      return {
        x: Math.round(bounds.x + (bounds.width - width) / 2),
        y: Math.round(bounds.y + TOP_OFFSET),
      };
    }
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    return {
      x: Math.round(area.x + (area.width - width) / 2),
      y: Math.round(area.y + area.height * 0.18),
    };
  }
}
