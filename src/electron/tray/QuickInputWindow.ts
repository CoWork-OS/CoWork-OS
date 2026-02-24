/**
 * QuickInputWindow - Floating task input window with response display
 *
 * A mini chat interface for quickly creating and viewing task responses.
 * - Positioned at bottom of screen
 * - Shows streaming responses inline
 * - Follows user across screens
 * - Frameless, minimal design
 */

import { BrowserWindow, screen, ipcMain, clipboard } from "electron";
import { IPC_CHANNELS } from "../../shared/types";

export class QuickInputWindow {
  private window: BrowserWindow | null = null;
  private onSubmit: ((task: string, workspaceId?: string) => void) | null = null;
  private onOpenMain: (() => void) | null = null;
  private isExpanded: boolean = false;
  private isProcessing: boolean = false;
  private hasResponse: boolean = false; // Track if there's a response to preserve
  private currentQuestion: string = ""; // Store the user's question

  constructor() {
    this.setupIpcHandlers();
  }

  /**
   * Set the callback for when a task is submitted
   */
  setOnSubmit(callback: (task: string, workspaceId?: string) => void): void {
    this.onSubmit = callback;
  }

  /**
   * Set the callback for when "Open in Main App" is clicked
   */
  setOnOpenMain(callback: () => void): void {
    this.onOpenMain = callback;
  }

  /**
   * Update the response display in the window
   */
  updateResponse(text: string, isComplete: boolean = false): void {
    if (!this.window || this.window.isDestroyed()) return;

    // Mark as no longer processing when complete, but preserve response
    if (isComplete) {
      this.isProcessing = false;
      this.hasResponse = true; // Keep window visible for viewing response
    }

    // Expand window if not already expanded
    if (!this.isExpanded) {
      this.expandWindow();
    }

    // Escape text for JavaScript string
    const escapedText = text.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$/g, "\\$");

    this.window.webContents
      .executeJavaScript(`
      (function() {
        const responseArea = document.getElementById('responseArea');
        const loadingIndicator = document.getElementById('loadingIndicator');
        const taskInput = document.getElementById('taskInput');
        const copyBtn = document.getElementById('copyBtn');
        if (responseArea) {
          responseArea.innerHTML = \`${escapedText}\`;
          responseArea.scrollTop = responseArea.scrollHeight;
        }
        if (loadingIndicator) {
          loadingIndicator.style.display = ${isComplete ? "'none'" : "'flex'"};
        }
        ${
          isComplete
            ? `
        if (taskInput) { taskInput.disabled = false; taskInput.placeholder = 'Ask anything...'; taskInput.focus(); }
        if (copyBtn) copyBtn.disabled = false;
        `
            : ""
        }
      })();
    `)
      .catch(() => {});
  }

  /**
   * Show loading state
   */
  showLoading(): void {
    if (!this.window || this.window.isDestroyed()) return;

    this.isProcessing = true;
    this.hasResponse = false;

    if (!this.isExpanded) {
      this.expandWindow();
    }

    // Show loading and the user's question
    const escapedQuestion = this.currentQuestion
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    this.window.webContents
      .executeJavaScript(`
      (function() {
        const responseArea = document.getElementById('responseArea');
        const loadingIndicator = document.getElementById('loadingIndicator');
        const submitBtn = document.getElementById('submitBtn');
        const taskInput = document.getElementById('taskInput');
        const copyBtn = document.getElementById('copyBtn');
        if (submitBtn) submitBtn.classList.remove('submitting');
        if (taskInput) { taskInput.disabled = true; taskInput.placeholder = 'Processing...'; }
        if (copyBtn) copyBtn.disabled = true;
        if (responseArea) {
          responseArea.innerHTML = ${escapedQuestion ? `'<div class="user-question"><strong>You:</strong> ${escapedQuestion}</div>'` : "''"};
        }
        if (loadingIndicator) loadingIndicator.style.display = 'flex';
      })();
    `)
      .catch(() => {});
  }

  /**
   * Get the current question
   */
  getCurrentQuestion(): string {
    return this.currentQuestion;
  }

  /**
   * Expand window to show response area
   */
  private expandWindow(): void {
    if (!this.window || this.window.isDestroyed() || this.isExpanded) return;

    const expandedHeight = 400;
    const bounds = this.window.getBounds();

    // Move window up and expand downward
    this.window.setBounds({
      x: bounds.x,
      y: bounds.y - (expandedHeight - bounds.height),
      width: bounds.width,
      height: expandedHeight,
    });

    // Show response container and add expanded class
    this.window.webContents
      .executeJavaScript(`
      document.querySelector('.main-container').classList.add('expanded');
      document.getElementById('responseContainer').style.display = 'flex';
    `)
      .catch(() => {});

    this.isExpanded = true;
  }

  /**
   * Collapse window back to input only
   */
  private collapseWindow(): void {
    if (!this.window || this.window.isDestroyed() || !this.isExpanded) return;

    const collapsedHeight = 80;
    const bounds = this.window.getBounds();

    // Move window down and collapse
    this.window.setBounds({
      x: bounds.x,
      y: bounds.y + (bounds.height - collapsedHeight),
      width: bounds.width,
      height: collapsedHeight,
    });

    // Hide response container and remove expanded class
    this.window.webContents
      .executeJavaScript(`
      document.querySelector('.main-container').classList.remove('expanded');
      document.getElementById('responseContainer').style.display = 'none';
      document.getElementById('responseArea').innerHTML = '';
    `)
      .catch(() => {});

    this.isExpanded = false;
  }

  /**
   * Show the quick input window
   */
  show(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.show();
      this.window.focus();
      // Focus the input field
      this.window.webContents
        .executeJavaScript(`
        document.getElementById('taskInput').focus();
      `)
        .catch(() => {});
      return;
    }

    this.createWindow();
  }

  /**
   * Hide the quick input window
   */
  hide(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.hide();
      // Reset state for next time
      this.isProcessing = false;
      this.hasResponse = false;
      this.currentQuestion = "";
      // Collapse the window back
      if (this.isExpanded) {
        this.collapseWindow();
      }
    }
  }

  /**
   * Toggle the quick input window
   */
  toggle(): void {
    if (this.window && !this.window.isDestroyed() && this.window.isVisible()) {
      this.hide();
    } else {
      this.show();
    }
  }

  /**
   * Create the quick input window
   */
  private createWindow(): void {
    // Get cursor position to show window on current display
    const cursorPoint = screen.getCursorScreenPoint();
    const currentDisplay = screen.getDisplayNearestPoint(cursorPoint);

    // Window dimensions
    const width = 700;
    const height = 80; // Start collapsed

    // Center horizontally on the current display, position at bottom
    const x = Math.round(currentDisplay.bounds.x + (currentDisplay.bounds.width - width) / 2);
    const y = Math.round(currentDisplay.bounds.y + currentDisplay.bounds.height - height - 100); // 100px from bottom

    // Reset expanded state
    this.isExpanded = false;

    this.window = new BrowserWindow({
      width,
      height,
      x,
      y,
      frame: false,
      transparent: true,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      closable: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: true,
      vibrancy: "under-window",
      visualEffectState: "active",
      backgroundColor: "#00000000",
      show: false,
      fullscreenable: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        // Note: preload scripts don't work with data URLs, we use executeJavaScript instead
      },
    });

    // Follow user across all macOS Spaces/desktops
    this.window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    // Load the quick input HTML using inline data URL
    // Note: We handle key events via before-input-event since data URLs don't load preload scripts
    const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Quick Task</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { height: 100%; background: transparent; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; overflow: hidden; }
    #root { height: 100%; display: flex; flex-direction: column; }

    .main-container {
      flex: 1; display: flex; flex-direction: column;
      background: rgba(40, 40, 45, 0.35); border-radius: 14px;
      border: 0.5px solid rgba(255, 255, 255, 0.12);
      backdrop-filter: blur(80px) saturate(200%); -webkit-backdrop-filter: blur(80px) saturate(200%);
      box-shadow: 0 20px 40px -10px rgba(0, 0, 0, 0.4), 0 0 0 0.5px rgba(255, 255, 255, 0.08) inset;
      overflow: hidden;
    }

    /* Draggable navbar - only visible when expanded */
    .navbar {
      height: 0; overflow: hidden; display: flex; align-items: center; justify-content: space-between;
      padding: 0 10px; -webkit-app-region: drag; cursor: grab;
      opacity: 0; transition: opacity 0.15s ease, height 0.15s ease;
      border-bottom: 0.5px solid transparent;
    }
    .main-container.expanded .navbar { height: 34px; }
    .main-container.expanded:hover .navbar { opacity: 1; border-bottom-color: rgba(255, 255, 255, 0.06); }
    .navbar-btn {
      width: 22px; height: 22px; display: flex; align-items: center; justify-content: center;
      background: transparent; border: none; border-radius: 5px; cursor: pointer;
      color: rgba(255, 255, 255, 0.45); transition: all 0.12s ease; -webkit-app-region: no-drag;
    }
    .navbar-btn:hover { background: rgba(255, 255, 255, 0.12); color: rgba(255, 255, 255, 0.85); }
    .navbar-btn svg { width: 12px; height: 12px; }
    .navbar-left, .navbar-right { display: flex; gap: 6px; }
    .navbar-btn.close:hover { background: rgba(255, 59, 48, 0.7); color: #fff; }
    .navbar-btn.copied { background: rgba(52, 199, 89, 0.7); color: #fff; }
    .navbar-btn:disabled { opacity: 0.25; cursor: not-allowed; pointer-events: none; }

    /* Response area - hidden by default */
    .response-container {
      display: none; flex-direction: column; flex: 1;
      padding: 14px 18px 0 18px; overflow: hidden;
    }
    .response-area {
      flex: 1; overflow-y: auto; color: rgba(255, 255, 255, 0.88);
      font-size: 14px; line-height: 1.65; letter-spacing: -0.01em;
      padding-right: 8px; padding-bottom: 10px;
    }
    .response-area::-webkit-scrollbar { width: 5px; }
    .response-area::-webkit-scrollbar-track { background: transparent; }
    .response-area::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 3px; }
    .response-area::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.25); }

    /* Loading indicator */
    .loading-indicator {
      display: none; align-items: center; gap: 6px;
      padding: 10px 0; color: rgba(255, 255, 255, 0.4); font-size: 12px;
    }
    .loading-dot { width: 5px; height: 5px; background: rgba(0, 122, 255, 0.7); border-radius: 50%; animation: pulse 1.4s ease-in-out infinite; }
    .loading-dot:nth-child(2) { animation-delay: 0.2s; }
    .loading-dot:nth-child(3) { animation-delay: 0.4s; }
    @keyframes pulse { 0%, 80%, 100% { opacity: 0.25; transform: scale(0.85); } 40% { opacity: 1; transform: scale(1); } }

    /* Input area */
    .input-container {
      padding: 14px 16px; display: flex; align-items: center;
      border-top: 0.5px solid transparent;
    }
    .main-container.expanded .input-container { border-top-color: rgba(255, 255, 255, 0.08); }
    .input-icon { width: 26px; height: 26px; margin-right: 12px; display: flex; align-items: center; justify-content: center; color: rgba(0, 122, 255, 0.7); }
    .input-icon svg { width: 18px; height: 18px; }
    .input-field { flex: 1; background: transparent; border: none; outline: none; color: rgba(255, 255, 255, 0.95); font-size: 15px; font-weight: 400; caret-color: #007AFF; transition: opacity 0.2s; }
    .input-field::placeholder { color: rgba(255, 255, 255, 0.3); }
    .input-field:disabled { opacity: 0.4; cursor: not-allowed; }
    .input-submit { width: 30px; height: 30px; margin-left: 10px; display: flex; align-items: center; justify-content: center; background: rgba(0, 122, 255, 0.85); border: none; border-radius: 50%; cursor: pointer; transition: all 0.15s ease; }
    .input-submit:hover { background: rgba(0, 122, 255, 1); transform: scale(1.08); }
    .input-submit:active { transform: scale(0.92); }
    .input-submit svg { width: 14px; height: 14px; color: #fff; }
    .input-submit.submitting { background: rgba(128, 128, 128, 0.4); pointer-events: none; }
    .input-submit.submitting svg { animation: pulse 1s ease-in-out infinite; }

    /* User question display */
    .user-question { padding: 10px 14px; margin-bottom: 14px; background: rgba(0, 122, 255, 0.12); border-radius: 10px; font-size: 13px; color: rgba(255,255,255,0.85); }
    .user-question strong { color: rgba(0, 122, 255, 0.9); font-weight: 500; }

    /* Error display */
    .error-message { padding: 10px 14px; margin: 8px 0; background: rgba(255, 59, 48, 0.12); border-radius: 10px; color: rgba(255, 100, 100, 0.95); font-size: 13px; }

    /* Markdown-like styling for response */
    .response-area strong { color: rgba(255, 255, 255, 0.95); font-weight: 600; }
    .response-area code { background: rgba(255,255,255,0.08); padding: 2px 6px; border-radius: 5px; font-family: 'SF Mono', Monaco, monospace; font-size: 12px; color: rgba(255,255,255,0.85); }
    .response-area pre { background: rgba(0,0,0,0.2); padding: 12px 14px; border-radius: 10px; overflow-x: auto; margin: 10px 0; border: 0.5px solid rgba(255,255,255,0.06); }
    .response-area pre code { background: none; padding: 0; font-size: 12px; }
    .response-area ul, .response-area ol { margin: 8px 0 8px 18px; }
    .response-area li { margin: 4px 0; color: rgba(255, 255, 255, 0.8); }
    .response-area p { margin: 8px 0; }
    .response-area h1, .response-area h2, .response-area h3 { color: rgba(255, 255, 255, 0.95); margin: 14px 0 8px 0; font-weight: 600; }
  </style>
</head>
<body>
  <div id="root">
    <div class="main-container">
      <!-- Draggable navbar with action buttons -->
      <div class="navbar">
        <div class="navbar-left">
          <button class="navbar-btn close" id="closeBtn" title="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </div>
        <div class="navbar-right">
          <button class="navbar-btn" id="copyBtn" title="Copy Response">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
          </button>
          <button class="navbar-btn" id="openMainBtn" title="Open in Main App">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18M9 9h12M9 15h12"/></svg>
          </button>
          <button class="navbar-btn" id="newWindowBtn" title="New Task">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
          </button>
        </div>
      </div>
      <div class="response-container" id="responseContainer">
        <div class="response-area" id="responseArea"></div>
        <div class="loading-indicator" id="loadingIndicator">
          <div class="loading-dot"></div>
          <div class="loading-dot"></div>
          <div class="loading-dot"></div>
          <span>Thinking...</span>
        </div>
      </div>
      <div class="input-container">
        <div class="input-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v8M8 12h8"/></svg>
        </div>
        <input type="text" class="input-field" placeholder="Ask anything..." autofocus id="taskInput" />
        <button class="input-submit" id="submitBtn" title="Send">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 19V5M5 12l7-7 7 7"/></svg>
        </button>
      </div>
    </div>
  </div>
  <script>
    document.getElementById('taskInput').focus();
  </script>
</body>
</html>`;

    this.window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(htmlContent)}`);

    // Show when ready
    this.window.once("ready-to-show", () => {
      this.window?.show();
      this.window?.focus();
    });

    // Hide on blur (clicking outside) - but not while processing or viewing response
    this.window.on("blur", () => {
      // Small delay to allow for click events to process
      setTimeout(() => {
        // Don't auto-hide if processing, viewing a response, or already focused back
        if (
          this.window &&
          !this.window.isDestroyed() &&
          !this.window.isFocused() &&
          !this.isProcessing &&
          !this.hasResponse
        ) {
          this.hide();
        }
      }, 100);
    });

    // Handle keyboard events since data URLs don't load preload scripts
    this.window.webContents.on("before-input-event", (event, input) => {
      if (input.key === "Escape") {
        this.hide();
      } else if (input.key === "Enter" && input.type === "keyDown" && !this.isProcessing) {
        // Get the input value and submit (only if not already processing)
        this.submitFromWindow();
      }
    });

    // Handle click on buttons via console message (since we can't use IPC with data URLs)
    this.window.webContents.on("console-message", (_event, _level, message) => {
      if (message === "__QUICK_INPUT_SUBMIT__") {
        this.submitFromWindow();
      } else if (message === "__QUICK_INPUT_CLOSE__") {
        this.hide();
      } else if (message === "__QUICK_INPUT_COPY__") {
        this.copyResponse();
      } else if (message === "__QUICK_INPUT_OPEN_MAIN__") {
        if (this.onOpenMain) this.onOpenMain();
      } else if (message === "__QUICK_INPUT_NEW_WINDOW__") {
        // Reset the window for a new task
        this.resetForNewTask();
      }
    });

    // Inject click handlers for all buttons
    this.window.webContents.on("did-finish-load", () => {
      this.window?.webContents
        .executeJavaScript(`
        document.getElementById('submitBtn').addEventListener('click', () => {
          console.log('__QUICK_INPUT_SUBMIT__');
        });
        document.getElementById('closeBtn').addEventListener('click', () => {
          console.log('__QUICK_INPUT_CLOSE__');
        });
        document.getElementById('copyBtn').addEventListener('click', () => {
          console.log('__QUICK_INPUT_COPY__');
        });
        document.getElementById('openMainBtn').addEventListener('click', () => {
          console.log('__QUICK_INPUT_OPEN_MAIN__');
        });
        document.getElementById('newWindowBtn').addEventListener('click', () => {
          console.log('__QUICK_INPUT_NEW_WINDOW__');
        });
      `)
        .catch(() => {});
    });
  }

  /**
   * Reset the window for a new task
   */
  private resetForNewTask(): void {
    if (!this.window || this.window.isDestroyed()) return;

    // Reset state
    this.hasResponse = false;
    this.currentQuestion = "";

    // Collapse if expanded
    if (this.isExpanded) {
      this.collapseWindow();
    }

    // Clear the input and response, reset states
    this.window.webContents
      .executeJavaScript(`
      const taskInput = document.getElementById('taskInput');
      const copyBtn = document.getElementById('copyBtn');
      if (taskInput) { taskInput.value = ''; taskInput.disabled = false; taskInput.placeholder = 'Ask anything...'; taskInput.focus(); }
      if (copyBtn) copyBtn.disabled = true;
    `)
      .catch(() => {});
  }

  /**
   * Copy the response text to clipboard
   */
  private async copyResponse(): Promise<void> {
    if (!this.window || this.window.isDestroyed()) return;

    try {
      // Get the text content from the response area
      const text = await this.window.webContents.executeJavaScript(
        `document.getElementById('responseArea').innerText`,
      );

      if (text) {
        clipboard.writeText(text);

        // Show visual feedback
        this.window.webContents
          .executeJavaScript(`
          (function() {
            const btn = document.getElementById('copyBtn');
            btn.classList.add('copied');
            btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>';
            setTimeout(() => {
              btn.classList.remove('copied');
              btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>';
            }, 1500);
          })();
        `)
          .catch(() => {});
      }
    } catch (error) {
      console.error("[QuickInputWindow] Failed to copy response:", error);
    }
  }

  /**
   * Get input value and submit task
   */
  private async submitFromWindow(): Promise<void> {
    if (!this.window || this.window.isDestroyed()) return;
    if (this.isProcessing) return; // Don't allow submit while processing

    try {
      const task = await this.window.webContents.executeJavaScript(
        `document.getElementById('taskInput').value.trim()`,
      );

      if (task && this.onSubmit) {
        // Store the question for display
        this.currentQuestion = task;
        this.hasResponse = false; // Reset for new task

        // Don't hide - keep window visible to show response
        // Clear the input and show submit feedback
        this.window?.webContents
          .executeJavaScript(`
          document.getElementById('taskInput').value = '';
          document.getElementById('submitBtn').classList.add('submitting');
        `)
          .catch(() => {});
        this.onSubmit(task);
      }
    } catch (error) {
      console.error("[QuickInputWindow] Failed to get input value:", error);
    }
  }

  /**
   * Setup IPC handlers for the quick input window
   */
  private setupIpcHandlers(): void {
    ipcMain.handle(IPC_CHANNELS.QUICK_INPUT_SUBMIT, (_event, task: string, workspaceId?: string) => {
      console.log("[QuickInputWindow] Received submit:", task);
      this.hide();
      if (this.onSubmit && task.trim()) {
        console.log("[QuickInputWindow] Calling onSubmit callback");
        this.onSubmit(task.trim(), workspaceId);
      }
    });

    ipcMain.handle(IPC_CHANNELS.QUICK_INPUT_CLOSE, () => {
      this.hide();
    });
  }

  /**
   * Destroy the window
   */
  destroy(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.destroy();
      this.window = null;
    }
  }
}
