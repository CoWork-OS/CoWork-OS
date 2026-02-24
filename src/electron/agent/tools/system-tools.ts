import { exec, execFile } from "child_process";
import { promisify } from "util";
import * as os from "os";
import * as path from "path";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import { Workspace } from "../../../shared/types";
import { AgentDaemon } from "../daemon";
import { LLMTool } from "../llm/types";
import { MemoryService } from "../../memory/MemoryService";
import { getUserDataDir } from "../../utils/user-data-dir";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT = 30 * 1000; // 30 seconds
const APPLESCRIPT_TIMEOUT_MS = 240 * 1000; // 4 minutes

function getElectronApis(): { clipboard?: any; desktopCapturer?: any; shell?: any; app?: any } {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require("electron") as any;
    if (electron && typeof electron === "object") return electron;
  } catch {
    // Not running under Electron.
  }
  return {};
}

/**
 * SystemTools provides system-level capabilities beyond the workspace
 * These tools enable more autonomous operation for general task completion
 */
export class SystemTools {
  constructor(
    private workspace: Workspace,
    private daemon: AgentDaemon,
    private taskId: string,
  ) {}

  /**
   * Update the workspace for this tool
   */
  setWorkspace(workspace: Workspace): void {
    this.workspace = workspace;
  }

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
    this.daemon.logEvent(this.taskId, "tool_call", {
      tool: "system_info",
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
      shell: process.env.SHELL || "unknown",
      username: os.userInfo().username,
    };

    this.daemon.logEvent(this.taskId, "tool_result", {
      tool: "system_info",
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
    this.daemon.logEvent(this.taskId, "tool_call", {
      tool: "read_clipboard",
    });

    const { clipboard } = getElectronApis();
    if (!clipboard) {
      throw new Error("Clipboard access is only available in the desktop (Electron) runtime");
    }

    const text = clipboard.readText();
    const image = clipboard.readImage();
    const formats = clipboard.availableFormats();

    const result = {
      text: text || "(no text in clipboard)",
      hasImage: !image.isEmpty(),
      formats,
    };

    this.daemon.logEvent(this.taskId, "tool_result", {
      tool: "read_clipboard",
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
    if (!text || typeof text !== "string") {
      throw new Error("Invalid text: must be a non-empty string");
    }

    this.daemon.logEvent(this.taskId, "tool_call", {
      tool: "write_clipboard",
      textLength: text.length,
    });

    const { clipboard } = getElectronApis();
    if (!clipboard) {
      throw new Error("Clipboard access is only available in the desktop (Electron) runtime");
    }

    clipboard.writeText(text);

    this.daemon.logEvent(this.taskId, "tool_result", {
      tool: "write_clipboard",
      success: true,
    });

    return { success: true };
  }

  /**
   * Take a screenshot and save it to the workspace
   * Uses Electron's desktopCapturer API
   */
  async takeScreenshot(options?: { filename?: string; fullscreen?: boolean }): Promise<{
    success: boolean;
    path: string;
    width: number;
    height: number;
  }> {
    const filename = options?.filename || `screenshot-${Date.now()}.png`;
    const outputPath = path.join(this.workspace.path, filename);

    this.daemon.logEvent(this.taskId, "tool_call", {
      tool: "take_screenshot",
      filename,
    });

    try {
      const { desktopCapturer } = getElectronApis();
      if (!desktopCapturer) {
        throw new Error("Screenshot capture is only available in the desktop (Electron) runtime");
      }

      // Get all available sources (screens and windows)
      const sources = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width: 1920, height: 1080 },
      });

      if (sources.length === 0) {
        throw new Error("No screen sources available for capture");
      }

      // Use the primary screen
      const primaryScreen = sources[0];
      const image = primaryScreen.thumbnail;

      if (image.isEmpty()) {
        throw new Error("Failed to capture screenshot - image is empty");
      }

      // Save to file
      const pngData = image.toPNG();
      await fs.writeFile(outputPath, pngData);

      const size = image.getSize();

      this.daemon.logEvent(this.taskId, "tool_result", {
        tool: "take_screenshot",
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
      this.daemon.logEvent(this.taskId, "tool_error", {
        tool: "take_screenshot",
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
    if (!appName || typeof appName !== "string") {
      throw new Error("Invalid appName: must be a non-empty string");
    }

    this.daemon.logEvent(this.taskId, "tool_call", {
      tool: "open_application",
      appName,
    });

    const platform = os.platform();

    try {
      let command: string;

      if (platform === "darwin") {
        // macOS: Use 'open -a' command
        command = `open -a "${appName}"`;
      } else if (platform === "win32") {
        // Windows: Use 'start' command
        command = `start "" "${appName}"`;
      } else {
        // Linux: Try common launchers
        command = appName.toLowerCase();
      }

      await execAsync(command, { timeout: DEFAULT_TIMEOUT });

      this.daemon.logEvent(this.taskId, "tool_result", {
        tool: "open_application",
        success: true,
        appName,
      });

      return {
        success: true,
        message: `Opened ${appName}`,
      };
    } catch (error: any) {
      this.daemon.logEvent(this.taskId, "tool_error", {
        tool: "open_application",
        error: error.message,
      });
      throw new Error(`Failed to open application "${appName}": ${error.message}`);
    }
  }

  /**
   * Open a URL in the default browser
   */
  async openUrl(url: string): Promise<{ success: boolean }> {
    if (!url || typeof url !== "string") {
      throw new Error("Invalid URL: must be a non-empty string");
    }

    // Basic URL validation
    try {
      new URL(url);
    } catch {
      throw new Error("Invalid URL format");
    }

    this.daemon.logEvent(this.taskId, "tool_call", {
      tool: "open_url",
      url,
    });

    const { shell } = getElectronApis();
    if (!shell?.openExternal) {
      throw new Error("openUrl is only available in the desktop (Electron) runtime");
    }

    await shell.openExternal(url);

    this.daemon.logEvent(this.taskId, "tool_result", {
      tool: "open_url",
      success: true,
    });

    return { success: true };
  }

  /**
   * Open a file or folder in the system's default application
   */
  async openPath(filePath: string): Promise<{ success: boolean; error?: string }> {
    if (!filePath || typeof filePath !== "string") {
      throw new Error("Invalid path: must be a non-empty string");
    }

    // Resolve relative to workspace
    const fullPath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(this.workspace.path, filePath);

    this.daemon.logEvent(this.taskId, "tool_call", {
      tool: "open_path",
      path: filePath,
    });

    const { shell } = getElectronApis();
    if (!shell?.openPath) {
      throw new Error("openPath is only available in the desktop (Electron) runtime");
    }

    const result = await shell.openPath(fullPath);

    if (result) {
      this.daemon.logEvent(this.taskId, "tool_error", {
        tool: "open_path",
        error: result,
      });
      return { success: false, error: result };
    }

    this.daemon.logEvent(this.taskId, "tool_result", {
      tool: "open_path",
      success: true,
    });

    return { success: true };
  }

  /**
   * Show a file in the system file manager (Finder/Explorer)
   */
  async showInFolder(filePath: string): Promise<{ success: boolean }> {
    if (!filePath || typeof filePath !== "string") {
      throw new Error("Invalid path: must be a non-empty string");
    }

    const fullPath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(this.workspace.path, filePath);

    this.daemon.logEvent(this.taskId, "tool_call", {
      tool: "show_in_folder",
      path: filePath,
    });

    const { shell } = getElectronApis();
    if (!shell?.showItemInFolder) {
      throw new Error("showInFolder is only available in the desktop (Electron) runtime");
    }

    shell.showItemInFolder(fullPath);

    this.daemon.logEvent(this.taskId, "tool_result", {
      tool: "show_in_folder",
      success: true,
    });

    return { success: true };
  }

  /**
   * Get environment variable value
   */
  async getEnvVariable(name: string): Promise<{ value: string | null; exists: boolean }> {
    if (!name || typeof name !== "string") {
      throw new Error("Invalid variable name: must be a non-empty string");
    }

    this.daemon.logEvent(this.taskId, "tool_call", {
      tool: "get_env",
      variable: name,
    });

    const value = process.env[name];

    this.daemon.logEvent(this.taskId, "tool_result", {
      tool: "get_env",
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
    const { app } = getElectronApis();
    const home = os.homedir();
    const getPath = typeof app?.getPath === "function" ? (name: string) => app.getPath(name) : null;
    return {
      userData: getUserDataDir(),
      temp: getPath ? getPath("temp") : os.tmpdir(),
      home: getPath ? getPath("home") : home,
      downloads: getPath ? getPath("downloads") : path.join(home, "Downloads"),
      documents: getPath ? getPath("documents") : path.join(home, "Documents"),
      desktop: getPath ? getPath("desktop") : path.join(home, "Desktop"),
    };
  }

  /**
   * Execute AppleScript code on macOS
   * This enables powerful automation capabilities for controlling applications and system features
   */
  async runAppleScript(script: string): Promise<{
    success: boolean;
    result: string;
  }> {
    if (!script || typeof script !== "string") {
      throw new Error("Invalid script: must be a non-empty string");
    }

    // Only available on macOS
    if (os.platform() !== "darwin") {
      throw new Error("AppleScript is only available on macOS");
    }

    const { script: normalizedScript, modified } = this.normalizeAppleScript(script);

    const approved = await this.daemon.requestApproval(
      this.taskId,
      "run_applescript",
      "Run AppleScript",
      {
        script: normalizedScript,
        scriptLength: normalizedScript.length,
        normalized: modified,
      },
    );

    if (!approved) {
      throw new Error("User denied AppleScript execution");
    }

    this.daemon.logEvent(this.taskId, "tool_call", {
      tool: "run_applescript",
      scriptLength: normalizedScript.length,
    });

    const attempts: Array<{ script: string; label: string }> = [
      { script: normalizedScript, label: "primary" },
    ];
    const timeoutWrapperFallback = this.stripAppleScriptTimeoutWrapper(normalizedScript);
    if (timeoutWrapperFallback) {
      attempts.push({ script: timeoutWrapperFallback, label: "timeout_wrapper_fallback" });
    }

    let lastError: any;
    for (const attempt of attempts) {
      try {
        if (!attempt.script || !attempt.script.trim()) {
          continue;
        }

        // Keep script as a single block to preserve structure of multi-line AppleScript.
        const args = ["-e", attempt.script];
        const { stdout, stderr } = await execFileAsync("osascript", args, {
          timeout: APPLESCRIPT_TIMEOUT_MS,
          maxBuffer: 1024 * 1024, // 1MB buffer
        });

        const result = stdout.trim() || stderr.trim() || "(no output)";

        this.daemon.logEvent(this.taskId, "tool_result", {
          tool: "run_applescript",
          success: true,
          outputLength: result.length,
        });

        return {
          success: true,
          result,
        };
      } catch (error: any) {
        lastError = error;
        const errorMessage = this.extractAppleScriptError(error);
        const canRetryWithFallback =
          attempt.label === "primary" &&
          attempts.length > 1 &&
          /syntax error/i.test(errorMessage) &&
          /timeout/i.test(errorMessage);

        if (canRetryWithFallback) {
          this.daemon.logEvent(this.taskId, "tool_warning", {
            tool: "run_applescript",
            warning: "Retrying AppleScript without timeout wrapper due to syntax error",
          });
          continue;
        }
        break;
      }
    }

    this.daemon.logEvent(this.taskId, "tool_error", {
      tool: "run_applescript",
      error: this.extractAppleScriptError(lastError),
    });
    throw new Error(`AppleScript execution failed: ${this.extractAppleScriptError(lastError)}`);
  }

  private extractAppleScriptError(error: any): string {
    if (!error) return "Unknown error";
    if (typeof error.stderr === "string" && error.stderr.trim()) {
      return error.stderr.trim();
    }
    if (typeof error.stdout === "string" && error.stdout.trim()) {
      return error.stdout.trim();
    }
    if (typeof error.message === "string" && error.message.trim()) {
      return error.message.trim();
    }
    return String(error);
  }

  private stripAppleScriptTimeoutWrapper(script: string): string | null {
    const trimmed = String(script || "").trim();
    if (!trimmed) return null;

    // Common model-generated wrapper:
    // with timeout of N seconds
    //   ...
    // end timeout
    const blockMatch = trimmed.match(
      /^with\s+timeout\s+of\s+\d+\s+seconds\s*[\r\n]+([\s\S]*?)[\r\n]+end\s+timeout\s*$/i,
    );
    if (blockMatch?.[1]) {
      const unwrapped = blockMatch[1].trim();
      return unwrapped.length > 0 && unwrapped !== trimmed ? unwrapped : null;
    }

    return null;
  }

  /**
   * Normalize AppleScript input for safer execution
   */
  private normalizeAppleScript(input: string): { script: string; modified: boolean } {
    let script = input;
    let modified = false;

    // Strip fenced code blocks if present
    const fencedMatch = script.match(/```(?:applescript)?\s*([\s\S]*?)\s*```/i);
    if (fencedMatch) {
      script = fencedMatch[1];
      modified = true;
    }

    // Replace smart quotes with straight quotes
    const replaced = script.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'");
    if (replaced !== script) {
      script = replaced;
      modified = true;
    }

    // Remove non-breaking spaces
    const cleaned = script.replace(/\u00A0/g, " ");
    if (cleaned !== script) {
      script = cleaned;
      modified = true;
    }

    return { script: script.trim(), modified };
  }

  /**
   * Search workspace memories (including imported ChatGPT conversations)
   * and workspace markdown files (.cowork/ kit files).
   */
  async searchMemories(input: { query: string; limit?: number }): Promise<{
    results: Array<{
      id: string;
      snippet: string;
      type: string;
      source: "db" | "markdown";
      date: string;
      path?: string;
    }>;
    totalFound: number;
  }> {
    this.daemon.logEvent(this.taskId, "tool_call", {
      tool: "search_memories",
      query: input.query,
    });

    try {
      const limit = Math.min(input.limit || 20, 50);

      // Search the memory database (semantic + BM25 hybrid)
      const dbResults = MemoryService.search(this.workspace.id, input.query, limit);

      // Also search workspace markdown (.cowork/ kit files)
      let mdResults: typeof dbResults = [];
      try {
        const kitRoot = path.join(this.workspace.path, ".cowork");
        if (fsSync.existsSync(kitRoot) && fsSync.statSync(kitRoot).isDirectory()) {
          mdResults = MemoryService.searchWorkspaceMarkdown(
            this.workspace.id,
            kitRoot,
            input.query,
            Math.max(5, Math.floor(limit / 3)),
          );
        }
      } catch {
        // Best-effort: markdown index may not be available
      }

      // Merge and deduplicate by id, sort by relevanceScore descending
      const seenIds = new Set<string>();
      const merged: typeof dbResults = [];
      for (const r of [...dbResults, ...mdResults]) {
        if (!seenIds.has(r.id)) {
          seenIds.add(r.id);
          merged.push(r);
        }
      }
      merged.sort((a, b) => b.relevanceScore - a.relevanceScore);
      const limited = merged.slice(0, limit);

      const mapped = limited.map((r) => ({
        id: r.id,
        snippet: r.snippet,
        type: r.type,
        source: r.source,
        date: new Date(r.createdAt).toISOString(),
        ...(r.source === "markdown" && "path" in r ? { path: r.path } : {}),
      }));

      this.daemon.logEvent(this.taskId, "tool_result", {
        tool: "search_memories",
        success: true,
        resultCount: mapped.length,
      });

      return { results: mapped, totalFound: mapped.length };
    } catch (error) {
      this.daemon.logEvent(this.taskId, "tool_result", {
        tool: "search_memories",
        success: false,
        error: String(error),
      });
      return { results: [], totalFound: 0 };
    }
  }

  /**
   * Static method to get tool definitions
   */
  static getToolDefinitions(options?: { headless?: boolean }): LLMTool[] {
    const headless = options?.headless === true;

    // In headless/VPS mode, avoid exposing tools that require an interactive desktop session.
    // Keep informational tools and memory search available.
    if (headless) {
      return [
        {
          name: "system_info",
          description: "Get system information including OS, CPU, memory, and user details",
          input_schema: {
            type: "object",
            properties: {},
            required: [],
          },
        },
        {
          name: "get_env",
          description: "Get the value of an environment variable",
          input_schema: {
            type: "object",
            properties: {
              name: {
                type: "string",
                description: "Name of the environment variable",
              },
            },
            required: ["name"],
          },
        },
        {
          name: "get_app_paths",
          description: "Get common system paths (home, downloads, documents, desktop, temp)",
          input_schema: {
            type: "object",
            properties: {},
            required: [],
          },
        },
        {
          name: "search_memories",
          description:
            "Search the workspace memory database for past observations, decisions, and insights " +
            "from previous sessions and imported conversations (e.g. ChatGPT history). " +
            "Use this tool when the user asks about something discussed previously, " +
            "or when you need to recall past context. Returns matching memory snippets.",
          input_schema: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description:
                  "Search query — keywords, names, topics, or phrases to find in memories",
              },
              limit: {
                type: "number",
                description: "Maximum number of results to return (default: 20, max: 50)",
              },
            },
            required: ["query"],
          },
        },
      ];
    }

    return [
      {
        name: "system_info",
        description: "Get system information including OS, CPU, memory, and user details",
        input_schema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      {
        name: "read_clipboard",
        description: "Read the current contents of the system clipboard",
        input_schema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      {
        name: "write_clipboard",
        description: "Write text to the system clipboard",
        input_schema: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description: "The text to write to the clipboard",
            },
          },
          required: ["text"],
        },
      },
      {
        name: "take_screenshot",
        description: "Take a screenshot of the screen and save it to the workspace",
        input_schema: {
          type: "object",
          properties: {
            filename: {
              type: "string",
              description: "Filename for the screenshot (optional, defaults to timestamp)",
            },
          },
          required: [],
        },
      },
      {
        name: "open_application",
        description:
          'Open an application by name (e.g., "Safari", "Terminal", "Visual Studio Code")',
        input_schema: {
          type: "object",
          properties: {
            appName: {
              type: "string",
              description: "Name of the application to open",
            },
          },
          required: ["appName"],
        },
      },
      {
        name: "open_url",
        description: "Open a URL in the default web browser",
        input_schema: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "The URL to open",
            },
          },
          required: ["url"],
        },
      },
      {
        name: "open_path",
        description: "Open a file or folder with the system default application",
        input_schema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Path to the file or folder to open",
            },
          },
          required: ["path"],
        },
      },
      {
        name: "show_in_folder",
        description:
          "Show a file in the system file manager (Finder on macOS, Explorer on Windows)",
        input_schema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Path to the file to reveal",
            },
          },
          required: ["path"],
        },
      },
      {
        name: "get_env",
        description: "Get the value of an environment variable",
        input_schema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Name of the environment variable",
            },
          },
          required: ["name"],
        },
      },
      {
        name: "get_app_paths",
        description: "Get common system paths (home, downloads, documents, desktop, temp)",
        input_schema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      {
        name: "run_applescript",
        description:
          "Execute AppleScript code on macOS to automate applications and system tasks. " +
          "Examples: control apps (Safari, Finder, Mail), manage windows, click UI elements, " +
          "get/set system preferences, interact with files, send keystrokes. " +
          "Only available on macOS.",
        input_schema: {
          type: "object",
          properties: {
            script: {
              type: "string",
              description:
                "The AppleScript code to execute. Can be a single line or multi-line script. " +
                "Example: 'tell application \"Finder\" to get name of front window'",
            },
          },
          required: ["script"],
        },
      },
      {
        name: "search_memories",
        description:
          "Search the workspace memory database AND workspace knowledge files (.cowork/) " +
          "for past observations, decisions, insights, and errors from previous sessions " +
          "and imported conversations (e.g. ChatGPT history). " +
          "Use this proactively when starting a task to check for relevant prior context, " +
          "or when you need to recall past decisions and their rationale.",
        input_schema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Search query — keywords, names, topics, or phrases to find in memories",
            },
            limit: {
              type: "number",
              description: "Maximum number of results to return (default: 20, max: 50)",
            },
          },
          required: ["query"],
        },
      },
    ];
  }
}
