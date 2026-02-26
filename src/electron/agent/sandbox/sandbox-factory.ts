/**
 * Sandbox Factory
 *
 * Provides a unified interface for sandbox implementations and factory
 * function to create the appropriate sandbox based on platform and availability.
 *
 * Supports:
 * - macOS sandbox-exec (native, preferred on macOS)
 * - Docker containers (cross-platform)
 * - No sandbox (fallback)
 */

import { Workspace } from "../../../shared/types";
import { MacOSSandbox } from "./macos-sandbox";
import { DockerSandbox } from "./docker-sandbox";
import { spawn } from "child_process";
import { createSecureTempFile } from "./security-utils";

/**
 * Sandbox type enumeration
 */
export type SandboxType = "macos" | "docker" | "none";

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
 * Unified sandbox interface
 * All sandbox implementations must implement this interface
 */
export interface ISandbox {
  /** The type of sandbox implementation */
  readonly type: SandboxType;

  /**
   * Initialize the sandbox environment
   * Must be called before execute()
   */
  initialize(): Promise<void>;

  /**
   * Execute a command in the sandbox
   */
  execute(command: string, args?: string[], options?: SandboxOptions): Promise<SandboxResult>;

  /**
   * Execute code in the sandbox (Python or JavaScript)
   */
  executeCode(code: string, language: "python" | "javascript"): Promise<SandboxResult>;

  /**
   * Cleanup sandbox resources
   */
  cleanup(): void;
}

/**
 * No-op sandbox implementation for when sandboxing is unavailable
 * Still enforces timeouts and output limits, but no OS-level isolation
 */
export class NoSandbox implements ISandbox {
  readonly type: SandboxType = "none";
  private workspace: Workspace;

  constructor(workspace: Workspace) {
    this.workspace = workspace;
  }

  async initialize(): Promise<void> {
    // No initialization needed
  }

  async execute(
    command: string,
    args: string[] = [],
    options: SandboxOptions = {},
  ): Promise<SandboxResult> {
    const timeout = options.timeout ?? 5 * 60 * 1000;
    const maxOutputSize = options.maxOutputSize ?? 100 * 1024;
    const cwd = options.cwd || this.workspace.path;

    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let killed = false;
      let timedOut = false;

      const shell =
        process.platform === "win32"
          ? process.env.COMSPEC || "cmd.exe"
          : "/bin/sh";
      const proc =
        args.length > 0
          ? spawn(command, args, {
              cwd,
              shell: false,
              stdio: ["ignore", "pipe", "pipe"],
            })
          : spawn(
              shell,
              process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command],
              {
                cwd,
                shell: false,
                stdio: ["ignore", "pipe", "pipe"],
              },
            );

      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        killed = true;
        proc.kill("SIGKILL");
      }, timeout);

      proc.stdout?.on("data", (data: Buffer) => {
        const chunk = data.toString();
        if (stdout.length + chunk.length <= maxOutputSize) {
          stdout += chunk;
        } else if (stdout.length < maxOutputSize) {
          stdout += chunk.slice(0, maxOutputSize - stdout.length);
          stdout += "\n[Output truncated]";
        }
      });

      proc.stderr?.on("data", (data: Buffer) => {
        const chunk = data.toString();
        if (stderr.length + chunk.length <= maxOutputSize) {
          stderr += chunk;
        } else if (stderr.length < maxOutputSize) {
          stderr += chunk.slice(0, maxOutputSize - stderr.length);
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

  cleanup(): void {
    // No cleanup needed
  }
}

/**
 * Cached Docker availability status
 */
let dockerAvailable: boolean | null = null;
let dockerCheckPromise: Promise<boolean> | null = null;

/**
 * Check if Docker is available and running
 */
export async function isDockerAvailable(): Promise<boolean> {
  // Return cached result if available
  if (dockerAvailable !== null) {
    return dockerAvailable;
  }

  // Return existing promise if check is in progress
  if (dockerCheckPromise) {
    return dockerCheckPromise;
  }

  dockerCheckPromise = new Promise((resolve) => {
    const proc = spawn("docker", ["info"], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        proc.kill();
        dockerAvailable = false;
        resolve(false);
      }
    }, 5000);

    proc.on("close", (code) => {
      clearTimeout(timeout);
      if (!resolved) {
        resolved = true;
        dockerAvailable = code === 0;
        resolve(dockerAvailable);
      }
    });

    proc.on("error", () => {
      clearTimeout(timeout);
      if (!resolved) {
        resolved = true;
        dockerAvailable = false;
        resolve(false);
      }
    });
  });

  return dockerCheckPromise;
}

/**
 * Detect the best available sandbox type for the current platform
 */
export async function detectAvailableSandbox(): Promise<SandboxType> {
  // On macOS, prefer native sandbox-exec
  if (process.platform === "darwin") {
    return "macos";
  }

  // On other platforms, check for Docker
  if (await isDockerAvailable()) {
    return "docker";
  }

  // Fallback to no sandbox
  return "none";
}

/**
 * Create a sandbox instance for the given workspace
 *
 * @param workspace - The workspace to create a sandbox for
 * @param preferredType - Optional preferred sandbox type (overrides auto-detection)
 * @returns An initialized sandbox instance
 */
export async function createSandbox(
  workspace: Workspace,
  preferredType?: SandboxType | "auto",
): Promise<ISandbox> {
  let sandboxType: SandboxType;

  if (preferredType && preferredType !== "auto") {
    // Validate the preferred type is available
    if (preferredType === "macos" && process.platform !== "darwin") {
      console.warn("macOS sandbox requested but not on macOS, falling back to auto-detect");
      sandboxType = await detectAvailableSandbox();
    } else if (preferredType === "docker" && !(await isDockerAvailable())) {
      console.warn(
        "Docker sandbox requested but Docker not available, falling back to auto-detect",
      );
      sandboxType = await detectAvailableSandbox();
    } else {
      sandboxType = preferredType;
    }
  } else {
    sandboxType = await detectAvailableSandbox();
  }

  let sandbox: ISandbox;

  switch (sandboxType) {
    case "macos":
      sandbox = new MacOSSandbox(workspace);
      break;
    case "docker":
      sandbox = new DockerSandbox(workspace);
      break;
    case "none":
    default:
      sandbox = new NoSandbox(workspace);
      break;
  }

  await sandbox.initialize();
  return sandbox;
}

/**
 * Reset Docker availability cache (useful for testing or after Docker installation)
 */
export function resetDockerCache(): void {
  dockerAvailable = null;
  dockerCheckPromise = null;
}
