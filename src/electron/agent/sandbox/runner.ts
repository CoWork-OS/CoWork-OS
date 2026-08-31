/**
 * SandboxRunner - Secure execution environment for shell commands
 *
 * This file maintains backward compatibility by re-exporting the refactored sandbox system.
 *
 * The sandbox system now supports:
 * - macOS sandbox-exec profiles (native, preferred on macOS)
 * - Docker containers (cross-platform, Linux/Windows)
 * - No sandbox fallback (with timeout and output limits)
 *
 * Use createSandbox() from sandbox-factory.ts for new code.
 */

// Re-export the sandbox factory and types for backward compatibility
// Note: SandboxOptions and SandboxResult are defined locally below to avoid conflicts
export {
  ISandbox,
  SandboxType,
  createSandbox,
  detectAvailableSandbox,
  isDockerAvailable,
  NoSandbox,
} from "./sandbox-factory";

export { MacOSSandbox } from "./macos-sandbox";
export { DockerSandbox, DockerSandboxConfig } from "./docker-sandbox";

import { spawn, ChildProcess, SpawnOptions } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { Workspace } from "../../../shared/types";
import {
  evaluateWorkspaceFilesystemAccess,
  hasEffectiveFilesystemScope,
  isAccessPathWithin,
  resolveAccessControlledPath,
} from "../../security/access-profile-paths";
import {
  createSecureTempFile,
  escapeSandboxProfileString,
  validatePathForSandboxProfile,
} from "./security-utils";

/**
 * Sandbox execution options
 */
export interface SandboxOptions {
  /** Working directory for command execution */
  cwd?: string;
  /** Command execution timeout in milliseconds */
  timeout?: number;
  /** Maximum output size in bytes */
  maxOutputSize?: number;
  /** Allow network access */
  allowNetwork?: boolean;
  /** Additional allowed paths for read access */
  allowedReadPaths?: string[];
  /** Additional allowed paths for write access */
  allowedWritePaths?: string[];
  /** Environment variables to pass through */
  envPassthrough?: string[];
}

/**
 * Sandbox execution result
 */
export interface SandboxResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  killed: boolean;
  timedOut: boolean;
  error?: string;
}

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
 * SandboxRunner manages secure command execution
 */
export class SandboxRunner {
  private workspace: Workspace;
  private sandboxProfile?: string;
  private runtimeTempDir?: string;

  constructor(workspace: Workspace) {
    this.workspace = workspace;
  }

  /**
   * Initialize sandbox environment
   */
  async initialize(): Promise<void> {
    // Generate sandbox profile for this workspace
    this.sandboxProfile = this.generateSandboxProfile(this.workspace.permissions.network === true);
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

    const networkError = this.getNetworkAccessError(
      options.allowNetwork === undefined
        ? this.workspace.permissions.network === true
        : opts.allowNetwork === true,
    );
    if (networkError) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: networkError,
        killed: false,
        timedOut: false,
        error: "Network access denied",
      };
    }

    // Determine working directory
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

    this.sandboxProfile = this.generateSandboxProfile(
      options.allowNetwork === undefined
        ? this.workspace.permissions.network === true
        : opts.allowNetwork === true,
      opts,
    );

    // Build minimal, safe environment
    const env = this.buildSafeEnvironment(opts.envPassthrough);

    // Check if we can use macOS sandbox-exec
    const useSandboxExec = process.platform === "darwin" && this.sandboxProfile;

    let proc: ChildProcess;
    const spawnOptions: SpawnOptions = {
      cwd,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    };

    if (useSandboxExec && this.sandboxProfile) {
      // Use sandbox-exec on macOS
      const { profilePath, cleanup } = this.writeTempProfile();
      proc =
        args.length > 0
          ? spawn("sandbox-exec", ["-f", profilePath, command, ...args], spawnOptions)
          : spawn("sandbox-exec", ["-f", profilePath, "/bin/sh", "-c", command], spawnOptions);
      proc.on("close", cleanup);
      proc.on("error", cleanup);
    } else {
      // Fallback: execute without OS-level sandboxing (still has resource limits)
      if (args.length > 0) {
        proc = spawn(command, args, spawnOptions);
      } else if (process.platform === "win32") {
        const comspec = process.env.COMSPEC || "cmd.exe";
        proc = spawn(comspec, ["/d", "/s", "/c", command], spawnOptions);
      } else {
        proc = spawn("/bin/sh", ["-c", command], spawnOptions);
      }
    }

    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let killed = false;
      let timedOut = false;

      // Timeout handler
      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        killed = true;
        proc.kill("SIGKILL");
      }, opts.timeout);

      // Collect stdout
      proc.stdout?.on("data", (data: Buffer) => {
        const chunk = data.toString();
        if (stdout.length + chunk.length <= opts.maxOutputSize) {
          stdout += chunk;
        } else if (stdout.length < opts.maxOutputSize) {
          stdout += chunk.slice(0, opts.maxOutputSize - stdout.length);
          stdout += "\n[Output truncated]";
        }
      });

      // Collect stderr
      proc.stderr?.on("data", (data: Buffer) => {
        const chunk = data.toString();
        if (stderr.length + chunk.length <= opts.maxOutputSize) {
          stderr += chunk;
        } else if (stderr.length < opts.maxOutputSize) {
          stderr += chunk.slice(0, opts.maxOutputSize - stderr.length);
          stderr += "\n[Output truncated]";
        }
      });

      // Process completion
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

      // Process error
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
   * Execute code in sandbox (for future scripting support)
   */
  async executeCode(code: string, language: "python" | "javascript"): Promise<SandboxResult> {
    // Create temp file with code
    const ext = language === "python" ? ".py" : ".js";
    const { filePath: tempFile, cleanup } = createSecureTempFile(ext, code);

    try {
      const interpreter = language === "python" ? "python3" : "node";
      return await this.execute(interpreter, [tempFile], {
        timeout: 60 * 1000, // 1 minute for scripts
        allowNetwork: false,
        allowedReadPaths: [tempFile],
      });
    } finally {
      // Cleanup temp file
      cleanup();
    }
  }

  /**
   * Cleanup sandbox resources
   */
  cleanup(): void {
    // Clean up any temp files or resources
    this.sandboxProfile = undefined;
    if (this.runtimeTempDir) {
      try {
        fs.rmSync(this.runtimeTempDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup; the directory is private to this sandbox.
      }
      this.runtimeTempDir = undefined;
    }
  }

  /**
   * Check if a path is allowed based on workspace permissions
   */
  private isPathAllowed(targetPath: string, mode: "read" | "write"): boolean {
    if (targetPath.includes("\0")) return false;
    const access = evaluateWorkspaceFilesystemAccess(this.workspace, targetPath, mode);
    if (access.decision === "allow") return true;
    if (
      access.reason === "profile_filesystem_denied" ||
      access.reason === "profile_filesystem_outside" ||
      access.reason === "protected_path"
    ) {
      return false;
    }

    if (this.isRuntimeTemporaryPath(targetPath)) return true;

    if (hasEffectiveFilesystemScope(this.workspace.path, this.workspace.permissions)) {
      return false;
    }

    const normalizedTarget = path.resolve(targetPath);
    // A workspace may itself live below the OS temp directory (including the
    // default test/temp workspace). The system temp fallback must not turn a
    // disabled workspace read bit into an implicit grant.
    if (isAccessPathWithin(this.workspace.path, normalizedTarget)) return false;

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
        const relative = path.relative(path.resolve(sysPath), normalizedTarget);
        if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
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

    // Only pass through allowed environment variables
    for (const key of passthrough) {
      if (process.env[key]) {
        safeEnv[key] = process.env[key];
      }
    }

    // Set safe defaults (platform-aware)
    safeEnv.HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
    safeEnv.USER = process.env.USER || process.env.USERNAME || os.userInfo().username;

    if (process.platform === "win32") {
      safeEnv.USERPROFILE = process.env.USERPROFILE || os.homedir();
      safeEnv.COMSPEC = process.env.COMSPEC || "C:\\Windows\\System32\\cmd.exe";
      safeEnv.PATH = process.env.PATH || "";
      safeEnv.TEMP = process.env.TEMP || os.tmpdir();
      safeEnv.TMP = process.env.TMP || os.tmpdir();
      safeEnv.SystemRoot = process.env.SystemRoot || "C:\\Windows";
    } else {
      safeEnv.SHELL = process.env.SHELL || "/bin/bash";
      safeEnv.TERM = "xterm-256color";
      safeEnv.LANG = process.env.LANG || "en_US.UTF-8";
      safeEnv.TMPDIR = this.getRuntimeTempDirIfScoped();

      // Minimal PATH with only standard locations
      safeEnv.PATH = ["/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");

      // Add homebrew paths on macOS
      if (process.platform === "darwin") {
        safeEnv.PATH = `/opt/homebrew/bin:/opt/homebrew/sbin:${safeEnv.PATH}`;
      }
    }

    return safeEnv;
  }

  /**
   * Generate macOS sandbox-exec profile
   */
  private generateSandboxProfile(
    allowNetwork = this.workspace.permissions.network === true,
    options: SandboxOptions = {},
  ): string {
    const workspacePath = path.resolve(this.workspace.path);
    const permissions = this.workspace.permissions;
    const finiteFilesystemScope = hasEffectiveFilesystemScope(this.workspace.path, permissions);
    const tempDir = finiteFilesystemScope ? this.getRuntimeTempDir() : os.tmpdir();
    validatePathForSandboxProfile(workspacePath);
    validatePathForSandboxProfile(tempDir);
    const escapedTempDir = escapeSandboxProfileString(tempDir);
    const workspaceAliases = this.getPathAliases(workspacePath);
    const tempAliases = this.getPathAliases(tempDir);
    const tempReadRules = finiteFilesystemScope
      ? tempAliases.map((alias) => `  (subpath "${escapeSandboxProfileString(alias)}")`).join("\n")
      : `  (subpath "/private/tmp")\n  (subpath "${escapedTempDir}")`;
    const tempWriteRules = finiteFilesystemScope
      ? tempAliases.map((alias) => `  (subpath "${escapeSandboxProfileString(alias)}")`).join("\n")
      : `  (subpath "/private/tmp")\n  (subpath "${escapedTempDir}")\n  (subpath "/private/var/folders")`;

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
${tempReadRules}
)

; Allow homebrew on macOS
(allow file-read* (subpath "/opt/homebrew"))

`;
    if (permissions.read) {
      profile += `
; Allow reading workspace
(allow file-read* (subpath "${escapeSandboxProfileString(workspacePath)}"))
`;
      profile = this.appendReadRules(profile, workspaceAliases);
    }
    profile = this.appendReadRules(profile, tempAliases);

    // Allow writing to workspace if permitted
    if (permissions.write) {
      profile += `
; Allow writing to workspace
(allow file-write* (subpath "${escapeSandboxProfileString(workspacePath)}"))
`;
      profile = this.appendWriteRules(profile, workspaceAliases);
    }

    // Allow writing to temp directories
    profile += `
; Allow writing to temp directories
(allow file-write*
${tempWriteRules}
)
`;

    // Allow network if permitted
    if (allowNetwork) {
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

    // Allow additional read paths only after the central evaluator approves
    // them. This keeps this compatibility runner aligned with the refactored
    // macOS sandbox instead of preserving the old prefix-only checks.
    const allowedPaths = finiteFilesystemScope ? [] : permissions.allowedPaths || [];
    for (const allowedPath of allowedPaths) {
      const resolved = this.resolvePolicyPath(allowedPath);
      if (this.isPathAllowed(resolved, "read")) {
        profile = this.appendReadRules(profile, this.getPathAliases(resolved));
      }
      if (permissions.write && this.isPathAllowed(resolved, "write")) {
        profile = this.appendWriteRules(profile, this.getPathAliases(resolved));
      }
    }

    for (const root of permissions.accessWorkspaceRoots || []) {
      const resolved = this.resolvePolicyPath(root);
      if (this.isPathAllowed(resolved, "read")) {
        profile = this.appendReadRules(profile, this.getPathAliases(resolved));
      }
      if (permissions.write && this.isPathAllowed(resolved, "write")) {
        profile = this.appendWriteRules(profile, this.getPathAliases(resolved));
      }
    }

    for (const rule of permissions.accessFilesystemRules || []) {
      const resolved = this.resolvePolicyPath(rule.path);
      const aliases = this.getPathAliases(resolved);
      if (rule.access === "deny") {
        for (const alias of aliases) {
          const escaped = escapeSandboxProfileString(alias);
          profile += `(deny file-read* (subpath "${escaped}"))\n`;
          profile += `(deny file-write* (subpath "${escaped}"))\n`;
        }
      } else if (this.isPathAllowed(resolved, "read")) {
        profile = this.appendReadRules(profile, aliases);
        if (rule.access === "write" && permissions.write && this.isPathAllowed(resolved, "write")) {
          profile = this.appendWriteRules(profile, aliases);
        }
      }
    }

    for (const readPath of options.allowedReadPaths || []) {
      const resolved = this.resolvePolicyPath(readPath);
      if (
        this.isPathAllowed(resolved, "read") ||
        this.isExplicitTemporaryOptionPath(resolved, options.allowedReadPaths)
      ) {
        profile = this.appendReadRules(profile, this.getPathAliases(resolved));
      }
    }
    for (const writePath of options.allowedWritePaths || []) {
      const resolved = this.resolvePolicyPath(writePath);
      if (
        this.isPathAllowed(resolved, "write") ||
        this.isExplicitTemporaryOptionPath(resolved, options.allowedWritePaths)
      ) {
        profile = this.appendWriteRules(profile, this.getPathAliases(resolved));
      }
    }

    // Allow mach services needed for basic operation
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
   */
  private writeTempProfile(): { profilePath: string; cleanup: () => void } {
    const tempFile = createSecureTempFile(".sb", this.sandboxProfile!);
    return { profilePath: tempFile.filePath, cleanup: tempFile.cleanup };
  }

  private resolvePolicyPath(rawPath: string): string {
    return resolveAccessControlledPath(this.workspace.path, rawPath);
  }

  private getRuntimeTempDirIfScoped(): string {
    return hasEffectiveFilesystemScope(this.workspace.path, this.workspace.permissions)
      ? this.getRuntimeTempDir()
      : os.tmpdir();
  }

  private getRuntimeTempDir(): string {
    if (!this.runtimeTempDir) {
      this.runtimeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-sandbox-"));
    }
    return this.runtimeTempDir;
  }

  private isExplicitTemporaryOptionPath(
    targetPath: string,
    candidates: readonly string[] | undefined,
  ): boolean {
    if (!hasEffectiveFilesystemScope(this.workspace.path, this.workspace.permissions)) return false;
    if (!candidates || candidates.length === 0) return false;
    const target = path.resolve(targetPath);
    if (!this.getPathAliases(os.tmpdir()).some((alias) => isAccessPathWithin(alias, target))) {
      return false;
    }
    return candidates.some((candidate) => {
      const resolvedCandidate = this.resolvePolicyPath(candidate);
      return resolvedCandidate && isAccessPathWithin(resolvedCandidate, target);
    });
  }

  private isRuntimeTemporaryPath(targetPath: string): boolean {
    if (isAccessPathWithin(this.workspace.path, targetPath)) return false;
    const runtimeTempDir = hasEffectiveFilesystemScope(
      this.workspace.path,
      this.workspace.permissions,
    )
      ? this.runtimeTempDir
      : os.tmpdir();
    return Boolean(runtimeTempDir && isAccessPathWithin(runtimeTempDir, targetPath));
  }

  private getPathAliases(targetPath: string): string[] {
    const aliases = new Set<string>([path.resolve(targetPath)]);
    try {
      if (fs.existsSync(targetPath)) aliases.add(fs.realpathSync(targetPath));
    } catch {
      // Keep the lexical path when a target is not resolvable.
    }
    for (const candidate of Array.from(aliases)) {
      if (candidate.startsWith("/var/")) aliases.add(`/private${candidate}`);
      if (candidate.startsWith("/private/var/")) aliases.add(candidate.slice("/private".length));
    }
    return Array.from(aliases);
  }

  private appendReadRules(profile: string, pathsToAllow: string[]): string {
    return pathsToAllow.reduce((next, value) => {
      validatePathForSandboxProfile(value);
      return `${next}(allow file-read* (subpath "${escapeSandboxProfileString(value)}"))\n`;
    }, profile);
  }

  private appendWriteRules(profile: string, pathsToAllow: string[]): string {
    return pathsToAllow.reduce((next, value) => {
      validatePathForSandboxProfile(value);
      return `${next}(allow file-write* (subpath "${escapeSandboxProfileString(value)}"))\n`;
    }, profile);
  }

  private getNetworkAccessError(allowNetwork: boolean): string | undefined {
    if (!allowNetwork) return undefined;
    const permissions = this.workspace.permissions;
    if (permissions.network !== true) return "Network access is disabled for this workspace.";
    if (permissions.accessNetworkMode === "disabled") {
      return "Network access is disabled by the active access profile.";
    }
    if ((permissions.accessDomainRules || []).length > 0) {
      return "The legacy sandbox runner cannot enforce domain-scoped network rules for arbitrary shell code.";
    }
    return undefined;
  }
}

/**
 * Create a sandboxed command executor for a workspace
 */
export async function createSandboxRunner(workspace: Workspace): Promise<SandboxRunner> {
  const runner = new SandboxRunner(workspace);
  await runner.initialize();
  return runner;
}
