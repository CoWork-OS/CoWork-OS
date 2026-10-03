import { execFile } from "child_process";
import { promisify } from "util";
import * as os from "os";
import * as path from "path";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import { Workspace } from "../../../shared/types";
import { AgentDaemon } from "../daemon";
import {
  resolveWorkspaceFilesystemAccessWithApproval,
  evaluateWorkspaceFilesystemAccess,
  isAccessPathWithin,
  isProtectedFilesystemPath,
  type WorkspaceFilesystemApprovalHandlers,
} from "../../security/access-profile-paths";
import { evaluateNetworkPolicy } from "../../security/network-policy";
import { assertResolvedHostAllowed } from "../../security/address-classes";
import { LLMTool } from "../llm/types";
import { getUserDataDir } from "../../utils/user-data-dir";
import {
  checkProjectAccess,
  getProjectIdFromWorkspaceRelPath,
  getWorkspaceRelativePosixPath,
} from "../../security/project-access";
import {
  getDesktopLocationService,
  type DesktopLocationSnapshot,
} from "../../location/DesktopLocationService";

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT = 30 * 1000; // 30 seconds
const APPLESCRIPT_TIMEOUT_MS = 240 * 1000; // 4 minutes
const CURRENT_LOCATION_FAILURE_TTL_MS = 2 * 60 * 1000;

type MacOSAppProcessRecord = {
  pid: number;
  ppid: number | null;
  command: string;
  args: string;
};

type MacOSLaunchAgentRecord = {
  path: string;
  label: string | null;
  program: string | null;
  programArguments: string[];
  domain: "user" | "system";
  matches: boolean;
};

function getCurrentLocationFailureMessage(error: unknown): string {
  const rawMessage = error instanceof Error ? error.message : String(error || "");
  if (/timed out while getting current location/i.test(rawMessage)) {
    return [
      "Native desktop geolocation timed out.",
      "Do not retry get_current_location in this task; ask the user for a typed address, venue, or nearby landmark.",
      "Check operating system Location Services permissions for CoWork OS.",
    ].join(" ");
  }
  if (
    /desktop geolocation is not configured|macos core location helper is not built|location_not_configured/i.test(
      rawMessage,
    )
  ) {
    return [
      "Native desktop geolocation is not configured.",
      "Do not retry get_current_location in this task; ask the user for a typed address, venue, or nearby landmark.",
      "Build and bundle the native OS location helper for this platform.",
    ].join(" ");
  }
  if (/location access was denied|location_denied/i.test(rawMessage)) {
    return [
      "Desktop location access was denied.",
      "Do not retry get_current_location in this task; ask the user for a typed address, venue, or nearby landmark.",
    ].join(" ");
  }
  if (
    /current location is unavailable|geolocation is not available|location_unavailable|not implemented yet|not supported/i.test(
      rawMessage,
    )
  ) {
    return [
      "Native desktop geolocation is unavailable.",
      "Do not retry get_current_location in this task; ask the user for a typed address, venue, or nearby landmark.",
    ].join(" ");
  }
  return rawMessage || "Unable to determine current location.";
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
  private currentLocationFailure: {
    at: number;
    message: string;
  } | null = null;

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

  private getFileApprovalHandlers(): WorkspaceFilesystemApprovalHandlers {
    const daemon = this.daemon as unknown as {
      requestApproval?: (
        taskId: string,
        type: "external_file_access",
        description: string,
        details: Record<string, unknown>,
      ) => Promise<boolean>;
      consumeExternalFileApproval?: (
        taskId: string,
        filePath: string,
        operation: "read" | "write" | "delete",
      ) => boolean;
    };
    return {
      ...(typeof daemon.requestApproval === "function"
        ? {
            request: ({ path: approvedPath, operation, label }) =>
              daemon.requestApproval!(
                this.taskId,
                "external_file_access",
                `Allow ${operation} access to external ${label}: ${approvedPath}`,
                { path: approvedPath, operation, tool: "system_tools" },
              ),
          }
        : {}),
      ...(typeof daemon.consumeExternalFileApproval === "function"
        ? {
            consume: (approvedPath: string, operation: "read" | "write" | "delete") =>
              daemon.consumeExternalFileApproval!(this.taskId, approvedPath, operation),
          }
        : {}),
    };
  }

  private requireShellPermission(toolName: string): void {
    if (this.workspace.permissions.shell) {
      return;
    }
    throw new Error(`Tool "${toolName}" requires shell permission for this workspace`);
  }

  private isProtectedPath(absolutePath: string): boolean {
    return isProtectedFilesystemPath(absolutePath);
  }

  private async resolveAccessibleLocalPath(
    inputPath: string,
    operation: "read" | "write" = "read",
  ): Promise<string> {
    if (operation === "read" && this.workspace.permissions.read === false) {
      throw new Error("Read permission not granted for this path");
    }
    if (operation === "write" && this.workspace.permissions.write === false) {
      throw new Error("Write permission not granted for this path");
    }

    const access = await resolveWorkspaceFilesystemAccessWithApproval(
      this.workspace,
      inputPath,
      operation,
      "system file",
      this.getFileApprovalHandlers(),
    );
    if (access.decision !== "allow") {
      if (access.reason === "profile_filesystem_denied") {
        throw new Error(`Access denied by the active access profile: ${inputPath}`);
      }
      if (access.reason === "access_profile_unavailable") {
        throw new Error("The selected access profile is unavailable.");
      }
      throw new Error(
        "Access denied: path must be inside the workspace or an approved Allowed Path (external access was not approved)",
      );
    }

    if (this.isProtectedPath(access.path)) {
      throw new Error("Access denied: path is inside a protected system location");
    }
    return access.path;
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

  async getCurrentLocation(options?: {
    accuracy?: "coarse" | "precise";
    maxAgeMs?: number;
  }): Promise<{
    latitude: number;
    longitude: number;
    accuracyMeters: number;
    timestamp: string;
    source: DesktopLocationSnapshot["source"];
    mapsUrl: string;
  }> {
    this.daemon.logEvent(this.taskId, "tool_call", {
      tool: "get_current_location",
      accuracy: options?.accuracy || "precise",
    });

    if (
      this.currentLocationFailure &&
      Date.now() - this.currentLocationFailure.at < CURRENT_LOCATION_FAILURE_TTL_MS
    ) {
      throw new Error(this.currentLocationFailure.message);
    }

    let location: DesktopLocationSnapshot;
    try {
      location = await getDesktopLocationService().getCurrentLocation({
        accuracy: options?.accuracy,
        maxAgeMs: options?.maxAgeMs,
      });
      this.currentLocationFailure = null;
    } catch (error) {
      const message = getCurrentLocationFailureMessage(error);
      this.currentLocationFailure = { at: Date.now(), message };
      this.daemon.logEvent(this.taskId, "tool_result", {
        tool: "get_current_location",
        success: false,
        error: message,
      });
      throw new Error(message);
    }

    this.daemon.logEvent(this.taskId, "tool_result", {
      tool: "get_current_location",
      success: true,
      source: location.source,
      accuracyMeters: Math.round(location.accuracyMeters),
    });

    return {
      latitude: location.latitude,
      longitude: location.longitude,
      accuracyMeters: location.accuracyMeters,
      timestamp: new Date(location.timestamp).toISOString(),
      source: location.source,
      mapsUrl: `https://www.google.com/maps?q=${location.latitude},${location.longitude}`,
    };
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
    const requestedOutputPath = path.isAbsolute(filename)
      ? filename
      : path.resolve(this.workspace.path, filename);
    if (this.workspace.permissions.write === false) {
      throw new Error("Write permission not granted for screenshot capture");
    }
    const outputPath = await this.resolveAccessibleLocalPath(requestedOutputPath, "write");

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
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new Error("Invalid URL format");
    }
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      throw new Error("Only http and https URLs are allowed");
    }

    const networkDecision = evaluateNetworkPolicy({
      url: parsedUrl.toString(),
      toolName: "open_url",
      networkEnabled: this.workspace.permissions?.network,
      accessNetworkMode: this.workspace.permissions?.accessNetworkMode,
      profileDomainRules: this.workspace.permissions?.accessDomainRules,
    });
    this.daemon.logEvent(this.taskId, "network_policy_decision", networkDecision);
    if (networkDecision.action === "deny") {
      throw new Error(
        `Network access denied for "${parsedUrl.toString()}": ${networkDecision.reason}`,
      );
    }
    // The policy above only inspects the literal host. Resolve the name too, so
    // `evil.test` pointing at 169.254.169.254 or a private range is refused.
    await assertResolvedHostAllowed(parsedUrl.hostname);

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

    const fullPath = await this.resolveAccessibleLocalPath(filePath);
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

    const fullPath = await this.resolveAccessibleLocalPath(filePath);
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
   * Resolve an installed macOS application's bundle identifier before using
   * AppleScript "application id" targets.
   */
  async resolveAppBundleId(appName: string): Promise<{
    success: boolean;
    appName: string;
    bundleId: string;
    resolvedBy: "app_name" | "bundle_id";
  }> {
    if (!appName || typeof appName !== "string" || !appName.trim()) {
      throw new Error("Invalid app name: must be a non-empty string");
    }
    if (os.platform() !== "darwin") {
      throw new Error("App bundle resolution is only available on macOS");
    }

    const query = appName.trim();
    const literal = this.toAppleScriptStringLiteral(query);
    const attempts: Array<{ label: "app_name" | "bundle_id"; script: string }> = [
      { label: "app_name", script: `id of application ${literal}` },
    ];
    if (/^[A-Za-z0-9][A-Za-z0-9._-]*\.[A-Za-z0-9._-]+$/.test(query)) {
      attempts.push({ label: "bundle_id", script: `id of application id ${literal}` });
    }

    this.daemon.logEvent(this.taskId, "tool_call", {
      tool: "resolve_app_bundle_id",
      appName: query,
    });

    let lastError: unknown;
    for (const attempt of attempts) {
      try {
        const { stdout, stderr } = await execFileAsync("osascript", ["-e", attempt.script], {
          timeout: DEFAULT_TIMEOUT,
          maxBuffer: 128 * 1024,
        });
        const bundleId = (stdout.trim() || stderr.trim()).trim();
        if (!bundleId) {
          throw new Error("osascript returned no bundle identifier");
        }

        this.daemon.logEvent(this.taskId, "tool_result", {
          tool: "resolve_app_bundle_id",
          appName: query,
          bundleId,
          resolvedBy: attempt.label,
        });

        return {
          success: true,
          appName: query,
          bundleId,
          resolvedBy: attempt.label,
        };
      } catch (error) {
        lastError = error;
      }
    }

    const message = this.extractAppleScriptError(lastError);
    this.daemon.logEvent(this.taskId, "tool_error", {
      tool: "resolve_app_bundle_id",
      appName: query,
      error: message,
    });
    throw new Error(`Failed to resolve bundle identifier for "${query}": ${message}`);
  }

  async findMacOSAppProcesses(input: { query: string; includeRelated?: boolean }): Promise<{
    success: boolean;
    query: string;
    processes: MacOSAppProcessRecord[];
  }> {
    if (os.platform() !== "darwin") {
      throw new Error("macOS process inspection is only available on macOS");
    }
    const query = this.normalizeRequiredQuery(input?.query, "query");
    const terms = this.buildMacOSAppSearchTerms(query, input?.includeRelated === true);

    this.daemon.logEvent(this.taskId, "tool_call", {
      tool: "find_macos_app_processes",
      query,
      terms,
    });

    const processes = await this.readMacOSProcesses();
    const matches = processes.filter((processRecord) =>
      this.matchesAnySearchTerm(`${processRecord.command}\n${processRecord.args}`, terms),
    );

    this.daemon.logEvent(this.taskId, "tool_result", {
      tool: "find_macos_app_processes",
      query,
      count: matches.length,
    });

    return {
      success: true,
      query,
      processes: matches,
    };
  }

  async terminateMacOSAppProcesses(input: {
    query: string;
    signal?: "TERM" | "KILL";
    includeRelated?: boolean;
  }): Promise<{
    success: boolean;
    query: string;
    signal: "TERM" | "KILL";
    terminated: Array<MacOSAppProcessRecord & { signal: "TERM" | "KILL" }>;
    remaining: MacOSAppProcessRecord[];
    skipped: Array<MacOSAppProcessRecord & { reason: string }>;
  }> {
    if (os.platform() !== "darwin") {
      throw new Error("macOS process termination is only available on macOS");
    }
    const query = this.normalizeRequiredQuery(input?.query, "query");
    const signal = input?.signal === "KILL" ? "KILL" : "TERM";
    const terms = this.buildMacOSAppSearchTerms(query, input?.includeRelated === true);
    const before = (await this.readMacOSProcesses()).filter((processRecord) =>
      this.matchesAnySearchTerm(`${processRecord.command}\n${processRecord.args}`, terms),
    );

    const ownPids = new Set(
      [process.pid, process.ppid].filter((pid): pid is number => Number.isFinite(pid)),
    );
    const candidates = before.filter((record) => !ownPids.has(record.pid));
    const skipped = before
      .filter((record) => ownPids.has(record.pid))
      .map((record) => ({ ...record, reason: "refusing_to_signal_cowork_process" }));

    const approved = await this.daemon.requestApproval(
      this.taskId,
      "terminate_macos_app_processes",
      `Terminate ${candidates.length} macOS process(es) matching "${query}"`,
      {
        query,
        signal,
        processes: candidates,
        skipped,
      },
    );
    if (!approved) {
      throw new Error("User denied macOS process termination");
    }

    this.daemon.logEvent(this.taskId, "tool_call", {
      tool: "terminate_macos_app_processes",
      query,
      signal,
      count: candidates.length,
    });

    const terminated: Array<MacOSAppProcessRecord & { signal: "TERM" | "KILL" }> = [];
    const signalName = signal === "KILL" ? "SIGKILL" : "SIGTERM";
    for (const processRecord of candidates) {
      try {
        process.kill(processRecord.pid, signalName);
        terminated.push({ ...processRecord, signal });
      } catch (error) {
        skipped.push({
          ...processRecord,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 750));
    const remaining = (await this.readMacOSProcesses()).filter((processRecord) =>
      this.matchesAnySearchTerm(`${processRecord.command}\n${processRecord.args}`, terms),
    );

    this.daemon.logEvent(this.taskId, "tool_result", {
      tool: "terminate_macos_app_processes",
      query,
      signal,
      terminated: terminated.length,
      remaining: remaining.length,
      skipped: skipped.length,
    });

    return {
      success: remaining.length === 0,
      query,
      signal,
      terminated,
      remaining,
      skipped,
    };
  }

  async listMacOSLaunchAgents(input?: { query?: string; includeSystem?: boolean }): Promise<{
    success: boolean;
    query: string | null;
    agents: MacOSLaunchAgentRecord[];
  }> {
    if (os.platform() !== "darwin") {
      throw new Error("macOS LaunchAgent inspection is only available on macOS");
    }
    if (this.workspace.permissions.read === false) {
      throw new Error("Read permission not granted for macOS LaunchAgent inspection");
    }
    const query =
      typeof input?.query === "string" && input.query.trim() ? input.query.trim() : null;
    const terms = query ? this.buildMacOSAppSearchTerms(query, true) : [];
    const agents = this.readMacOSLaunchAgents(input?.includeSystem !== false, terms);

    this.daemon.logEvent(this.taskId, "tool_result", {
      tool: "list_macos_launch_agents",
      query,
      count: agents.length,
      matched: agents.filter((agent) => agent.matches).length,
    });

    return {
      success: true,
      query,
      agents: query ? agents.filter((agent) => agent.matches) : agents,
    };
  }

  async disableMacOSLaunchAgents(input: {
    query?: string;
    labels?: string[];
    paths?: string[];
    dryRun?: boolean;
  }): Promise<{
    success: boolean;
    dryRun: boolean;
    disabledDirectory: string;
    disabled: Array<MacOSLaunchAgentRecord & { disabledPath: string; bootoutStatus: string }>;
    skipped: Array<MacOSLaunchAgentRecord & { reason: string }>;
  }> {
    if (os.platform() !== "darwin") {
      throw new Error("macOS LaunchAgent disable is only available on macOS");
    }
    if (this.workspace.permissions.write === false) {
      throw new Error("Write permission not granted for macOS LaunchAgent changes");
    }
    const dryRun = input?.dryRun === true;
    const query =
      typeof input?.query === "string" && input.query.trim() ? input.query.trim() : null;
    const terms = query ? this.buildMacOSAppSearchTerms(query, true) : [];
    const labelSet = new Set((input?.labels || []).map((label) => label.trim()).filter(Boolean));
    const pathSet = new Set((input?.paths || []).map((agentPath) => path.resolve(agentPath)));
    if (!query && labelSet.size === 0 && pathSet.size === 0) {
      throw new Error("Provide query, labels, or paths to select LaunchAgents to disable");
    }

    const allAgents = this.readMacOSLaunchAgents(true, terms);
    const selected = allAgents.filter((agent) => {
      if (pathSet.has(path.resolve(agent.path))) return true;
      if (agent.label && labelSet.has(agent.label)) return true;
      return query ? agent.matches : false;
    });
    const disabledDirectory = path.join(os.homedir(), "Library", "LaunchAgents.disabled-by-cowork");

    const approved = dryRun
      ? true
      : await this.daemon.requestApproval(
          this.taskId,
          "disable_macos_launch_agents",
          `Disable ${selected.length} macOS LaunchAgent(s)`,
          {
            query,
            labels: Array.from(labelSet),
            paths: Array.from(pathSet),
            disabledDirectory,
            selected,
          },
        );
    if (!approved) {
      throw new Error("User denied disabling macOS LaunchAgents");
    }

    const disabled: Array<
      MacOSLaunchAgentRecord & { disabledPath: string; bootoutStatus: string }
    > = [];
    const skipped: Array<MacOSLaunchAgentRecord & { reason: string }> = [];
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    const userLaunchAgentsDirectory = path.join(os.homedir(), "Library", "LaunchAgents");
    const approvedMoves: Array<{
      agent: MacOSLaunchAgentRecord;
      disabledPath: string;
    }> = [];

    for (const agent of selected) {
      if (
        agent.domain !== "user" ||
        !isAccessPathWithin(userLaunchAgentsDirectory, agent.path) ||
        path.resolve(agent.path) === path.resolve(userLaunchAgentsDirectory)
      ) {
        skipped.push({ ...agent, reason: "only_user_launch_agents_can_be_moved_by_this_tool" });
        continue;
      }

      const disabledPath = this.nextAvailablePath(
        path.join(disabledDirectory, path.basename(agent.path)),
      );
      const sourceDecision = evaluateWorkspaceFilesystemAccess(
        this.workspace,
        agent.path,
        "delete",
      );
      const destinationDecision = evaluateWorkspaceFilesystemAccess(
        this.workspace,
        disabledPath,
        "write",
      );
      if (sourceDecision.decision !== "allow" || destinationDecision.decision !== "allow") {
        skipped.push({ ...agent, reason: "denied_by_access_profile" });
        continue;
      }

      approvedMoves.push({ agent, disabledPath });
    }

    if (!dryRun && approvedMoves.length > 0) {
      fsSync.mkdirSync(disabledDirectory, { recursive: true });
    }

    for (const { agent, disabledPath } of approvedMoves) {
      let bootoutStatus = "not_attempted";
      if (!dryRun && agent.label && uid !== null) {
        try {
          await execFileAsync("/bin/launchctl", ["bootout", `gui/${uid}`, agent.label], {
            timeout: DEFAULT_TIMEOUT,
            maxBuffer: 128 * 1024,
          });
          bootoutStatus = "unloaded";
        } catch (error) {
          bootoutStatus = `unload_failed: ${this.extractAppleScriptError(error)}`;
        }
      }

      if (!dryRun) {
        fsSync.renameSync(agent.path, disabledPath);
      }
      disabled.push({ ...agent, disabledPath, bootoutStatus });
    }

    this.daemon.logEvent(this.taskId, "tool_result", {
      tool: "disable_macos_launch_agents",
      query,
      dryRun,
      selected: selected.length,
      disabled: disabled.length,
      skipped: skipped.length,
    });

    return {
      success: skipped.length === 0,
      dryRun,
      disabledDirectory,
      disabled,
      skipped,
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
      error: this.formatAppleScriptFailure(lastError),
    });
    throw new Error(`AppleScript execution failed: ${this.formatAppleScriptFailure(lastError)}`);
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

  private formatAppleScriptFailure(error: Any): string {
    const message = this.extractAppleScriptError(error);
    const invalidIdMatch = message.match(/application id "([^"]+)"/i);
    if (!invalidIdMatch) return message;
    const invalidId = invalidIdMatch[1];
    return (
      `${message}\n` +
      `The bundle identifier "${invalidId}" was not resolvable. ` +
      `Verify the target with: osascript -e 'id of app "App Name"' before retrying.`
    );
  }

  private toAppleScriptStringLiteral(value: string): string {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }

  private normalizeRequiredQuery(value: unknown, fieldName: string): string {
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`Invalid ${fieldName}: must be a non-empty string`);
    }
    return value.trim();
  }

  private buildMacOSAppSearchTerms(query: string, includeRelated: boolean): string[] {
    const terms = new Set<string>();
    const add = (term: string): void => {
      const normalized = term.trim().toLowerCase();
      if (normalized) terms.add(normalized);
    };
    add(query);
    if (includeRelated) {
      const compact = query.toLowerCase().replace(/\s+/g, "");
      if (compact.includes("perplexity")) {
        add("perplexity");
        add("ai.perplexity");
        add("com.perplexity");
        add("comet");
      }
    }
    return Array.from(terms);
  }

  private matchesAnySearchTerm(text: string, terms: string[]): boolean {
    const haystack = text.toLowerCase();
    return terms.some((term) => haystack.includes(term));
  }

  private async readMacOSProcesses(): Promise<MacOSAppProcessRecord[]> {
    const { stdout } = await execFileAsync("/bin/ps", ["-axo", "pid=,ppid=,comm=,args="], {
      timeout: DEFAULT_TIMEOUT,
      maxBuffer: 2 * 1024 * 1024,
    });
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line): MacOSAppProcessRecord | null => {
        const match = line.match(/^(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);
        if (!match) return null;
        return {
          pid: Number(match[1]),
          ppid: Number(match[2]),
          command: match[3] || "",
          args: match[4] || "",
        };
      })
      .filter((record): record is MacOSAppProcessRecord =>
        Boolean(record && Number.isFinite(record.pid)),
      );
  }

  private readMacOSLaunchAgents(includeSystem: boolean, terms: string[]): MacOSLaunchAgentRecord[] {
    const userDir = path.join(os.homedir(), "Library", "LaunchAgents");
    const dirs: Array<{ dir: string; domain: "user" | "system" }> = [
      { dir: userDir, domain: "user" },
    ];
    if (includeSystem) {
      dirs.push({ dir: "/Library/LaunchAgents", domain: "system" });
      dirs.push({ dir: "/Library/LaunchDaemons", domain: "system" });
    }

    const agents: MacOSLaunchAgentRecord[] = [];
    for (const { dir, domain } of dirs) {
      let entries: string[] = [];
      try {
        entries = fsSync.readdirSync(dir).filter((entry) => entry.endsWith(".plist"));
      } catch {
        continue;
      }
      for (const entry of entries) {
        const agentPath = path.join(dir, entry);
        if (
          evaluateWorkspaceFilesystemAccess(this.workspace, agentPath, "read").decision !== "allow"
        ) {
          continue;
        }
        let content = "";
        try {
          content = fsSync.readFileSync(agentPath, "utf8");
        } catch {
          continue;
        }
        const label = this.extractPlistString(content, "Label");
        const program = this.extractPlistString(content, "Program");
        const programArguments = this.extractPlistStringArray(content, "ProgramArguments");
        const searchable = [agentPath, label, program, ...programArguments, content]
          .filter(Boolean)
          .join("\n");
        agents.push({
          path: agentPath,
          label,
          program,
          programArguments,
          domain,
          matches: terms.length === 0 ? true : this.matchesAnySearchTerm(searchable, terms),
        });
      }
    }
    return agents;
  }

  private extractPlistString(content: string, key: string): string | null {
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = content.match(
      new RegExp(`<key>\\s*${escapedKey}\\s*</key>\\s*<string>([\\s\\S]*?)</string>`, "i"),
    );
    return match?.[1]?.trim() || null;
  }

  private extractPlistStringArray(content: string, key: string): string[] {
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const arrayMatch = content.match(
      new RegExp(`<key>\\s*${escapedKey}\\s*</key>\\s*<array>([\\s\\S]*?)</array>`, "i"),
    );
    if (!arrayMatch?.[1]) return [];
    return Array.from(arrayMatch[1].matchAll(/<string>([\s\S]*?)<\/string>/gi)).map((match) =>
      (match[1] || "").trim(),
    );
  }

  private nextAvailablePath(targetPath: string): string {
    if (!fsSync.existsSync(targetPath)) return targetPath;
    const parsed = path.parse(targetPath);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    let candidate = path.join(parsed.dir, `${parsed.name}.${stamp}${parsed.ext}`);
    let suffix = 1;
    while (fsSync.existsSync(candidate)) {
      candidate = path.join(parsed.dir, `${parsed.name}.${stamp}.${suffix}${parsed.ext}`);
      suffix += 1;
    }
    return candidate;
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
   * Static method to get tool definitions
   */
  static getToolDefinitions(options?: { headless?: boolean }): LLMTool[] {
    const headless = options?.headless === true;
    // In headless/VPS mode, avoid exposing tools that require an interactive desktop session.
    // Memory tools come from MemoryTools in both modes.
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
        name: "get_current_location",
        description:
          "Get the user's current desktop location after explicit one-time location permission. " +
          "Use this for nearby, walking-distance, or local errand questions.",
        input_schema: {
          type: "object",
          properties: {
            accuracy: {
              type: "string",
              enum: ["coarse", "precise"],
              description: 'Desired accuracy. Defaults to "precise".',
            },
            maxAgeMs: {
              type: "number",
              description:
                "Maximum age in milliseconds for a cached native OS location, when supported.",
            },
          },
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
        name: "resolve_app_bundle_id",
        description:
          "Resolve an installed macOS app name or existing bundle identifier to the exact bundle identifier. " +
          "Use before AppleScript application id targets, for example before run_applescript with application id.",
        input_schema: {
          type: "object",
          properties: {
            appName: {
              type: "string",
              description: 'Installed app name or bundle identifier, for example "Perplexity".',
            },
          },
          required: ["appName"],
        },
      },
      {
        name: "find_macos_app_processes",
        description:
          "Find running macOS processes matching an app name or bundle-related query without shell pipelines. " +
          "Use for native app troubleshooting before terminating or reporting process state.",
        input_schema: {
          type: "object",
          properties: {
            query: { type: "string", description: 'App/process query, for example "Perplexity".' },
            includeRelated: {
              type: "boolean",
              description: "Include known related helper terms for the app query when available.",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "terminate_macos_app_processes",
        description:
          "Terminate running macOS processes matching an app name or bundle-related query without shell pipelines. " +
          "Use when a native app must be quit or force-quit after user approval.",
        input_schema: {
          type: "object",
          properties: {
            query: { type: "string", description: 'App/process query, for example "Perplexity".' },
            signal: {
              type: "string",
              enum: ["TERM", "KILL"],
              description: "TERM first, KILL for force quit.",
            },
            includeRelated: {
              type: "boolean",
              description: "Include known related helper terms for the app query when available.",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "list_macos_launch_agents",
        description:
          "List macOS LaunchAgents/LaunchDaemons matching an app query without shell pipelines. " +
          "Use to diagnose apps that relaunch after quitting.",
        input_schema: {
          type: "object",
          properties: {
            query: { type: "string", description: 'Optional app query, for example "Perplexity".' },
            includeSystem: {
              type: "boolean",
              description:
                "Include /Library LaunchAgents and LaunchDaemons in addition to the user's LaunchAgents.",
            },
          },
          required: [],
        },
      },
      {
        name: "disable_macos_launch_agents",
        description:
          "Unload and move matching user LaunchAgent plists into ~/Library/LaunchAgents.disabled-by-cowork. " +
          "Use to remediate apps that relaunch after quitting; run with dryRun first when unsure.",
        input_schema: {
          type: "object",
          properties: {
            query: { type: "string", description: 'App query, for example "Perplexity".' },
            labels: {
              type: "array",
              items: { type: "string" },
              description: "Specific LaunchAgent labels to disable.",
            },
            paths: {
              type: "array",
              items: { type: "string" },
              description: "Specific LaunchAgent plist paths to disable.",
            },
            dryRun: {
              type: "boolean",
              description: "Preview matching agents without moving files.",
            },
          },
          required: [],
        },
      },
      {
        name: "run_applescript",
        description:
          "Execute exact AppleScript / osascript code on macOS. " +
          "Use this when the user explicitly asks for AppleScript, or as a low-level fallback " +
          "after screenshot/click/type_text/keypress-style computer-use tools cannot complete a specific native GUI step. " +
          "Do not prefer this first for ordinary native app interaction. Verify app names or bundle identifiers before using application id. Only available on macOS.",
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
    ];
    return tools;
  }
}
