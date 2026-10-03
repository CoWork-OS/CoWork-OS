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
import * as crypto from "crypto";
import { Workspace } from "../../../shared/types";
import { macOSFilesystemRestrictions } from "./macos-filesystem-policy";
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
  isAccessPathWithin,
  resolveAccessControlledPath,
} from "../../security/access-profile-paths";
import {
  createSecureTempFile,
  escapeSandboxProfileString,
  validatePathForSandboxProfile,
} from "./security-utils";
import { applyNonInteractiveEnvDefaults } from "./non-interactive-env";
import {
  macOSToolchainProfileRules,
  resolveMacOSToolchainAccess,
  writeSanitizedNpmrc,
  type MacOSToolchainAccess,
} from "./macos-toolchain-access";
import { BoundedOutputBuffer } from "./bounded-output";
import { createLogger } from "../../utils/logger";

const log = createLogger("MacOSSandbox");

/**
 * Default sandbox options
 */
const DEFAULT_OPTIONS: Required<SandboxOptions> = {
  cwd: process.cwd(),
  timeout: 5 * 60 * 1000, // 5 minutes
  maxOutputSize: 100 * 1024, // 100KB
  allowNetwork: false,
  allowLoopbackListen: false,
  detached: false,
  allowedReadPaths: [],
  allowedWritePaths: [],
  envPassthrough: ["PATH", "HOME", "USER", "SHELL", "LANG", "TERM", "TMPDIR"],
  onProcess: () => undefined,
};

/**
 * Kill a sandboxed command together with every process it started. Signalling
 * only the shell leaves its children running, and they keep the output pipes
 * (and the caller waiting on them) open.
 */
function killProcessGroup(proc: ChildProcess): void {
  if (proc.pid) {
    try {
      process.kill(-proc.pid, "SIGKILL");
      return;
    } catch {
      // The group may already be gone; fall back to the direct child.
    }
  }
  proc.kill("SIGKILL");
}

/**
 * True when `root` holds a .git or .cowork/policy entry, or is too large to
 * check. The profile lets nothing create those names in private scratch, so
 * one found there is a nested repository (or policy directory) whose parent
 * was moved out of the workspace; deleting scratch would delete it.
 */
function holdsProtectedEntry(root: string, limit = 50_000): boolean {
  const pending = [root];
  let seen = 0;
  while (pending.length > 0) {
    const dir = pending.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (++seen > limit) return true;
      const name = entry.name.toLowerCase();
      if (name === ".git") return true;
      if (!entry.isDirectory()) continue;
      const child = path.join(dir, entry.name);
      if (name === ".cowork") {
        try {
          if (fs.readdirSync(child).some((item) => item.toLowerCase() === "policy")) return true;
        } catch {
          // Unreadable: fall through and walk it like any other directory.
        }
      }
      pending.push(child);
    }
  }
  return false;
}

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
    const toolchain = this.resolveToolchainAccess();
    this.sandboxProfile = this.generateSandboxProfile(opts.allowNetwork === true, opts, toolchain);
    if (!this.sandboxProfile) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "macOS sandbox profile unavailable; refusing unsandboxed execution.",
        killed: false,
        timedOut: false,
        error: "Sandbox profile unavailable",
      };
    }

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
    const env = this.buildSafeEnvironment(opts.envPassthrough, toolchain);

    let proc: ChildProcess;
    const spawnOptions: SpawnOptions = {
      cwd,
      env,
      shell: false,
      // Lead a new process group so a timeout can stop the whole command.
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    };

    // Use sandbox-exec on macOS. There is intentionally no unsandboxed fallback
    // here: callers that explicitly choose NoSandbox are handled by the factory.
    const { profilePath, cleanup } = this.writeTempProfile();
    proc =
      args.length > 0
        ? spawn("sandbox-exec", ["-f", profilePath, command, ...args], spawnOptions)
        : spawn("sandbox-exec", ["-f", profilePath, "/bin/sh", "-c", command], spawnOptions);
    proc.on("close", cleanup);
    proc.on("error", cleanup);
    opts.onProcess?.(proc);

    return new Promise((resolve) => {
      // Keep the start and the end of long output; errors and summaries print last.
      const stdout = new BoundedOutputBuffer(opts.maxOutputSize);
      const stderr = new BoundedOutputBuffer(opts.maxOutputSize);
      let killed = false;
      let timedOut = false;

      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        killed = true;
        killProcessGroup(proc);
      }, opts.timeout);

      proc.stdout?.on("data", (data: Buffer) => stdout.append(data.toString()));
      proc.stderr?.on("data", (data: Buffer) => stderr.append(data.toString()));

      proc.on("close", (code) => {
        clearTimeout(timeoutHandle);
        resolve({
          exitCode: code ?? 1,
          stdout: stdout.toString(),
          stderr: stderr.toString(),
          killed,
          timedOut,
          truncated: stdout.truncated || stderr.truncated,
        });
      });

      proc.on("error", (err) => {
        clearTimeout(timeoutHandle);
        resolve({
          exitCode: 1,
          stdout: stdout.toString(),
          stderr: err.message,
          killed,
          timedOut,
          error: err.message,
          truncated: stdout.truncated,
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

    const toolchain = this.resolveToolchainAccess();
    this.sandboxProfile = this.generateSandboxProfile(opts.allowNetwork === true, opts, toolchain);
    if (!this.sandboxProfile) {
      throw new Error("macOS sandbox profile unavailable; refusing unsandboxed execution.");
    }
    const { profilePath, cleanup: cleanupProfile } = this.writeTempProfile();
    const env = this.buildSafeEnvironment(opts.envPassthrough, toolchain);
    const proc = spawn("sandbox-exec", ["-f", profilePath, command, ...args], {
      cwd,
      env,
      shell: false,
      detached: opts.detached === true,
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
    const { filePath, cleanup } = this.createRuntimeCodeFile(ext, code);

    try {
      const interpreter = language === "python" ? "python3" : "node";
      return await this.execute(interpreter, [filePath], {
        cwd: this.workspace.path,
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
      if (holdsProtectedEntry(this.runtimeTempDir)) {
        // A command may move a workspace directory into scratch; if that
        // directory holds a nested repository, removing scratch would delete
        // its history, which the sandbox itself is never allowed to do.
        log.warn(
          `Keeping sandbox scratch ${this.runtimeTempDir}: it holds a .git or .cowork/policy entry moved out of the workspace.`,
        );
      } else {
        try {
          fs.rmSync(this.runtimeTempDir, { recursive: true, force: true });
        } catch {
          // Best-effort cleanup; the directory is private to this sandbox.
        }
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

  /**
   * Return literal directory entries needed to resolve a path under a
   * macOS synthetic mount such as /private/tmp. Literal rules expose only
   * the directory entry itself; they do not grant recursive access to the
   * ancestor tree.
   */
  private getMacOSPathAncestors(targetPaths: readonly string[]): string[] {
    const ancestors = new Set<string>();
    for (const targetPath of targetPaths) {
      let current = path.dirname(path.resolve(targetPath));
      while (current !== "/") {
        if (current === "/private" || current.startsWith("/private/")) {
          ancestors.add(current);
        }
        current = path.dirname(current);
      }
    }
    return Array.from(ancestors);
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

    // Capability denials are authoritative. In particular, do not let the
    // temporary-path or system-read compatibility exceptions turn a disabled
    // workspace read/write bit into an implicit grant.
    if (access.reason === "access_profile_unavailable" || access.reason.endsWith("_disabled")) {
      return false;
    }

    const normalizedTarget = path.resolve(targetPath);
    // A workspace may itself live below the OS temp directory. Keep that
    // workspace boundary ahead of the host-temp compatibility exception.
    if (isAccessPathWithin(this.workspace.path, normalizedTarget)) return false;

    if (this.isRuntimeTemporaryPath(targetPath)) return true;

    // A finite profile gets a private implementation temp directory below;
    // the host temp tree must not become an implicit shell escape hatch.
    if (this.hasBoundedFilesystemScope()) {
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
        if (this.isPathWithin(sysPath, normalizedTarget)) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Home-directory toolchain grants, PATH and environment for this command.
   * Cache writes follow the workspace write capability: a read-only profile
   * must not leave anything behind outside its private scratch directory.
   */
  private resolveToolchainAccess(): MacOSToolchainAccess {
    const permissions = this.workspace.permissions;
    return resolveMacOSToolchainAccess({
      homeDir: this.getHomeDir(),
      env: process.env,
      workspacePath: this.workspace.path,
      allowWrites: permissions.write === true && permissions.accessSandboxMode !== "read-only",
    });
  }

  private getHomeDir(): string {
    return process.env.HOME || os.homedir();
  }

  /**
   * Build a minimal, safe environment for command execution
   */
  private buildSafeEnvironment(
    passthrough: string[],
    toolchain: MacOSToolchainAccess,
  ): Record<string, string | undefined> {
    const safeEnv: Record<string, string | undefined> = {};

    for (const key of passthrough) {
      if (process.env[key]) {
        safeEnv[key] = process.env[key];
      }
    }
    // Toolchain configuration only: proxies (without credentials), CA
    // bundles and relocated toolchain homes. Never tokens or keys.
    Object.assign(safeEnv, toolchain.env);

    safeEnv.HOME = this.getHomeDir();
    safeEnv.USER = process.env.USER || os.userInfo().username;
    safeEnv.SHELL = process.env.SHELL || "/bin/bash";
    safeEnv.TERM = "xterm-256color";
    safeEnv.LANG = process.env.LANG || "en_US.UTF-8";
    safeEnv.TMPDIR = this.getRuntimeTempDirIfScoped();
    safeEnv.PATH = toolchain.path;

    // The user's npmrc keeps registry, proxy and script settings, but its
    // auth tokens stay outside the sandbox (the original file is denied).
    const npmrc = writeSanitizedNpmrc(this.getHomeDir(), process.env, this.getRuntimeTempDir());
    if (npmrc) safeEnv.NPM_CONFIG_USERCONFIG = npmrc;

    return applyNonInteractiveEnvDefaults(safeEnv);
  }

  /**
   * Generate macOS sandbox-exec profile
   * Paths are escaped to prevent sandbox profile injection attacks
   */
  private generateSandboxProfile(
    allowNetwork: boolean,
    options: SandboxOptions = {},
    toolchain: MacOSToolchainAccess = this.resolveToolchainAccess(),
  ): string {
    const permissions = this.workspace.permissions;
    const finiteFilesystemScope = this.hasBoundedFilesystemScope();
    const tempDir = finiteFilesystemScope ? this.getRuntimeTempDir() : os.tmpdir();

    // Validate and escape workspace path
    validatePathForSandboxProfile(this.workspace.path);
    const workspaceAliases = this.getMacOSPathAliases(this.workspace.path);
    const workspaceAncestorRules = this.getMacOSPathAncestors(workspaceAliases)
      .map((ancestor) => `  (literal "${escapeSandboxProfileString(ancestor)}")`)
      .join("\n");
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
  ; These immutable system symlinks must be readable when resolving an
  ; explicitly permitted path through its /var or /tmp spelling.
  (literal "/var")
  (literal "/tmp")
  (subpath "/usr/lib")
  (subpath "/usr/bin")
  (subpath "/bin")
  (subpath "/usr/local")
  (subpath "/System")
  (subpath "/Library/Frameworks")
  (subpath "/Applications/Xcode.app")
  (subpath "/private/var/db")
  (subpath "/private/var/select")
${workspaceAncestorRules}
  (literal "/dev/urandom")
  (literal "/dev/random")
${tempReadRules}
)

; Standard device nodes. Git opens /dev/null read-write at startup and shells
; redirect to it; /dev/fd and /dev/std* only reach descriptors the process
; already holds. /dev/tty stays denied: a command spawned without a new
; session could otherwise read from or inject into the user's terminal.
(allow file-read* file-write-data
  (literal "/dev/null")
  (literal "/dev/zero")
  (literal "/dev/stdin")
  (literal "/dev/stdout")
  (literal "/dev/stderr")
  (subpath "/dev/fd")
)

; Name resolution and TLS configuration read by curl, git, pip and others.
; The /etc link and /private/etc itself are traversed, not listed.
(allow file-read-metadata (literal "/etc") (literal "/private/etc"))
(allow file-read*
  (literal "/private/etc/hosts")
  (literal "/private/etc/resolv.conf")
  (literal "/private/etc/services")
  (literal "/private/etc/protocols")
  (literal "/private/etc/localtime")
  (subpath "/private/etc/ssl")
)

; Allow homebrew on macOS
(allow file-read*
  ; Homebrew's Python launcher resolves /opt before following the
  ; /opt/homebrew symlink tree. Permit the mount point itself without granting
  ; recursive access to unrelated /opt contents.
  (literal "/opt")
  (subpath "/opt/homebrew")
)
${macOSToolchainProfileRules(toolchain)}
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
      // Network access is for the network. A Unix-domain socket reaches a
      // local program instead, often with the user's full authority: the
      // Docker daemon (a host-root container is one request away), an
      // ssh-agent, database servers. Keep those out; DNS goes through
      // mDNSResponder's socket, and sockets the command creates in its own
      // workspace or private scratch keep working. (The shared host temp
      // directory is not included: editors and agents keep IPC sockets there.)
      const ownSockets = [
        ...workspaceAliases,
        ...this.getMacOSPathAliases(this.getRuntimeTempDir()),
      ]
        .map((alias) => `  (remote unix-socket (subpath "${escapeSandboxProfileString(alias)}"))`)
        .join("\n");
      profile += `
; Allow network access
(allow network*)
; ...except other programs' local sockets
(deny network-outbound (remote unix-socket))
(allow network-outbound
  (remote unix-socket (path-literal "/private/var/run/mDNSResponder"))
${ownSockets}
)
`;
    } else {
      profile += `
; Deny network access (except localhost)
(deny network*)
; Keep the localhost exception scoped to outbound loopback sockets. An
; unrestricted network* allow with a (local ip ...) filter is treated as
; a broad network grant by seatbelt on current macOS releases.
(allow network-outbound
  (remote tcp "localhost:*")
  (remote udp "localhost:*")
)
`;
      if (options.allowLoopbackListen === true) {
        profile += `
; Local TCP servers (dev servers, test servers). Egress stays limited to
; loopback above, but seatbelt matches a (local ... "localhost:*") filter for
; 0.0.0.0 and LAN addresses too, so this alone does not keep a server off the
; network: the caller pairs it with LoopbackListenerGuard, which stops a
; process group that listens on a non-loopback address. TCP only; UDP binds
; stay denied.
(allow network-bind (local tcp "localhost:*"))
(allow network-inbound (local tcp "localhost:*"))
`;
      }
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
; Allow essential mach services. trustd.agent evaluates TLS certificates for
; tools that use the system trust store (pip, go, cargo); the opendirectoryd
; services answer user and group name lookups (getpwuid, id, git identity).
(allow mach-lookup
  (global-name "com.apple.CoreServices.coreservicesd")
  (global-name "com.apple.SecurityServer")
  (global-name "com.apple.system.logger")
  (global-name "com.apple.cfprefsd.daemon")
  (global-name "com.apple.cfprefsd.agent")
  (global-name "com.apple.trustd.agent")
  (global-name "com.apple.system.opendirectoryd.libinfo")
  (global-name "com.apple.system.opendirectoryd.membership")
)
`;

    return (
      profile +
      macOSFilesystemRestrictions(
        this.workspace,
        options,
        this.getRuntimeTempDir(),
        finiteFilesystemScope,
        { writableCaches: toolchain.writeDirs, gitMarkerCaches: toolchain.gitMarkerCaches },
      )
    );
  }

  private resolvePolicyPath(rawPath: string): string {
    return resolveAccessControlledPath(this.workspace.path, rawPath);
  }

  /**
   * Named read-only/workspace-write profiles are bounded even when they do
   * not carry explicit filesystem rules or extra workspace roots. Keep the
   * legacy unscoped behavior for persisted permissions without an access
   * sandbox mode (and for explicit danger-full-access).
   */
  private hasBoundedFilesystemScope(): boolean {
    return (
      hasEffectiveFilesystemScope(this.workspace.path, this.workspace.permissions) ||
      this.workspace.permissions.accessSandboxMode === "workspace-write" ||
      this.workspace.permissions.accessSandboxMode === "read-only"
    );
  }

  private isPathWithin(parentPath: string, candidatePath: string): boolean {
    const relative = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  }

  private getRuntimeTempDirIfScoped(): string {
    return this.hasBoundedFilesystemScope() ? this.getRuntimeTempDir() : os.tmpdir();
  }

  private getRuntimeTempDir(): string {
    if (!this.runtimeTempDir) {
      this.runtimeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-sandbox-"));
    }
    return this.runtimeTempDir;
  }

  private createRuntimeCodeFile(
    extension: string,
    content: string,
  ): { filePath: string; cleanup: () => void } {
    const runtimeTempDir = this.getRuntimeTempDir();
    const filename = `cowork_${crypto.randomBytes(16).toString("hex")}${extension}`;
    const filePath = path.join(runtimeTempDir, filename);
    const fd = fs.openSync(
      filePath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      0o600,
    );
    try {
      fs.writeSync(fd, content, 0, "utf8");
    } finally {
      fs.closeSync(fd);
    }
    return {
      filePath,
      cleanup: () => {
        try {
          fs.unlinkSync(filePath);
        } catch {
          // Best-effort cleanup; the runtime temp directory is private.
        }
      },
    };
  }

  private isExplicitTemporaryOptionPath(
    targetPath: string,
    candidates: readonly string[] | undefined,
  ): boolean {
    if (!this.hasBoundedFilesystemScope()) return false;
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
    const runtimeTempDir = this.hasBoundedFilesystemScope() ? this.runtimeTempDir : os.tmpdir();
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
