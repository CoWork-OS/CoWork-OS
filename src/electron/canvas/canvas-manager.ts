/**
 * Canvas Manager
 *
 * Manages Live Canvas sessions - agent-driven visual workspaces that render
 * HTML/CSS/JS content in dedicated Electron BrowserWindows.
 *
 * Features:
 * - Session lifecycle management (create, show, hide, close)
 * - Content pushing with auto-reload via file watching
 * - JavaScript execution in canvas context
 * - Screenshot capture
 * - A2UI (Agent-to-UI) action handling
 */

import { app, BrowserWindow } from 'electron';
import * as path from 'path';
import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import { randomUUID } from 'crypto';
import chokidar, { type FSWatcher } from 'chokidar';
import type {
  CanvasSession,
  CanvasEvent,
  CanvasA2UIAction,
  CanvasSnapshot,
} from '../../shared/types';

// Default HTML scaffold for new canvas sessions
const DEFAULT_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Live Canvas</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      margin: 0;
      padding: 20px;
      background: #1a1a2e;
      color: #eee;
      min-height: 100vh;
    }
    .loading {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 80vh;
      font-size: 1.2em;
      color: #888;
    }
  </style>
</head>
<body>
  <div class="loading">Waiting for content...</div>
</body>
</html>`;

/**
 * Canvas Manager Singleton
 */
export class CanvasManager {
  private static instance: CanvasManager;

  private sessions: Map<string, CanvasSession> = new Map();
  private windows: Map<string, BrowserWindow> = new Map();
  private watchers: Map<string, FSWatcher> = new Map();
  private windowToSession: Map<number, string> = new Map();
  private mainWindow: BrowserWindow | null = null;
  private eventCallback: ((event: CanvasEvent) => void) | null = null;
  private a2uiCallback: ((action: CanvasA2UIAction) => void) | null = null;

  private constructor() {}

  /**
   * Get the singleton instance
   */
  static getInstance(): CanvasManager {
    if (!CanvasManager.instance) {
      CanvasManager.instance = new CanvasManager();
    }
    return CanvasManager.instance;
  }

  /**
   * Set the main window reference for event broadcasting
   */
  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window;
  }

  /**
   * Set callback for canvas events (used for IPC broadcasting)
   */
  setEventCallback(callback: (event: CanvasEvent) => void): void {
    this.eventCallback = callback;
  }

  /**
   * Set callback for A2UI actions
   */
  setA2UICallback(callback: (action: CanvasA2UIAction) => void): void {
    this.a2uiCallback = callback;
  }

  /**
   * Create a new canvas session
   */
  async createSession(
    taskId: string,
    workspaceId: string,
    title?: string
  ): Promise<CanvasSession> {
    const sessionId = randomUUID();
    const sessionDir = path.join(
      app.getPath('userData'),
      'canvas',
      sessionId
    );

    // Create session directory
    await fs.mkdir(sessionDir, { recursive: true });

    // Write default HTML scaffold
    await fs.writeFile(
      path.join(sessionDir, 'index.html'),
      DEFAULT_HTML,
      'utf-8'
    );

    const session: CanvasSession = {
      id: sessionId,
      taskId,
      workspaceId,
      sessionDir,
      status: 'active',
      title: title || `Canvas ${new Date().toLocaleTimeString()}`,
      createdAt: Date.now(),
      lastUpdatedAt: Date.now(),
    };

    this.sessions.set(sessionId, session);

    // Emit event
    this.emitEvent({
      type: 'session_created',
      sessionId,
      taskId,
      timestamp: Date.now(),
      session,
    });

    console.log(`[CanvasManager] Created session ${sessionId} for task ${taskId}`);
    return session;
  }

  /**
   * Get a session by ID
   */
  getSession(sessionId: string): CanvasSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Get session ID from a BrowserWindow
   */
  getSessionFromWindow(window: BrowserWindow): string | undefined {
    return this.windowToSession.get(window.id);
  }

  /**
   * List all sessions for a task
   */
  listSessionsForTask(taskId: string): CanvasSession[] {
    return Array.from(this.sessions.values()).filter(
      (s) => s.taskId === taskId
    );
  }

  /**
   * List all active sessions
   */
  listAllSessions(): CanvasSession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Push content to a canvas session
   */
  async pushContent(
    sessionId: string,
    content: string,
    filename: string = 'index.html'
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error('Canvas session not found');
    }

    // Sanitize filename to prevent path traversal
    const safeFilename = path.basename(filename);
    const filePath = path.join(session.sessionDir, safeFilename);

    await fs.writeFile(filePath, content, 'utf-8');

    // Update session timestamp
    session.lastUpdatedAt = Date.now();

    // Emit event
    this.emitEvent({
      type: 'content_pushed',
      sessionId,
      taskId: session.taskId,
      timestamp: Date.now(),
    });

    console.log(`[CanvasManager] Pushed ${safeFilename} to session ${sessionId}`);
  }

  /**
   * Show the canvas window
   */
  async showCanvas(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error('Canvas session not found');
    }

    let window = this.windows.get(sessionId);

    if (!window || window.isDestroyed()) {
      // Create new window
      window = new BrowserWindow({
        width: 900,
        height: 700,
        title: session.title || 'Live Canvas',
        webPreferences: {
          preload: path.join(__dirname, 'canvas-preload.js'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false,
        },
        backgroundColor: '#1a1a2e',
      });

      this.windows.set(sessionId, window);
      this.windowToSession.set(window.id, sessionId);

      // Handle window close
      window.on('closed', () => {
        this.windows.delete(sessionId);
        this.windowToSession.delete(window!.id);
        this.stopWatcher(sessionId);
      });

      // Load the canvas URL
      await window.loadURL(`canvas://${sessionId}/index.html`);

      // Start file watcher for auto-reload
      this.startWatcher(sessionId, session.sessionDir, window);
    }

    window.show();
    window.focus();

    this.emitEvent({
      type: 'window_opened',
      sessionId,
      taskId: session.taskId,
      timestamp: Date.now(),
    });
  }

  /**
   * Hide the canvas window
   */
  hideCanvas(sessionId: string): void {
    const window = this.windows.get(sessionId);
    if (window && !window.isDestroyed()) {
      window.hide();
    }
  }

  /**
   * Close a canvas session
   */
  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    // Close window if open
    const window = this.windows.get(sessionId);
    if (window && !window.isDestroyed()) {
      window.close();
    }

    // Stop watcher
    this.stopWatcher(sessionId);

    // Update session status
    session.status = 'closed';

    // Emit event
    this.emitEvent({
      type: 'session_closed',
      sessionId,
      taskId: session.taskId,
      timestamp: Date.now(),
    });

    console.log(`[CanvasManager] Closed session ${sessionId}`);
  }

  /**
   * Execute JavaScript in the canvas context
   */
  async evalScript(sessionId: string, script: string): Promise<unknown> {
    const window = this.windows.get(sessionId);
    if (!window || window.isDestroyed()) {
      throw new Error('Canvas window not open');
    }

    return window.webContents.executeJavaScript(script);
  }

  /**
   * Take a screenshot of the canvas
   */
  async takeSnapshot(sessionId: string): Promise<CanvasSnapshot> {
    const window = this.windows.get(sessionId);
    if (!window || window.isDestroyed()) {
      throw new Error('Canvas window not open');
    }

    const image = await window.webContents.capturePage();
    const size = image.getSize();

    return {
      sessionId,
      imageBase64: image.toPNG().toString('base64'),
      width: size.width,
      height: size.height,
    };
  }

  /**
   * Handle A2UI action from canvas window
   */
  handleA2UIAction(
    windowId: number,
    action: { actionName: string; componentId?: string; context?: Record<string, unknown> }
  ): void {
    const sessionId = this.windowToSession.get(windowId);
    if (!sessionId) return;

    const session = this.sessions.get(sessionId);
    if (!session) return;

    const a2uiAction: CanvasA2UIAction = {
      actionName: action.actionName,
      sessionId,
      componentId: action.componentId,
      context: action.context,
      timestamp: Date.now(),
    };

    // Emit event for UI
    this.emitEvent({
      type: 'a2ui_action',
      sessionId,
      taskId: session.taskId,
      timestamp: Date.now(),
      action: a2uiAction,
    });

    // Call A2UI callback if set
    if (this.a2uiCallback) {
      this.a2uiCallback(a2uiAction);
    }
  }

  /**
   * Start file watcher for a session
   */
  private startWatcher(
    sessionId: string,
    sessionDir: string,
    window: BrowserWindow
  ): void {
    if (this.watchers.has(sessionId)) {
      return;
    }

    const watcher = chokidar.watch(sessionDir, {
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 50,
      },
    });

    watcher.on('change', () => {
      if (!window.isDestroyed()) {
        window.webContents.reload();
      }
    });

    this.watchers.set(sessionId, watcher);
  }

  /**
   * Stop file watcher for a session
   */
  private stopWatcher(sessionId: string): void {
    const watcher = this.watchers.get(sessionId);
    if (watcher) {
      watcher.close();
      this.watchers.delete(sessionId);
    }
  }

  /**
   * Emit a canvas event
   */
  private emitEvent(event: CanvasEvent): void {
    // Call event callback
    if (this.eventCallback) {
      this.eventCallback(event);
    }

    // Broadcast to main window
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('canvas:event', event);
    }
  }

  /**
   * Cleanup all sessions and resources
   */
  async cleanup(): Promise<void> {
    // Close all windows
    for (const [sessionId, window] of this.windows) {
      if (!window.isDestroyed()) {
        window.close();
      }
      this.stopWatcher(sessionId);
    }

    this.sessions.clear();
    this.windows.clear();
    this.windowToSession.clear();

    console.log('[CanvasManager] Cleanup complete');
  }
}
