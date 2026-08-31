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
import {
  ISandbox,
  SandboxType,
  SandboxOptions,
  SandboxResult,
  SandboxedProcess,
} from "./sandbox-factory";
import {
  evaluateWorkspaceFilesystemAccess,
  hasEffectiveFilesystemScope,
  resolveAccessControlledPath,
} from "../../security/access-profile-paths";
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
  onProcess: () => undefined,
};

const PROTECTED_WORKSPACE_WRITE_RELATIVE_PATHS = [
  ".git",
  ".cowork",
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
];

/**
 * macOS sandbox-exec based sandbox implementation
 */
export class MacOSSandbox implements ISandbox {
  readonly type: SandboxType = "macos";
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
    if (process.platform !== "darwin") {
      throw new Error("MacOSSandbox can only be used on macOS");
    }
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
    const networkError = this.getNetworkAccessError(opts.allowNetwork === true);
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
    this.sandboxProfile = this.generateSandboxProfile(opts.allowNetwork === true, opts);

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
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    };

    if (this.sandboxProfile) {
      // Use sandbox-exec on macOS
      const { profilePath, cleanup } = this.writeTempProfile();
      proc =
        args.length > 0
          ? spawn("sandbox-exec", ["-f", profilePath, command, ...args], spawnOptions)
          : spawn("sandbox-exec", ["-f", profilePath, "/bin/sh", "-c", command], spawnOptions);
      proc.on("close", cleanup);
      proc.on("error", cleanup);
    } else {
      // Fallback without sandbox profile
      proc =
        args.length > 0
          ? spawn(command, args, spawnOptions)
          : spawn("/bin/sh", ["-c", command], spawnOptions);
    }
    opts.onProcess?.(proc);

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
   * Start a command under the same seatbelt profile used by execute(). This is
   * deliberately separate from execute() so callers cannot accidentally
   * leave a child process running without retaining a cleanup handle.
   */
  spawnProcess(
    command: string,
    args: string[] = [],
    options: SandboxOptions = {},
  ): SandboxedProcess {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const cwd = opts.cwd || this.workspace.path;
    const networkError = this.getNetworkAccessError(opts.allowNetwork === true);
    if (networkError) throw new Error(networkError);
    if (!this.isPathAllowed(cwd, "read")) {
      throw new Error(`Working directory not allowed: ${cwd}`);
    }

    this.sandboxProfile = this.generateSandboxProfile(opts.allowNetwork === true, opts);
    const { profilePath, cleanup: cleanupProfile } = this.writeTempProfile();
    const env = this.buildSafeEnvironment(opts.envPassthrough);
    const proc = spawn("sandbox-exec", ["-f", profilePath, command, ...args], {
      cwd,
      env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    opts.onProcess?.(proc);

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      cleanupProfile();
    };
    proc.once("close", cleanup);
    proc.once("error", cleanup);
    return { process: proc, cleanup };
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
        allowedReadPaths: [filePath],
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
    if (this.runtimeTempDir) {
      try {
        fs.rmSync(this.runtimeTempDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup; the directory is private to this sandbox.
      }
      this.runtimeTempDir = undefined;
    }
  }

  private getMacOSPathAliases(targetPath: string): string[] {
    const aliases = new Set<string>();
    const add = (candidate: string | null | undefined): void => {
      if (!candidate) return;
      aliases.add(path.resolve(candidate));
    };

    add(targetPath);
    try {
      if (fs.existsSync(targetPath)) {
        add(fs.realpathSync(targetPath));
      }
    } catch {
      // Keep the configured path when realpath is unavailable.
    }

    for (const candidate of Array.from(aliases)) {
      if (candidate.startsWith("/var/")) {
        add(`/private${candidate}`);
      } else if (candidate.startsWith("/private/var/")) {
        add(candidate.slice("/private".length));
      }
    }

    return Array.from(aliases);
  }

  private appendReadSubpathRules(profile: string, pathsToAllow: string[]): string {
    let next = profile;
    for (const pathToAllow of pathsToAllow) {
      try {
        validatePathForSandboxProfile(pathToAllow);
        next += `(allow file-read* (subpath "${escapeSandboxProfileString(pathToAllow)}"))\n`;
      } catch (err) {
        console.warn(`[MacOSSandbox] Skipping unsafe read path: ${pathToAllow}`, err);
      }
    }
    return next;
  }

  private appendWriteSubpathRules(profile: string, pathsToAllow: string[]): string {
    let next = profile;
    for (const pathToAllow of pathsToAllow) {
      try {
        validatePathForSandboxProfile(pathToAllow);
        next += `(allow file-write* (subpath "${escapeSandboxProfileString(pathToAllow)}"))\n`;
      } catch (err) {
        console.warn(`[MacOSSandbox] Skipping unsafe write path: ${pathToAllow}`, err);
      }
    }
    return next;
  }

  private appendDenySubpathRules(profile: string, pathsToDeny: string[]): string {
    let next = profile;
    for (const pathToDeny of pathsToDeny) {
      try {
        validatePathForSandboxProfile(pathToDeny);
        const escaped = escapeSandboxProfileString(pathToDeny);
        next += `(deny file-read* (subpath "${escaped}"))\n`;
        next += `(deny file-write* (subpath "${escaped}"))\n`;
      } catch (err) {
        console.warn(`[MacOSSandbox] Skipping unsafe denied path: ${pathToDeny}`, err);
      }
    }
    return next;
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

    // A finite profile gets a private implementation temp directory below;
    // the host temp tree must not become an implicit shell escape hatch.
    if (hasEffectiveFilesystemScope(this.workspace.path, this.workspace.permissions)) {
      return false;
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
        const resolvedTarget = path.resolve(targetPath);
        if (this.isPathWithin(sysPath, resolvedTarget)) {
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
    safeEnv.TMPDIR = this.getRuntimeTempDirIfScoped();

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
  private generateSandboxProfile(allowNetwork: boolean, options: SandboxOptions = {}): string {
    const permissions = this.workspace.permissions;
    const finiteFilesystemScope = hasEffectiveFilesystemScope(this.workspace.path, permissions);
    const tempDir = finiteFilesystemScope ? this.getRuntimeTempDir() : os.tmpdir();

    // Validate and escape workspace path
    validatePathForSandboxProfile(this.workspace.path);
    const workspaceAliases = this.getMacOSPathAliases(this.workspace.path);
    const tempAliases = this.getMacOSPathAliases(tempDir);
    const escapedWorkspace = escapeSandboxProfileString(this.workspace.path);
    const escapedTempDir = escapeSandboxProfileString(tempDir);
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
  ; Current macOS /bin/sh resolves the working directory from the filesystem
  ; root before running even shell built-ins such as pwd. Keep this literal so
  ; it does not grant recursive access outside the configured workspace.
  (literal "/")
  (subpath "/usr/lib")
  (subpath "/usr/bin")
  (subpath "/bin")
  (subpath "/usr/local")
  (subpath "/System")
  (subpath "/Library/Frameworks")
  (subpath "/Applications/Xcode.app")
  (subpath "/private/var/db")
  (subpath "/private/var/select")
  (literal "/dev/null")
  (literal "/dev/urandom")
  (literal "/dev/random")
${tempReadRules}
)

; Allow homebrew on macOS
(allow file-read*
  ; Homebrew's Python launcher resolves /opt before following the
  ; /opt/homebrew symlink tree. Permit the mount point itself without granting
  ; recursive access to unrelated /opt contents.
  (literal "/opt")
  (subpath "/opt/homebrew")
)

`;
    if (permissions.read) {
      profile += `
; Allow reading workspace
(allow file-read* (subpath "${escapedWorkspace}"))
`;
      profile = this.appendReadSubpathRules(profile, workspaceAliases);
    }
    profile = this.appendReadSubpathRules(profile, tempAliases);

    // Named profile roots are allowed in addition to the workspace. Resolve
    // aliases before emitting seatbelt rules so /var and /private/var paths
    // are treated consistently on macOS.
    for (const root of permissions.accessWorkspaceRoots || []) {
      const resolvedRoot = this.resolvePolicyPath(root);
      if (this.isPathAllowed(resolvedRoot, "read")) {
        profile = this.appendReadSubpathRules(profile, this.getMacOSPathAliases(resolvedRoot));
      }
    }

    // Allow writing to workspace if permitted
    if (permissions.write) {
      profile += `
; Allow writing to workspace
(allow file-write* (subpath "${escapedWorkspace}"))
`;
      profile = this.appendWriteSubpathRules(profile, workspaceAliases);
      for (const relativePath of PROTECTED_WORKSPACE_WRITE_RELATIVE_PATHS) {
        const protectedPath = path.join(this.workspace.path, relativePath);
        try {
          validatePathForSandboxProfile(protectedPath);
          const escapedProtectedPath = escapeSandboxProfileString(protectedPath);
          profile += `(deny file-write* (subpath "${escapedProtectedPath}"))\n`;
          profile += `(deny file-write* (literal "${escapedProtectedPath}"))\n`;
        } catch (err) {
          console.warn(`[MacOSSandbox] Skipping unsafe protected path: ${protectedPath}`, err);
        }
      }
    }

    // Allow writing to temp directories
    profile += `
; Allow writing to temp directories
(allow file-write*
${tempWriteRules}
)
`;
    profile = this.appendWriteSubpathRules(profile, tempAliases);

    for (const root of permissions.accessWorkspaceRoots || []) {
      const resolvedRoot = this.resolvePolicyPath(root);
      if (permissions.write && this.isPathAllowed(resolvedRoot, "write")) {
        profile = this.appendWriteSubpathRules(profile, this.getMacOSPathAliases(resolvedRoot));
      }
    }

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

    // Allow additional read paths (with validation and escaping)
    const allowedPaths = finiteFilesystemScope ? [] : permissions.allowedPaths || [];
    for (const allowedPath of allowedPaths) {
      const resolvedAllowedPath = this.resolvePolicyPath(allowedPath);
      const allowedPathAliases = this.getMacOSPathAliases(resolvedAllowedPath);
      if (this.isPathAllowed(resolvedAllowedPath, "read")) {
        profile = this.appendReadSubpathRules(profile, allowedPathAliases);
      }
      if (permissions.write && this.isPathAllowed(resolvedAllowedPath, "write")) {
        profile = this.appendWriteSubpathRules(profile, allowedPathAliases);
      }
    }

    for (const rule of permissions.accessFilesystemRules || []) {
      const resolvedRulePath = this.resolvePolicyPath(rule.path);
      const aliases = this.getMacOSPathAliases(resolvedRulePath);
      if (rule.access === "deny") {
        profile = this.appendDenySubpathRules(profile, aliases);
      } else if (this.isPathAllowed(resolvedRulePath, "read")) {
        profile = this.appendReadSubpathRules(profile, aliases);
        if (
          rule.access === "write" &&
          permissions.write &&
          this.isPathAllowed(resolvedRulePath, "write")
        ) {
          profile = this.appendWriteSubpathRules(profile, aliases);
        }
      }
    }

    // Callers use these paths for short-lived script inputs and generated
    // outputs. They are still subject to the same evaluator; only the
    // sandbox's private temp area is exempted as an implementation detail.
    for (const readPath of options.allowedReadPaths || []) {
      const resolvedPath = this.resolvePolicyPath(readPath);
      if (
        this.isPathAllowed(resolvedPath, "read") ||
        this.isExplicitTemporaryOptionPath(resolvedPath, options.allowedReadPaths)
      ) {
        profile = this.appendReadSubpathRules(profile, this.getMacOSPathAliases(resolvedPath));
      }
    }
    for (const writePath of options.allowedWritePaths || []) {
      const resolvedPath = this.resolvePolicyPath(writePath);
      if (
        this.isPathAllowed(resolvedPath, "write") ||
        this.isExplicitTemporaryOptionPath(resolvedPath, options.allowedWritePaths)
      ) {
        profile = this.appendWriteSubpathRules(profile, this.getMacOSPathAliases(resolvedPath));
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

  private resolvePolicyPath(rawPath: string): string {
    return resolveAccessControlledPath(this.workspace.path, rawPath);
  }

  private isPathWithin(parentPath: string, candidatePath: string): boolean {
    const relative = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
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
    const tempAliases = this.getMacOSPathAliases(os.tmpdir());
    if (!tempAliases.some((alias) => this.isPathWithin(alias, target))) return false;
    return candidates.some((candidate) => {
      const resolvedCandidate = this.resolvePolicyPath(candidate);
      return resolvedCandidate && this.isPathWithin(resolvedCandidate, target);
    });
  }

  private isRuntimeTemporaryPath(targetPath: string): boolean {
    if (this.isPathWithin(this.workspace.path, targetPath)) return false;
    const runtimeTempDir = hasEffectiveFilesystemScope(
      this.workspace.path,
      this.workspace.permissions,
    )
      ? this.runtimeTempDir
      : os.tmpdir();
    if (!runtimeTempDir) return false;
    return this.getMacOSPathAliases(runtimeTempDir).some((alias) =>
      this.isPathWithin(alias, targetPath),
    );
  }

  private getNetworkAccessError(allowNetwork: boolean): string | undefined {
    if (!allowNetwork) return undefined;
    const permissions = this.workspace.permissions;
    if (permissions.network !== true) {
      return "Network access is disabled for this workspace.";
    }
    if (permissions.accessNetworkMode === "disabled") {
      return "Network access is disabled by the active access profile.";
    }
    if ((permissions.accessDomainRules || []).length > 0) {
      return "The macOS process sandbox cannot enforce domain-scoped network rules for arbitrary shell code.";
    }
    return undefined;
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
