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

import type { BrowserWindow } from "electron";
import * as path from "path";
import * as fs from "fs/promises";
import { existsSync, readdirSync, statSync } from "fs";
import { randomUUID } from "crypto";
import chokidar, { type FSWatcher } from "chokidar";
import type {
  CanvasSession,
  CanvasSessionMode,
  CanvasEvent,
  CanvasA2UIAction,
  CanvasSnapshot,
  CanvasCheckpoint,
} from "../../shared/types";
import { loadCanvasStore, saveCanvasStore } from "./canvas-store";
import { getUserDataDir } from "../utils/user-data-dir";

function getElectronRuntime(): { BrowserWindow: Any; screen: Any; shell: Any } | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
// oxlint-disable-next-line typescript-eslint(no-require-imports)
    const electron = require("electron") as Any;
    // In plain Node.js, `require('electron')` resolves to the Electron binary path (string),
    // not the runtime API object. Only treat it as available when it looks like the API.
    if (!electron || typeof electron !== "object") return null;
    if (!electron.BrowserWindow || !electron.screen || !electron.shell) return null;
    return {
      BrowserWindow: electron.BrowserWindow,
      screen: electron.screen,
      shell: electron.shell,
    };
  } catch {
    return null;
  }
}

function requireElectronRuntime(): { BrowserWindow: Any; screen: Any; shell: Any } {
  const rt = getElectronRuntime();
  if (!rt) {
    throw new Error(
      "Live Canvas requires the Electron desktop runtime and is not available in the Node-only daemon/headless mode.",
    );
  }
  return rt;
}

// Default HTML scaffold for new canvas sessions
const DEFAULT_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Live Canvas</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text', 'Segoe UI', system-ui, sans-serif;
      margin: 0;
      padding: 20px;
      background: #0f1220;
      color: #e7e9f2;
      min-height: 100vh;
      display: grid;
      place-items: center;
    }
    .loading {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 16px;
      text-align: center;
    }
    .spinner {
      width: 44px;
      height: 44px;
      border-radius: 50%;
      border: 4px solid rgba(255, 255, 255, 0.15);
      border-top-color: #52d1dc;
      animation: spin 0.9s linear infinite;
      box-shadow: 0 0 18px rgba(82, 209, 220, 0.35);
    }
    .message {
      font-size: 1.05em;
      color: #a3acc4;
      letter-spacing: 0.2px;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
  </style>
</head>
<body>
  <div class="loading">
    <div class="spinner"></div>
    <div class="message">Waiting for content...</div>
  </div>
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
  private checkpoints: Map<string, CanvasCheckpoint[]> = new Map();
  private mainWindow: BrowserWindow | null = null;
  private eventCallback: ((event: CanvasEvent) => void) | null = null;
  private a2uiCallback: ((action: CanvasA2UIAction) => void) | null = null;

  /** Maximum checkpoints per session */
  private maxCheckpointsPerSession = 50;
  /** Maximum individual file size to include in a checkpoint (5 MB) */
  private static readonly MAX_CHECKPOINT_FILE_BYTES = 5 * 1024 * 1024;

  private constructor() {}

  private getSessionMode(session: CanvasSession): CanvasSessionMode {
    return session.mode || "html";
  }

  private getCanvasUrl(sessionId: string): string {
    return `canvas://${sessionId}/index.html`;
  }

  private normalizeUrl(rawUrl: string): string {
    const trimmed = rawUrl.trim();
    if (!trimmed) {
      throw new Error("URL cannot be empty");
    }

    const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const parsed = new URL(withScheme);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("Only http and https URLs are supported for canvas browsing");
    }
    return parsed.toString();
  }

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
   * Restore sessions from disk storage
   * Called on app startup to reload persisted sessions
   */
  async restoreSessions(): Promise<void> {
    try {
      const store = await loadCanvasStore();

      for (const session of store.sessions) {
        // Only restore active sessions with valid directories
        if (session.status === "active" && existsSync(session.sessionDir)) {
          this.sessions.set(session.id, session);
        }
      }

      if (this.sessions.size > 0) {
        console.log(`[CanvasManager] Restored ${this.sessions.size} sessions from disk`);
      }
    } catch (error) {
      console.error("[CanvasManager] Failed to restore sessions:", error);
    }
  }

  /**
   * Persist all sessions to disk
   */
  async persistSessions(): Promise<void> {
    try {
      const sessions = Array.from(this.sessions.values());
      await saveCanvasStore({ version: 1, sessions });
      console.log(`[CanvasManager] Persisted ${sessions.length} sessions to disk`);
    } catch (error) {
      console.error("[CanvasManager] Failed to persist sessions:", error);
    }
  }

  /**
   * Create a new canvas session
   */
  async createSession(
    taskId: string,
    workspaceId: string,
    title?: string,
    options?: { mode?: CanvasSessionMode; url?: string },
  ): Promise<CanvasSession> {
    const sessionId = randomUUID();
    const sessionDir = path.join(getUserDataDir(), "canvas", sessionId);

    // Create session directory
    await fs.mkdir(sessionDir, { recursive: true });

    // Write default HTML scaffold
    await fs.writeFile(path.join(sessionDir, "index.html"), DEFAULT_HTML, "utf-8");

    const normalizedUrl = options?.url ? this.normalizeUrl(options.url) : undefined;
    const normalizedMode = options?.mode === "browser" && normalizedUrl ? "browser" : "html";
    const session: CanvasSession = {
      id: sessionId,
      taskId,
      workspaceId,
      sessionDir,
      mode: normalizedMode,
      url: normalizedMode === "browser" ? normalizedUrl : undefined,
      status: "active",
      title: title || `Canvas ${new Date().toLocaleTimeString()}`,
      createdAt: Date.now(),
      lastUpdatedAt: Date.now(),
    };

    this.sessions.set(sessionId, session);

    // Persist sessions to disk
    await this.persistSessions();

    // Emit event
    this.emitEvent({
      type: "session_created",
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
    return Array.from(this.sessions.values()).filter((s) => s.taskId === taskId);
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
    filename: string = "index.html",
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      const existingSessions = Array.from(this.sessions.keys());
      console.error(`[CanvasManager] Session not found: "${sessionId}"`);
      console.error(
        `[CanvasManager] Existing sessions: ${existingSessions.length > 0 ? existingSessions.join(", ") : "none"}`,
      );
      throw new Error(
        `Canvas session not found: "${sessionId}". Available sessions: ${existingSessions.join(", ") || "none"}`,
      );
    }

    const wasBrowser = this.getSessionMode(session) === "browser";

    // Sanitize filename to prevent path traversal
    const safeFilename = path.basename(filename);
    const filePath = path.join(session.sessionDir, safeFilename);

    await fs.writeFile(filePath, content, "utf-8");

    // Switch back to HTML mode when content is pushed
    session.mode = "html";
    session.url = undefined;

    // Update session timestamp
    session.lastUpdatedAt = Date.now();

    // Persist sessions to disk (in background, don't await to avoid blocking)
    this.persistSessions().catch((err) =>
      console.error("[CanvasManager] Failed to persist after push:", err),
    );

    // Ensure a hidden window exists for snapshots (NOT shown to user)
    // The window will only be shown when user explicitly requests via showCanvas()
    const window = await this.ensureWindowForSnapshots(sessionId);

    // If the session previously loaded a remote URL, navigate back to canvas content
    if (wasBrowser && window && !window.isDestroyed()) {
      await window.loadURL(this.getCanvasUrl(sessionId));
    }

    // Ensure watcher is running for HTML mode
    this.startWatcher(sessionId, session.sessionDir, window);

    // Emit event
    this.emitEvent({
      type: "content_pushed",
      sessionId,
      taskId: session.taskId,
      timestamp: Date.now(),
    });

    this.emitEvent({
      type: "session_updated",
      sessionId,
      taskId: session.taskId,
      timestamp: Date.now(),
      session,
    });

    console.log(`[CanvasManager] Pushed ${safeFilename} to session ${sessionId}`);
  }

  /**
   * Open a remote URL inside the canvas window (browser mode)
   */
  async openUrl(sessionId: string, rawUrl: string, options?: { show?: boolean }): Promise<string> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      const existingSessions = Array.from(this.sessions.keys());
      console.error(`[CanvasManager] Session not found: "${sessionId}"`);
      console.error(
        `[CanvasManager] Existing sessions: ${existingSessions.length > 0 ? existingSessions.join(", ") : "none"}`,
      );
      throw new Error(
        `Canvas session not found: "${sessionId}". Available sessions: ${existingSessions.join(", ") || "none"}`,
      );
    }

    const normalizedUrl = this.normalizeUrl(rawUrl);

    session.mode = "browser";
    session.url = normalizedUrl;
    session.lastUpdatedAt = Date.now();

    this.persistSessions().catch((err) =>
      console.error("[CanvasManager] Failed to persist after openUrl:", err),
    );

    const window = await this.ensureWindowForSnapshots(sessionId);
    if (window && !window.isDestroyed()) {
      this.stopWatcher(sessionId);
      if (window.webContents.getURL() !== normalizedUrl) {
        await window.loadURL(normalizedUrl);
      }
    }

    this.emitEvent({
      type: "session_updated",
      sessionId,
      taskId: session.taskId,
      timestamp: Date.now(),
      session,
    });

    if (options?.show) {
      await this.showCanvas(sessionId);
    }

    console.log(`[CanvasManager] Opened URL in session ${sessionId}: ${normalizedUrl}`);
    return normalizedUrl;
  }

  /**
   * Ensure a window exists for taking snapshots (hidden by default)
   * This creates a hidden window that can be used for previews without
   * showing a separate window to the user
   */
  private async ensureWindowForSnapshots(sessionId: string): Promise<BrowserWindow> {
    const { BrowserWindow: BrowserWindowCtor, screen: screenApi } = requireElectronRuntime();
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error("Canvas session not found");
    }

    let window = this.windows.get(sessionId);

    if (!window || window.isDestroyed()) {
      // Calculate initial position - to the right of main window or right side of screen
      let initialX: number | undefined;
      let initialY: number | undefined;
      let initialHeight = 700;

      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        const mainBounds = this.mainWindow.getBounds();
        initialX = mainBounds.x + mainBounds.width + 20;
        initialY = mainBounds.y;
        initialHeight = mainBounds.height;
      } else {
        // Fallback: position on right side of primary display
        const primaryDisplay = screenApi.getPrimaryDisplay();
        const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;
        initialX = screenWidth - 920; // 900 width + 20 margin
        initialY = 50;
        initialHeight = screenHeight - 100;
      }

      // Create new HIDDEN window for snapshots
      // NOT a child window - will be positioned to the side when shown
      window = new BrowserWindowCtor({
        x: initialX,
        y: initialY,
        width: 900,
        height: initialHeight,
        title: session.title || "Live Canvas",
        show: false, // Start hidden - only show when user explicitly requests
        // No parent - independent window that won't overlap main app
        webPreferences: {
          preload: path.join(__dirname, "canvas-preload.js"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false,
        },
        backgroundColor: "#1a1a2e",
      }) as BrowserWindow;

      this.windows.set(sessionId, window);
      this.windowToSession.set(window.id, sessionId);

      // Handle window close
      window.on("closed", () => {
        this.windows.delete(sessionId);
        this.windowToSession.delete(window!.id);
        this.stopWatcher(sessionId);
      });

      // Forward console messages from canvas to the renderer
      window.webContents.on("console-message", (_event, level, message) => {
        const levelMap: Record<number, "log" | "warn" | "error" | "info"> = {
          0: "log", // Verbose/debug → log
          1: "info",
          2: "warn",
          3: "error",
        };
        this.emitEvent({
          type: "console_message",
          sessionId,
          taskId: session.taskId,
          timestamp: Date.now(),
          console: {
            level: levelMap[level] || "log",
            message,
          },
        });
      });

      const mode = this.getSessionMode(session);
      let targetUrl = this.getCanvasUrl(sessionId);
      if (mode === "browser" && session.url) {
        try {
          targetUrl = this.normalizeUrl(session.url);
        } catch (error) {
          console.warn(
            "[CanvasManager] Invalid stored URL, falling back to canvas content:",
            error,
          );
          session.mode = "html";
          session.url = undefined;
        }
      }

      // Load the canvas URL (or remote URL for browser mode)
      await window.loadURL(targetUrl);

      // Start file watcher for auto-reload only in HTML mode
      if (mode === "html") {
        this.startWatcher(sessionId, session.sessionDir, window);
      }
    }

    // Ensure watcher state is correct for existing windows
    if (window && !window.isDestroyed()) {
      const mode = this.getSessionMode(session);
      if (mode === "html") {
        this.startWatcher(sessionId, session.sessionDir, window);
      } else {
        this.stopWatcher(sessionId);
      }
    }

    return window;
  }

  /**
   * Show the canvas window (opens it visibly to the user)
   */
  async showCanvas(sessionId: string): Promise<void> {
    const { screen: screenApi } = requireElectronRuntime();
    // Ensure window exists (may be hidden)
    const window = await this.ensureWindowForSnapshots(sessionId);

    let bounds: { x: number; y: number; width: number; height: number };

    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      const mainBounds = this.mainWindow.getBounds();
      console.log(`[CanvasManager] Main window bounds:`, mainBounds);

      // Position canvas window completely to the RIGHT of the main window
      // This ensures it never overlaps with the main app
      bounds = {
        x: mainBounds.x + mainBounds.width + 20, // 20px gap to the right
        y: mainBounds.y,
        width: 900,
        height: mainBounds.height,
      };
    } else {
      console.log(`[CanvasManager] WARNING: mainWindow not available, using fallback position`);
      // Fallback: position on right side of primary display
      const primaryDisplay = screenApi.getPrimaryDisplay();
      const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;
      bounds = {
        x: screenWidth - 920, // 900 width + 20 margin
        y: 50,
        width: 900,
        height: screenHeight - 100,
      };
    }

    console.log(`[CanvasManager] Setting canvas window bounds:`, bounds);

    // Always set position first to ensure correct placement
    window.setPosition(bounds.x, bounds.y);
    window.setSize(bounds.width, bounds.height);

    // Show and focus the window so keyboard input works for interactive browsing
    if (!window.isVisible()) {
      window.show();
    }
    window.focus();

    // Ensure bounds are applied after show (some systems need this)
    window.setBounds(bounds);

    this.emitEvent({
      type: "window_opened",
      sessionId,
      taskId: this.sessions.get(sessionId)!.taskId,
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
    session.status = "closed";

    // Persist sessions to disk (removes closed sessions)
    await this.persistSessions();

    // Emit event
    this.emitEvent({
      type: "session_closed",
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
    // Ensure window exists (create hidden one if needed)
    const window = await this.ensureWindowForSnapshots(sessionId);
    if (!window || window.isDestroyed()) {
      throw new Error("Canvas window could not be created");
    }

    return window.webContents.executeJavaScript(script);
  }

  /**
   * Take a screenshot of the canvas
   */
  async takeSnapshot(sessionId: string): Promise<CanvasSnapshot> {
    // Ensure window exists (create hidden one if needed)
    const window = await this.ensureWindowForSnapshots(sessionId);
    if (!window || window.isDestroyed()) {
      throw new Error("Canvas window could not be created");
    }

    const image = await window.webContents.capturePage();
    const size = image.getSize();

    return {
      sessionId,
      imageBase64: image.toPNG().toString("base64"),
      width: size.width,
      height: size.height,
    };
  }

  /**
   * Export canvas content as a standalone HTML file
   * Returns the HTML content with all assets inlined if possible
   */
  async exportAsHTML(sessionId: string): Promise<{ content: string; filename: string }> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Canvas session not found: ${sessionId}`);
    }

    const htmlPath = path.join(session.sessionDir, "index.html");
    if (!existsSync(htmlPath)) {
      throw new Error("Canvas index.html not found");
    }

    const content = await fs.readFile(htmlPath, "utf-8");
    const filename = `canvas-${session.title?.replace(/[^a-z0-9]/gi, "-") || sessionId.slice(0, 8)}.html`;

    console.log(`[CanvasManager] Exported HTML for session ${sessionId}`);
    return { content, filename };
  }

  /**
   * Export all canvas files to a target directory
   */
  async exportToFolder(
    sessionId: string,
    targetDir: string,
  ): Promise<{ files: string[]; targetDir: string }> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Canvas session not found: ${sessionId}`);
    }

    if (!existsSync(session.sessionDir)) {
      throw new Error("Canvas session directory not found");
    }

    // Create target directory if it doesn't exist
    await fs.mkdir(targetDir, { recursive: true });

    // Get all files in the session directory
    const files = readdirSync(session.sessionDir);
    const copiedFiles: string[] = [];

    for (const file of files) {
      const srcPath = path.join(session.sessionDir, file);
      const destPath = path.join(targetDir, file);
      await fs.copyFile(srcPath, destPath);
      copiedFiles.push(file);
    }

    console.log(
      `[CanvasManager] Exported ${copiedFiles.length} files for session ${sessionId} to ${targetDir}`,
    );
    return { files: copiedFiles, targetDir };
  }

  /**
   * Open canvas content in the default system browser
   */
  async openInBrowser(sessionId: string): Promise<{ success: boolean; path: string }> {
    const { shell: shellApi } = requireElectronRuntime();
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Canvas session not found: ${sessionId}`);
    }

    if (this.getSessionMode(session) === "browser" && session.url) {
      await shellApi.openExternal(session.url);
      console.log(`[CanvasManager] Opened session ${sessionId} in browser: ${session.url}`);
      return { success: true, path: session.url };
    }

    const htmlPath = path.join(session.sessionDir, "index.html");
    if (!existsSync(htmlPath)) {
      throw new Error("Canvas index.html not found");
    }

    // Open in default browser
    await shellApi.openPath(htmlPath);

    console.log(`[CanvasManager] Opened session ${sessionId} in browser: ${htmlPath}`);
    return { success: true, path: htmlPath };
  }

  /**
   * Get the session directory path for external access
   */
  getSessionDir(sessionId: string): string | null {
    const session = this.sessions.get(sessionId);
    return session?.sessionDir || null;
  }

  /**
   * Handle A2UI action from canvas window
   */
  handleA2UIAction(
    windowId: number,
    action: { actionName: string; componentId?: string; context?: Record<string, unknown> },
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
      type: "a2ui_action",
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
  private startWatcher(sessionId: string, sessionDir: string, window: BrowserWindow): void {
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

    watcher.on("change", () => {
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
      this.mainWindow.webContents.send("canvas:event", event);
    }
  }

  // ===== Checkpoint / State History =====

  /**
   * Save a checkpoint of the current canvas file state.
   * Reads all files from the session directory and stores them in-memory.
   */
  async saveCheckpoint(sessionId: string, label?: string): Promise<CanvasCheckpoint> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Canvas session not found: ${sessionId}`);
    }

    if (!existsSync(session.sessionDir)) {
      throw new Error("Canvas session directory not found");
    }

    // Read all files from the session directory (with size limits)
    const fileNames = readdirSync(session.sessionDir);
    const files: Record<string, string> = {};
    const skipped: string[] = [];
    for (const fileName of fileNames) {
      const filePath = path.join(session.sessionDir, fileName);
      try {
        const stat = statSync(filePath);
        if (!stat.isFile()) {
          skipped.push(`${fileName} (not a file)`);
          continue;
        }
        if (stat.size > CanvasManager.MAX_CHECKPOINT_FILE_BYTES) {
          skipped.push(`${fileName} (${(stat.size / 1024 / 1024).toFixed(1)} MB exceeds limit)`);
          continue;
        }
        files[fileName] = await fs.readFile(filePath, "utf-8");
      } catch {
        skipped.push(`${fileName} (read error)`);
      }
    }
    if (skipped.length > 0) {
      console.warn(`[CanvasManager] Checkpoint skipped files: ${skipped.join(", ")}`);
    }

    const checkpoint: CanvasCheckpoint = {
      id: randomUUID(),
      sessionId,
      label: label || `Checkpoint ${new Date().toLocaleTimeString()}`,
      files,
      createdAt: Date.now(),
    };

    // Store checkpoint
    let sessionCheckpoints = this.checkpoints.get(sessionId);
    if (!sessionCheckpoints) {
      sessionCheckpoints = [];
      this.checkpoints.set(sessionId, sessionCheckpoints);
    }
    sessionCheckpoints.push(checkpoint);

    // Evict oldest if over limit
    while (sessionCheckpoints.length > this.maxCheckpointsPerSession) {
      sessionCheckpoints.shift();
    }

    // Emit event
    this.emitEvent({
      type: "checkpoint_saved",
      sessionId,
      taskId: session.taskId,
      timestamp: Date.now(),
      checkpoint: { id: checkpoint.id, label: checkpoint.label },
    });

    console.log(
      `[CanvasManager] Saved checkpoint "${checkpoint.label}" for session ${sessionId} (${Object.keys(files).length} files)`,
    );
    return checkpoint;
  }

  /**
   * Restore a canvas session to a previously saved checkpoint.
   * Writes all checkpoint files back to the session directory and reloads.
   */
  async restoreCheckpoint(sessionId: string, checkpointId: string): Promise<CanvasCheckpoint> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Canvas session not found: ${sessionId}`);
    }

    const sessionCheckpoints = this.checkpoints.get(sessionId);
    if (!sessionCheckpoints) {
      throw new Error("No checkpoints found for this session");
    }

    const checkpoint = sessionCheckpoints.find((cp) => cp.id === checkpointId);
    if (!checkpoint) {
      throw new Error(`Checkpoint not found: ${checkpointId}`);
    }

    // Verify session directory still exists before restoring
    if (!existsSync(session.sessionDir)) {
      throw new Error(`Cannot restore: session directory was deleted: ${session.sessionDir}`);
    }

    // Write all checkpoint files back to the session directory
    for (const [fileName, content] of Object.entries(checkpoint.files)) {
      const safeFilename = path.basename(fileName);
      const filePath = path.join(session.sessionDir, safeFilename);
      await fs.writeFile(filePath, content, "utf-8");
    }

    // Update session timestamp
    session.lastUpdatedAt = Date.now();
    session.mode = "html";
    session.url = undefined;

    // Reload the canvas window if it exists
    const window = this.windows.get(sessionId);
    if (window && !window.isDestroyed()) {
      await window.loadURL(this.getCanvasUrl(sessionId));
    }

    // Persist sessions
    this.persistSessions().catch((err) =>
      console.error("[CanvasManager] Failed to persist after restore:", err),
    );

    // Emit event
    this.emitEvent({
      type: "checkpoint_restored",
      sessionId,
      taskId: session.taskId,
      timestamp: Date.now(),
      checkpoint: { id: checkpoint.id, label: checkpoint.label },
    });

    this.emitEvent({
      type: "session_updated",
      sessionId,
      taskId: session.taskId,
      timestamp: Date.now(),
      session,
    });

    console.log(
      `[CanvasManager] Restored checkpoint "${checkpoint.label}" for session ${sessionId}`,
    );
    return checkpoint;
  }

  /**
   * List checkpoints for a session
   */
  listCheckpoints(sessionId: string): CanvasCheckpoint[] {
    return (this.checkpoints.get(sessionId) || []).map((cp) => ({
      ...cp,
      files: {}, // Don't return file contents in list — only metadata
    }));
  }

  /**
   * Delete a specific checkpoint
   */
  deleteCheckpoint(sessionId: string, checkpointId: string): boolean {
    const sessionCheckpoints = this.checkpoints.get(sessionId);
    if (!sessionCheckpoints) return false;

    const idx = sessionCheckpoints.findIndex((cp) => cp.id === checkpointId);
    if (idx === -1) return false;

    sessionCheckpoints.splice(idx, 1);
    return true;
  }

  /**
   * Compare two checkpoints and return a file-level diff summary.
   */
  diffCheckpoints(
    sessionId: string,
    fromCheckpointId: string,
    toCheckpointId: string,
  ): { added: string[]; removed: string[]; modified: string[] } | null {
    const sessionCheckpoints = this.checkpoints.get(sessionId);
    if (!sessionCheckpoints) return null;

    const fromCp = sessionCheckpoints.find((cp) => cp.id === fromCheckpointId);
    const toCp = sessionCheckpoints.find((cp) => cp.id === toCheckpointId);
    if (!fromCp || !toCp) return null;

    const fromFiles = Object.keys(fromCp.files);
    const toFiles = Object.keys(toCp.files);
    const fromSet = new Set(fromFiles);
    const toSet = new Set(toFiles);

    const added = toFiles.filter((f) => !fromSet.has(f));
    const removed = fromFiles.filter((f) => !toSet.has(f));
    const modified = toFiles.filter((f) => fromSet.has(f) && fromCp.files[f] !== toCp.files[f]);

    return { added, removed, modified };
  }

  /**
   * Find a checkpoint by label (useful for named phase checkpoints).
   */
  findCheckpointByLabel(sessionId: string, label: string): CanvasCheckpoint | undefined {
    const sessionCheckpoints = this.checkpoints.get(sessionId);
    if (!sessionCheckpoints) return undefined;
    return sessionCheckpoints.find((cp) => cp.label === label);
  }

  // ===== Cross-device Canvas Access =====

  /**
   * Get the current HTML content of a canvas session (for remote rendering).
   * Returns the contents of all files in the session directory.
   */
  async getSessionContent(sessionId: string): Promise<Record<string, string>> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Canvas session not found: ${sessionId}`);
    }

    if (!existsSync(session.sessionDir)) {
      throw new Error("Canvas session directory not found");
    }

    const fileNames = readdirSync(session.sessionDir);
    const files: Record<string, string> = {};
    for (const fileName of fileNames) {
      const filePath = path.join(session.sessionDir, fileName);
      try {
        files[fileName] = await fs.readFile(filePath, "utf-8");
      } catch {
        // Skip unreadable files
      }
    }

    return files;
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
    this.checkpoints.clear();

    console.log("[CanvasManager] Cleanup complete");
  }
}
