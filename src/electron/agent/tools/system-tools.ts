import { exec } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { clipboard, desktopCapturer, nativeImage, shell, app } from 'electron';
import { Workspace } from '../../../shared/types';
import { AgentDaemon } from '../daemon';
import { LLMTool } from '../llm/types';

const execAsync = promisify(exec);

const DEFAULT_TIMEOUT = 30 * 1000; // 30 seconds

/**
 * SystemTools provides system-level capabilities beyond the workspace
 * These tools enable more autonomous operation for general task completion
 */
export class SystemTools {
  constructor(
    private workspace: Workspace,
    private daemon: AgentDaemon,
    private taskId: string
  ) {}

  /**
   * Get system information (OS, CPU, memory, etc.)
   */
  async getSystemInfo(): Promise<{
    platform: string;
    arch: string;
    osVersion: string;
    hostname: string;
    cpus: number;
    totalMemory: string;
    freeMemory: string;
    uptime: string;
    homeDir: string;
    tempDir: string;
    shell: string;
    username: string;
  }> {
    this.daemon.logEvent(this.taskId, 'tool_call', {
      tool: 'system_info',
    });

    const totalMemGB = (os.totalmem() / (1024 * 1024 * 1024)).toFixed(2);
    const freeMemGB = (os.freemem() / (1024 * 1024 * 1024)).toFixed(2);
    const uptimeHours = (os.uptime() / 3600).toFixed(1);

    const result = {
      platform: os.platform(),
      arch: os.arch(),
      osVersion: os.release(),
      hostname: os.hostname(),
      cpus: os.cpus().length,
      totalMemory: `${totalMemGB} GB`,
      freeMemory: `${freeMemGB} GB`,
      uptime: `${uptimeHours} hours`,
      homeDir: os.homedir(),
      tempDir: os.tmpdir(),
      shell: process.env.SHELL || 'unknown',
      username: os.userInfo().username,
    };

    this.daemon.logEvent(this.taskId, 'tool_result', {
      tool: 'system_info',
      success: true,
    });

    return result;
  }

  /**
   * Read from system clipboard
   */
  async readClipboard(): Promise<{
    text: string;
    hasImage: boolean;
    formats: string[];
  }> {
    this.daemon.logEvent(this.taskId, 'tool_call', {
      tool: 'read_clipboard',
    });

    const text = clipboard.readText();
    const image = clipboard.readImage();
    const formats = clipboard.availableFormats();

    const result = {
      text: text || '(no text in clipboard)',
      hasImage: !image.isEmpty(),
      formats,
    };

    this.daemon.logEvent(this.taskId, 'tool_result', {
      tool: 'read_clipboard',
      success: true,
      hasText: !!text,
      hasImage: result.hasImage,
    });

    return result;
  }

  /**
   * Write text to system clipboard
   */
  async writeClipboard(text: string): Promise<{ success: boolean }> {
    if (!text || typeof text !== 'string') {
      throw new Error('Invalid text: must be a non-empty string');
    }

    this.daemon.logEvent(this.taskId, 'tool_call', {
      tool: 'write_clipboard',
      textLength: text.length,
    });

    clipboard.writeText(text);

    this.daemon.logEvent(this.taskId, 'tool_result', {
      tool: 'write_clipboard',
      success: true,
    });

    return { success: true };
  }

  /**
   * Take a screenshot and save it to the workspace
   * Uses Electron's desktopCapturer API
   */
  async takeScreenshot(options?: {
    filename?: string;
    fullscreen?: boolean;
  }): Promise<{
    success: boolean;
    path: string;
    width: number;
    height: number;
  }> {
    const filename = options?.filename || `screenshot-${Date.now()}.png`;
    const outputPath = path.join(this.workspace.path, filename);

    this.daemon.logEvent(this.taskId, 'tool_call', {
      tool: 'take_screenshot',
      filename,
    });

    try {
      // Get all available sources (screens and windows)
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1920, height: 1080 },
      });

      if (sources.length === 0) {
        throw new Error('No screen sources available for capture');
      }

      // Use the primary screen
      const primaryScreen = sources[0];
      const image = primaryScreen.thumbnail;

      if (image.isEmpty()) {
        throw new Error('Failed to capture screenshot - image is empty');
      }

      // Save to file
      const pngData = image.toPNG();
      await fs.writeFile(outputPath, pngData);

      const size = image.getSize();

      this.daemon.logEvent(this.taskId, 'tool_result', {
        tool: 'take_screenshot',
        success: true,
        path: filename,
        width: size.width,
        height: size.height,
      });

      return {
        success: true,
        path: filename,
        width: size.width,
        height: size.height,
      };
    } catch (error: any) {
      this.daemon.logEvent(this.taskId, 'tool_error', {
        tool: 'take_screenshot',
        error: error.message,
      });
      throw new Error(`Failed to take screenshot: ${error.message}`);
    }
  }

  /**
   * Open an application by name (macOS/Windows/Linux)
   */
  async openApplication(appName: string): Promise<{
    success: boolean;
    message: string;
  }> {
    if (!appName || typeof appName !== 'string') {
      throw new Error('Invalid appName: must be a non-empty string');
    }

    this.daemon.logEvent(this.taskId, 'tool_call', {
      tool: 'open_application',
      appName,
    });

    const platform = os.platform();

    try {
      let command: string;

      if (platform === 'darwin') {
        // macOS: Use 'open -a' command
        command = `open -a "${appName}"`;
      } else if (platform === 'win32') {
        // Windows: Use 'start' command
        command = `start "" "${appName}"`;
      } else {
        // Linux: Try common launchers
        command = appName.toLowerCase();
      }

      await execAsync(command, { timeout: DEFAULT_TIMEOUT });

      this.daemon.logEvent(this.taskId, 'tool_result', {
        tool: 'open_application',
        success: true,
        appName,
      });

      return {
        success: true,
        message: `Opened ${appName}`,
      };
    } catch (error: any) {
      this.daemon.logEvent(this.taskId, 'tool_error', {
        tool: 'open_application',
        error: error.message,
      });
      throw new Error(`Failed to open application "${appName}": ${error.message}`);
    }
  }

  /**
   * Open a URL in the default browser
   */
  async openUrl(url: string): Promise<{ success: boolean }> {
    if (!url || typeof url !== 'string') {
      throw new Error('Invalid URL: must be a non-empty string');
    }

    // Basic URL validation
    try {
      new URL(url);
    } catch {
      throw new Error('Invalid URL format');
    }

    this.daemon.logEvent(this.taskId, 'tool_call', {
      tool: 'open_url',
      url,
    });

    await shell.openExternal(url);

    this.daemon.logEvent(this.taskId, 'tool_result', {
      tool: 'open_url',
      success: true,
    });

    return { success: true };
  }

  /**
   * Open a file or folder in the system's default application
   */
  async openPath(filePath: string): Promise<{ success: boolean; error?: string }> {
    if (!filePath || typeof filePath !== 'string') {
      throw new Error('Invalid path: must be a non-empty string');
    }

    // Resolve relative to workspace
    const fullPath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(this.workspace.path, filePath);

    this.daemon.logEvent(this.taskId, 'tool_call', {
      tool: 'open_path',
      path: filePath,
    });

    const result = await shell.openPath(fullPath);

    if (result) {
      this.daemon.logEvent(this.taskId, 'tool_error', {
        tool: 'open_path',
        error: result,
      });
      return { success: false, error: result };
    }

    this.daemon.logEvent(this.taskId, 'tool_result', {
      tool: 'open_path',
      success: true,
    });

    return { success: true };
  }

  /**
   * Show a file in the system file manager (Finder/Explorer)
   */
  async showInFolder(filePath: string): Promise<{ success: boolean }> {
    if (!filePath || typeof filePath !== 'string') {
      throw new Error('Invalid path: must be a non-empty string');
    }

    const fullPath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(this.workspace.path, filePath);

    this.daemon.logEvent(this.taskId, 'tool_call', {
      tool: 'show_in_folder',
      path: filePath,
    });

    shell.showItemInFolder(fullPath);

    this.daemon.logEvent(this.taskId, 'tool_result', {
      tool: 'show_in_folder',
      success: true,
    });

    return { success: true };
  }

  /**
   * Get environment variable value
   */
  async getEnvVariable(name: string): Promise<{ value: string | null; exists: boolean }> {
    if (!name || typeof name !== 'string') {
      throw new Error('Invalid variable name: must be a non-empty string');
    }

    this.daemon.logEvent(this.taskId, 'tool_call', {
      tool: 'get_env',
      variable: name,
    });

    const value = process.env[name];

    this.daemon.logEvent(this.taskId, 'tool_result', {
      tool: 'get_env',
      exists: value !== undefined,
    });

    return {
      value: value ?? null,
      exists: value !== undefined,
    };
  }

  /**
   * Get the application's data directory
   */
  getAppPaths(): {
    userData: string;
    temp: string;
    home: string;
    downloads: string;
    documents: string;
    desktop: string;
  } {
    return {
      userData: app.getPath('userData'),
      temp: app.getPath('temp'),
      home: app.getPath('home'),
      downloads: app.getPath('downloads'),
      documents: app.getPath('documents'),
      desktop: app.getPath('desktop'),
    };
  }

  /**
   * Static method to get tool definitions
   */
  static getToolDefinitions(): LLMTool[] {
    return [
      {
        name: 'system_info',
        description: 'Get system information including OS, CPU, memory, and user details',
        input_schema: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
      {
        name: 'read_clipboard',
        description: 'Read the current contents of the system clipboard',
        input_schema: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
      {
        name: 'write_clipboard',
        description: 'Write text to the system clipboard',
        input_schema: {
          type: 'object',
          properties: {
            text: {
              type: 'string',
              description: 'The text to write to the clipboard',
            },
          },
          required: ['text'],
        },
      },
      {
        name: 'take_screenshot',
        description: 'Take a screenshot of the screen and save it to the workspace',
        input_schema: {
          type: 'object',
          properties: {
            filename: {
              type: 'string',
              description: 'Filename for the screenshot (optional, defaults to timestamp)',
            },
          },
          required: [],
        },
      },
      {
        name: 'open_application',
        description: 'Open an application by name (e.g., "Safari", "Terminal", "Visual Studio Code")',
        input_schema: {
          type: 'object',
          properties: {
            appName: {
              type: 'string',
              description: 'Name of the application to open',
            },
          },
          required: ['appName'],
        },
      },
      {
        name: 'open_url',
        description: 'Open a URL in the default web browser',
        input_schema: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              description: 'The URL to open',
            },
          },
          required: ['url'],
        },
      },
      {
        name: 'open_path',
        description: 'Open a file or folder with the system default application',
        input_schema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Path to the file or folder to open',
            },
          },
          required: ['path'],
        },
      },
      {
        name: 'show_in_folder',
        description: 'Show a file in the system file manager (Finder on macOS, Explorer on Windows)',
        input_schema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Path to the file to reveal',
            },
          },
          required: ['path'],
        },
      },
      {
        name: 'get_env',
        description: 'Get the value of an environment variable',
        input_schema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Name of the environment variable',
            },
          },
          required: ['name'],
        },
      },
      {
        name: 'get_app_paths',
        description: 'Get common system paths (home, downloads, documents, desktop, temp)',
        input_schema: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
    ];
  }
}
