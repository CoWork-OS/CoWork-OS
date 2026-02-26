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
import { Workspace } from "../../../shared/types";
import { ISandbox, SandboxType, SandboxOptions, SandboxResult } from "./sandbox-factory";

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
};

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

    const opts = { ...DEFAULT_OPTIONS, ...options };
    const dockerArgs = this.buildDockerArgs(opts);
    const fullCommand = args.length > 0 ? `${command} ${args.join(" ")}` : command;

    // Add the command to execute inside container
    dockerArgs.push(this.config.image, "/bin/sh", "-c", fullCommand);

    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let killed = false;
      let timedOut = false;

      const proc = spawn("docker", dockerArgs, {
        stdio: ["ignore", "pipe", "pipe"],
      });

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

  /**
   * Execute code in Docker container
   */
  async executeCode(code: string, language: "python" | "javascript"): Promise<SandboxResult> {
    const ext = language === "python" ? ".py" : ".js";
    const tempFile = path.join(os.tmpdir(), `cowork_script_${Date.now()}${ext}`);

    try {
      fs.writeFileSync(tempFile, code, "utf8");

      // Select appropriate image and interpreter
      const interpreter = language === "python" ? "python3" : "node";
      const image = language === "python" ? "python:3.11-alpine" : this.config.image;

      // Create a modified config for this execution
      const originalImage = this.config.image;
      this.config.image = image;

      const result = await this.execute(interpreter, ["/tmp/script" + ext], {
        timeout: 60 * 1000,
        allowNetwork: false,
        allowedReadPaths: [tempFile],
      });

      // Restore original image
      this.config.image = originalImage;

      return result;
    } finally {
      try {
        fs.unlinkSync(tempFile);
      } catch {
        // Ignore cleanup errors
      }
    }
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

    // Mount workspace (with Windows path conversion)
    const workspacePath = this.convertToDockerPath(this.workspace.path);
    const writeMode = this.workspace.permissions.write ? "rw" : "ro";
    args.push("-v", `${workspacePath}:/workspace:${writeMode}`);

    // Set working directory
    args.push("-w", options.cwd || "/workspace");

    // Mount additional allowed paths
    for (const readPath of options.allowedReadPaths || []) {
      if (fs.existsSync(readPath)) {
        const dockerPath = this.convertToDockerPath(readPath);
        const containerPath = this.getContainerMountPath(readPath);
        args.push("-v", `${dockerPath}:${containerPath}:ro`);
      }
    }

    for (const writePath of options.allowedWritePaths || []) {
      if (fs.existsSync(writePath)) {
        const dockerPath = this.convertToDockerPath(writePath);
        const containerPath = this.getContainerMountPath(writePath);
        args.push("-v", `${dockerPath}:${containerPath}:rw`);
      }
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
    // For temp directories, keep the path structure
    if (
      hostPath.startsWith("/tmp") ||
      hostPath.includes("\\Temp\\") ||
      hostPath.includes("/temp/")
    ) {
      return hostPath.startsWith("/tmp") ? hostPath : "/tmp/mounted";
    }
    // For other paths, mount under /mnt
    return `/mnt${hostPath.replace(/^[a-zA-Z]:/, "").replace(/\\/g, "/")}`;
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
