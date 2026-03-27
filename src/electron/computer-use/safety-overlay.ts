/**
 * CUA Safety Overlay — visual indicators during computer use sessions.
 *
 * When the CUA is actively controlling the desktop, two always-on-top windows appear:
 *  1. An orange border around the entire screen (click-through, transparent).
 *  2. A thinking panel docked to the top-right showing the agent's current reasoning.
 *
 * Both windows follow the frameless/transparent BrowserWindow pattern from
 * NotificationOverlayWindow.ts.
 */

import { BrowserWindow, screen } from "electron";

const BORDER_WIDTH = 4;
const THINKING_PANEL_WIDTH = 320;
const THINKING_PANEL_HEIGHT = 200;
const THINKING_PANEL_MARGIN = 12;

export class CUASafetyOverlay {
  private borderWindow: BrowserWindow | null = null;
  private thinkingWindow: BrowserWindow | null = null;
  private _active = false;

  get isActive(): boolean {
    return this._active;
  }

  show(): void {
    if (this._active) return;
    this._active = true;
    this.createBorderWindow();
    this.createThinkingWindow();
  }

  hide(): void {
    if (!this._active) return;
    this._active = false;
    this.destroyWindow(this.borderWindow);
    this.borderWindow = null;
    this.destroyWindow(this.thinkingWindow);
    this.thinkingWindow = null;
  }

  updateThinking(text: string): void {
    if (!this.thinkingWindow || this.thinkingWindow.isDestroyed()) return;
    const escaped = text.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$/g, "\\$");
    this.thinkingWindow.webContents
      .executeJavaScript(`document.getElementById('thinking-text').textContent = \`${escaped}\`;`)
      .catch(() => {});
  }

  // ───────────── Border window ─────────────

  private createBorderWindow(): void {
    const display = screen.getPrimaryDisplay();
    const { x, y, width, height } = display.bounds;

    const html = `<!DOCTYPE html>
<html><head><style>
  * { margin: 0; padding: 0; }
  body {
    overflow: hidden;
    background: transparent;
  }
  .border {
    position: fixed;
    inset: 0;
    border: ${BORDER_WIDTH}px solid #e07a3a;
    border-radius: 6px;
    pointer-events: none;
    box-sizing: border-box;
    animation: pulse 2s ease-in-out infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: 0.85; }
    50% { opacity: 1; }
  }
</style></head>
<body><div class="border"></div></body></html>`;

    this.borderWindow = new BrowserWindow({
      x,
      y,
      width,
      height,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      movable: false,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    this.borderWindow.setAlwaysOnTop(true, "screen-saver");
    this.borderWindow.setIgnoreMouseEvents(true);
    this.borderWindow.setVisibleOnAllWorkspaces(true);
    this.borderWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  }

  // ───────────── Thinking panel ─────────────

  private createThinkingWindow(): void {
    const display = screen.getPrimaryDisplay();
    const { x: dx, width: dw } = display.bounds;

    const panelX = dx + dw - THINKING_PANEL_WIDTH - THINKING_PANEL_MARGIN;
    const panelY = THINKING_PANEL_MARGIN + 30; // below menu bar

    const html = `<!DOCTYPE html>
<html><head><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif;
    font-size: 12px;
    color: #1a1a1a;
    background: rgba(255, 255, 255, 0.92);
    border-radius: 10px;
    overflow: hidden;
    -webkit-app-region: drag;
  }
  .header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 12px;
    background: rgba(224, 122, 58, 0.12);
    border-bottom: 1px solid rgba(224, 122, 58, 0.2);
    font-weight: 600;
    font-size: 11px;
    color: #c05a20;
  }
  .dot {
    width: 6px; height: 6px;
    border-radius: 50%;
    background: #e07a3a;
    animation: blink 1.2s ease-in-out infinite;
  }
  @keyframes blink {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }
  .body {
    padding: 10px 12px;
    line-height: 1.5;
    max-height: 140px;
    overflow-y: auto;
    color: #444;
  }
</style></head>
<body>
  <div class="header"><span class="dot"></span> Computer Use Active</div>
  <div class="body" id="thinking-text">Preparing...</div>
</body></html>`;

    this.thinkingWindow = new BrowserWindow({
      x: panelX,
      y: panelY,
      width: THINKING_PANEL_WIDTH,
      height: THINKING_PANEL_HEIGHT,
      frame: false,
      transparent: true,
      hasShadow: true,
      resizable: false,
      movable: true,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    this.thinkingWindow.setAlwaysOnTop(true, "screen-saver");
    this.thinkingWindow.setVisibleOnAllWorkspaces(true);
    this.thinkingWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  }

  // ───────────── Cleanup ─────────────

  private destroyWindow(win: BrowserWindow | null): void {
    if (win && !win.isDestroyed()) {
      win.close();
    }
  }
}
