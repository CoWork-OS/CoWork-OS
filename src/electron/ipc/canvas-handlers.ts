/**
 * Canvas IPC Handlers
 *
 * IPC handlers for Live Canvas operations.
 * These handlers bridge the renderer process with the CanvasManager.
 */

import { ipcMain, BrowserWindow, dialog } from "electron";
import {
  IPC_CHANNELS,
  CanvasSession,
  CanvasA2UIAction,
  CanvasCheckpoint as _CanvasCheckpoint,
} from "../../shared/types";
import { CanvasManager } from "../canvas/canvas-manager";
import { AgentDaemon } from "../agent/daemon";

/**
 * Setup Canvas IPC handlers
 */
export function setupCanvasHandlers(mainWindow: BrowserWindow, agentDaemon: AgentDaemon): void {
  const manager = CanvasManager.getInstance();

  // Set main window reference for event broadcasting
  manager.setMainWindow(mainWindow);

  // Set A2UI callback to forward actions to the agent
  manager.setA2UICallback((action: CanvasA2UIAction) => {
    // Find the task associated with this session
    const session = manager.getSession(action.sessionId);
    if (session) {
      // Format as user message and send to the running task
      const message = formatA2UIMessage(action);
      agentDaemon.sendMessage(session.taskId, message).catch((err: Error) => {
        console.error("[CanvasHandlers] Failed to send A2UI action to task:", err);
      });
    }
  });

  // Get a canvas session by ID
  ipcMain.handle(
    IPC_CHANNELS.CANVAS_GET_SESSION,
    async (_, sessionId: string): Promise<CanvasSession | null> => {
      return manager.getSession(sessionId) || null;
    },
  );

  // List all canvas sessions (optionally filtered by taskId)
  ipcMain.handle(
    IPC_CHANNELS.CANVAS_LIST_SESSIONS,
    async (_, taskId?: string): Promise<CanvasSession[]> => {
      if (taskId) {
        return manager.listSessionsForTask(taskId);
      }
      return manager.listAllSessions();
    },
  );

  // Show a canvas window
  ipcMain.handle(
    IPC_CHANNELS.CANVAS_SHOW,
    async (_, sessionId: string): Promise<{ success: boolean }> => {
      await manager.showCanvas(sessionId);
      return { success: true };
    },
  );

  // Close a canvas session
  ipcMain.handle(
    IPC_CHANNELS.CANVAS_CLOSE,
    async (_, sessionId: string): Promise<{ success: boolean }> => {
      await manager.closeSession(sessionId);
      return { success: true };
    },
  );

  // Take a snapshot of the canvas
  ipcMain.handle(
    IPC_CHANNELS.CANVAS_SNAPSHOT,
    async (
      _,
      sessionId: string,
    ): Promise<{
      imageBase64: string;
      width: number;
      height: number;
    }> => {
      return manager.takeSnapshot(sessionId);
    },
  );

  // Export canvas as HTML
  ipcMain.handle(
    IPC_CHANNELS.CANVAS_EXPORT_HTML,
    async (
      _,
      sessionId: string,
    ): Promise<{
      content: string;
      filename: string;
    }> => {
      return manager.exportAsHTML(sessionId);
    },
  );

  // Export canvas (page + assets/) to a folder the user picks in a native dialog.
  // The destination is chosen here in the main process; a renderer-supplied
  // path is never trusted for the write.
  ipcMain.handle(
    IPC_CHANNELS.CANVAS_EXPORT_TO_FOLDER,
    async (event, data: unknown): Promise<{ files: string[]; targetDir: string } | null> => {
      const sessionId =
        data && typeof data === "object" ? (data as { sessionId?: unknown }).sessionId : undefined;
      if (typeof sessionId !== "string" || !sessionId.trim() || !manager.getSession(sessionId)) {
        throw new Error("Invalid canvas session");
      }
      const owner = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
      const picked = await dialog.showOpenDialog(owner, {
        title: "Export canvas to folder",
        buttonLabel: "Export",
        properties: ["openDirectory", "createDirectory"],
      });
      if (picked.canceled || picked.filePaths.length === 0) return null;
      return manager.exportToFolder(sessionId, picked.filePaths[0]);
    },
  );

  // Open canvas in browser
  ipcMain.handle(
    IPC_CHANNELS.CANVAS_OPEN_IN_BROWSER,
    async (
      _,
      sessionId: string,
    ): Promise<{
      success: boolean;
      path: string;
    }> => {
      return manager.openInBrowser(sessionId);
    },
  );

  // Get session directory
  ipcMain.handle(
    IPC_CHANNELS.CANVAS_GET_SESSION_DIR,
    async (_, sessionId: string): Promise<string | null> => {
      return manager.getSessionDir(sessionId);
    },
  );

  // Handle A2UI action from canvas window (internal IPC from canvas preload)
  ipcMain.handle(
    IPC_CHANNELS.CANVAS_A2UI_ACTION_FROM_WINDOW,
    async (
      event,
      action: {
        actionName: string;
        componentId?: string;
        context?: Record<string, unknown>;
      },
    ): Promise<{ success: boolean }> => {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (window) {
        manager.handleA2UIAction(window.id, action);
      }
      return { success: true };
    },
  );

  // Get session info from canvas window (internal IPC from canvas preload)
  ipcMain.handle(
    IPC_CHANNELS.CANVAS_GET_SESSION_FROM_WINDOW,
    async (
      event,
    ): Promise<{
      id: string;
      taskId: string;
      workspaceId: string;
      title?: string;
    } | null> => {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window) return null;

      const sessionId = manager.getSessionFromWindow(window);
      if (!sessionId) return null;

      const session = manager.getSession(sessionId);
      if (!session) return null;

      return {
        id: session.id,
        taskId: session.taskId,
        workspaceId: session.workspaceId,
        title: session.title,
      };
    },
  );

  // Request snapshot from canvas window (internal IPC from canvas preload)
  ipcMain.handle(
    IPC_CHANNELS.CANVAS_REQUEST_SNAPSHOT_FROM_WINDOW,
    async (
      event,
    ): Promise<{
      imageBase64: string;
      width: number;
      height: number;
    } | null> => {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window) return null;

      const sessionId = manager.getSessionFromWindow(window);
      if (!sessionId) return null;

      return manager.takeSnapshot(sessionId);
    },
  );

  // Log from canvas window (internal IPC from canvas preload)
  ipcMain.on(IPC_CHANNELS.CANVAS_LOG, (event, data: { message: string; data?: unknown }) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const sessionId = window ? manager.getSessionFromWindow(window) : "unknown";
    console.log(`[Canvas:${sessionId?.slice(0, 8)}] ${data.message}`, data.data || "");
  });

  console.log("[CanvasHandlers] Canvas IPC handlers registered");
}

/**
 * Format A2UI action as a message for the agent
 */
function formatA2UIMessage(action: CanvasA2UIAction): string {
  let message = `[Canvas Interaction]\n`;
  message += `Action: ${action.actionName}\n`;

  if (action.componentId) {
    message += `Component: ${action.componentId}\n`;
  }

  if (action.context && Object.keys(action.context).length > 0) {
    message += `Context: ${JSON.stringify(action.context, null, 2)}\n`;
  }

  message += `\nThe user interacted with the canvas. Please respond appropriately based on this action.`;

  return message;
}

/**
 * Cleanup canvas handlers (call on app quit)
 */
export async function cleanupCanvasHandlers(): Promise<void> {
  const manager = CanvasManager.getInstance();
  await manager.cleanup();
}
