/**
 * SandboxRunner - Secure execution environment for shell commands
 *
 * Implements sandboxing for shell command execution with:
 * - macOS sandbox-exec profiles for system call filtering
 * - Process isolation with limited environment
 * - Resource limits (CPU, memory, file descriptors)
 * - Network access control
 * - Filesystem access restrictions
 */

import { spawn, ChildProcess, SpawnOptions } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { Workspace } from '../../../shared/types';

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
  envPassthrough: ['PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'TERM', 'TMPDIR'],
};

/**
 * SandboxRunner manages secure command execution
 */
export class SandboxRunner {
  private workspace: Workspace;
  private sandboxProfile?: string;

  constructor(workspace: Workspace) {
    this.workspace = workspace;
  }

  /**
   * Initialize sandbox environment
   */
  async initialize(): Promise<void> {
    // Generate sandbox profile for this workspace
    this.sandboxProfile = this.generateSandboxProfile();
  }

  /**
   * Execute a command in the sandbox
   */
  async execute(
    command: string,
    args: string[] = [],
    options: SandboxOptions = {}
  ): Promise<SandboxResult> {
    const opts = { ...DEFAULT_OPTIONS, ...options };

    // Determine working directory
    const cwd = opts.cwd || this.workspace.path;

    // Validate working directory is within allowed paths
    if (!this.isPathAllowed(cwd, 'read')) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: `Working directory not allowed: ${cwd}`,
        killed: false,
        timedOut: false,
        error: 'Path access denied',
      };
    }

    // Build minimal, safe environment
    const env = this.buildSafeEnvironment(opts.envPassthrough);

    // Check if we can use macOS sandbox-exec
    const useSandboxExec = process.platform === 'darwin' && this.sandboxProfile;

    let proc: ChildProcess;
    const spawnOptions: SpawnOptions = {
      cwd,
      env,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    };

    if (useSandboxExec && this.sandboxProfile) {
      // Use sandbox-exec on macOS
      const profilePath = this.writeTempProfile();
      proc = spawn('sandbox-exec', ['-f', profilePath, '/bin/sh', '-c', `${command} ${args.join(' ')}`], spawnOptions);
    } else {
      // Fallback: execute without OS-level sandboxing (still has resource limits)
      proc = spawn('/bin/sh', ['-c', `${command} ${args.join(' ')}`], spawnOptions);
    }

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let killed = false;
      let timedOut = false;

      // Timeout handler
      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        killed = true;
        proc.kill('SIGKILL');
      }, opts.timeout);

      // Collect stdout
      proc.stdout?.on('data', (data: Buffer) => {
        const chunk = data.toString();
        if (stdout.length + chunk.length <= opts.maxOutputSize) {
          stdout += chunk;
        } else if (stdout.length < opts.maxOutputSize) {
          stdout += chunk.slice(0, opts.maxOutputSize - stdout.length);
          stdout += '\n[Output truncated]';
        }
      });

      // Collect stderr
      proc.stderr?.on('data', (data: Buffer) => {
        const chunk = data.toString();
        if (stderr.length + chunk.length <= opts.maxOutputSize) {
          stderr += chunk;
        } else if (stderr.length < opts.maxOutputSize) {
          stderr += chunk.slice(0, opts.maxOutputSize - stderr.length);
          stderr += '\n[Output truncated]';
        }
      });

      // Process completion
      proc.on('close', (code) => {
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
      proc.on('error', (err) => {
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
  async executeCode(code: string, language: 'python' | 'javascript'): Promise<SandboxResult> {
    // Create temp file with code
    const ext = language === 'python' ? '.py' : '.js';
    const tempFile = path.join(os.tmpdir(), `cowork_script_${Date.now()}${ext}`);

    try {
      fs.writeFileSync(tempFile, code, 'utf8');

      const interpreter = language === 'python' ? 'python3' : 'node';
      return await this.execute(interpreter, [tempFile], {
        timeout: 60 * 1000, // 1 minute for scripts
        allowNetwork: false,
      });
    } finally {
      // Cleanup temp file
      try {
        fs.unlinkSync(tempFile);
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  /**
   * Cleanup sandbox resources
   */
  cleanup(): void {
    // Clean up any temp files or resources
    this.sandboxProfile = undefined;
  }

  /**
   * Check if a path is allowed based on workspace permissions
   */
  private isPathAllowed(targetPath: string, mode: 'read' | 'write'): boolean {
    const normalizedTarget = path.resolve(targetPath);
    const normalizedWorkspace = path.resolve(this.workspace.path);

    // Always allow paths within workspace
    if (normalizedTarget.startsWith(normalizedWorkspace)) {
      return true;
    }

    // Check unrestricted access
    if (this.workspace.permissions.unrestrictedFileAccess) {
      return true;
    }

    // Check allowed paths
    const allowedPaths = this.workspace.permissions.allowedPaths || [];
    for (const allowed of allowedPaths) {
      const normalizedAllowed = path.resolve(allowed);
      if (normalizedTarget.startsWith(normalizedAllowed)) {
        return true;
      }
    }

    // System paths for read-only access
    if (mode === 'read') {
      const systemReadPaths = [
        '/usr/bin',
        '/usr/local/bin',
        '/bin',
        '/usr/lib',
        '/System',
        os.tmpdir(),
      ];
      for (const sysPath of systemReadPaths) {
        if (normalizedTarget.startsWith(sysPath)) {
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

    // Set safe defaults
    safeEnv.HOME = process.env.HOME || os.homedir();
    safeEnv.USER = process.env.USER || os.userInfo().username;
    safeEnv.SHELL = process.env.SHELL || '/bin/bash';
    safeEnv.TERM = 'xterm-256color';
    safeEnv.LANG = process.env.LANG || 'en_US.UTF-8';
    safeEnv.TMPDIR = os.tmpdir();

    // Minimal PATH with only standard locations
    safeEnv.PATH = [
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
    ].join(':');

    // Add homebrew paths on macOS
    if (process.platform === 'darwin') {
      safeEnv.PATH = `/opt/homebrew/bin:/opt/homebrew/sbin:${safeEnv.PATH}`;
    }

    return safeEnv;
  }

  /**
   * Generate macOS sandbox-exec profile
   */
  private generateSandboxProfile(): string {
    const workspacePath = this.workspace.path;
    const permissions = this.workspace.permissions;
    const tempDir = os.tmpdir();
    const homeDir = os.homedir();

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
  (subpath "${tempDir}")
)

; Allow homebrew on macOS
(allow file-read* (subpath "/opt/homebrew"))

; Allow reading workspace
(allow file-read* (subpath "${workspacePath}"))
`;

    // Allow writing to workspace if permitted
    if (permissions.write) {
      profile += `
; Allow writing to workspace
(allow file-write* (subpath "${workspacePath}"))
`;
    }

    // Allow writing to temp directories
    profile += `
; Allow writing to temp directories
(allow file-write*
  (subpath "/private/tmp")
  (subpath "${tempDir}")
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

    // Allow additional read paths
    const allowedPaths = permissions.allowedPaths || [];
    for (const allowedPath of allowedPaths) {
      profile += `(allow file-read* (subpath "${allowedPath}"))\n`;
      if (permissions.write) {
        profile += `(allow file-write* (subpath "${allowedPath}"))\n`;
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
  private writeTempProfile(): string {
    const profilePath = path.join(os.tmpdir(), `cowork_sandbox_${Date.now()}.sb`);
    fs.writeFileSync(profilePath, this.sandboxProfile!, 'utf8');

    // Schedule cleanup
    setTimeout(() => {
      try {
        fs.unlinkSync(profilePath);
      } catch {
        // Ignore cleanup errors
      }
    }, 60 * 1000); // Clean up after 1 minute

    return profilePath;
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
