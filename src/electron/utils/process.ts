/**
 * Process Utilities
 *
 * Helper functions for executing external commands.
 */

import { spawn, exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunCommandOptions {
  timeoutMs?: number;
  cwd?: string;
  env?: Record<string, string>;
}

/**
 * Check if a binary exists in PATH
 */
export async function checkBinaryExists(binary: string): Promise<boolean> {
  try {
    const command = process.platform === "win32" ? `where ${binary}` : `which ${binary}`;
    await execAsync(command);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run a command with timeout
 */
export async function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions = {},
): Promise<CommandResult> {
  const { timeoutMs = 30_000, cwd, env } = options;

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let resolved = false;

    const child = spawn(command, args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timeout = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      child.kill("SIGKILL");
      resolve({
        code: -1,
        stdout,
        stderr: stderr || "Command timed out",
      });
    }, timeoutMs);

    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("error", (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      resolve({
        code: -1,
        stdout,
        stderr: err.message,
      });
    });

    child.on("exit", (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      resolve({
        code: code ?? -1,
        stdout,
        stderr,
      });
    });
  });
}

/**
 * Run a shell command (with shell expansion)
 */
export async function runShellCommand(
  command: string,
  options: RunCommandOptions = {},
): Promise<CommandResult> {
  const { timeoutMs = 30_000, cwd, env } = options;

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      timeout: timeoutMs,
    });
    return { code: 0, stdout, stderr };
  } catch (error: Any) {
    return {
      code: error.code ?? -1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? error.message ?? String(error),
    };
  }
}
