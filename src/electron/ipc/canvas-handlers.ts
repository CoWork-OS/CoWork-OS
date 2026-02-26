/**
 * Canvas IPC Handlers
 *
 * IPC handlers for Live Canvas operations.
 * These handlers bridge the renderer process with the CanvasManager.
 */

import { ipcMain, BrowserWindow } from "electron";
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

  // Create a new canvas session
  ipcMain.handle(
    IPC_CHANNELS.CANVAS_CREATE,
    async (
      _,
      data: {
        taskId: string;
        workspaceId: string;
        title?: string;
      },
    ): Promise<CanvasSession> => {
      return manager.createSession(data.taskId, data.workspaceId, data.title);
    },
  );

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

  // Hide a canvas window
  ipcMain.handle(
    IPC_CHANNELS.CANVAS_HIDE,
    async (_, sessionId: string): Promise<{ success: boolean }> => {
      manager.hideCanvas(sessionId);
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

  // Push content to a canvas
  ipcMain.handle(
    IPC_CHANNELS.CANVAS_PUSH,
    async (
      _,
      data: {
        sessionId: string;
        content: string;
        filename?: string;
      },
    ): Promise<{ success: boolean }> => {
      await manager.pushContent(data.sessionId, data.content, data.filename);
      return { success: true };
    },
  );

  // Execute script in canvas context
  ipcMain.handle(
    IPC_CHANNELS.CANVAS_EVAL,
    async (
      _,
      data: {
        sessionId: string;
        script: string;
      },
    ): Promise<{ result: unknown }> => {
      const result = await manager.evalScript(data.sessionId, data.script);
      return { result };
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

  // Export canvas to folder
  ipcMain.handle(
    IPC_CHANNELS.CANVAS_EXPORT_TO_FOLDER,
    async (
      _,
      data: {
        sessionId: string;
        targetDir: string;
      },
    ): Promise<{ files: string[]; targetDir: string }> => {
      return manager.exportToFolder(data.sessionId, data.targetDir);
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

  // Open a remote URL inside the canvas window
  ipcMain.handle(
    IPC_CHANNELS.CANVAS_OPEN_URL,
    async (
      _,
      data: {
        sessionId: string;
        url: string;
        show?: boolean;
      },
    ): Promise<{ success: boolean; url: string }> => {
      const normalizedUrl = await manager.openUrl(data.sessionId, data.url, { show: data.show });
      return { success: true, url: normalizedUrl };
    },
  );

  // Get session directory
  ipcMain.handle(
    IPC_CHANNELS.CANVAS_GET_SESSION_DIR,
    async (_, sessionId: string): Promise<string | null> => {
      return manager.getSessionDir(sessionId);
    },
  );

  // Save a checkpoint
  ipcMain.handle(
    IPC_CHANNELS.CANVAS_CHECKPOINT_SAVE,
    async (
      _,
      data: {
        sessionId: string;
        label?: string;
      },
    ): Promise<{ id: string; label: string; createdAt: number }> => {
      const cp = await manager.saveCheckpoint(data.sessionId, data.label);
      return { id: cp.id, label: cp.label, createdAt: cp.createdAt };
    },
  );

  // List checkpoints
  ipcMain.handle(
    IPC_CHANNELS.CANVAS_CHECKPOINT_LIST,
    async (
      _,
      sessionId: string,
    ): Promise<
      Array<{
        id: string;
        label: string;
        createdAt: number;
      }>
    > => {
      return manager.listCheckpoints(sessionId).map((cp) => ({
        id: cp.id,
        label: cp.label,
        createdAt: cp.createdAt,
      }));
    },
  );

  // Restore a checkpoint
  ipcMain.handle(
    IPC_CHANNELS.CANVAS_CHECKPOINT_RESTORE,
    async (
      _,
      data: {
        sessionId: string;
        checkpointId: string;
      },
    ): Promise<{ id: string; label: string }> => {
      const cp = await manager.restoreCheckpoint(data.sessionId, data.checkpointId);
      return { id: cp.id, label: cp.label };
    },
  );

  // Delete a checkpoint
  ipcMain.handle(
    IPC_CHANNELS.CANVAS_CHECKPOINT_DELETE,
    async (
      _,
      data: {
        sessionId: string;
        checkpointId: string;
      },
    ): Promise<{ success: boolean }> => {
      const removed = manager.deleteCheckpoint(data.sessionId, data.checkpointId);
      return { success: removed };
    },
  );

  // Get canvas session content (all files)
  ipcMain.handle(
    IPC_CHANNELS.CANVAS_GET_CONTENT,
    async (_, sessionId: string): Promise<Record<string, string>> => {
      return manager.getSessionContent(sessionId);
    },
  );

  // Handle A2UI action from canvas window (internal IPC from canvas preload)
  ipcMain.handle(
    "canvas:a2ui-action-from-window",
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
    "canvas:get-session-from-window",
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
    "canvas:request-snapshot-from-window",
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
  ipcMain.on("canvas:log", (event, data: { message: string; data?: unknown }) => {
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
