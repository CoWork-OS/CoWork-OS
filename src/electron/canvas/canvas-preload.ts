/**
 * Canvas Preload Script
 *
 * Exposes a secure bridge between the canvas content and the main process.
 * This preload script is loaded into canvas BrowserWindows and provides:
 * - A2UI (Agent-to-UI) action sending
 * - Session information retrieval
 * - Agent update notifications
 */

import { contextBridge, ipcRenderer } from 'electron';

// Type definitions for the canvas API
interface CanvasAPI {
  /**
   * Send an A2UI action to the agent
   * @param actionName - Name of the action (e.g., 'button_click', 'form_submit')
   * @param componentId - Optional ID of the component that triggered the action
   * @param context - Optional context data to send with the action
   */
  sendA2UIAction: (
    actionName: string,
    componentId?: string,
    context?: Record<string, unknown>
  ) => Promise<void>;

  /**
   * Get information about the current canvas session
   */
  getSessionInfo: () => Promise<{
    id: string;
    taskId: string;
    workspaceId: string;
    title?: string;
  } | null>;

  /**
   * Register a callback for agent updates
   * @param callback - Function to call when agent sends an update
   */
  onAgentUpdate: (callback: (data: unknown) => void) => void;

  /**
   * Request a snapshot of the current canvas
   */
  requestSnapshot: () => Promise<{
    imageBase64: string;
    width: number;
    height: number;
  } | null>;

  /**
   * Log a message to the main process console
   */
  log: (message: string, data?: unknown) => void;
}

// Create the canvas API
const canvasAPI: CanvasAPI = {
  sendA2UIAction: async (actionName, componentId, context) => {
    await ipcRenderer.invoke('canvas:a2ui-action-from-window', {
      actionName,
      componentId,
      context,
    });
  },

  getSessionInfo: async () => {
    return ipcRenderer.invoke('canvas:get-session-from-window');
  },

  onAgentUpdate: (callback) => {
    ipcRenderer.on('canvas:agent-update', (_event, data) => {
      callback(data);
    });
  },

  requestSnapshot: async () => {
    return ipcRenderer.invoke('canvas:request-snapshot-from-window');
  },

  log: (message, data) => {
    ipcRenderer.send('canvas:log', { message, data });
  },
};

// Expose the API to the renderer
contextBridge.exposeInMainWorld('coworkCanvas', canvasAPI);

// Log that preload script loaded successfully
console.log('[CanvasPreload] Canvas preload script loaded');
