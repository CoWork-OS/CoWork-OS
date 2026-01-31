/**
 * Canvas Tools
 *
 * Agent tools for interacting with Live Canvas visual workspace.
 * Enables the agent to:
 * - Create canvas sessions
 * - Push HTML/CSS/JS content
 * - Execute JavaScript in the canvas context
 * - Take snapshots of the canvas
 * - Show/hide/close canvas windows
 */

import { Workspace } from '../../../shared/types';
import { AgentDaemon } from '../daemon';
import { CanvasManager } from '../../canvas/canvas-manager';
import { LLMTool } from '../llm/types';

/**
 * CanvasTools provides agent capabilities for visual content rendering
 */
export class CanvasTools {
  private manager: CanvasManager;

  constructor(
    private workspace: Workspace,
    private daemon: AgentDaemon,
    private taskId: string
  ) {
    this.manager = CanvasManager.getInstance();
  }

  /**
   * Create a new canvas session
   */
  async createCanvas(title?: string): Promise<{
    sessionId: string;
    sessionDir: string;
  }> {
    this.daemon.logEvent(this.taskId, 'tool_call', {
      tool: 'canvas_create',
      title,
    });

    try {
      const session = await this.manager.createSession(
        this.taskId,
        this.workspace.id,
        title
      );

      this.daemon.logEvent(this.taskId, 'tool_result', {
        tool: 'canvas_create',
        success: true,
        sessionId: session.id,
      });

      return {
        sessionId: session.id,
        sessionDir: session.sessionDir,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.daemon.logEvent(this.taskId, 'tool_error', {
        tool: 'canvas_create',
        error: message,
      });
      throw error;
    }
  }

  /**
   * Push content to the canvas
   */
  async pushContent(
    sessionId: string,
    content: string,
    filename: string = 'index.html'
  ): Promise<{ success: boolean }> {
    this.daemon.logEvent(this.taskId, 'tool_call', {
      tool: 'canvas_push',
      sessionId,
      filename,
      contentLength: content.length,
    });

    try {
      await this.manager.pushContent(sessionId, content, filename);

      this.daemon.logEvent(this.taskId, 'tool_result', {
        tool: 'canvas_push',
        success: true,
      });

      return { success: true };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.daemon.logEvent(this.taskId, 'tool_error', {
        tool: 'canvas_push',
        error: message,
      });
      throw error;
    }
  }

  /**
   * Show the canvas window
   */
  async showCanvas(sessionId: string): Promise<{ success: boolean }> {
    this.daemon.logEvent(this.taskId, 'tool_call', {
      tool: 'canvas_show',
      sessionId,
    });

    try {
      await this.manager.showCanvas(sessionId);

      this.daemon.logEvent(this.taskId, 'tool_result', {
        tool: 'canvas_show',
        success: true,
      });

      return { success: true };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.daemon.logEvent(this.taskId, 'tool_error', {
        tool: 'canvas_show',
        error: message,
      });
      throw error;
    }
  }

  /**
   * Hide the canvas window
   */
  hideCanvas(sessionId: string): { success: boolean } {
    this.daemon.logEvent(this.taskId, 'tool_call', {
      tool: 'canvas_hide',
      sessionId,
    });

    try {
      this.manager.hideCanvas(sessionId);

      this.daemon.logEvent(this.taskId, 'tool_result', {
        tool: 'canvas_hide',
        success: true,
      });

      return { success: true };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.daemon.logEvent(this.taskId, 'tool_error', {
        tool: 'canvas_hide',
        error: message,
      });
      throw error;
    }
  }

  /**
   * Close the canvas session
   */
  async closeCanvas(sessionId: string): Promise<{ success: boolean }> {
    this.daemon.logEvent(this.taskId, 'tool_call', {
      tool: 'canvas_close',
      sessionId,
    });

    try {
      await this.manager.closeSession(sessionId);

      this.daemon.logEvent(this.taskId, 'tool_result', {
        tool: 'canvas_close',
        success: true,
      });

      return { success: true };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.daemon.logEvent(this.taskId, 'tool_error', {
        tool: 'canvas_close',
        error: message,
      });
      throw error;
    }
  }

  /**
   * Execute JavaScript in the canvas context
   */
  async evalScript(sessionId: string, script: string): Promise<{ result: unknown }> {
    this.daemon.logEvent(this.taskId, 'tool_call', {
      tool: 'canvas_eval',
      sessionId,
      scriptLength: script.length,
    });

    try {
      const result = await this.manager.evalScript(sessionId, script);

      this.daemon.logEvent(this.taskId, 'tool_result', {
        tool: 'canvas_eval',
        success: true,
      });

      return { result };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.daemon.logEvent(this.taskId, 'tool_error', {
        tool: 'canvas_eval',
        error: message,
      });
      throw error;
    }
  }

  /**
   * Take a screenshot of the canvas
   */
  async takeSnapshot(sessionId: string): Promise<{
    imageBase64: string;
    width: number;
    height: number;
  }> {
    this.daemon.logEvent(this.taskId, 'tool_call', {
      tool: 'canvas_snapshot',
      sessionId,
    });

    try {
      const snapshot = await this.manager.takeSnapshot(sessionId);

      this.daemon.logEvent(this.taskId, 'tool_result', {
        tool: 'canvas_snapshot',
        success: true,
        width: snapshot.width,
        height: snapshot.height,
      });

      return {
        imageBase64: snapshot.imageBase64,
        width: snapshot.width,
        height: snapshot.height,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.daemon.logEvent(this.taskId, 'tool_error', {
        tool: 'canvas_snapshot',
        error: message,
      });
      throw error;
    }
  }

  /**
   * List all canvas sessions for the current task
   */
  listSessions(): {
    sessions: Array<{
      id: string;
      title?: string;
      status: string;
      createdAt: number;
    }>;
  } {
    const sessions = this.manager.listSessionsForTask(this.taskId);
    return {
      sessions: sessions.map((s) => ({
        id: s.id,
        title: s.title,
        status: s.status,
        createdAt: s.createdAt,
      })),
    };
  }

  /**
   * Static method to get tool definitions
   */
  static getToolDefinitions(): LLMTool[] {
    return [
      {
        name: 'canvas_create',
        description:
          'Create a new Live Canvas session for displaying interactive HTML/CSS/JS content. ' +
          'The canvas opens in a separate window where you can render visual content. ' +
          'Returns a session ID that you use for subsequent canvas operations.',
        input_schema: {
          type: 'object',
          properties: {
            title: {
              type: 'string',
              description: 'Optional title for the canvas window',
            },
          },
          required: [],
        },
      },
      {
        name: 'canvas_push',
        description:
          'Push HTML/CSS/JS content to a canvas session. ' +
          'Use this to display interactive visualizations, forms, dashboards, or any web content. ' +
          'The content will be rendered in the canvas window and auto-reload on changes.',
        input_schema: {
          type: 'object',
          properties: {
            session_id: {
              type: 'string',
              description: 'The canvas session ID returned from canvas_create',
            },
            content: {
              type: 'string',
              description: 'HTML content to display (can include embedded CSS and JavaScript)',
            },
            filename: {
              type: 'string',
              description: 'Filename to save (default: index.html). Use for CSS/JS files.',
            },
          },
          required: ['session_id', 'content'],
        },
      },
      {
        name: 'canvas_show',
        description: 'Show the canvas window and bring it to focus',
        input_schema: {
          type: 'object',
          properties: {
            session_id: {
              type: 'string',
              description: 'The canvas session ID',
            },
          },
          required: ['session_id'],
        },
      },
      {
        name: 'canvas_hide',
        description: 'Hide the canvas window without closing the session',
        input_schema: {
          type: 'object',
          properties: {
            session_id: {
              type: 'string',
              description: 'The canvas session ID',
            },
          },
          required: ['session_id'],
        },
      },
      {
        name: 'canvas_close',
        description: 'Close a canvas session and its window',
        input_schema: {
          type: 'object',
          properties: {
            session_id: {
              type: 'string',
              description: 'The canvas session ID',
            },
          },
          required: ['session_id'],
        },
      },
      {
        name: 'canvas_eval',
        description:
          'Execute JavaScript code in the canvas context. ' +
          'Use this to interact with the rendered content, read values, or trigger updates.',
        input_schema: {
          type: 'object',
          properties: {
            session_id: {
              type: 'string',
              description: 'The canvas session ID',
            },
            script: {
              type: 'string',
              description: 'JavaScript code to execute in the canvas context',
            },
          },
          required: ['session_id', 'script'],
        },
      },
      {
        name: 'canvas_snapshot',
        description:
          'Take a screenshot of the canvas content. ' +
          'Returns a base64-encoded PNG image of the current visual state.',
        input_schema: {
          type: 'object',
          properties: {
            session_id: {
              type: 'string',
              description: 'The canvas session ID',
            },
          },
          required: ['session_id'],
        },
      },
      {
        name: 'canvas_list',
        description: 'List all active canvas sessions for the current task',
        input_schema: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
    ];
  }
}
