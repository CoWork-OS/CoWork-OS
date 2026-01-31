/**
 * Canvas IPC Handlers
 *
 * IPC handlers for Live Canvas operations.
 * These handlers bridge the renderer process with the CanvasManager.
 */

import { ipcMain, BrowserWindow } from 'electron';
import { IPC_CHANNELS, CanvasSession, CanvasA2UIAction } from '../../shared/types';
import { CanvasManager } from '../canvas/canvas-manager';
import { AgentDaemon } from '../agent/daemon';

/**
 * Setup Canvas IPC handlers
 */
export function setupCanvasHandlers(
  mainWindow: BrowserWindow,
  agentDaemon: AgentDaemon
): void {
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
        console.error('[CanvasHandlers] Failed to send A2UI action to task:', err);
      });
    }
  });

  // Create a new canvas session
  ipcMain.handle(IPC_CHANNELS.CANVAS_CREATE, async (_, data: {
    taskId: string;
    workspaceId: string;
    title?: string;
  }): Promise<CanvasSession> => {
    return manager.createSession(data.taskId, data.workspaceId, data.title);
  });

  // Get a canvas session by ID
  ipcMain.handle(IPC_CHANNELS.CANVAS_GET_SESSION, async (_, sessionId: string): Promise<CanvasSession | null> => {
    return manager.getSession(sessionId) || null;
  });

  // List all canvas sessions (optionally filtered by taskId)
  ipcMain.handle(IPC_CHANNELS.CANVAS_LIST_SESSIONS, async (_, taskId?: string): Promise<CanvasSession[]> => {
    if (taskId) {
      return manager.listSessionsForTask(taskId);
    }
    return manager.listAllSessions();
  });

  // Show a canvas window
  ipcMain.handle(IPC_CHANNELS.CANVAS_SHOW, async (_, sessionId: string): Promise<{ success: boolean }> => {
    await manager.showCanvas(sessionId);
    return { success: true };
  });

  // Hide a canvas window
  ipcMain.handle(IPC_CHANNELS.CANVAS_HIDE, async (_, sessionId: string): Promise<{ success: boolean }> => {
    manager.hideCanvas(sessionId);
    return { success: true };
  });

  // Close a canvas session
  ipcMain.handle(IPC_CHANNELS.CANVAS_CLOSE, async (_, sessionId: string): Promise<{ success: boolean }> => {
    await manager.closeSession(sessionId);
    return { success: true };
  });

  // Push content to a canvas
  ipcMain.handle(IPC_CHANNELS.CANVAS_PUSH, async (_, data: {
    sessionId: string;
    content: string;
    filename?: string;
  }): Promise<{ success: boolean }> => {
    await manager.pushContent(data.sessionId, data.content, data.filename);
    return { success: true };
  });

  // Execute script in canvas context
  ipcMain.handle(IPC_CHANNELS.CANVAS_EVAL, async (_, data: {
    sessionId: string;
    script: string;
  }): Promise<{ result: unknown }> => {
    const result = await manager.evalScript(data.sessionId, data.script);
    return { result };
  });

  // Take a snapshot of the canvas
  ipcMain.handle(IPC_CHANNELS.CANVAS_SNAPSHOT, async (_, sessionId: string): Promise<{
    imageBase64: string;
    width: number;
    height: number;
  }> => {
    return manager.takeSnapshot(sessionId);
  });

  // Handle A2UI action from canvas window (internal IPC from canvas preload)
  ipcMain.handle('canvas:a2ui-action-from-window', async (event, action: {
    actionName: string;
    componentId?: string;
    context?: Record<string, unknown>;
  }): Promise<{ success: boolean }> => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window) {
      manager.handleA2UIAction(window.id, action);
    }
    return { success: true };
  });

  // Get session info from canvas window (internal IPC from canvas preload)
  ipcMain.handle('canvas:get-session-from-window', async (event): Promise<{
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
  });

  // Request snapshot from canvas window (internal IPC from canvas preload)
  ipcMain.handle('canvas:request-snapshot-from-window', async (event): Promise<{
    imageBase64: string;
    width: number;
    height: number;
  } | null> => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return null;

    const sessionId = manager.getSessionFromWindow(window);
    if (!sessionId) return null;

    return manager.takeSnapshot(sessionId);
  });

  // Log from canvas window (internal IPC from canvas preload)
  ipcMain.on('canvas:log', (event, data: { message: string; data?: unknown }) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const sessionId = window ? manager.getSessionFromWindow(window) : 'unknown';
    console.log(`[Canvas:${sessionId?.slice(0, 8)}] ${data.message}`, data.data || '');
  });

  console.log('[CanvasHandlers] Canvas IPC handlers registered');
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
