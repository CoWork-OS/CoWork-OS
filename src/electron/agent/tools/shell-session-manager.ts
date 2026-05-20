import * as crypto from "crypto";
import * as fs from "fs";
import * as fsPromises from "fs/promises";
import * as path from "path";
import { execFileSync, spawn, type ChildProcess } from "child_process";
import { getUserDataDir } from "../../utils/user-data-dir";
import type {
  CommandTerminationReason,
  ShellSessionInfo,
  ShellSessionLifecycleEvent,
  ShellSessionScope,
  ShellSessionStatus,
} from "../../../shared/types";

type ShellSnapshot = {
  cwd: string;
  env: Record<string, string>;
  aliases: Record<string, string>;
};

type ShellSessionRuntime = {
  info: ShellSessionInfo;
  snapshot: ShellSnapshot;
  process: ChildProcess | null;
  buffer: string;
  ready: boolean;
  busy: boolean;
  pending: Array<{
    commandId: string;
    command: string;
    resolve: (value: ShellCommandResult) => void;
    reject: (reason?: unknown) => void;
    timeout: ReturnType<typeof setTimeout>;
    fallback: boolean;
    cwd?: string;
    onOutput?: (event: { stream: "stdout" | "stderr"; output: string }) => void;
  }>;
  cmdSeq: number;
  exitStatusOverride?: ShellSessionStatus;
  terminalOutputListeners: Map<
    string,
    (event: { stream: "stdout" | "stderr"; output: string }) => void
  >;
};

export interface ShellCommandResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  truncated?: boolean;
  terminationReason?: CommandTerminationReason;
  usedPersistentSession: boolean;
  sessionId?: string;
  sessionEvent?: ShellSessionLifecycleEvent;
}

export interface ShellRunRequest {
  taskId: string;
  workspaceId: string;
  workspacePath: string;
  command: string;
  cwd?: string;
  scope?: ShellSessionScope;
  sessionId?: string;
  timeoutMs: number;
  onOutput?: (event: { stream: "stdout" | "stderr"; output: string }) => void;
  fallbackRunner: () => Promise<Omit<ShellCommandResult, "usedPersistentSession" | "sessionId" | "sessionEvent">>;
}

const STATE_FILE = path.join(getUserDataDir(), "shell-sessions.json");
const COMMAND_TIMEOUT_FALLBACK_MS = 60_000;
const COMMAND_TIMEOUT_MAX_MS = 5 * 60 * 1000;
const TAB_COMMAND_TIMEOUT_MAX_MS = 24 * 60 * 60 * 1000;
const MAX_TERMINAL_TABS_PER_WORKSPACE = 12;

function safeJsonParse<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function normalizePathForShell(value: string): string {
  return value.replace(/\\/g, "/");
}

function quoteForPosixShell(value: string): string {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function terminateProcessTree(child: ChildProcess | null, signal: NodeJS.Signals = "SIGTERM"): void {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { timeout: 5_000 });
      return;
    } catch {
      // Fall through to direct process termination.
    }
  } else {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall through to direct process termination.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Ignore teardown races.
  }
}

function terminatePersistedShellProcess(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { timeout: 5_000 });
    } catch {
      // The previous process may already be gone.
    }
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // The previous process may already be gone.
    }
  }
}

function stripShellControlCodes(text: string): string {
  return String(text || "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/\x1b[@-_][0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b/g, "")
    .replace(/\r/g, "")
    .trim();
}

export function isLikelyInteractiveCommand(command: string): boolean {
  const text = String(command || "").trim().toLowerCase();
  if (!text) return false;
  return /(^|\s)(vim|nvim|nano|less|more|top|htop|ssh|scp|sftp|telnet|ftp|python\s+-i|node\s+-i|mysql|psql|sqlite3|ipython|fzf|man|watch)\b/.test(
    text,
  );
}

function resolveShellExecutable(): string {
  if (process.platform === "win32") {
    const pwsh = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
    if (fs.existsSync(pwsh)) return pwsh;
    const systemRoot = process.env.SystemRoot || "C:\\Windows";
    const powershell = path.join(
      systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    if (fs.existsSync(powershell)) return powershell;
    return process.env.COMSPEC || "cmd.exe";
  }

  if (process.env.SHELL && fs.existsSync(process.env.SHELL)) {
    return process.env.SHELL;
  }
  if (fs.existsSync("/bin/bash")) return "/bin/bash";
  if (fs.existsSync("/bin/zsh")) return "/bin/zsh";
  return "/bin/sh";
}

function resolveTerminalShellExecutable(): string {
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot || "C:\\Windows";
    const cmd = path.join(systemRoot, "System32", "cmd.exe");
    if (fs.existsSync(cmd)) return cmd;
    return process.env.COMSPEC || "cmd.exe";
  }
  if (process.env.SHELL && fs.existsSync(process.env.SHELL)) {
    return process.env.SHELL;
  }
  if (fs.existsSync("/bin/zsh")) return "/bin/zsh";
  if (fs.existsSync("/bin/bash")) return "/bin/bash";
  return "/bin/sh";
}

function getShellArgs(shell: string): string[] {
  if (process.platform === "win32") {
    const lower = shell.toLowerCase();
    if (lower.includes("powershell") || lower.includes("pwsh")) {
      return ["-NoLogo", "-NoProfile"];
    }
    return [];
  }
  // Keep persistent sessions non-interactive so they do not attach to or read
  // from the user's controlling TTY (which can suspend an active dev terminal).
  return [];
}

function getTerminalShellArgs(shell: string): string[] {
  if (process.platform === "win32" && shell.toLowerCase().endsWith("cmd.exe")) {
    return ["/Q"];
  }
  return [];
}

function parseAliasLine(line: string): [string, string] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("alias ")) return null;
  const eqIndex = trimmed.indexOf("=");
  if (eqIndex <= 6) return null;
  const name = trimmed.slice(6, eqIndex).trim();
  const rawValue = trimmed.slice(eqIndex + 1).trim();
  if (!name || !rawValue) return null;
  const unwrapped = rawValue.replace(/^'/, "").replace(/'$/, "");
  return [name, unwrapped];
}

function parseEnvLine(line: string): [string, string] | null {
  const idx = line.indexOf("=");
  if (idx <= 0) return null;
  const key = line.slice(0, idx).trim();
  if (!key) return null;
  return [key, line.slice(idx + 1)];
}

function diffSnapshot(previous: ShellSnapshot, next: ShellSnapshot): {
  cwd: string;
  env: Record<string, string | null>;
  aliases: Record<string, string | null>;
} {
  const env: Record<string, string | null> = {};
  const aliases: Record<string, string | null> = {};

  const envKeys = new Set([...Object.keys(previous.env), ...Object.keys(next.env)]);
  for (const key of envKeys) {
    const prev = previous.env[key];
    const curr = next.env[key];
    if (prev !== curr) {
      env[key] = curr ?? null;
    }
  }

  const aliasKeys = new Set([...Object.keys(previous.aliases), ...Object.keys(next.aliases)]);
  for (const key of aliasKeys) {
    const prev = previous.aliases[key];
    const curr = next.aliases[key];
    if (prev !== curr) {
      aliases[key] = curr ?? null;
    }
  }

  return {
    cwd: next.cwd,
    env,
    aliases,
  };
}

function applyEnvExport(name: string, value: string): string {
  return `export ${name}=${quoteForPosixShell(value)}`;
}

function applyEnvUnset(name: string): string {
  return `unset ${name}`;
}

function applyAliasExport(name: string, value: string): string {
  const escaped = value.replace(/'/g, `'"'"'`);
  return `alias ${name}='${escaped}'`;
}

function buildRehydrateCommands(snapshot: ShellSnapshot): string[] {
  const commands: string[] = [];
  if (snapshot.cwd) {
    commands.push(`cd ${quoteForPosixShell(normalizePathForShell(snapshot.cwd))}`);
  }
  for (const [key, value] of Object.entries(snapshot.env)) {
    if (value == null) {
      commands.push(applyEnvUnset(key));
    } else {
      commands.push(applyEnvExport(key, value));
    }
  }
  for (const [key, value] of Object.entries(snapshot.aliases)) {
    if (value != null) {
      commands.push(applyAliasExport(key, value));
    }
  }
  return commands;
}

function snapshotForPersistence(snapshot: ShellSnapshot): ShellSnapshot {
  return {
    cwd: snapshot.cwd,
    // Do not persist environment values or aliases to disk. They may contain
    // secrets and are not required for safe session recovery.
    env: {},
    aliases: {},
  };
}

export class ShellSessionManager {
  private static instance: ShellSessionManager | null = null;
  private sessions = new Map<string, ShellSessionRuntime>();
  private activeSessionRuns = new Set<string>();
  private stateLoaded = false;

  static getInstance(): ShellSessionManager {
    if (!ShellSessionManager.instance) {
      ShellSessionManager.instance = new ShellSessionManager();
    }
    return ShellSessionManager.instance;
  }

  private constructor() {}

  private async ensureStateLoaded(): Promise<void> {
    if (this.stateLoaded) return;
    this.stateLoaded = true;
    try {
      const raw = await fsPromises.readFile(STATE_FILE, "utf-8");
      const parsed = safeJsonParse<{
        sessions?: Array<{
          id: string;
          taskId: string;
          workspaceId: string;
          scope: ShellSessionScope;
          cwd: string;
          status: ShellSessionStatus;
          retained: boolean;
          commandCount: number;
          aliases: string[];
          envKeys: string[];
          createdAt: number;
          updatedAt: number;
          lastCommandAt?: number;
          lastCommand?: string;
          lastExitCode?: number | null;
          lastTerminationReason?: CommandTerminationReason;
          lastError?: string;
          pid?: number;
          snapshot?: ShellSnapshot;
        }>;
      }>(raw, {});
      for (const session of parsed.sessions || []) {
        if (session.pid) {
          terminatePersistedShellProcess(session.pid);
        }
        const runtime: ShellSessionRuntime = {
          info: {
            id: session.id,
            taskId: session.taskId,
            workspaceId: session.workspaceId,
            scope: session.scope,
            cwd: session.cwd,
            status: session.status,
            retained: session.retained,
            commandCount: session.commandCount,
            aliases: session.aliases || [],
            envKeys: session.envKeys || [],
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            lastCommandAt: session.lastCommandAt,
            lastCommand: session.lastCommand,
            lastExitCode: session.lastExitCode,
            lastTerminationReason: session.lastTerminationReason,
            lastError: session.lastError,
          },
          snapshot: session.snapshot || { cwd: session.cwd, env: {}, aliases: {} },
          process: null,
          buffer: "",
          ready: false,
          busy: false,
          pending: [],
          cmdSeq: 0,
          exitStatusOverride: undefined,
          terminalOutputListeners: new Map(),
        };
        this.sessions.set(session.id, runtime);
      }
    } catch {
      // No persisted state yet.
    }
  }

  private async persistState(): Promise<void> {
    const payload = {
      sessions: Array.from(this.sessions.values()).map((session) => ({
        id: session.info.id,
        taskId: session.info.taskId,
        workspaceId: session.info.workspaceId,
        scope: session.info.scope,
        cwd: session.info.cwd,
        status: session.info.status,
        retained: session.info.retained,
        commandCount: session.info.commandCount,
        aliases: [],
        envKeys: [],
        createdAt: session.info.createdAt,
        updatedAt: session.info.updatedAt,
        lastCommandAt: session.info.lastCommandAt,
        lastCommand: undefined,
        lastExitCode: session.info.lastExitCode,
        lastTerminationReason: session.info.lastTerminationReason,
        lastError: undefined,
        pid: session.process?.pid,
        snapshot: snapshotForPersistence(session.snapshot),
      })),
    };
    await fsPromises.mkdir(path.dirname(STATE_FILE), { recursive: true });
    try {
      await fsPromises.chmod(path.dirname(STATE_FILE), 0o700);
    } catch {
      // Best effort only.
    }
    await fsPromises.writeFile(STATE_FILE, JSON.stringify(payload, null, 2), "utf-8");
    try {
      await fsPromises.chmod(STATE_FILE, 0o600);
    } catch {
      // Best effort only.
    }
  }

  private getSessionKey(taskId: string, workspaceId: string, scope: ShellSessionScope): string {
    return `${scope}:${workspaceId}:${taskId}`;
  }

  private createInfo(params: {
    taskId: string;
    workspaceId: string;
    scope: ShellSessionScope;
    cwd: string;
    id?: string;
  }): ShellSessionInfo {
    const now = Date.now();
    return {
      id: params.id || this.getSessionKey(params.taskId, params.workspaceId, params.scope),
      taskId: params.taskId,
      workspaceId: params.workspaceId,
      scope: params.scope,
      cwd: params.cwd,
      status: "inactive",
      retained: true,
      commandCount: 0,
      aliases: [],
      envKeys: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  private getOrCreateRuntime(params: {
    taskId: string;
    workspaceId: string;
    workspacePath: string;
    scope?: ShellSessionScope;
    id?: string;
  }): ShellSessionRuntime {
    const scope = params.scope || "task";
    const sessionKey = params.id || this.getSessionKey(params.taskId, params.workspaceId, scope);
    let runtime = this.sessions.get(sessionKey);
    if (!runtime) {
      runtime = {
        info: this.createInfo({
          taskId: params.taskId,
          workspaceId: params.workspaceId,
          scope,
          cwd: params.workspacePath,
          id: params.id,
        }),
        snapshot: { cwd: params.workspacePath, env: {}, aliases: {} },
        process: null,
        buffer: "",
        ready: false,
        busy: false,
        pending: [],
        cmdSeq: 0,
        exitStatusOverride: undefined,
        terminalOutputListeners: new Map(),
      };
      this.sessions.set(sessionKey, runtime);
    }
    return runtime;
  }

  private updateRuntimeInfo(runtime: ShellSessionRuntime, patch: Partial<ShellSessionInfo>): void {
    runtime.info = {
      ...runtime.info,
      ...patch,
      updatedAt: Date.now(),
    };
  }

  private async invalidateRuntime(runtime: ShellSessionRuntime, reason: string): Promise<void> {
    const pending = [...runtime.pending];
    runtime.pending = [];

    for (const item of pending) {
      clearTimeout(item.timeout);
      try {
        item.reject(new Error(reason));
      } catch {
        // Ignore duplicate or late rejections.
      }
    }

    const previousCwd = runtime.snapshot.cwd || runtime.info.cwd;
    const processToKill = runtime.process;
    runtime.process = null;
    runtime.ready = false;
    runtime.busy = false;
    runtime.buffer = "";
    runtime.snapshot = {
      cwd: previousCwd,
      env: {},
      aliases: {},
    };
    this.updateRuntimeInfo(runtime, {
      status: "inactive",
      cwd: previousCwd,
      aliases: [],
      envKeys: [],
      lastError: reason,
    });

    runtime.exitStatusOverride = "inactive";
    terminateProcessTree(processToKill);

    await this.persistState();
  }

  private emitTerminalOutput(
    runtime: ShellSessionRuntime,
    event: { stream: "stdout" | "stderr"; output: string },
  ): void {
    if (runtime.terminalOutputListeners.size === 0) return;
    for (const listener of runtime.terminalOutputListeners.values()) {
      try {
        listener(event);
      } catch {
        // Ignore stale renderer listeners.
      }
    }
  }

  private spawnProcess(runtime: ShellSessionRuntime, workspacePath: string): void {
    const isTerminalTab = runtime.info.scope === "tab";
    const shell = isTerminalTab ? resolveTerminalShellExecutable() : resolveShellExecutable();
    const args = isTerminalTab ? getTerminalShellArgs(shell) : getShellArgs(shell);
    const child = spawn(shell, args, {
      cwd: runtime.info.cwd || workspacePath,
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        HOME: process.env.HOME || "",
        SHELL: shell,
        PS1: isTerminalTab ? "\\w % " : "",
        PS2: isTerminalTab ? "> " : "",
        PROMPT_COMMAND: "",
        PROMPT: isTerminalTab ? "$P$G" : "",
        PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        LANG: process.env.LANG || "en_US.UTF-8",
        TERM: process.env.TERM || "xterm-256color",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    runtime.process = child;
    runtime.buffer = "";
    runtime.ready = true;

    child.stdout?.on("data", (chunk: Buffer) => {
      const output = chunk.toString("utf-8");
      if (runtime.pending.length > 0) {
        runtime.buffer += output;
      }
      this.emitTerminalOutput(runtime, { stream: "stdout", output });
      for (const pending of runtime.pending) {
        pending.onOutput?.({ stream: "stdout", output });
      }
      this.tryCompletePending(runtime);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const output = chunk.toString("utf-8");
      if (runtime.pending.length > 0) {
        runtime.buffer += output;
      }
      this.emitTerminalOutput(runtime, { stream: "stderr", output });
      for (const pending of runtime.pending) {
        pending.onOutput?.({ stream: "stderr", output });
      }
      this.tryCompletePending(runtime);
    });

    child.on("exit", (code, signal) => {
      const nextStatus = runtime.exitStatusOverride || "ended";
      runtime.exitStatusOverride = undefined;
      runtime.process = null;
      runtime.ready = false;
      runtime.busy = false;
      this.emitTerminalOutput(runtime, {
        stream: "stderr",
        output: signal ? `\n[terminal exited: ${signal}]\n` : `\n[terminal exited: ${code ?? "unknown"}]\n`,
      });
      this.updateRuntimeInfo(runtime, {
        status: nextStatus,
        retained: true,
        lastExitCode: code,
        lastTerminationReason: signal ? "error" : code === 0 ? "normal" : "error",
      });
      void this.persistState();
    });
  }

  private tryCompletePending(runtime: ShellSessionRuntime): void {
    const currentPending = runtime.pending[0];
    if (!currentPending) return;
    const doneMarker = `__COWORK_DONE__:${currentPending.commandId}:`;
    if (!runtime.buffer.includes(doneMarker)) return;

    const raw = runtime.buffer;
    runtime.buffer = "";
    const parsed = this.parseShellOutput(raw, runtime);
    const diff = diffSnapshot(runtime.snapshot, {
      cwd: parsed.cwd,
      env: parsed.env,
      aliases: parsed.aliases,
    });
    const previousCwd = runtime.info.cwd;
    const nextCommandCount = runtime.info.commandCount + 1;

    runtime.snapshot = {
      cwd: parsed.cwd,
      env: parsed.env,
      aliases: parsed.aliases,
    };
    this.updateRuntimeInfo(runtime, {
      status: "active",
      cwd: parsed.cwd,
      aliases: Object.keys(parsed.aliases),
      envKeys: Object.keys(parsed.env),
      commandCount: nextCommandCount,
      lastCommand: currentPending.command,
      lastCommandAt: Date.now(),
      lastExitCode: parsed.exitCode,
      lastTerminationReason:
        parsed.exitCode === 0 ? "normal" : ("error" as CommandTerminationReason),
      lastError: undefined,
    });

    clearTimeout(currentPending.timeout);
    runtime.pending.shift();
    runtime.busy = false;
    void this.persistState();

    const sessionEvent: ShellSessionLifecycleEvent = {
      action: nextCommandCount <= 1 ? "created" : "updated",
      taskId: runtime.info.taskId,
      workspaceId: runtime.info.workspaceId,
      session: { ...runtime.info },
      commandId: currentPending.commandId,
      reason:
        diff.cwd !== previousCwd
          ? "cwd_changed"
          : Object.keys(diff.env).length > 0 || Object.keys(diff.aliases).length > 0
            ? "state_updated"
            : undefined,
      timestamp: Date.now(),
    };

    currentPending.resolve({
      success: parsed.exitCode === 0,
      stdout: parsed.visible,
      stderr: "",
      exitCode: parsed.exitCode,
      terminationReason: parsed.exitCode === 0 ? "normal" : ("error" as CommandTerminationReason),
      usedPersistentSession: true,
      sessionId: runtime.info.id,
      sessionEvent,
    });
  }

  private async ensureShellReady(runtime: ShellSessionRuntime, workspacePath: string): Promise<void> {
    if (runtime.process && !runtime.process.killed) return;
    this.spawnProcess(runtime, workspacePath);
    if (!runtime.process?.stdin) {
      throw new Error("Unable to start persistent shell session.");
    }

    const rehydrateCommands = buildRehydrateCommands(runtime.snapshot);
    if (rehydrateCommands.length > 0) {
      runtime.process.stdin.write(`${rehydrateCommands.join("\n")}\n`);
    }
  }

  private parseShellOutput(
    raw: string,
    runtime: ShellSessionRuntime,
  ): {
    visible: string;
    cwd: string;
    env: Record<string, string>;
    aliases: Record<string, string>;
    exitCode: number | null;
  } {
    const doneMatch = raw.match(/__COWORK_DONE__:(.+?):(\d+|null)\s*$/m);
    const exitCode = doneMatch
      ? doneMatch[2] === "null"
        ? null
        : Number(doneMatch[2])
      : null;

    const stateStart = raw.indexOf("__COWORK_STATE_START__");
    const stateEnd = raw.indexOf("__COWORK_ENV_END__");
    const visible = stateStart >= 0 ? raw.slice(0, stateStart) : raw;
    const stateBlock = stateStart >= 0 && stateEnd >= 0 ? raw.slice(stateStart, stateEnd) : "";

    let cwd = runtime.snapshot.cwd;
    const env = { ...runtime.snapshot.env };
    const aliases = { ...runtime.snapshot.aliases };

    if (stateBlock) {
      const lines = stateBlock.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const cwdLine =
        lines.find((line) => line.includes("__COWORK_CWD__:")) ||
        lines.find((line) => !line.startsWith("__COWORK_") && line.length > 0);
      if (cwdLine) {
        const cleaned = stripShellControlCodes(cwdLine);
        const cwdMarker = cleaned.match(/__COWORK_CWD__:(.+)$/);
        if (cwdMarker?.[1]) {
          cwd = cwdMarker[1].trim();
        } else {
          const promptSplit = cleaned.match(/%\s*(.+)$/);
          cwd = (promptSplit?.[1] || cleaned).trim();
        }
      }

      const aliasStart = raw.indexOf("__COWORK_ALIASES_START__");
      const aliasEnd = raw.indexOf("__COWORK_ALIASES_END__");
      if (aliasStart >= 0 && aliasEnd >= 0 && aliasEnd > aliasStart) {
        const aliasLines = raw
          .slice(aliasStart + "__COWORK_ALIASES_START__".length, aliasEnd)
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
        const nextAliases: Record<string, string> = {};
        for (const line of aliasLines) {
          const parsed = parseAliasLine(line);
          if (parsed) {
            nextAliases[parsed[0]] = parsed[1];
          }
        }
        for (const key of Object.keys(aliases)) {
          delete aliases[key];
        }
        Object.assign(aliases, nextAliases);
      }

      const envStart = raw.indexOf("__COWORK_ENV_START__");
      if (envStart >= 0 && stateEnd > envStart) {
        const envLines = raw
          .slice(envStart + "__COWORK_ENV_START__".length, stateEnd)
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
        const nextEnv: Record<string, string> = {};
        for (const line of envLines) {
          const parsed = parseEnvLine(line);
          if (parsed) {
            nextEnv[parsed[0]] = parsed[1];
          }
        }
        for (const key of Object.keys(env)) {
          delete env[key];
        }
        Object.assign(env, nextEnv);
      }
    }

    const cleanedVisible = visible
      .replace(/__COWORK_[A-Z_]+__.*/g, "")
      .replace(/^\s+|\s+$/g, "");

    return {
      visible: cleanedVisible,
      cwd,
      env,
      aliases,
      exitCode,
    };
  }

  async runCommand(request: ShellRunRequest): Promise<ShellCommandResult> {
    await this.ensureStateLoaded();

    const session = this.getOrCreateRuntime({
      taskId: request.taskId,
      workspaceId: request.workspaceId,
      workspacePath: request.workspacePath,
      scope: request.scope || "task",
      id: request.sessionId,
    });

    if (session.busy || session.pending.length > 0) {
      throw new Error("Terminal session is already running a command.");
    }
    const runKey = session.info.id;
    if (this.activeSessionRuns.has(runKey)) {
      throw new Error("Terminal session is already running a command.");
    }
    this.activeSessionRuns.add(runKey);

    const commandId = `${session.info.id}:${++session.cmdSeq}`;
    const commandTimeoutMaxMs = request.scope === "tab" ? TAB_COMMAND_TIMEOUT_MAX_MS : COMMAND_TIMEOUT_MAX_MS;
    const commandTimeoutMs = Math.min(Math.max(request.timeoutMs || COMMAND_TIMEOUT_FALLBACK_MS, 1_000), commandTimeoutMaxMs);

    const firstCommand = !session.process || session.process.killed;
    if (firstCommand) {
      this.spawnProcess(session, request.workspacePath);
      this.updateRuntimeInfo(session, {
        status: "active",
        cwd: session.snapshot.cwd || request.workspacePath,
      });
      await this.persistState();
    }

    if (!session.process?.stdin || !session.process.stdout) {
      this.activeSessionRuns.delete(runKey);
      return {
        success: false,
        stdout: "",
        stderr: "Persistent shell unavailable.",
        exitCode: null,
        terminationReason: "error",
        usedPersistentSession: false,
        sessionId: session.info.id,
      };
    }

    const targetCwd = request.cwd
      ? path.isAbsolute(request.cwd)
        ? request.cwd
        : path.resolve(session.snapshot.cwd || request.workspacePath, request.cwd)
      : session.snapshot.cwd || request.workspacePath;
    const heredocMarker = `__COWORK_CMD_${commandId.replace(/[^a-zA-Z0-9]/g, "_")}__`;
    const wrapper = [
      "set +e",
      `cd ${quoteForPosixShell(normalizePathForShell(targetCwd))}`,
      `__COWORK_COMMAND=$(cat <<'${heredocMarker}'`,
      request.command,
      heredocMarker,
      ")",
      "eval \"$__COWORK_COMMAND\"",
      "__cowork_exit_code=$?",
      "printf '\\n__COWORK_STATE_START__\\n'",
      "printf '__COWORK_CWD__:%s\\n' \"$(pwd -P)\"",
      "printf '__COWORK_ALIASES_START__\\n'",
      "alias",
      "printf '__COWORK_ALIASES_END__\\n'",
      "printf '__COWORK_ENV_START__\\n'",
      "env",
      "printf '__COWORK_ENV_END__\\n'",
      `printf '__COWORK_DONE__:%s:%s\\n' ${quoteForPosixShell(commandId)} "$__cowork_exit_code"`,
    ].join("\n");

    const commandPromise = new Promise<ShellCommandResult>((resolve, reject) => {
      session.busy = true;
      const timeout = setTimeout(() => {
        session.busy = false;
        session.pending = session.pending.filter((item) => item.commandId !== commandId);
        void this.invalidateRuntime(session, "Persistent shell command timed out.");
        reject(new Error("Persistent shell command timed out."));
      }, commandTimeoutMs);

      session.pending.push({
        commandId,
        command: request.command,
        timeout,
        fallback: false,
        resolve,
        reject,
        cwd: targetCwd,
        onOutput: request.onOutput,
      });
      session.process!.stdin!.write(`${wrapper}\n`);
      session.process!.stdin!.once("error", (error) => {
        clearTimeout(timeout);
        session.busy = false;
        session.pending = session.pending.filter((item) => item.commandId !== commandId);
        reject(error);
      });
    });
    return commandPromise.finally(() => {
      this.activeSessionRuns.delete(runKey);
    });
  }

  async createTab(params: {
    workspaceId: string;
    workspacePath: string;
    cwd?: string;
    title?: string;
  }): Promise<ShellSessionInfo> {
    await this.ensureStateLoaded();
    const existingTabs = Array.from(this.sessions.values())
      .filter((session) => session.info.workspaceId === params.workspaceId && session.info.scope === "tab")
      .sort((a, b) => a.info.updatedAt - b.info.updatedAt);
    let tabCount = existingTabs.length;
    for (const tab of existingTabs) {
      if (tabCount < MAX_TERMINAL_TABS_PER_WORKSPACE) break;
      if (tab.info.status !== "ended") continue;
      this.sessions.delete(tab.info.id);
      tabCount -= 1;
    }
    if (tabCount >= MAX_TERMINAL_TABS_PER_WORKSPACE) {
      throw new Error(`Terminal tabs are limited to ${MAX_TERMINAL_TABS_PER_WORKSPACE} per workspace.`);
    }
    const now = Date.now();
    const tabToken = `tab-${now}-${crypto.randomUUID().slice(0, 8)}`;
    const cwd = params.cwd
      ? path.isAbsolute(params.cwd)
        ? params.cwd
        : path.resolve(params.workspacePath, params.cwd)
      : params.workspacePath;
    const runtime = this.getOrCreateRuntime({
      taskId: tabToken,
      workspaceId: params.workspaceId,
      workspacePath: cwd,
      scope: "tab",
      id: `tab:${params.workspaceId}:${tabToken}`,
    });
    runtime.info.lastCommand = params.title?.trim() || undefined;
    this.updateRuntimeInfo(runtime, {
      cwd,
      status: "inactive",
      retained: true,
    });
    await this.persistState();
    return { ...runtime.info };
  }

  async listTabs(workspaceId?: string): Promise<ShellSessionInfo[]> {
    await this.ensureStateLoaded();
    return this.listSessions(undefined, workspaceId).filter((session) => session.scope === "tab");
  }

  async runInTab(params: {
    tabId: string;
    workspacePath: string;
    command: string;
    cwd?: string;
    timeoutMs: number;
    onOutput?: (event: { stream: "stdout" | "stderr"; output: string }) => void;
  }): Promise<ShellCommandResult> {
    await this.ensureStateLoaded();
    const runtime = this.sessions.get(params.tabId);
    if (!runtime || runtime.info.scope !== "tab") {
      throw new Error("Terminal tab not found.");
    }
    if (runtime.busy || runtime.pending.length > 0) {
      throw new Error("Terminal session is already running a command.");
    }
    this.updateRuntimeInfo(runtime, { status: "running" });
    return this.runCommand({
      taskId: runtime.info.taskId,
      workspaceId: runtime.info.workspaceId,
      workspacePath: params.workspacePath,
      command: params.command,
      cwd: params.cwd,
      timeoutMs: params.timeoutMs,
      scope: "tab",
      sessionId: params.tabId,
      onOutput: params.onOutput,
      fallbackRunner: async () => ({
        success: false,
        stdout: "",
        stderr: "Terminal tab fallback requested.",
        exitCode: null,
        terminationReason: "error",
        truncated: false,
      }),
    });
  }

  async attachTerminalTabOutput(
    sessionId: string,
    listenerKey: string,
    listener: (event: { stream: "stdout" | "stderr"; output: string }) => void,
    workspacePath?: string,
  ): Promise<ShellSessionInfo> {
    await this.ensureStateLoaded();
    const session = this.sessions.get(sessionId);
    if (!session || session.info.scope !== "tab") {
      throw new Error("Terminal tab not found.");
    }
    session.terminalOutputListeners.set(listenerKey, listener);
    if (!session.process || session.process.killed) {
      this.spawnProcess(session, workspacePath || session.info.cwd);
      this.updateRuntimeInfo(session, { status: "active" });
      await this.persistState();
    }
    return { ...session.info };
  }

  async writeToSession(sessionId: string, input: string): Promise<ShellSessionInfo> {
    await this.ensureStateLoaded();
    if (input.length > 1_000_000) {
      throw new Error("Input exceeds maximum allowed length.");
    }
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error("Terminal session is not running.");
    }
    if (session.info.scope === "tab" && input === "\x03") {
      return (await this.stopSessionById(sessionId)) || { ...session.info };
    }
    if (session.info.scope === "tab" && (!session.process || session.process.killed)) {
      this.spawnProcess(session, session.info.cwd);
      this.updateRuntimeInfo(session, { status: "active" });
    }
    if (!session.process?.stdin) {
      throw new Error("Terminal session is not running.");
    }
    if (input) {
      session.process.stdin.write(input);
    }
    this.updateRuntimeInfo(session, {
      status: session.info.scope === "tab" ? "active" : input ? "running" : "active",
    });
    return { ...session.info };
  }

  async stopSessionById(sessionId: string): Promise<ShellSessionInfo | null> {
    await this.ensureStateLoaded();
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    session.exitStatusOverride = "inactive";
    terminateProcessTree(session.process);
    session.process = null;
    session.ready = false;
    session.busy = false;
    this.activeSessionRuns.delete(session.info.id);
    for (const pending of session.pending) {
      clearTimeout(pending.timeout);
      pending.resolve({
        success: false,
        stdout: "",
        stderr: "Terminal command stopped.",
        exitCode: null,
        terminationReason: "error",
        usedPersistentSession: true,
        sessionId: session.info.id,
      });
    }
    session.pending = [];
    this.updateRuntimeInfo(session, { status: "inactive", lastTerminationReason: "error" });
    await this.persistState();
    return { ...session.info };
  }

  async closeSessionById(sessionId: string): Promise<ShellSessionInfo | null> {
    await this.ensureStateLoaded();
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    for (const pending of session.pending) {
      pending.resolve({ stdout: "", stderr: "", exitCode: null, success: false, usedPersistentSession: true });
    }
    session.pending = [];
    terminateProcessTree(session.process);
    this.activeSessionRuns.delete(session.info.id);
    this.sessions.delete(sessionId);
    await this.persistState();
    return { ...session.info, status: "ended" };
  }

  getSessionInfo(taskId: string, workspaceId: string, scope: ShellSessionScope = "task"): ShellSessionInfo | null {
    const session = this.sessions.get(this.getSessionKey(taskId, workspaceId, scope));
    return session ? { ...session.info } : null;
  }

  listSessions(taskId?: string, workspaceId?: string): ShellSessionInfo[] {
    return Array.from(this.sessions.values())
      .filter((session) => {
        if (taskId && session.info.taskId !== taskId) return false;
        if (workspaceId && session.info.workspaceId !== workspaceId) return false;
        return true;
      })
      .map((session) => ({ ...session.info }));
  }

  async resetSession(taskId: string, workspaceId: string, scope: ShellSessionScope = "task"): Promise<ShellSessionInfo | null> {
    await this.ensureStateLoaded();
    const key = this.getSessionKey(taskId, workspaceId, scope);
    const session = this.sessions.get(key);
    if (!session) return null;

    this.updateRuntimeInfo(session, { status: "resetting" });
    session.process?.kill("SIGTERM");
    session.process = null;
    session.ready = false;
    session.buffer = "";
    session.busy = false;
    session.snapshot = { cwd: session.info.cwd, env: {}, aliases: {} };
    session.info.commandCount = 0;
    session.info.lastCommand = undefined;
    session.info.lastExitCode = undefined;
    session.info.lastTerminationReason = undefined;
    session.info.lastError = undefined;
    this.updateRuntimeInfo(session, { status: "inactive" });
    void this.persistState();
    return { ...session.info };
  }

  async closeSession(taskId: string, workspaceId: string, scope: ShellSessionScope = "task"): Promise<ShellSessionInfo | null> {
    await this.ensureStateLoaded();
    const key = this.getSessionKey(taskId, workspaceId, scope);
    const session = this.sessions.get(key);
    if (!session) return null;

    session.process?.kill("SIGTERM");
    session.process = null;
    this.updateRuntimeInfo(session, { status: "ended" });
    void this.persistState();
    return { ...session.info };
  }
}

export const _testUtils = {
  getShellArgs,
  getTerminalShellArgs,
};
