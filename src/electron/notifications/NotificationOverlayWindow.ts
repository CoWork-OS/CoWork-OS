/**
 * NotificationOverlayWindow — desktop banners and optional macOS Dock cards
 *
 * Creates frameless, transparent, always-on-top BrowserWindows that display
 * rounded notifications at the top-right or near the Dock, inside the display work area.
 * Follows the same pattern as QuickInputWindow
 * (data URL, console-message IPC).
 */

import { BrowserWindow, Rectangle, screen } from "electron";
import type { DesktopNotificationStyle } from "../../shared/types";
import { getOverlayLayout } from "./overlay-layout";

interface OverlayNotification {
  id: string;
  title: string;
  message: string;
  type?: string;
  taskId?: string;
}

interface ActiveOverlay {
  window: BrowserWindow;
  notification: OverlayNotification;
  dismissTimer: NodeJS.Timeout;
  index: number;
  style: DesktopNotificationStyle;
  displayId: number;
}

const DISMISS_TIMEOUT = 5000;
const DOCK_DISMISS_TIMEOUT = 10000;
const FADE_DURATION = 300;
const MAX_VISIBLE = 5;

export class NotificationOverlayManager {
  private static instance: NotificationOverlayManager | null = null;
  private activeOverlays: Map<string, ActiveOverlay> = new Map();

  // Provider callback so we always get fresh tray bounds (avoids stale-on-init issues)
  private anchorBoundsProvider: (() => Rectangle | null) | null = null;

  private onClickCallback: ((notificationId: string, taskId?: string) => void) | null = null;
  private onReadCallback: ((notificationId: string) => void) | null = null;
  private listening = false;
  private readonly onDisplayChange = () => this.repositionOverlays();

  static getInstance(): NotificationOverlayManager {
    if (!NotificationOverlayManager.instance) {
      NotificationOverlayManager.instance = new NotificationOverlayManager();
    }
    return NotificationOverlayManager.instance;
  }

  private constructor() {}

  /**
   * Provide a function that returns the current tray icon bounds.
   * Call this once from TrayManager after the Tray is created.
   * Using a callback (not stored bounds) ensures we always get a fresh position.
   */
  setAnchorBoundsProvider(fn: () => Rectangle | null): void {
    this.anchorBoundsProvider = fn;
  }

  setOnClick(callback: (notificationId: string, taskId?: string) => void): void {
    this.onClickCallback = callback;
  }

  setOnRead(callback: (notificationId: string) => void): void {
    this.onReadCallback = callback;
  }

  show(notification: OverlayNotification, style: DesktopNotificationStyle = "system"): void {
    if (this.activeOverlays.has(notification.id)) this.dismiss(notification.id);
    if (!this.listening) {
      screen.on("display-metrics-changed", this.onDisplayChange);
      screen.on("display-removed", this.onDisplayChange);
      this.listening = true;
    }
    const trayBounds = this.anchorBoundsProvider?.();
    const display =
      style === "near-dock"
        ? screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
        : trayBounds
          ? screen.getDisplayMatching(trayBounds)
          : screen.getPrimaryDisplay();
    const layout = getOverlayLayout(display, style, 0);
    const capacity = Math.max(
      1,
      Math.min(MAX_VISIBLE, Math.floor((display.workArea.height - 32) / (layout.height + 10))),
    );
    // Cap visible notifications — dismiss oldest if needed
    while (this.activeOverlays.size >= capacity) {
      const oldest = this.activeOverlays.values().next().value;
      if (oldest) this.dismiss(oldest.notification.id);
    }

    const win = this.createOverlayWindow(notification, style, display.id);

    const dismissTimer = setTimeout(
      () => {
        this.dismiss(notification.id);
      },
      style === "near-dock" ? DOCK_DISMISS_TIMEOUT : DISMISS_TIMEOUT,
    );

    this.activeOverlays.set(notification.id, {
      window: win,
      notification,
      dismissTimer,
      index: this.activeOverlays.size,
      style,
      displayId: display.id,
    });
    this.repositionOverlays();
  }

  dismiss(id: string): void {
    const overlay = this.activeOverlays.get(id);
    if (!overlay) return;

    clearTimeout(overlay.dismissTimer);
    this.activeOverlays.delete(id);

    if (overlay.window && !overlay.window.isDestroyed()) {
      overlay.window.webContents
        .executeJavaScript(`document.getElementById('n').classList.add('out');`)
        .catch(() => {});

      setTimeout(() => {
        if (overlay.window && !overlay.window.isDestroyed()) {
          overlay.window.destroy();
        }
      }, FADE_DURATION);
    }

    this.repositionOverlays();
  }

  dismissAll(): void {
    for (const [id] of this.activeOverlays) {
      this.dismiss(id);
    }
  }

  destroy(): void {
    if (this.listening) {
      screen.removeListener("display-metrics-changed", this.onDisplayChange);
      screen.removeListener("display-removed", this.onDisplayChange);
      this.listening = false;
    }
    for (const [, overlay] of this.activeOverlays) {
      clearTimeout(overlay.dismissTimer);
      if (overlay.window && !overlay.window.isDestroyed()) {
        overlay.window.destroy();
      }
    }
    this.activeOverlays.clear();
    NotificationOverlayManager.instance = null;
  }

  private createOverlayWindow(
    notification: OverlayNotification,
    style: DesktopNotificationStyle,
    displayId: number,
  ): BrowserWindow {
    const isMac = process.platform === "darwin";
    const layout = this.getPosition(this.activeOverlays.size, style, displayId);

    const win = new BrowserWindow({
      ...layout,
      frame: false,
      transparent: isMac,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      focusable: false,
      backgroundColor: "#00000000",
      show: false,
      fullscreenable: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    if (isMac) {
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      win.setAlwaysOnTop(true, "floating");
    }

    win.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(this.getHtml(notification, style))}`,
    );

    win.once("ready-to-show", () => {
      if (this.activeOverlays.get(notification.id)?.window === win && !win.isDestroyed())
        win.showInactive();
    });

    win.webContents.on("console-message", (_event, _level, message) => {
      if (message === "__CLICK__") {
        if (this.onClickCallback) {
          this.onClickCallback(notification.id, notification.taskId);
        }
        this.dismiss(notification.id);
      } else if (message === "__DISMISS__") {
        this.dismiss(notification.id);
      } else if (message === "__READ__") {
        this.onReadCallback?.(notification.id);
        this.dismiss(notification.id);
      }
    });

    return win;
  }

  private getPosition(
    stackIndex: number,
    style: DesktopNotificationStyle,
    displayId: number,
  ): Rectangle {
    const display =
      screen.getAllDisplays().find((candidate) => candidate.id === displayId) ??
      screen.getPrimaryDisplay();
    return getOverlayLayout(display, style, stackIndex);
  }

  private repositionOverlays(): void {
    const indices = new Map<string, number>();
    for (const [, overlay] of this.activeOverlays) {
      const key = `${overlay.displayId}:${overlay.style}`;
      const index = indices.get(key) ?? 0;
      overlay.index = index;
      const layout = this.getPosition(index, overlay.style, overlay.displayId);
      if (overlay.window && !overlay.window.isDestroyed()) {
        overlay.window.setBounds(layout);
      }
      indices.set(key, index + 1);
    }
  }

  private escapeHtml(str: string): string {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  private getHtml(notification: OverlayNotification, style: DesktopNotificationStyle): string {
    const title = this.escapeHtml(notification.title);
    const message = this.escapeHtml(notification.message);
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }

  html, body {
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: transparent;
  }

  body {
    position: relative;
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display',
                 'SF Pro Text', 'Segoe UI', system-ui, sans-serif;
    cursor: pointer;
    user-select: none;
    -webkit-user-select: none;
  }

  #n {
    position: absolute;
    inset: 3px;
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 12px 36px 12px 13px;
    border-radius: 18px;
    overflow: hidden;
    isolation: isolate;
    box-shadow:
      0 18px 48px rgba(0, 0, 0, 0.32),
      0 4px 14px rgba(0, 0, 0, 0.24);
    animation: in 0.28s cubic-bezier(0.16, 1, 0.3, 1);
    transform-origin: top right;
  }

  #n::before {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: inherit;
    background: rgba(38, 38, 42, 0.88);
    backdrop-filter: blur(30px) saturate(170%);
    -webkit-backdrop-filter: blur(30px) saturate(170%);
    z-index: -2;
  }

  #n::after {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: inherit;
    box-shadow:
      inset 0 0 0 0.5px rgba(255, 255, 255, 0.18),
      inset 0 1px 0 rgba(255, 255, 255, 0.13);
    z-index: -1;
    pointer-events: none;
  }

  @keyframes in {
    from { opacity: 0; transform: translateX(18px) scale(0.98); }
    to   { opacity: 1; transform: translateX(0) scale(1); }
  }

  body:hover #n::before {
    background: rgba(42, 42, 46, 0.92);
  }

  #n.out {
    animation: out 0.28s cubic-bezier(0.4, 0, 1, 1) forwards;
  }

  @keyframes out {
    to { opacity: 0; transform: translateX(14px) scale(0.98); }
  }

  .app-icon {
    width: 42px;
    height: 42px;
    min-width: 42px;
    margin-top: 2px;
    border-radius: 10px;
    background:
      linear-gradient(180deg, rgba(255, 255, 255, 0.26), rgba(255, 255, 255, 0) 42%),
      linear-gradient(145deg, #06b6d4 0%, #0891b2 100%);
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow:
      0 1px 2px rgba(0, 0, 0, 0.28),
      inset 0 0 0 0.5px rgba(255, 255, 255, 0.22);
  }

  .app-icon svg {
    width: 23px;
    height: 23px;
    filter: drop-shadow(0 1px 1px rgba(0,0,0,0.24));
  }

  .text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
  }

  .meta {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    margin-bottom: 2px;
  }

  .app-name {
    min-width: 0;
    color: rgba(255, 255, 255, 0.82);
    font-size: 12px;
    font-weight: 600;
    line-height: 1.2;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    letter-spacing: 0;
  }

  .time {
    color: rgba(255, 255, 255, 0.42);
    font-size: 12px;
    font-weight: 500;
    line-height: 1.2;
    white-space: nowrap;
  }

  .title {
    font-size: 14px;
    font-weight: 600;
    color: rgba(255, 255, 255, 0.96);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    letter-spacing: 0;
    line-height: 1.25;
  }

  .sub {
    font-size: 13px;
    font-weight: 400;
    color: rgba(255, 255, 255, 0.68);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    margin-top: 2px;
    letter-spacing: 0;
    line-height: 1.3;
  }

  .dismiss {
    position: absolute;
    top: 9px;
    right: 9px;
    width: 18px;
    height: 18px;
    border: 0;
    border-radius: 50%;
    color: rgba(255, 255, 255, 0.62);
    background: rgba(255, 255, 255, 0.12);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    opacity: 0;
    cursor: default;
    transition:
      opacity 0.12s ease,
      background 0.12s ease,
      color 0.12s ease;
  }

  body:hover .dismiss {
    opacity: 1;
  }

  .dismiss:hover {
    background: rgba(255, 255, 255, 0.2);
    color: rgba(255, 255, 255, 0.88);
  }

  .dismiss svg {
    width: 11px;
    height: 11px;
  }
  .read { display: none; }
  body.dock #n { align-items: center; padding: 16px; gap: 12px; border-radius: 28px; transform-origin: bottom center; }
  body.dock #n::before { background: rgba(16, 17, 19, 0.96); }
  body.dock .app-icon { width: 28px; height: 28px; min-width: 28px; border-radius: 8px; }
  body.dock .app-icon svg { width: 19px; height: 19px; }
  body.dock .app-name { color: #46d7af; }
  body.dock .meta { justify-content: space-between; margin-bottom: 5px; }
  body.dock .sub { white-space: normal; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  body.dock .title { font-size: 13px; }
  body.dock .dismiss, body.dock .read { position: static; display: flex; flex-shrink: 0; width: 44px; height: 44px; opacity: 1; cursor: pointer; }
  body.dock .read { align-items: center; justify-content: center; border: 1px solid rgba(255,255,255,.1); border-radius: 50%; background: rgba(255,255,255,.12); color: white; }
  body.dock .dismiss svg, body.dock .read svg { width: 20px; height: 20px; }
  body.dock .read:hover { background: rgba(255,255,255,.2); }
  body.dock #n { animation-name: dock-in; }
  body.dock #n.out { animation-name: dock-out; }
  @keyframes dock-in { from { opacity: 0; transform: translateY(12px) scale(.98); } to { opacity: 1; transform: translateY(0) scale(1); } }
  @keyframes dock-out { to { opacity: 0; transform: translateY(12px) scale(.98); } }
</style>
</head>
<body class="${style === "near-dock" ? "dock" : "banner"}">
  <div id="n" onclick="console.log('__CLICK__')">
    <div class="app-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-linecap="round" stroke-linejoin="round">
        <rect x="2.2" y="7.1" width="19.6" height="9.4" rx="1.15" stroke-width="1.7"/>
        <path d="M4.3 16.9c0.45 1 1.25 1.45 2.55 1.45h10.3c1.3 0 2.1-0.45 2.55-1.45" stroke-width="1.5"/>
        <circle cx="17.4" cy="9.95" r="1.02" fill="white" stroke="none"/>
        <circle cx="19.2" cy="9.95" r="0.46" fill="white" stroke="none"/>
      </svg>
    </div>
    <div class="text">
      <div class="meta">
        <div class="app-name">CoWork OS</div>
        <div class="time">now</div>
      </div>
      <div class="title">${title}</div>
      <div class="sub">${message}</div>
    </div>
    <button class="read" type="button" aria-label="Mark as read" title="Mark as read" onclick="event.stopPropagation(); console.log('__READ__')">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 4 4 10-10" /></svg>
    </button>
    <button class="dismiss" type="button" aria-label="Dismiss" title="Dismiss" onclick="event.stopPropagation(); console.log('__DISMISS__')">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
      </svg>
    </button>
  </div>
  <script>
    setTimeout(function(){
      document.getElementById('n').classList.add('out');
    }, ${(style === "near-dock" ? DOCK_DISMISS_TIMEOUT : DISMISS_TIMEOUT) - FADE_DURATION});
  </script>
</body>
</html>`;
  }
}
