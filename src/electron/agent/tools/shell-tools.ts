import { exec, ExecOptions } from 'child_process';
import { promisify } from 'util';
import { Workspace } from '../../../shared/types';
import { AgentDaemon } from '../daemon';

const execAsync = promisify(exec);

// Limits to prevent runaway commands
const MAX_TIMEOUT = 5 * 60 * 1000; // 5 minutes max
const DEFAULT_TIMEOUT = 60 * 1000; // 1 minute default
const MAX_OUTPUT_SIZE = 100 * 1024; // 100KB max output

/**
 * ShellTools implements shell command execution with user approval
 */
export class ShellTools {
  constructor(
    private workspace: Workspace,
    private daemon: AgentDaemon,
    private taskId: string
  ) {}

  /**
   * Check if shell execution is allowed
   */
  private checkPermission(): void {
    if (!this.workspace.permissions.shell) {
      throw new Error('Shell execution permission not granted for this workspace');
    }
  }

  /**
   * Execute a shell command (requires user approval)
   */
  async runCommand(
    command: string,
    options?: {
      cwd?: string;
      timeout?: number;
      env?: Record<string, string>;
    }
  ): Promise<{
    success: boolean;
    stdout: string;
    stderr: string;
    exitCode: number | null;
    truncated?: boolean;
  }> {
    this.checkPermission();

    // Request user approval before executing
    const approved = await this.daemon.requestApproval(
      this.taskId,
      'run_command',
      `Run command: ${command}`,
      {
        command,
        cwd: options?.cwd || this.workspace.path,
        timeout: options?.timeout || DEFAULT_TIMEOUT,
      }
    );

    if (!approved) {
      throw new Error('User denied command execution');
    }

    // Log the command execution attempt
    this.daemon.logEvent(this.taskId, 'tool_call', {
      tool: 'run_command',
      command,
      cwd: options?.cwd || this.workspace.path,
    });

    const timeout = Math.min(options?.timeout || DEFAULT_TIMEOUT, MAX_TIMEOUT);

    // Create a minimal, safe environment (don't leak sensitive process.env vars like API keys)
    const safeEnv: Record<string, string> = {
      // Essential system variables only
      PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: process.env.HOME || '',
      USER: process.env.USER || '',
      SHELL: process.env.SHELL || '/bin/bash',
      LANG: process.env.LANG || 'en_US.UTF-8',
      TERM: process.env.TERM || 'xterm-256color',
      TMPDIR: process.env.TMPDIR || '/tmp',
      // Add any user-provided env vars (explicitly passed by caller)
      ...options?.env,
    };

    const execOptions: ExecOptions = {
      cwd: options?.cwd || this.workspace.path,
      timeout,
      maxBuffer: MAX_OUTPUT_SIZE,
      encoding: 'utf-8',
      env: safeEnv,
    };

    try {
      const { stdout, stderr } = await execAsync(command, execOptions);

      // Convert to string (execAsync may return Buffer or string)
      const stdoutStr = typeof stdout === 'string' ? stdout : stdout.toString('utf-8');
      const stderrStr = typeof stderr === 'string' ? stderr : stderr.toString('utf-8');

      const result = {
        success: true,
        stdout: this.truncateOutput(stdoutStr),
        stderr: this.truncateOutput(stderrStr),
        exitCode: 0,
        truncated: stdoutStr.length > MAX_OUTPUT_SIZE || stderrStr.length > MAX_OUTPUT_SIZE,
      };

      this.daemon.logEvent(this.taskId, 'tool_result', {
        tool: 'run_command',
        success: true,
        exitCode: 0,
      });

      return result;
    } catch (error: any) {
      // exec throws on non-zero exit codes
      // Convert potential Buffers to strings
      const errorStdout = error.stdout
        ? typeof error.stdout === 'string' ? error.stdout : error.stdout.toString('utf-8')
        : '';
      const errorStderr = error.stderr
        ? typeof error.stderr === 'string' ? error.stderr : error.stderr.toString('utf-8')
        : error.message;

      const result = {
        success: false,
        stdout: this.truncateOutput(errorStdout),
        stderr: this.truncateOutput(errorStderr),
        exitCode: error.code ?? null,
        truncated:
          errorStdout.length > MAX_OUTPUT_SIZE ||
          errorStderr.length > MAX_OUTPUT_SIZE,
      };

      this.daemon.logEvent(this.taskId, 'tool_result', {
        tool: 'run_command',
        success: false,
        exitCode: error.code,
        error: error.message,
      });

      return result;
    }
  }

  /**
   * Truncate output to prevent context overflow
   */
  private truncateOutput(output: string): string {
    if (output.length <= MAX_OUTPUT_SIZE) {
      return output;
    }
    return (
      output.slice(0, MAX_OUTPUT_SIZE) +
      `\n\n[... Output truncated. Showing first ${Math.round(MAX_OUTPUT_SIZE / 1024)}KB ...]`
    );
  }
}
