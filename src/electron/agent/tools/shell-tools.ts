import { spawn, ChildProcess, execSync } from "child_process";
import * as path from "path";
import { existsSync } from "fs";
import { Workspace, CommandTerminationReason } from "../../../shared/types";
import { AgentDaemon } from "../daemon";
import { GuardrailManager } from "../../guardrails/guardrail-manager";
import { BuiltinToolsSettingsManager, type RunCommandApprovalMode } from "./builtin-settings";

// Limits to prevent runaway commands
const MAX_TIMEOUT = 5 * 60 * 1000; // 5 minutes max
const DEFAULT_TIMEOUT = 60 * 1000; // 1 minute default
const MAX_OUTPUT_SIZE = 100 * 1024; // 100KB max output

const SHELL_OUTPUT_REDACTION_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  {
    // Solana and similar wallets often print a recovery phrase in this exact format.
    pattern:
      /(Save this seed phrase to recover your new keypair:\s*\n)([a-z]+(?:\s+[a-z]+){11,23})(\s*\n?)/gi,
    replacement: "$1[REDACTED_SEED_PHRASE]$3",
  },
  {
    // Generic "seed phrase:" / "mnemonic:" style output.
    pattern:
      /((?:seed phrase|recovery phrase|mnemonic)[^:\n]{0,40}:\s*\n?)([a-z]+(?:\s+[a-z]+){11,23})(\s*\n?)/gi,
    replacement: "$1[REDACTED_SEED_PHRASE]$3",
  },
  {
    pattern:
      /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z]+)? PRIVATE KEY-----/g,
    replacement: "[REDACTED_PRIVATE_KEY]",
  },
  {
    // Common JSON-secret-key shape (e.g., Solana id.json).
    pattern: /\[(?:\s*\d{1,3}\s*,){31,}\s*\d{1,3}\s*\]/g,
    replacement: "[REDACTED_SECRET_KEY_ARRAY]",
  },
];

/**
 * Validate that a PID is a safe positive integer
 * Prevents command injection if PID is somehow not a number
 */
function isValidPid(pid: unknown): pid is number {
  return typeof pid === "number" && Number.isInteger(pid) && pid > 0 && pid <= 4194304; // Max PID on Linux (can be configured higher, but this is safe default)
}

/**
 * Check if a process with the given PID exists and is owned by the current user
 * Returns false if the process doesn't exist or is owned by another user
 */
function isProcessOwnedByCurrentUser(pid: number): boolean {
  if (!isValidPid(pid)) return false;

  try {
    // Use kill with signal 0 to check if process exists and we have permission to signal it
    // This will throw EPERM if process exists but is owned by another user
    // This will throw ESRCH if process doesn't exist
    process.kill(pid, 0);
    return true;
  } catch (error: Any) {
    // ESRCH = no such process (that's fine, process exited)
    // EPERM = permission denied (process exists but owned by another user - DON'T KILL)
    if (error.code === "EPERM") {
      console.warn(`[ShellTools] Process ${pid} exists but is owned by another user, skipping`);
      return false;
    }
    // Process doesn't exist, that's fine
    return false;
  }
}

/**
 * Validate username for safe use in shell commands
 * Prevents command injection via USER environment variable
 */
function isValidUsername(username: string | undefined): username is string {
  if (!username) return false;
  // Username must be alphanumeric, underscore, or dash (standard POSIX username chars)
  // Max length 32 chars (common limit)
  return /^[a-zA-Z0-9_-]{1,32}$/.test(username);
}

function resolveShellForCommandExecution(): string {
  if (process.platform === "win32") {
    // Prefer PowerShell 7+ (pwsh), then Windows PowerShell, then cmd.exe
    const pwshPath = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
    if (existsSync(pwshPath)) return pwshPath;
    const systemRoot = process.env.SystemRoot || "C:\\Windows";
    const powershellPath = path.join(
      systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    if (existsSync(powershellPath)) return powershellPath;
    return process.env.COMSPEC || "cmd.exe";
  }

  const envShell = process.env.SHELL;
  if (envShell && existsSync(envShell)) return envShell;

  // In minimal Linux containers (e.g., Alpine), /bin/bash may not exist.
  if (existsSync("/bin/bash")) return "/bin/bash";
  if (existsSync("/bin/sh")) return "/bin/sh";

  // Last resort: fall back to whatever is set (even if it doesn't exist).
  return envShell || "/bin/sh";
}

/**
 * Get the shell arguments for running a command string.
 * Unix shells use -c, PowerShell uses -Command, cmd.exe uses /c.
 */
function getShellArgs(shell: string, command: string): string[] {
  if (process.platform === "win32") {
    const lowerShell = shell.toLowerCase();
    if (lowerShell.includes("powershell") || lowerShell.includes("pwsh")) {
      return ["-NoProfile", "-Command", command];
    }
    // cmd.exe
    return ["/c", command];
  }
  return ["-c", command];
}

/**
 * Get all descendant process IDs for a given parent PID.
 * Uses pgrep on Unix, wmic on Windows.
 * Only returns processes owned by the current user for security.
 */
function getDescendantPids(parentPid: number): number[] {
  if (!isValidPid(parentPid)) {
    console.error(`[ShellTools] Invalid parent PID: ${parentPid}`);
    return [];
  }

  if (process.platform === "win32") {
    return getDescendantPidsWindows(parentPid);
  }

  const currentUser = process.env.USER;
  // Validate username to prevent command injection
  const safeUser = isValidUsername(currentUser) ? currentUser : undefined;
  if (currentUser && !safeUser) {
    console.warn(`[ShellTools] Invalid USER env var: ${currentUser}, skipping user filter`);
  }

  const descendants: number[] = [];
  const toProcess: number[] = [parentPid];
  const seen = new Set<number>(); // Prevent infinite loops from circular references

  while (toProcess.length > 0) {
    const pid = toProcess.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);

    try {
      // pgrep -P finds direct children of the given PID
      // Add -U $USER to only find processes owned by current user (security)
      const pgrepCmd = safeUser ? `pgrep -P ${pid} -U ${safeUser}` : `pgrep -P ${pid}`;

      const output = execSync(pgrepCmd, {
        encoding: "utf-8",
        timeout: 1000,
        // Don't inherit env to avoid any injection via environment
        env: { PATH: "/usr/bin:/bin" },
      });

      const childPids = output
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => parseInt(line, 10))
        .filter((childPid) => isValidPid(childPid) && !seen.has(childPid));

      descendants.push(...childPids);
      toProcess.push(...childPids);
    } catch {
      // pgrep returns non-zero if no children found, which is fine
    }
  }

  return descendants;
}

/**
 * Windows-specific: get descendant PIDs using wmic.
 */
function getDescendantPidsWindows(parentPid: number): number[] {
  const descendants: number[] = [];
  const toProcess: number[] = [parentPid];
  const seen = new Set<number>();

  while (toProcess.length > 0) {
    const pid = toProcess.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);

    try {
      // Use PowerShell Get-CimInstance (works on Windows 10+/11) with wmic as fallback
      let output: string;
      try {
        output = execSync(
          `powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process -Filter 'ParentProcessId=${pid}' | Select-Object -ExpandProperty ProcessId"`,
          { encoding: "utf-8", timeout: 5000 },
        );
      } catch {
        // Fallback to wmic for older Windows versions
        output = execSync(
          `wmic process where (ParentProcessId=${pid}) get ProcessId /format:csv`,
          { encoding: "utf-8", timeout: 3000 },
        );
      }
      const childPids = output
        .split("\n")
        .map((line) => {
          const trimmed = line.trim();
          // Handle both PowerShell output (plain numbers) and wmic CSV (Node,PID)
          if (trimmed.includes(",")) {
            const parts = trimmed.split(",");
            return parts[parts.length - 1];
          }
          return trimmed;
        })
        .filter(Boolean)
        .map((s) => parseInt(s!, 10))
        .filter((p) => isValidPid(p) && !seen.has(p));

      descendants.push(...childPids);
      toProcess.push(...childPids);
    } catch {
      // No children found or process enumeration failed
    }
  }

  return descendants;
}

/**
 * Kill a process and all its descendants
 * Sends the signal to children first, then to the parent (bottom-up killing)
 * Only kills processes owned by the current user for security
 */
function killProcessTree(pid: number, signal: NodeJS.Signals): void {
  if (!isValidPid(pid)) {
    console.error(`[ShellTools] Refusing to kill invalid PID: ${pid}`);
    return;
  }

  // On Windows, use taskkill for tree kill (POSIX signals don't apply)
  if (process.platform === "win32") {
    try {
      execSync(`taskkill /PID ${pid} /T /F`, { timeout: 5000 });
    } catch {
      // Process may have already exited
    }
    return;
  }

  const descendants = getDescendantPids(pid);

  // Kill descendants first (in reverse order, deepest children first)
  for (const descendantPid of descendants.reverse()) {
    // Double-check ownership before killing each process
    if (isProcessOwnedByCurrentUser(descendantPid)) {
      try {
        process.kill(descendantPid, signal);
      } catch {
        // Process may have already exited
      }
    }
  }

  // Kill the parent process (also verify ownership)
  if (isProcessOwnedByCurrentUser(pid)) {
    try {
      process.kill(pid, signal);
    } catch {
      // Process may have already exited
    }
  }
}

/**
 * ShellTools implements shell command execution with user approval
 */
export class ShellTools {
  private readonly recentApprovals = new Map<string, { approvedAt: number; count: number }>();
  private readonly approvalWindowMs = 2 * 60 * 1000;
  private readonly bundleApprovalWindowMs = 10 * 60 * 1000;
  private bundleApproval: { approvedAt: number; count: number } | null = null;
  // Track the currently running child process for stdin support
  private activeProcess: ChildProcess | null = null;
  // Track escalation timeouts so we can cancel them when process exits
  private escalationTimeouts: ReturnType<typeof setTimeout>[] = [];
  // Prevent multiple concurrent kill attempts
  private killInProgress = false;
  // Unique identifier for the current process session (prevents PID reuse issues)
  private processSessionId = 0;
  // Track user-initiated kills to signal termination reason to agent
  private userKillRequested = false;

  constructor(
    private workspace: Workspace,
    private daemon: AgentDaemon,
    private taskId: string,
  ) {}

  /**
   * Update the workspace for this tool
   */
  setWorkspace(workspace: Workspace): void {
    this.workspace = workspace;
  }

  /**
   * Clear all pending escalation timeouts
   * Called when process exits to prevent killing reused PIDs
   */
  private clearEscalationTimeouts(): void {
    for (const timeout of this.escalationTimeouts) {
      clearTimeout(timeout);
    }
    this.escalationTimeouts = [];
    this.killInProgress = false;
  }

  /**
   * Send input to the currently running command's stdin
   */
  sendStdin(input: string): boolean {
    if (!this.activeProcess || !this.activeProcess.stdin || this.activeProcess.killed) {
      return false;
    }
    try {
      this.activeProcess.stdin.write(input);
      // Echo the input to show it was sent
      this.daemon.logEvent(this.taskId, "command_output", {
        type: "stdin",
        output: input,
      });
      return true;
    } catch (error) {
      console.error("Failed to write to stdin:", error);
      return false;
    }
  }

  /**
   * Check if a command is currently running
   */
  hasActiveProcess(): boolean {
    return this.activeProcess !== null && !this.activeProcess.killed;
  }

  /**
   * Kill the currently running command and all its child processes
   * @param force - If true, send SIGKILL immediately. Otherwise, try SIGINT first, then SIGTERM, then SIGKILL.
   */
  killProcess(force: boolean = false): boolean {
    if (!this.activeProcess || this.activeProcess.killed) {
      return false;
    }

    const pid = this.activeProcess.pid;
    if (!isValidPid(pid)) {
      console.error(`[ShellTools] Invalid PID for kill: ${pid}`);
      return false;
    }

    // Prevent multiple concurrent kill chains (security: avoid race conditions)
    if (this.killInProgress && !force) {
      console.log(`[ShellTools] Kill already in progress, ignoring duplicate request`);
      return true; // Return true since a kill is already underway
    }

    // Capture session ID to verify we're killing the right process in escalation timeouts
    const currentSessionId = this.processSessionId;

    // Mark this as a user-initiated kill so the close handler can signal the agent
    this.userKillRequested = true;

    if (force) {
      // Force kill - immediate SIGKILL to entire process tree
      // Clear any pending escalation timeouts first
      this.clearEscalationTimeouts();

      try {
        killProcessTree(pid, "SIGKILL");
        this.daemon.logEvent(this.taskId, "command_output", {
          type: "error",
          output: "\n[Process tree force killed by user]\n",
        });
        return true;
      } catch (error) {
        console.error("Failed to force kill process tree:", error);
        return false;
      }
    }

    // Mark kill as in progress to prevent duplicate escalation chains
    this.killInProgress = true;

    try {
      // Send SIGINT (Ctrl+C) to gracefully interrupt the process tree
      killProcessTree(pid, "SIGINT");
      this.daemon.logEvent(this.taskId, "command_output", {
        type: "error",
        output: "\n^C [Process tree interrupted by user]\n",
      });

      // Set up escalation: if still running after 2s, send SIGTERM to tree
      // If still running after 4s, send SIGKILL to tree
      // These timeouts are tracked so they can be cancelled if process exits
      const childProcess = this.activeProcess;

      const sigtermTimeout = setTimeout(() => {
        // Verify this is still the same process session (prevents PID reuse attacks)
        if (currentSessionId !== this.processSessionId) {
          console.log(`[ShellTools] Session ID mismatch, skipping SIGTERM escalation`);
          return;
        }
        if (childProcess && !childProcess.killed && childProcess.pid === pid) {
          // Additional safety: verify we own this process before killing
          if (!isProcessOwnedByCurrentUser(pid)) {
            console.warn(
              `[ShellTools] Process ${pid} no longer owned by current user, skipping SIGTERM`,
            );
            return;
          }
          try {
            killProcessTree(pid, "SIGTERM");
            this.daemon.logEvent(this.taskId, "command_output", {
              type: "error",
              output: "[Escalating to SIGTERM for process tree...]\n",
            });
          } catch {
            /* Process may have exited */
          }
        }
      }, 2000);
      this.escalationTimeouts.push(sigtermTimeout);

      const sigkillTimeout = setTimeout(() => {
        // Verify this is still the same process session (prevents PID reuse attacks)
        if (currentSessionId !== this.processSessionId) {
          console.log(`[ShellTools] Session ID mismatch, skipping SIGKILL escalation`);
          return;
        }
        if (childProcess && !childProcess.killed && childProcess.pid === pid) {
          // Additional safety: verify we own this process before killing
          if (!isProcessOwnedByCurrentUser(pid)) {
            console.warn(
              `[ShellTools] Process ${pid} no longer owned by current user, skipping SIGKILL`,
            );
            return;
          }
          try {
            killProcessTree(pid, "SIGKILL");
            this.daemon.logEvent(this.taskId, "command_output", {
              type: "error",
              output: "[Escalating to SIGKILL for process tree...]\n",
            });
          } catch {
            /* Process may have exited */
          }
        }
      }, 4000);
      this.escalationTimeouts.push(sigkillTimeout);

      return true;
    } catch (error) {
      console.error("Failed to kill process tree:", error);
      this.killInProgress = false;

      // Try SIGTERM as fallback
      try {
        killProcessTree(pid, "SIGTERM");
        return true;
      } catch {
        // Last resort: SIGKILL
        try {
          killProcessTree(pid, "SIGKILL");
          return true;
        } catch {
          return false;
        }
      }
    }
  }

  /**
   * Execute a shell command (requires user approval unless auto-approve is enabled)
   * Note: We don't check workspace.permissions.shell here because
   * shell commands are gated by approval flow (or auto-approve/trust settings)
   */
  async runCommand(
    command: string,
    options?: {
      cwd?: string;
      timeout?: number;
      env?: Record<string, string>;
    },
  ): Promise<{
    success: boolean;
    stdout: string;
    stderr: string;
    exitCode: number | null;
    truncated?: boolean;
    terminationReason?: CommandTerminationReason;
  }> {
    // Check if command is blocked by guardrails BEFORE anything else
    const blockCheck = GuardrailManager.isCommandBlocked(command);
    if (blockCheck.blocked) {
      throw new Error(
        `Command blocked by guardrails: "${command}"\n` +
          `Matched pattern: ${blockCheck.pattern}\n` +
          `This command has been blocked for safety. You can modify blocked patterns in Settings > Guardrails.`,
      );
    }

    // Check if command is trusted (auto-approve without user confirmation)
    const trustCheck = GuardrailManager.isCommandTrusted(command);
    const autoApproveEnabled = BuiltinToolsSettingsManager.getToolAutoApprove("run_command");
    const approvalMode: RunCommandApprovalMode =
      BuiltinToolsSettingsManager.getRunCommandApprovalMode();
    const safeForAutoApproval = this.isAutoApprovalSafe(command);
    const bundleEligible = approvalMode === "single_bundle" && safeForAutoApproval;
    let approved = false;
    const signature = this.getCommandSignature(command);
    const now = Date.now();

    if (bundleEligible && this.isBundleApprovalActive(now)) {
      approved = true;
      this.recordBundleApproval(now);
      this.daemon.logEvent(this.taskId, "log", {
        message: `Auto-approved command via single bundle (${this.bundleApproval?.count || 1} approved in current bundle)`,
        command,
      });
    } else if (autoApproveEnabled && safeForAutoApproval) {
      approved = true;
      this.daemon.logEvent(this.taskId, "log", {
        message: "Auto-approved command (user setting enabled)",
        command,
      });
    } else if (trustCheck.trusted) {
      // Auto-approve trusted commands
      approved = true;
      this.daemon.logEvent(this.taskId, "log", {
        message: `Auto-approved trusted command (matched: ${trustCheck.pattern})`,
        command,
      });
    } else {
      const previousApproval = signature ? this.recentApprovals.get(signature) : undefined;

      if (
        signature &&
        previousApproval &&
        now - previousApproval.approvedAt <= this.approvalWindowMs &&
        safeForAutoApproval
      ) {
        approved = true;
        previousApproval.count += 1;
        previousApproval.approvedAt = now;
        this.recentApprovals.set(signature, previousApproval);
        this.daemon.logEvent(this.taskId, "log", {
          message: `Auto-approved similar command (approved ${previousApproval.count}x in last ${Math.round(this.approvalWindowMs / 1000)}s)`,
          command,
        });
      } else {
        // Request user approval before executing
        approved = await this.daemon.requestApproval(
          this.taskId,
          "run_command",
          bundleEligible
            ? `Run command (single approval bundle for this task): ${command}`
            : `Run command: ${command}`,
          {
            command,
            cwd: options?.cwd || this.workspace.path,
            timeout: options?.timeout || DEFAULT_TIMEOUT,
            approvalMode,
            bundleScope: bundleEligible ? "safe_commands_in_this_task" : undefined,
          },
        );

        if (approved && signature) {
          this.recentApprovals.set(signature, { approvedAt: now, count: 1 });
        }
        if (approved && bundleEligible) {
          this.recordBundleApproval(now);
          this.daemon.logEvent(this.taskId, "log", {
            message: "Single approval bundle activated for safe shell commands in this task",
            command,
          });
        }
      }
    }

    if (!approved) {
      throw new Error("User denied command execution");
    }

    // Log the command execution attempt
    this.daemon.logEvent(this.taskId, "tool_call", {
      tool: "run_command",
      command,
      cwd: options?.cwd || this.workspace.path,
    });

    const timeout = Math.min(options?.timeout || DEFAULT_TIMEOUT, MAX_TIMEOUT);

    // Create a minimal, safe environment (don't leak sensitive process.env vars like API keys)
    const resolvedShell = resolveShellForCommandExecution();
    const safeEnv: Record<string, string> =
      process.platform === "win32"
        ? {
            PATH: process.env.PATH || "",
            USERPROFILE: process.env.USERPROFILE || "",
            USERNAME: process.env.USERNAME || "",
            HOMEDRIVE: process.env.HOMEDRIVE || "C:",
            HOMEPATH: process.env.HOMEPATH || "\\Users\\" + (process.env.USERNAME || ""),
            TEMP: process.env.TEMP || process.env.TMP || "C:\\Windows\\Temp",
            TMP: process.env.TMP || process.env.TEMP || "C:\\Windows\\Temp",
            SystemRoot: process.env.SystemRoot || "C:\\Windows",
            COMSPEC: process.env.COMSPEC || "C:\\Windows\\System32\\cmd.exe",
            ...options?.env,
          }
        : {
            // Essential system variables only (Unix/macOS)
            PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
            HOME: process.env.HOME || "",
            USER: process.env.USER || "",
            SHELL: resolvedShell,
            LANG: process.env.LANG || "en_US.UTF-8",
            TERM: process.env.TERM || "xterm-256color",
            TMPDIR: process.env.TMPDIR || "/tmp",
            ...options?.env,
          };

    const cwd = options?.cwd || this.workspace.path;

    // Emit the command being executed
    this.daemon.logEvent(this.taskId, "command_output", {
      command,
      cwd,
      type: "start",
      output: `$ ${command}\n`,
    });

    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let killed = false;

      // Increment session ID to invalidate any pending escalation timeouts from previous commands
      this.processSessionId++;
      // Clear any leftover escalation timeouts from previous commands
      this.clearEscalationTimeouts();

      // Use a shell to handle complex commands with pipes, redirects, etc.
      const child = spawn(resolvedShell, getShellArgs(resolvedShell, command), {
        cwd,
        env: safeEnv,
        stdio: ["pipe", "pipe", "pipe"], // Enable stdin for interactive commands
      });

      // Store reference to active process for stdin support
      this.activeProcess = child;

      // Set timeout
      const timeoutId = setTimeout(() => {
        killed = true;
        child.kill("SIGTERM");
        this.daemon.logEvent(this.taskId, "command_output", {
          command,
          type: "error",
          output: `\n[Command timed out after ${timeout / 1000}s]\n`,
        });
      }, timeout);

      // Stream stdout
      child.stdout.on("data", (data: Buffer) => {
        const chunk = this.sanitizeCommandOutput(data.toString("utf-8"));
        stdout += chunk;
        // Emit live output
        this.daemon.logEvent(this.taskId, "command_output", {
          command,
          type: "stdout",
          output: chunk,
        });
      });

      // Stream stderr
      child.stderr.on("data", (data: Buffer) => {
        const chunk = this.sanitizeCommandOutput(data.toString("utf-8"));
        stderr += chunk;
        // Emit live output
        this.daemon.logEvent(this.taskId, "command_output", {
          command,
          type: "stderr",
          output: chunk,
        });
      });

      child.on("close", (code: number | null) => {
        clearTimeout(timeoutId);
        this.activeProcess = null; // Clear active process reference
        // Clear any pending escalation timeouts to prevent killing reused PIDs
        this.clearEscalationTimeouts();

        // Determine termination reason to signal the agent
        let terminationReason: CommandTerminationReason = "normal";
        if (this.userKillRequested) {
          terminationReason = "user_stopped";
        } else if (killed) {
          terminationReason = "timeout";
        }

        // Reset for next command
        this.userKillRequested = false;

        const success = terminationReason === "normal" && code === 0;
        const truncatedStdout = this.truncateOutput(stdout);
        const truncatedStderr = this.truncateOutput(stderr);
        const exitCodeLabel = code === null ? "unknown" : String(code);
        const errorMessage =
          terminationReason === "timeout"
            ? "Command timed out"
            : terminationReason === "user_stopped"
              ? "Command stopped by user"
              : !success
                ? `Command exited with code ${exitCodeLabel}`
                : undefined;

        // Emit command completion with termination reason
        this.daemon.logEvent(this.taskId, "command_output", {
          command,
          type: "end",
          exitCode: code,
          success,
          terminationReason,
        });

        this.daemon.logEvent(this.taskId, "tool_result", {
          tool: "run_command",
          success,
          exitCode: code,
          terminationReason,
          error: errorMessage,
        });

        resolve({
          success,
          stdout: this.sanitizeCommandOutput(truncatedStdout),
          stderr: this.sanitizeCommandOutput(truncatedStderr),
          exitCode: code,
          truncated: stdout.length > MAX_OUTPUT_SIZE || stderr.length > MAX_OUTPUT_SIZE,
          terminationReason,
        });
      });

      child.on("error", (error: Error) => {
        clearTimeout(timeoutId);
        this.activeProcess = null; // Clear active process reference
        // Clear any pending escalation timeouts to prevent killing reused PIDs
        this.clearEscalationTimeouts();
        // Reset user kill flag
        this.userKillRequested = false;

        const terminationReason: CommandTerminationReason = "error";

        this.daemon.logEvent(this.taskId, "command_output", {
          command,
          type: "error",
          output: `\n[Error: ${error.message}]\n`,
          terminationReason,
        });

        this.daemon.logEvent(this.taskId, "tool_result", {
          tool: "run_command",
          success: false,
          error: error.message,
          terminationReason,
        });

        resolve({
          success: false,
          stdout: this.sanitizeCommandOutput(this.truncateOutput(stdout)),
          stderr: this.sanitizeCommandOutput(error.message),
          exitCode: null,
          terminationReason,
        });
      });
    });
  }

  /**
   * Generate a normalized signature for a command to detect similar repeats
   */
  private getCommandSignature(command: string): string {
    if (!command) return "";
    let signature = command.trim();
    signature = signature.replace(/\s+/g, " ");
    signature = signature.replace(/"(?:[^"\\]|\\.)*"/g, '"<arg>"');
    signature = signature.replace(/'(?:[^'\\]|\\.)*'/g, "'<arg>'");
    signature = signature.replace(/(?:\/Users\/[^\s]+|~\/[^\s]+|\/[^\s]+)/g, "<path>");
    signature = signature.replace(/\b\d+(?:\.\d+)?\b/g, "<num>");
    signature = signature.replace(/\b[A-Za-z0-9_-]{20,}\b/g, "<id>");
    return signature;
  }

  /**
   * Safety check for auto-approving similar commands
   */
  private isAutoApprovalSafe(command: string): boolean {
    return !/(^|\s)(sudo|rm|dd|mkfs|diskutil|shutdown|reboot|killall)\b/i.test(command);
  }

  /**
   * Whether an approval bundle is still active for this task.
   */
  private isBundleApprovalActive(now: number): boolean {
    return Boolean(
      this.bundleApproval && now - this.bundleApproval.approvedAt <= this.bundleApprovalWindowMs,
    );
  }

  /**
   * Refresh bundle approval bookkeeping.
   */
  private recordBundleApproval(now: number): void {
    if (
      this.bundleApproval &&
      now - this.bundleApproval.approvedAt <= this.bundleApprovalWindowMs
    ) {
      this.bundleApproval.approvedAt = now;
      this.bundleApproval.count += 1;
      return;
    }
    this.bundleApproval = { approvedAt: now, count: 1 };
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

  /**
   * Redact sensitive output before it reaches task logs or model context.
   */
  private sanitizeCommandOutput(output: string): string {
    if (!output) return "";
    let sanitized = output;
    for (const { pattern, replacement } of SHELL_OUTPUT_REDACTION_PATTERNS) {
      sanitized = sanitized.replace(pattern, replacement);
    }
    return sanitized;
  }
}

// Export validation functions for testing
export const _testUtils = {
  isValidPid,
  isValidUsername,
  isProcessOwnedByCurrentUser,
  getDescendantPids,
  killProcessTree,
};
