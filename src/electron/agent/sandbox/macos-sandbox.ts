/**
 * macOS Sandbox Implementation
 *
 * Uses macOS sandbox-exec with generated profiles for system call filtering.
 * Provides:
 * - Process isolation with limited environment
 * - Filesystem access restrictions
 * - Network access control
 */

import { spawn, ChildProcess, SpawnOptions } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { Workspace } from "../../../shared/types";
import { ISandbox, SandboxType, SandboxOptions, SandboxResult } from "./sandbox-factory";
import {
  createSecureTempFile,
  escapeSandboxProfileString,
  validatePathForSandboxProfile,
} from "./security-utils";

/**
 * Default sandbox options
 */
const DEFAULT_OPTIONS: Required<SandboxOptions> = {
  cwd: process.cwd(),
  timeout: 5 * 60 * 1000, // 5 minutes
  maxOutputSize: 100 * 1024, // 100KB
  allowNetwork: false,
  allowedReadPaths: [],
  allowedWritePaths: [],
  envPassthrough: ["PATH", "HOME", "USER", "SHELL", "LANG", "TERM", "TMPDIR"],
};

/**
 * macOS sandbox-exec based sandbox implementation
 */
export class MacOSSandbox implements ISandbox {
  readonly type: SandboxType = "macos";
  private workspace: Workspace;
  private sandboxProfile?: string;

  constructor(workspace: Workspace) {
    this.workspace = workspace;
  }

  /**
   * Initialize sandbox environment
   */
  async initialize(): Promise<void> {
    if (process.platform !== "darwin") {
      throw new Error("MacOSSandbox can only be used on macOS");
    }
    this.sandboxProfile = this.generateSandboxProfile();
  }

  /**
   * Execute a command in the sandbox
   */
  async execute(
    command: string,
    args: string[] = [],
    options: SandboxOptions = {},
  ): Promise<SandboxResult> {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const cwd = opts.cwd || this.workspace.path;

    // Validate working directory is within allowed paths
    if (!this.isPathAllowed(cwd, "read")) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `Working directory not allowed: ${cwd}`,
        killed: false,
        timedOut: false,
        error: "Path access denied",
      };
    }

    // Build minimal, safe environment
    const env = this.buildSafeEnvironment(opts.envPassthrough);

    let proc: ChildProcess;
    const spawnOptions: SpawnOptions = {
      cwd,
      env,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    };

    if (this.sandboxProfile) {
      // Use sandbox-exec on macOS
      const { profilePath, cleanup } = this.writeTempProfile();
      proc = spawn(
        "sandbox-exec",
        ["-f", profilePath, "/bin/sh", "-c", `${command} ${args.join(" ")}`],
        spawnOptions,
      );
      proc.on("close", cleanup);
      proc.on("error", cleanup);
    } else {
      // Fallback without sandbox profile
      proc = spawn("/bin/sh", ["-c", `${command} ${args.join(" ")}`], spawnOptions);
    }

    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let killed = false;
      let timedOut = false;

      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        killed = true;
        proc.kill("SIGKILL");
      }, opts.timeout);

      proc.stdout?.on("data", (data: Buffer) => {
        const chunk = data.toString();
        if (stdout.length + chunk.length <= opts.maxOutputSize) {
          stdout += chunk;
        } else if (stdout.length < opts.maxOutputSize) {
          stdout += chunk.slice(0, opts.maxOutputSize - stdout.length);
          stdout += "\n[Output truncated]";
        }
      });

      proc.stderr?.on("data", (data: Buffer) => {
        const chunk = data.toString();
        if (stderr.length + chunk.length <= opts.maxOutputSize) {
          stderr += chunk;
        } else if (stderr.length < opts.maxOutputSize) {
          stderr += chunk.slice(0, opts.maxOutputSize - stderr.length);
          stderr += "\n[Output truncated]";
        }
      });

      proc.on("close", (code) => {
        clearTimeout(timeoutHandle);
        resolve({
          exitCode: code ?? 1,
          stdout,
          stderr,
          killed,
          timedOut,
        });
      });

      proc.on("error", (err) => {
        clearTimeout(timeoutHandle);
        resolve({
          exitCode: 1,
          stdout,
          stderr: err.message,
          killed,
          timedOut,
          error: err.message,
        });
      });
    });
  }

  /**
   * Execute code in sandbox
   */
  async executeCode(code: string, language: "python" | "javascript"): Promise<SandboxResult> {
    const ext = language === "python" ? ".py" : ".js";
    const { filePath, cleanup } = createSecureTempFile(ext, code);

    try {
      const interpreter = language === "python" ? "python3" : "node";
      return await this.execute(interpreter, [filePath], {
        timeout: 60 * 1000,
        allowNetwork: false,
      });
    } finally {
      cleanup();
    }
  }

  /**
   * Cleanup sandbox resources
   */
  cleanup(): void {
    this.sandboxProfile = undefined;
  }

  /**
   * Check if a path is allowed based on workspace permissions
   * Resolves symlinks to prevent symlink-based path traversal attacks
   */
  private isPathAllowed(targetPath: string, mode: "read" | "write"): boolean {
    // Reject paths with null bytes
    if (targetPath.includes("\0")) {
      return false;
    }

    // Resolve symlinks to get real path (if it exists)
    let realTarget: string;
    try {
      realTarget = fs.existsSync(targetPath)
        ? fs.realpathSync(targetPath)
        : path.resolve(targetPath);
    } catch {
      return false;
    }

    // Resolve workspace path (with symlinks resolved)
    let realWorkspace: string;
    try {
      realWorkspace = fs.existsSync(this.workspace.path)
        ? fs.realpathSync(this.workspace.path)
        : path.resolve(this.workspace.path);
    } catch {
      realWorkspace = path.resolve(this.workspace.path);
    }

    // Always allow paths within workspace
    if (realTarget.startsWith(realWorkspace + path.sep) || realTarget === realWorkspace) {
      return true;
    }

    // Check unrestricted access
    if (this.workspace.permissions.unrestrictedFileAccess) {
      return true;
    }

    // Check allowed paths (with symlink resolution)
    const allowedPaths = this.workspace.permissions.allowedPaths || [];
    for (const allowed of allowedPaths) {
      try {
        const realAllowed = fs.existsSync(allowed)
          ? fs.realpathSync(allowed)
          : path.resolve(allowed);
        if (realTarget.startsWith(realAllowed + path.sep) || realTarget === realAllowed) {
          return true;
        }
      } catch {
        // Skip invalid allowed paths
      }
    }

    // System paths for read-only access
    if (mode === "read") {
      const systemReadPaths = [
        "/usr/bin",
        "/usr/local/bin",
        "/bin",
        "/usr/lib",
        "/System",
        os.tmpdir(),
      ];
      for (const sysPath of systemReadPaths) {
        if (realTarget.startsWith(sysPath + path.sep) || realTarget === sysPath) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Build a minimal, safe environment for command execution
   */
  private buildSafeEnvironment(passthrough: string[]): Record<string, string | undefined> {
    const safeEnv: Record<string, string | undefined> = {};

    for (const key of passthrough) {
      if (process.env[key]) {
        safeEnv[key] = process.env[key];
      }
    }

    safeEnv.HOME = process.env.HOME || os.homedir();
    safeEnv.USER = process.env.USER || os.userInfo().username;
    safeEnv.SHELL = process.env.SHELL || "/bin/bash";
    safeEnv.TERM = "xterm-256color";
    safeEnv.LANG = process.env.LANG || "en_US.UTF-8";
    safeEnv.TMPDIR = os.tmpdir();

    safeEnv.PATH = [
      "/opt/homebrew/bin",
      "/opt/homebrew/sbin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ].join(":");

    return safeEnv;
  }

  /**
   * Generate macOS sandbox-exec profile
   * Paths are escaped to prevent sandbox profile injection attacks
   */
  private generateSandboxProfile(): string {
    const permissions = this.workspace.permissions;
    const tempDir = os.tmpdir();

    // Validate and escape workspace path
    validatePathForSandboxProfile(this.workspace.path);
    const escapedWorkspace = escapeSandboxProfileString(this.workspace.path);
    const escapedTempDir = escapeSandboxProfileString(tempDir);

    let profile = `(version 1)
(deny default)

; Allow basic process operations
(allow process-fork)
(allow process-exec)
(allow signal)

; Allow sysctl for system info
(allow sysctl-read)

; Allow reading system libraries and binaries
(allow file-read*
  (subpath "/usr/lib")
  (subpath "/usr/bin")
  (subpath "/bin")
  (subpath "/usr/local")
  (subpath "/System")
  (subpath "/Library/Frameworks")
  (subpath "/Applications/Xcode.app")
  (subpath "/private/var/db")
  (literal "/dev/null")
  (literal "/dev/urandom")
  (literal "/dev/random")
  (subpath "/private/tmp")
  (subpath "${escapedTempDir}")
)

; Allow homebrew on macOS
(allow file-read* (subpath "/opt/homebrew"))

; Allow reading workspace
(allow file-read* (subpath "${escapedWorkspace}"))
`;

    // Allow writing to workspace if permitted
    if (permissions.write) {
      profile += `
; Allow writing to workspace
(allow file-write* (subpath "${escapedWorkspace}"))
`;
    }

    // Allow writing to temp directories
    profile += `
; Allow writing to temp directories
(allow file-write*
  (subpath "/private/tmp")
  (subpath "${escapedTempDir}")
  (subpath "/private/var/folders")
)
`;

    // Allow network if permitted
    if (permissions.network) {
      profile += `
; Allow network access
(allow network*)
`;
    } else {
      profile += `
; Deny network access (except localhost)
(deny network*)
(allow network* (local ip "localhost:*"))
`;
    }

    // Allow additional read paths (with validation and escaping)
    const allowedPaths = permissions.allowedPaths || [];
    for (const allowedPath of allowedPaths) {
      try {
        validatePathForSandboxProfile(allowedPath);
        const escapedPath = escapeSandboxProfileString(allowedPath);
        profile += `(allow file-read* (subpath "${escapedPath}"))\n`;
        if (permissions.write) {
          profile += `(allow file-write* (subpath "${escapedPath}"))\n`;
        }
      } catch (err) {
        // Skip paths that fail validation - log warning
        console.warn(`[MacOSSandbox] Skipping unsafe allowed path: ${allowedPath}`, err);
      }
    }

    // Allow essential mach services
    profile += `
; Allow essential mach services
(allow mach-lookup
  (global-name "com.apple.CoreServices.coreservicesd")
  (global-name "com.apple.SecurityServer")
  (global-name "com.apple.system.logger")
  (global-name "com.apple.cfprefsd.daemon")
  (global-name "com.apple.cfprefsd.agent")
)
`;

    return profile;
  }

  /**
   * Write sandbox profile to temp file
   * Uses secure temp file creation to prevent TOCTOU attacks
   */
  private writeTempProfile(): { profilePath: string; cleanup: () => void } {
    const { filePath, cleanup } = createSecureTempFile(".sb", this.sandboxProfile!);

    let cleaned = false;
    const cleanupOnce = () => {
      if (cleaned) return;
      cleaned = true;
      cleanup();
    };

    // Fallback cleanup for abrupt exits where process handlers don't fire.
    const cleanupTimer = setTimeout(cleanupOnce, 5 * 60 * 1000);
    cleanupTimer.unref();

    return { profilePath: filePath, cleanup: cleanupOnce };
  }
}
