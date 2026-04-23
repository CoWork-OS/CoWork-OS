import { execFile } from "child_process";
import { promisify } from "util";
import * as os from "os";
import * as path from "path";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import { Workspace, type VerbatimQuoteSourceType } from "../../../shared/types";
import { AgentDaemon } from "../daemon";
import { LLMTool } from "../llm/types";
import { MemoryService } from "../../memory/MemoryService";
import { SessionRecallService } from "../../memory/SessionRecallService";
import { LayeredMemoryIndexService } from "../../memory/LayeredMemoryIndexService";
import { QuoteRecallService } from "../../memory/QuoteRecallService";
import { MemoryFeaturesManager } from "../../settings/memory-features-manager";
import { getUserDataDir } from "../../utils/user-data-dir";
import {
  checkProjectAccess,
  getProjectIdFromWorkspaceRelPath,
  getWorkspaceRelativePosixPath,
} from "../../security/project-access";

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT = 30 * 1000; // 30 seconds
const APPLESCRIPT_TIMEOUT_MS = 240 * 1000; // 4 minutes

function sessionRecallEnabled(): boolean {
  return MemoryFeaturesManager.loadSettings().sessionRecallEnabled !== false;
}

function topicMemoryEnabled(): boolean {
  return MemoryFeaturesManager.loadSettings().topicMemoryEnabled !== false;
}

function verbatimRecallEnabled(): boolean {
  return MemoryFeaturesManager.loadSettings().verbatimRecallEnabled !== false;
}

const PROTECTED_SYSTEM_PATHS = [
  "/System",
  "/Library",
  "/usr",
  "/bin",
  "/sbin",
  "/etc",
  "/var",
  "/private",
  "C:\\Windows",
  "C:\\Program Files",
  "C:\\Program Files (x86)",
];

function normalizeAllowedRoot(root: string): string {
  try {
    return fsSync.existsSync(root) ? fsSync.realpathSync(root) : path.resolve(root);
  } catch {
    return path.resolve(root);
  }
}

function isPathWithinRoot(targetPath: string, rootPath: string): boolean {
  return targetPath === rootPath || targetPath.startsWith(`${rootPath}${path.sep}`);
}

function buildSessionRecallTool(description: string): LLMTool {
  return {
    name: "search_sessions",
    description,
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Keywords or phrases to search across transcript spans and checkpoints",
        },
        taskId: {
          type: "string",
          description: "Optional task ID to scope search to a single task transcript",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return (default: 10, max: 50)",
        },
        includeCheckpoints: {
          type: "boolean",
          description: "Also search transcript checkpoint summaries when available",
        },
      },
      required: ["query"],
    },
  };
}

function buildTopicMemoryTool(description: string): LLMTool {
  return {
    name: "memory_topics_load",
    description,
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Topic or query to use when building/loading topic files",
        },
        limit: {
          type: "number",
          description: "Maximum number of topic files to return (default: 4, max: 12)",
        },
        refresh: {
          type: "boolean",
          description: "Whether to rebuild the topic index for the current query before loading",
        },
      },
      required: ["query"],
    },
  };
}

function buildQuoteRecallTool(description: string): LLMTool {
  return {
    name: "search_quotes",
    description,
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Exact wording, phrase fragment, or semantic quote target to locate verbatim spans.",
        },
        taskId: {
          type: "string",
          description: "Optional task ID to scope recall to a single task or transcript.",
        },
        limit: {
          type: "number",
          description: "Maximum number of quote hits to return (default: 10, max: 50).",
        },
        sourceTypes: {
          type: "array",
          items: {
            type: "string",
            enum: ["transcript_span", "task_message", "memory", "workspace_markdown"],
          },
          description: "Optional source filters for the quote lane.",
        },
        includeWorkspaceNotes: {
          type: "boolean",
          description: "Whether to include indexed workspace markdown notes from `.cowork/`.",
        },
      },
      required: ["query"],
    },
  };
}

function getElectronApis(): { clipboard?: Any; desktopCapturer?: Any; shell?: Any; app?: Any } {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
// oxlint-disable-next-line typescript-eslint(no-require-imports)
    const electron = require("electron") as Any;
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

  private requireShellPermission(toolName: string): void {
    if (this.workspace.permissions.shell) {
      return;
    }
    throw new Error(`Tool "${toolName}" requires shell permission for this workspace`);
  }

  private isProtectedPath(absolutePath: string): boolean {
    const normalizedPath = path.normalize(absolutePath).toLowerCase();
    return PROTECTED_SYSTEM_PATHS.some((protectedPath) =>
      normalizedPath.startsWith(protectedPath.toLowerCase()),
    );
  }

  private resolveAccessibleLocalPath(inputPath: string): string {
    const workspaceRoot = normalizeAllowedRoot(this.workspace.path);
    const candidatePath = path.isAbsolute(inputPath)
      ? path.resolve(inputPath)
      : path.resolve(workspaceRoot, inputPath);

    let resolvedPath = candidatePath;
    try {
      resolvedPath = fsSync.realpathSync(candidatePath);
    } catch {
      resolvedPath = candidatePath;
    }

    if (this.workspace.permissions.unrestrictedFileAccess) {
      if (this.isProtectedPath(resolvedPath)) {
        throw new Error("Access denied: path is inside a protected system location");
      }
      return resolvedPath;
    }

    if (isPathWithinRoot(resolvedPath, workspaceRoot)) {
      return resolvedPath;
    }

    const allowedRoots = (this.workspace.permissions.allowedPaths || []).map(normalizeAllowedRoot);
    if (allowedRoots.some((root) => isPathWithinRoot(resolvedPath, root))) {
      return resolvedPath;
    }

    throw new Error("Access denied: path must be inside the workspace or an approved Allowed Path");
  }

  private async enforceProjectAccess(absolutePath: string): Promise<void> {
    const relPosix = getWorkspaceRelativePosixPath(this.workspace.path, absolutePath);
    if (relPosix === null) return;
    const projectId = getProjectIdFromWorkspaceRelPath(relPosix);
    if (!projectId) return;

    const taskGetter = (this.daemon as Any)?.getTask;
    const task =
      typeof taskGetter === "function" ? taskGetter.call(this.daemon, this.taskId) : null;
    const res = await checkProjectAccess({
      workspacePath: this.workspace.path,
      projectId,
      agentRoleId: task?.assignedAgentRoleId || null,
    });
    if (!res.allowed) {
      throw new Error(res.reason || `Access denied for project "${projectId}"`);
    }
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
    } catch (error: Any) {
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
    this.requireShellPermission("open_application");

    this.daemon.logEvent(this.taskId, "tool_call", {
      tool: "open_application",
      appName,
    });

    const platform = os.platform();

    try {
      if (platform === "darwin") {
        await execFileAsync("open", ["-a", appName], { timeout: DEFAULT_TIMEOUT });
      } else if (platform === "win32") {
        await execFileAsync(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-Command", "Start-Process", "-FilePath", appName],
          { timeout: DEFAULT_TIMEOUT, windowsHide: true },
        );
      } else {
        await execFileAsync(appName, [], { timeout: DEFAULT_TIMEOUT });
      }

      this.daemon.logEvent(this.taskId, "tool_result", {
        tool: "open_application",
        success: true,
        appName,
      });

      return {
        success: true,
        message: `Opened ${appName}`,
      };
    } catch (error: Any) {
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

    const fullPath = this.resolveAccessibleLocalPath(filePath);
    await this.enforceProjectAccess(fullPath);

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

    const fullPath = this.resolveAccessibleLocalPath(filePath);
    await this.enforceProjectAccess(fullPath);

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

    let lastError: Any;
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
      } catch (error: Any) {
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

  private extractAppleScriptError(error: Any): string {
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
  async searchMemories(input: {
    query: string;
    limit?: number;
    lane?: "archive" | "kit" | "all";
    types?: string[];
  }): Promise<{
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
      const lane = input.lane || "all";
      const typeFilter = new Set((input.types || []).map((item) => String(item || "").trim()).filter(Boolean));

      // Search the memory database (semantic + BM25 hybrid)
      const dbResults =
        lane === "kit" ? [] : MemoryService.search(this.workspace.id, input.query, limit);

      // Also search workspace markdown (.cowork/ kit files)
      let mdResults: typeof dbResults = [];
      if (lane !== "archive") {
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
      const filtered = typeFilter.size
        ? merged.filter((entry) => typeFilter.has(entry.type))
        : merged;
      filtered.sort((a, b) => b.relevanceScore - a.relevanceScore);
      const limited = filtered.slice(0, limit);

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

  async searchSessions(input: {
    query: string;
    taskId?: string;
    limit?: number;
    includeCheckpoints?: boolean;
  }): Promise<{
    results: Array<{
      taskId: string;
      timestamp: string;
      type: string;
      snippet: string;
      eventId?: string;
      seq?: number;
    }>;
    totalFound: number;
  }> {
    this.daemon.logEvent(this.taskId, "tool_call", {
      tool: "search_sessions",
      query: input.query,
    });

    if (!sessionRecallEnabled()) {
      const error = "Session recall is disabled in Memory settings.";
      this.daemon.logEvent(this.taskId, "tool_result", {
        tool: "search_sessions",
        success: false,
        error,
      });
      throw new Error(error);
    }

    try {
      const results = await SessionRecallService.search({
        workspacePath: this.workspace.path,
        query: input.query,
        taskId: input.taskId,
        limit: Math.min(input.limit || 10, 50),
        includeCheckpoints: input.includeCheckpoints === true,
      });
      const mapped = results.map((entry) => ({
        taskId: entry.taskId,
        timestamp: new Date(entry.timestamp).toISOString(),
        type: entry.type,
        snippet: entry.snippet,
        ...(entry.eventId ? { eventId: entry.eventId } : {}),
        ...(typeof entry.seq === "number" ? { seq: entry.seq } : {}),
      }));
      this.daemon.logEvent(this.taskId, "tool_result", {
        tool: "search_sessions",
        success: true,
        resultCount: mapped.length,
      });
      return { results: mapped, totalFound: mapped.length };
    } catch (error) {
      this.daemon.logEvent(this.taskId, "tool_result", {
        tool: "search_sessions",
        success: false,
        error: String(error),
      });
      return { results: [], totalFound: 0 };
    }
  }

  async searchQuotes(input: {
    query: string;
    taskId?: string;
    limit?: number;
    sourceTypes?: VerbatimQuoteSourceType[];
    includeWorkspaceNotes?: boolean;
  }): Promise<{
    results: Array<{
      id: string;
      sourceType: VerbatimQuoteSourceType;
      objectId: string;
      taskId?: string;
      timestamp: string;
      excerpt: string;
      path?: string;
      rankingReason: string;
      sourcePriority: number;
      eventId?: string;
      seq?: number;
      startLine?: number;
      endLine?: number;
      memoryType?: string;
    }>;
    totalFound: number;
  }> {
    this.daemon.logEvent(this.taskId, "tool_call", {
      tool: "search_quotes",
      query: input.query,
    });

    if (!verbatimRecallEnabled()) {
      const error = "Verbatim recall is disabled in Memory settings.";
      this.daemon.logEvent(this.taskId, "tool_result", {
        tool: "search_quotes",
        success: false,
        error,
      });
      throw new Error(error);
    }

    try {
      const results = await QuoteRecallService.search({
        db: this.daemon.getDatabase(),
        workspaceId: this.workspace.id,
        workspacePath: this.workspace.path,
        query: input.query,
        taskId: input.taskId,
        limit: Math.min(input.limit || 10, 50),
        sourceTypes: input.sourceTypes,
        includeWorkspaceNotes: input.includeWorkspaceNotes,
      });
      const mapped = results.map((entry) => ({
        id: entry.id,
        sourceType: entry.sourceType,
        objectId: entry.objectId,
        ...(entry.taskId ? { taskId: entry.taskId } : {}),
        timestamp: new Date(entry.timestamp).toISOString(),
        excerpt: entry.excerpt,
        ...(entry.path ? { path: entry.path } : {}),
        rankingReason: entry.rankingReason,
        sourcePriority: entry.sourcePriority,
        ...(entry.eventId ? { eventId: entry.eventId } : {}),
        ...(typeof entry.seq === "number" ? { seq: entry.seq } : {}),
        ...(typeof entry.startLine === "number" ? { startLine: entry.startLine } : {}),
        ...(typeof entry.endLine === "number" ? { endLine: entry.endLine } : {}),
        ...(entry.memoryType ? { memoryType: entry.memoryType } : {}),
      }));
      this.daemon.logEvent(this.taskId, "tool_result", {
        tool: "search_quotes",
        success: true,
        resultCount: mapped.length,
      });
      return { results: mapped, totalFound: mapped.length };
    } catch (error) {
      this.daemon.logEvent(this.taskId, "tool_result", {
        tool: "search_quotes",
        success: false,
        error: String(error),
      });
      return { results: [], totalFound: 0 };
    }
  }

  async loadMemoryTopics(input: {
    query: string;
    limit?: number;
    refresh?: boolean;
  }): Promise<{
    indexPath: string;
    topics: Array<{
      title: string;
      path: string;
      snippet: string;
      source: "memory" | "markdown";
    }>;
    totalFound: number;
  }> {
    this.daemon.logEvent(this.taskId, "tool_call", {
      tool: "memory_topics_load",
      query: input.query,
    });

    if (!topicMemoryEnabled()) {
      const error = "Topic memory is disabled in Memory settings.";
      this.daemon.logEvent(this.taskId, "tool_result", {
        tool: "memory_topics_load",
        success: false,
        error,
      });
      throw new Error(error);
    }

    try {
      const topicLimit = Math.min(input.limit || 4, 12);
      const shouldRefresh = input.refresh === true;
      const topics = shouldRefresh
        ? (
            await LayeredMemoryIndexService.refreshIndex({
              workspaceId: this.workspace.id,
              workspacePath: this.workspace.path,
              taskPrompt: input.query,
              topicLimit,
            })
          ).topics
        : (await LayeredMemoryIndexService.loadRelevantTopicSnippets({
            workspaceId: this.workspace.id,
            workspacePath: this.workspace.path,
            query: input.query,
            limit: topicLimit,
          }));
      const mapped = topics.map((topic) => ({
        title: topic.title,
        path: path.relative(this.workspace.path, topic.path),
        snippet: topic.content,
        source: topic.source,
      }));
      this.daemon.logEvent(this.taskId, "tool_result", {
        tool: "memory_topics_load",
        success: true,
        resultCount: mapped.length,
      });
      return {
        indexPath: path.relative(
          this.workspace.path,
          LayeredMemoryIndexService.resolveMemoryIndexPath(this.workspace.path),
        ),
        topics: mapped,
        totalFound: mapped.length,
      };
    } catch (error) {
      this.daemon.logEvent(this.taskId, "tool_result", {
        tool: "memory_topics_load",
        success: false,
        error: String(error),
      });
      return {
        indexPath: path.relative(
          this.workspace.path,
          LayeredMemoryIndexService.resolveMemoryIndexPath(this.workspace.path),
        ),
        topics: [],
        totalFound: 0,
      };
    }
  }

  /**
   * Static method to get tool definitions
   */
  static getToolDefinitions(options?: { headless?: boolean }): LLMTool[] {
    const headless = options?.headless === true;
    const enableSessionRecall = sessionRecallEnabled();
    const enableTopicMemory = topicMemoryEnabled();
    const enableVerbatimRecall = verbatimRecallEnabled();
    const sessionRecallTools: LLMTool[] = enableSessionRecall
      ? [
          buildSessionRecallTool(
            "Search recent task/session transcript spans and optional checkpoints for prior task context. " +
              "Use this when you need to recall what happened in a specific recent run, not just durable memory.",
          ),
        ]
      : [];
    const quoteRecallTools: LLMTool[] = enableVerbatimRecall
      ? [
          buildQuoteRecallTool(
            "Search exact quoted spans across transcripts, task messages, imported memories, and workspace notes. " +
              "Prefer this when the task needs the verbatim wording of what was actually said.",
          ),
        ]
      : [];
    const topicMemoryTools: LLMTool[] = enableTopicMemory
      ? [
          buildTopicMemoryTool(
            "Load topical memory packs from `.cowork/memory/topics` for the current query. " +
              "Use this when the task is topical and you want a small focused memory pack instead of broad recall.",
          ),
        ]
      : [];
    const conciseSessionRecallTools: LLMTool[] = enableSessionRecall
      ? [
          buildSessionRecallTool(
            "Search recent task/session transcript spans and optional checkpoints for prior task context.",
          ),
        ]
      : [];
    const conciseQuoteRecallTools: LLMTool[] = enableVerbatimRecall
      ? [
          buildQuoteRecallTool(
            "Search exact quoted spans across transcripts, task messages, imported memories, and workspace notes.",
          ),
        ]
      : [];
    const conciseTopicMemoryTools: LLMTool[] = enableTopicMemory
      ? [buildTopicMemoryTool("Load topical memory packs from `.cowork/memory/topics` for the current query.")]
      : [];

    // In headless/VPS mode, avoid exposing tools that require an interactive desktop session.
    // Keep informational tools and memory search available.
    if (headless) {
      const tools: LLMTool[] = [
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
              lane: {
                type: "string",
                enum: ["archive", "kit", "all"],
                description: "Restrict search to archive memories, workspace kit markdown, or both",
              },
              types: {
                type: "array",
                items: { type: "string" },
                description: "Optional memory types to keep (for example decision, insight, constraint)",
              },
            },
            required: ["query"],
          },
        },
        ...quoteRecallTools,
        ...sessionRecallTools,
        ...topicMemoryTools,
      ];
      return tools;
    }

    const tools: LLMTool[] = [
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
          "Execute exact AppleScript / osascript code on macOS. " +
          "Use this when the user explicitly asks for AppleScript, or as a low-level fallback " +
          "after screenshot/click/type_text/keypress-style computer-use tools cannot complete a specific native GUI step. " +
          "Do not prefer this first for ordinary native app interaction. Only available on macOS.",
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
            lane: {
              type: "string",
              enum: ["archive", "kit", "all"],
              description: "Restrict search to archive memories, workspace kit markdown, or both",
            },
            types: {
              type: "array",
              items: { type: "string" },
              description: "Optional memory types to keep (for example decision, insight, constraint)",
            },
          },
          required: ["query"],
        },
      },
      ...conciseQuoteRecallTools,
      ...conciseSessionRecallTools,
      ...conciseTopicMemoryTools,
    ];
    return tools;
  }
}
