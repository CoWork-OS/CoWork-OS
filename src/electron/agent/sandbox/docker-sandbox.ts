/**
 * Docker Sandbox Implementation
 *
 * Cross-platform sandboxing using Docker containers.
 * Provides:
 * - Process isolation via container boundaries
 * - Resource limits (CPU, memory)
 * - Network isolation
 * - Filesystem restrictions via volume mounts
 */

import { spawn, ChildProcess as _ChildProcess } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { createHash } from "crypto";
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
  isAccessPathWithin,
  resolveAccessControlledPath,
} from "../../security/access-profile-paths";
import { createSecureTempFile } from "./security-utils";

/**
 * Docker sandbox configuration
 */
export interface DockerSandboxConfig {
  /** Docker image to use (default: node:20-alpine) */
  image?: string;
  /** CPU limit in cores (e.g., 0.5 = half a core) */
  cpuLimit?: number;
  /** Memory limit (e.g., "512m", "1g") */
  memoryLimit?: string;
  /** Network mode: 'none' for isolation, 'bridge' for network access */
  networkMode?: "none" | "bridge";
  /** Additional environment variables */
  env?: Record<string, string>;
}

/**
 * Default Docker configuration
 */
const DEFAULT_DOCKER_CONFIG: Required<DockerSandboxConfig> = {
  image: "node:20-alpine",
  cpuLimit: 1,
  memoryLimit: "512m",
  networkMode: "none",
  env: {},
};

/**
 * Default sandbox options
 */
const DEFAULT_OPTIONS: Required<SandboxOptions> = {
  cwd: "/workspace",
  timeout: 5 * 60 * 1000, // 5 minutes
  maxOutputSize: 100 * 1024, // 100KB
  allowNetwork: false,
  allowedReadPaths: [],
  allowedWritePaths: [],
  envPassthrough: ["LANG", "TERM"],
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

interface DockerPathMapping {
  hostPath: string;
  containerPath: string;
  kind: "directory" | "file";
}

function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/**
 * Docker container-based sandbox implementation
 */
export class DockerSandbox implements ISandbox {
  readonly type: SandboxType = "docker";
  private workspace: Workspace;
  private config: Required<DockerSandboxConfig>;
  private initialized: boolean = false;

  constructor(workspace: Workspace, config?: DockerSandboxConfig) {
    this.workspace = workspace;
    this.config = { ...DEFAULT_DOCKER_CONFIG, ...config };

    // Get Docker config from workspace if available
    const wsConfig = workspace.permissions as { dockerConfig?: DockerSandboxConfig };
    if (wsConfig.dockerConfig) {
      this.config = { ...this.config, ...wsConfig.dockerConfig };
    }
  }

  /**
   * Initialize Docker sandbox
   */
  async initialize(): Promise<void> {
    // Verify Docker is available
    const available = await this.checkDockerAvailable();
    if (!available) {
      throw new Error("Docker is not available. Please install and start Docker.");
    }

    // Pull image if not present (non-blocking, we'll catch errors on execute)
    this.pullImageIfNeeded().catch((err) => {
      console.warn(`Failed to pull Docker image: ${err.message}`);
    });

    this.initialized = true;
  }

  /**
   * Execute a command in Docker container
   */
  async execute(
    command: string,
    args: string[] = [],
    options: SandboxOptions = {},
    imageOverride?: string,
  ): Promise<SandboxResult> {
    if (!this.initialized) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "Docker sandbox not initialized",
        killed: false,
        timedOut: false,
        error: "Not initialized",
      };
    }

    const unsupportedDenyRule = this.getUnsupportedWorkspaceDenyRule();
    if (unsupportedDenyRule) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `Docker sandbox cannot safely mask the denied path inside the workspace: ${unsupportedDenyRule}`,
        killed: false,
        timedOut: false,
        error: "Unsupported access-profile deny rule",
      };
    }

    let containerCwd: string;
    try {
      containerCwd = this.resolveContainerCwd(options.cwd);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        exitCode: 1,
        stdout: "",
        stderr: message,
        killed: false,
        timedOut: false,
        error: "Path access denied",
      };
    }
    const opts = {
      ...DEFAULT_OPTIONS,
      ...options,
      cwd: containerCwd,
    };
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

    let dockerArgs: string[];
    try {
      dockerArgs = this.buildDockerArgs(opts);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        exitCode: 1,
        stdout: "",
        stderr: message,
        killed: false,
        timedOut: false,
        error: "Path access denied",
      };
    }
    // The legacy shell-command path intentionally accepts a complete command
    // string when no args are supplied. Once structured args are present,
    // quote every token so a caller cannot turn an argument into shell syntax.
    const mappedArgs = args.map((arg) => this.mapHostArgumentToContainer(arg, opts));
    const fullCommand =
      mappedArgs.length > 0 ? [command, ...mappedArgs].map(shellQuote).join(" ") : command;

    // Add the command to execute inside container
    dockerArgs.push(imageOverride || this.config.image, "/bin/sh", "-c", fullCommand);

    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let killed = false;
      let timedOut = false;

      const proc = spawn("docker", dockerArgs, {
        stdio: ["pipe", "pipe", "pipe"],
      });
      opts.onProcess?.(proc);

      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        killed = true;
        proc.kill("SIGKILL");
        // Also try to stop any running container
        this.killContainer(proc.pid);
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

  /** Start a long-running command inside a managed Docker container. */
  spawnProcess(
    command: string,
    args: string[] = [],
    options: SandboxOptions = {},
  ): SandboxedProcess {
    if (!this.initialized) {
      throw new Error("Docker sandbox not initialized");
    }
    const unsupportedDenyRule = this.getUnsupportedWorkspaceDenyRule();
    if (unsupportedDenyRule) {
      throw new Error(
        `Docker sandbox cannot safely mask the denied path inside the workspace: ${unsupportedDenyRule}`,
      );
    }

    const opts = { ...DEFAULT_OPTIONS, ...options };
    const networkError = this.getNetworkAccessError(opts.allowNetwork === true);
    if (networkError) throw new Error(networkError);
    const normalizedOptions = {
      ...opts,
      cwd: this.resolveContainerCwd(opts.cwd),
    };
    const dockerArgs = this.buildDockerArgs(normalizedOptions);
    const fullCommand = [
      command,
      ...args.map((arg) => this.mapHostArgumentToContainer(arg, normalizedOptions)),
    ]
      .map(shellQuote)
      .join(" ");
    dockerArgs.push(this.config.image, "/bin/sh", "-c", fullCommand);

    const proc = spawn("docker", dockerArgs, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    opts.onProcess?.(proc);

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      if (!proc.killed) proc.kill("SIGTERM");
      this.killContainer(proc.pid);
    };
    proc.once("close", () => {
      this.currentContainerName = undefined;
    });
    return { process: proc, cleanup };
  }

  /**
   * Execute code in Docker container
   */
  async executeCode(code: string, language: "python" | "javascript"): Promise<SandboxResult> {
    const ext = language === "python" ? ".py" : ".js";
    const { filePath: tempFile, cleanup } = createSecureTempFile(ext, code);
    try {
      // Select appropriate image and interpreter
      const interpreter = language === "python" ? "python3" : "node";
      const image = language === "python" ? "python:3.11-alpine" : this.config.image;

      const result = await this.execute(
        interpreter,
        [tempFile],
        {
          timeout: 60 * 1000,
          allowNetwork: false,
          allowedReadPaths: [tempFile],
        },
        image,
      );

      return result;
    } finally {
      cleanup();
    }
  }

  /**
   * Docker bind-mounts the complete workspace. A nested deny rule cannot be
   * represented safely by simply omitting an additional mount because the
   * parent bind mount would still expose that path. Refuse the command rather
   * than silently widening the effective access profile.
   */
  private getUnsupportedWorkspaceDenyRule(): string | undefined {
    if (this.workspace.permissions.read !== true) return undefined;
    const workspacePath = path.resolve(this.workspace.path);

    for (const rule of this.workspace.permissions.accessFilesystemRules || []) {
      if (rule.access !== "deny" || typeof rule.path !== "string") continue;
      const rawPath = rule.path.trim();
      if (!rawPath) continue;

      const deniedPath = resolveAccessControlledPath(workspacePath, rawPath);
      if (isAccessPathWithin(workspacePath, deniedPath)) {
        return rawPath;
      }
    }

    return undefined;
  }

  /**
   * Cleanup Docker resources
   */
  cleanup(): void {
    this.initialized = false;
  }

  /**
   * Check if Docker is available and running
   */
  private async checkDockerAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = spawn("docker", ["info"], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      const timeout = setTimeout(() => {
        proc.kill();
        resolve(false);
      }, 5000);

      proc.on("close", (code) => {
        clearTimeout(timeout);
        resolve(code === 0);
      });

      proc.on("error", () => {
        clearTimeout(timeout);
        resolve(false);
      });
    });
  }

  /**
   * Pull Docker image if not present locally
   */
  private async pullImageIfNeeded(): Promise<void> {
    // Check if image exists locally
    const exists = await this.imageExists(this.config.image);
    if (exists) {
      return;
    }

    // Pull the image
    return new Promise((resolve, reject) => {
      const proc = spawn("docker", ["pull", this.config.image], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      const timeout = setTimeout(() => {
        proc.kill();
        reject(new Error("Docker pull timed out"));
      }, 120000); // 2 minute timeout for pull

      proc.on("close", (code) => {
        clearTimeout(timeout);
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Failed to pull image: exit code ${code}`));
        }
      });

      proc.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  /**
   * Check if Docker image exists locally
   */
  private async imageExists(image: string): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = spawn("docker", ["image", "inspect", image], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      proc.on("close", (code) => {
        resolve(code === 0);
      });

      proc.on("error", () => {
        resolve(false);
      });
    });
  }

  /**
   * Build Docker run arguments
   */
  private buildDockerArgs(options: SandboxOptions): string[] {
    // Generate unique container name for cleanup tracking
    const containerName = `cowork-sandbox-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.currentContainerName = containerName;

    const args: string[] = ["run", "--rm", "--name", containerName];

    // Resource limits
    args.push("--cpus", this.config.cpuLimit.toString());
    args.push("--memory", this.config.memoryLimit);

    // Prevent privilege escalation
    args.push("--security-opt", "no-new-privileges:true");
    args.push("--cap-drop", "ALL");

    // Read-only root filesystem (except for specific mounts)
    args.push("--read-only");

    // Add tmpfs for /tmp
    args.push("--tmpfs", "/tmp:rw,noexec,nosuid,size=100m");

    // Network isolation
    const networkMode = options.allowNetwork ? "bridge" : "none";
    args.push("--network", networkMode);

    const mounts = new Map<
      string,
      { hostPath: string; containerPath: string; mode: "ro" | "rw" }
    >();
    const addMount = (hostPath: string, containerPath: string, mode: "ro" | "rw"): void => {
      const key = `${hostPath}\0${containerPath}`;
      const existing = mounts.get(key);
      if (!existing || (existing.mode === "ro" && mode === "rw")) {
        mounts.set(key, { hostPath, containerPath, mode });
      }
    };

    // Never bind the host workspace when read access is disabled. A writable
    // ephemeral mount still lets a task create scratch output without
    // exposing pre-existing host files.
    if (this.workspace.permissions.read === true) {
      const workspacePath = this.convertToDockerPath(path.resolve(this.workspace.path));
      const writeMode = this.workspace.permissions.write ? "rw" : "ro";
      addMount(workspacePath, "/workspace", writeMode);
    } else {
      const mode = this.workspace.permissions.write ? "rw" : "ro";
      args.push("--tmpfs", `/workspace:${mode},nosuid,nodev,size=100m`);
    }

    if (this.workspace.permissions.read === true && this.workspace.permissions.write) {
      for (const relativePath of PROTECTED_WORKSPACE_WRITE_RELATIVE_PATHS) {
        const hostPath = path.resolve(this.workspace.path, relativePath);
        if (!fs.existsSync(hostPath)) continue;
        const containerPath = `/workspace/${relativePath.replace(/\\/g, "/")}`;
        addMount(this.convertToDockerPath(hostPath), containerPath, "ro");
      }
    }

    // Set working directory
    args.push("-w", options.cwd || "/workspace");

    // Mount additional caller-supplied paths only after the central evaluator
    // has approved them. Temp files are mapped into the container's private
    // /tmp namespace rather than exposing the host temp directory wholesale.
    for (const readPath of options.allowedReadPaths || []) {
      const checkedPath = this.assertSandboxPath(readPath, "read", options);
      if (!fs.existsSync(checkedPath) || this.isPathInsideWorkspace(checkedPath)) continue;
      addMount(
        this.convertToDockerPath(checkedPath),
        this.getContainerMountPath(checkedPath),
        "ro",
      );
    }

    for (const writePath of options.allowedWritePaths || []) {
      const checkedPath = this.assertSandboxPath(writePath, "write", options);
      if (!fs.existsSync(checkedPath) || this.isPathInsideWorkspace(checkedPath)) continue;
      addMount(
        this.convertToDockerPath(checkedPath),
        this.getContainerMountPath(checkedPath),
        "rw",
      );
    }

    // Named profile roots are mounted explicitly. Denied rules are not
    // mounted, so they cannot accidentally become an additional container
    // filesystem surface.
    for (const root of this.workspace.permissions.accessWorkspaceRoots || []) {
      const checkedPath = this.assertSandboxPath(root, "read", options);
      if (!fs.existsSync(checkedPath) || this.isPathInsideWorkspace(checkedPath)) continue;
      const mode =
        this.workspace.permissions.write &&
        this.isSandboxPathAllowed(checkedPath, "write", options) &&
        !this.isExplicitReadOnlyOptionPath(checkedPath, options)
          ? "rw"
          : "ro";
      addMount(
        this.convertToDockerPath(checkedPath),
        this.getContainerMountPath(checkedPath),
        mode,
      );
    }

    for (const rule of this.workspace.permissions.accessFilesystemRules || []) {
      if (rule.access === "deny") continue;
      const checkedPath = this.assertSandboxPath(rule.path, "read", options);
      if (!fs.existsSync(checkedPath) || this.isPathInsideWorkspace(checkedPath)) continue;
      const mode =
        rule.access === "write" &&
        this.workspace.permissions.write &&
        this.isSandboxPathAllowed(checkedPath, "write", options) &&
        !this.isExplicitReadOnlyOptionPath(checkedPath, options)
          ? "rw"
          : "ro";
      addMount(
        this.convertToDockerPath(checkedPath),
        this.getContainerMountPath(checkedPath),
        mode,
      );
    }

    const legacyAllowedPaths = hasEffectiveFilesystemScope(
      this.workspace.path,
      this.workspace.permissions,
    )
      ? []
      : this.workspace.permissions.allowedPaths || [];
    for (const allowedPath of legacyAllowedPaths) {
      const checkedPath = this.assertSandboxPath(allowedPath, "read", options);
      if (!fs.existsSync(checkedPath) || this.isPathInsideWorkspace(checkedPath)) continue;
      const mode =
        this.workspace.permissions.write &&
        this.isSandboxPathAllowed(checkedPath, "write", options) &&
        !this.isExplicitReadOnlyOptionPath(checkedPath, options)
          ? "rw"
          : "ro";
      addMount(
        this.convertToDockerPath(checkedPath),
        this.getContainerMountPath(checkedPath),
        mode,
      );
    }

    for (const mount of mounts.values()) {
      args.push("-v", `${mount.hostPath}:${mount.containerPath}:${mount.mode}`);
    }

    // Environment variables
    for (const envKey of options.envPassthrough || []) {
      if (process.env[envKey]) {
        args.push("-e", `${envKey}=${process.env[envKey]}`);
      }
    }

    // Add custom environment
    for (const [key, value] of Object.entries(this.config.env)) {
      args.push("-e", `${key}=${value}`);
    }

    // User mapping (run as current user to avoid permission issues)
    // Skip on Windows as Docker Desktop handles this differently
    if (process.platform !== "win32") {
      args.push("--user", `${process.getuid?.() || 1000}:${process.getgid?.() || 1000}`);
    }

    return args;
  }

  private resolveContainerCwd(rawCwd?: string): string {
    if (!rawCwd) return "/workspace";
    if (rawCwd === "/workspace" || rawCwd.startsWith("/workspace/")) {
      const relative = rawCwd.slice("/workspace".length).replace(/^\/+/, "");
      const normalized = path.posix.normalize(`/workspace/${relative}`);
      if (normalized !== "/workspace" && !normalized.startsWith("/workspace/")) {
        throw new Error(`Docker sandbox working directory escapes /workspace: ${rawCwd}`);
      }
      if (this.workspace.permissions.read === true && relative) {
        const hostPath = path.resolve(this.workspace.path, relative);
        if (!this.isSandboxPathAllowed(hostPath, "read")) {
          throw new Error(`Docker sandbox working directory is not readable: ${rawCwd}`);
        }
      }
      return normalized === "/workspace/." ? "/workspace" : normalized;
    }

    const workspacePath = path.resolve(this.workspace.path);
    const candidate = resolveAccessControlledPath(workspacePath, rawCwd);
    const relative = path.relative(workspacePath, candidate);
    if (relative === "") return "/workspace";
    if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
      return `/workspace/${relative.replace(/\\/g, "/")}`;
    }

    if (!this.isSandboxPathAllowed(candidate, "read")) {
      throw new Error(`Docker sandbox working directory is outside the workspace: ${rawCwd}`);
    }

    const mountRoot = this.findExternalMountRoot(candidate);
    if (!mountRoot) {
      throw new Error(`Docker sandbox working directory is not mounted: ${rawCwd}`);
    }
    const mountPath = this.getContainerMountPath(mountRoot);
    const mountRelative = path.relative(mountRoot, candidate).replace(/\\/g, "/");
    return mountRelative ? `${mountPath}/${mountRelative}` : mountPath;
  }

  private isPathInsideWorkspace(candidatePath: string): boolean {
    return isAccessPathWithin(path.resolve(this.workspace.path), candidatePath);
  }

  private isRuntimeTemporaryPath(candidatePath: string): boolean {
    if (this.isPathInsideWorkspace(candidatePath)) return false;
    if (hasEffectiveFilesystemScope(this.workspace.path, this.workspace.permissions)) return false;
    return isAccessPathWithin(os.tmpdir(), candidatePath);
  }

  private isSandboxPathAllowed(
    rawPath: string,
    operation: "read" | "write" | "delete",
    options?: SandboxOptions,
  ): boolean {
    try {
      const candidate = resolveAccessControlledPath(this.workspace.path, rawPath);
      const decision = evaluateWorkspaceFilesystemAccess(this.workspace, candidate, operation);
      return (
        decision.decision === "allow" ||
        this.isRuntimeTemporaryPath(candidate) ||
        this.isExplicitTemporaryOptionPath(candidate, options, operation)
      );
    } catch {
      return false;
    }
  }

  private assertSandboxPath(
    rawPath: string,
    operation: "read" | "write",
    options?: SandboxOptions,
  ): string {
    const candidate = resolveAccessControlledPath(this.workspace.path, rawPath);
    if (!this.isSandboxPathAllowed(candidate, operation, options)) {
      throw new Error(`Docker sandbox denied ${operation} access to path: ${rawPath}`);
    }
    return candidate;
  }

  private isExplicitTemporaryOptionPath(
    candidatePath: string,
    options: SandboxOptions | undefined,
    operation: "read" | "write" | "delete",
  ): boolean {
    if (!options || !hasEffectiveFilesystemScope(this.workspace.path, this.workspace.permissions)) {
      return false;
    }
    if (operation === "delete") return false;
    if (!isAccessPathWithin(os.tmpdir(), candidatePath)) return false;
    const candidates = operation === "read" ? options.allowedReadPaths : options.allowedWritePaths;
    return (candidates || []).some((rawPath) => {
      try {
        const allowedPath = resolveAccessControlledPath(this.workspace.path, rawPath);
        return isAccessPathWithin(allowedPath, candidatePath);
      } catch {
        return false;
      }
    });
  }

  /**
   * Preserve a caller's read-only file boundary even when a broader profile
   * root or legacy allowed path overlaps it. Without this check Docker's
   * mount de-duplication could upgrade an explicitly readable input to rw.
   */
  private isExplicitReadOnlyOptionPath(
    candidatePath: string,
    options: SandboxOptions | undefined,
  ): boolean {
    if (!options) return false;

    const readPaths = (options.allowedReadPaths || []).map((rawPath) => {
      try {
        return resolveAccessControlledPath(this.workspace.path, rawPath);
      } catch {
        return undefined;
      }
    });
    const writePaths = (options.allowedWritePaths || []).map((rawPath) => {
      try {
        return resolveAccessControlledPath(this.workspace.path, rawPath);
      } catch {
        return undefined;
      }
    });

    return readPaths.some((readPath) => {
      if (!readPath) return false;
      const readIsCoveredByWrite = writePaths.some(
        (writePath) => !!writePath && isAccessPathWithin(writePath, readPath),
      );
      if (readIsCoveredByWrite) return false;
      return (
        isAccessPathWithin(candidatePath, readPath) || isAccessPathWithin(readPath, candidatePath)
      );
    });
  }

  private collectPathMappings(options: SandboxOptions): DockerPathMapping[] {
    const mappings: DockerPathMapping[] = [
      {
        hostPath: path.resolve(this.workspace.path),
        containerPath: "/workspace",
        kind: "directory",
      },
    ];
    const seen = new Set<string>();
    const add = (
      rawPath: string,
      operation: "read" | "write",
      approvalOptions?: SandboxOptions,
    ): void => {
      const checkedPath = this.assertSandboxPath(rawPath, operation, approvalOptions);
      if (!fs.existsSync(checkedPath) || this.isPathInsideWorkspace(checkedPath)) return;
      const key = path.resolve(checkedPath);
      if (seen.has(key)) return;
      seen.add(key);
      let kind: DockerPathMapping["kind"] = "file";
      try {
        kind = fs.statSync(checkedPath).isDirectory() ? "directory" : "file";
      } catch {
        return;
      }
      mappings.push({
        hostPath: checkedPath,
        containerPath: this.getContainerMountPath(checkedPath),
        kind,
      });
    };

    for (const readPath of options.allowedReadPaths || []) add(readPath, "read", options);
    for (const writePath of options.allowedWritePaths || []) add(writePath, "write", options);
    for (const root of this.workspace.permissions.accessWorkspaceRoots || []) {
      add(
        root,
        this.workspace.permissions.write && this.isSandboxPathAllowed(root, "write")
          ? "write"
          : "read",
      );
    }
    for (const rule of this.workspace.permissions.accessFilesystemRules || []) {
      if (rule.access === "deny") continue;
      add(rule.path, rule.access === "write" ? "write" : "read");
    }
    const legacyAllowedPaths = hasEffectiveFilesystemScope(
      this.workspace.path,
      this.workspace.permissions,
    )
      ? []
      : this.workspace.permissions.allowedPaths || [];
    for (const allowedPath of legacyAllowedPaths) {
      add(
        allowedPath,
        this.workspace.permissions.write && this.isSandboxPathAllowed(allowedPath, "write")
          ? "write"
          : "read",
      );
    }
    return mappings;
  }

  private findExternalMountRoot(candidatePath: string): string | undefined {
    const configuredRoots = [
      ...(this.workspace.permissions.accessWorkspaceRoots || []),
      ...(this.workspace.permissions.accessFilesystemRules || [])
        .filter((rule) => rule.access !== "deny")
        .map((rule) => rule.path),
      ...(hasEffectiveFilesystemScope(this.workspace.path, this.workspace.permissions)
        ? []
        : this.workspace.permissions.allowedPaths || []),
    ];
    const candidate = resolveAccessControlledPath(this.workspace.path, candidatePath);
    return configuredRoots
      .map((rawRoot) => {
        try {
          return resolveAccessControlledPath(this.workspace.path, rawRoot);
        } catch {
          return "";
        }
      })
      .filter((root) => root && isAccessPathWithin(root, candidate))
      .sort((left, right) => right.length - left.length)[0];
  }

  private mapHostArgumentToContainer(arg: string, options: SandboxOptions): string {
    const value = String(arg);
    if (!path.isAbsolute(value) && !/^[a-zA-Z]:[\\/]/.test(value)) return value;

    let candidate: string;
    try {
      candidate = resolveAccessControlledPath(this.workspace.path, value);
    } catch {
      return value;
    }

    const mappings = this.collectPathMappings(options).sort(
      (left, right) => right.hostPath.length - left.hostPath.length,
    );
    for (const mapping of mappings) {
      const isMatch =
        mapping.kind === "file"
          ? path.resolve(mapping.hostPath) === path.resolve(candidate)
          : isAccessPathWithin(mapping.hostPath, candidate);
      if (!isMatch) continue;
      const relative = path.relative(mapping.hostPath, candidate).replace(/\\/g, "/");
      if (mapping.kind === "file" || !relative) return mapping.containerPath;
      return `${mapping.containerPath}/${relative}`;
    }
    return value;
  }

  private getNetworkAccessError(allowNetwork: boolean): string | undefined {
    if (!allowNetwork) return undefined;
    const permissions = this.workspace.permissions;
    if (permissions.network !== true) return "Network access is disabled for this workspace.";
    if (permissions.accessNetworkMode === "disabled") {
      return "Network access is disabled by the active access profile.";
    }
    if ((permissions.accessDomainRules || []).length > 0) {
      return "The Docker process sandbox cannot enforce domain-scoped network rules for arbitrary shell code.";
    }
    return undefined;
  }

  /**
   * Convert host path to Docker-compatible format
   * Handles Windows path conversion for Docker Desktop
   */
  private convertToDockerPath(hostPath: string): string {
    if (process.platform !== "win32") {
      return hostPath;
    }

    // Windows: Convert C:\path\to\dir to /c/path/to/dir for Docker
    // Docker Desktop for Windows uses this format for volume mounts
    const normalized = hostPath.replace(/\\/g, "/");

    // Match drive letter pattern (e.g., C:/)
    const driveMatch = normalized.match(/^([a-zA-Z]):\//);
    if (driveMatch) {
      const driveLetter = driveMatch[1].toLowerCase();
      return `/${driveLetter}${normalized.slice(2)}`;
    }

    return normalized;
  }

  /**
   * Get the container mount path for a host path
   */
  private getContainerMountPath(hostPath: string): string {
    const normalized = path.resolve(hostPath);
    const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
    return this.isRuntimeTemporaryPath(normalized)
      ? `/tmp/cowork-mount-${digest}`
      : `/mnt/cowork-mount-${digest}`;
  }

  // Track current container name for cleanup
  private currentContainerName?: string;

  /**
   * Stop and remove the current container
   */
  private killContainer(_parentPid: number | undefined): void {
    if (!this.currentContainerName) {
      return;
    }

    // Stop the specific container by name (more targeted than prune)
    const stopProc = spawn("docker", ["stop", "-t", "2", this.currentContainerName], {
      stdio: "ignore",
    });

    stopProc.on("close", () => {
      // Container should auto-remove due to --rm, but force remove if stuck
      spawn("docker", ["rm", "-f", this.currentContainerName!], {
        stdio: "ignore",
      });
      this.currentContainerName = undefined;
    });

    stopProc.on("error", () => {
      // Ignore errors - container may already be gone
      this.currentContainerName = undefined;
    });
  }
}
