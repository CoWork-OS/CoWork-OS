import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as pty from "node-pty";
import type { ShellSessionInfo } from "../../shared/types";

type TerminalPtyOutputListener = (event: {
  stream: "stdout";
  output: string;
  cwd: string;
  status: ShellSessionInfo["status"];
}) => void;

type TerminalPtyRuntime = {
  info: ShellSessionInfo;
  process: pty.IPty | null;
  listeners: Map<string, TerminalPtyOutputListener>;
  buffer: string;
  cols: number;
  rows: number;
  closeRequested: boolean;
  cwdParseBuffer: string;
};

const MAX_TERMINAL_TABS_PER_WORKSPACE = 12;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const MAX_REPLAY_BUFFER_LENGTH = 256 * 1024;
const OSC7_PATTERN = /\x1b]7;file:\/\/([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
let nodePtyHelperChecked = false;
let terminalZdotdir: string | null = null;

function resolveTerminalShellExecutable(): string {
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot || "C:\\Windows";
    const cmd = path.join(systemRoot, "System32", "cmd.exe");
    if (fs.existsSync(cmd)) return cmd;
    return process.env.COMSPEC || "cmd.exe";
  }
  if (process.env.SHELL && fs.existsSync(process.env.SHELL)) return process.env.SHELL;
  if (fs.existsSync("/bin/zsh")) return "/bin/zsh";
  if (fs.existsSync("/bin/bash")) return "/bin/bash";
  return "/bin/sh";
}

function getTerminalShellArgs(shell: string): string[] {
  if (process.platform === "win32") {
    return shell.toLowerCase().endsWith("cmd.exe") ? ["/Q"] : [];
  }
  return ["-l"];
}

function buildTerminalEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  delete env.ELECTRON_RUN_AS_NODE;
  env.TERM = env.TERM || "xterm-256color";
  env.COLORTERM = env.COLORTERM || "truecolor";
  env.TERM_PROGRAM = "CoWork OS";
  if (process.platform === "win32") {
    env.PROMPT = "$P$G ";
  } else {
    env.PS1 = "\\W \\$ ";
  }
  if (process.platform !== "win32" && path.basename(resolveTerminalShellExecutable()) === "zsh") {
    env.ZDOTDIR = ensureTerminalZdotdir();
    env.COWORK_TERMINAL_ZDOTDIR = env.ZDOTDIR;
  }
  return env;
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function buildZshSourceLine(filePath: string): string {
  return `[[ -r ${shellSingleQuote(filePath)} ]] && source ${shellSingleQuote(filePath)}\n`;
}

function buildZshPromptSetup(): string {
  return [
    "PROMPT='%1~ %# '",
    "PS1=$PROMPT",
    "RPROMPT=''",
    "RPS1=''",
    "function __cowork_terminal_emit_cwd() {",
    "  printf '\\e]7;file://%s%s\\a' \"$HOST\" \"${PWD// /%20}\"",
    "}",
    "autoload -Uz add-zsh-hook 2>/dev/null",
    "if (( $+functions[add-zsh-hook] )); then",
    "  add-zsh-hook precmd __cowork_terminal_emit_cwd",
    "  add-zsh-hook chpwd __cowork_terminal_emit_cwd",
    "fi",
    "",
  ].join("\n");
}

function ensureTerminalZdotdir(): string {
  if (terminalZdotdir && fs.existsSync(terminalZdotdir)) return terminalZdotdir;
  const home = os.homedir();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-terminal-zsh-"));
  fs.writeFileSync(path.join(dir, ".zshenv"), buildZshSourceLine(path.join(home, ".zshenv")));
  fs.writeFileSync(path.join(dir, ".zprofile"), buildZshSourceLine(path.join(home, ".zprofile")));
  fs.writeFileSync(
    path.join(dir, ".zshrc"),
    `${buildZshSourceLine(path.join(home, ".zshrc"))}\n${buildZshPromptSetup()}`,
  );
  fs.writeFileSync(
    path.join(dir, ".zlogin"),
    `${buildZshSourceLine(path.join(home, ".zlogin"))}\n${buildZshPromptSetup()}`,
  );
  terminalZdotdir = dir;
  return dir;
}

function ensureNodePtySpawnHelperExecutable(): void {
  if (nodePtyHelperChecked || process.platform !== "darwin") return;
  nodePtyHelperChecked = true;
  try {
    const packageRoot = path.dirname(require.resolve("node-pty/package.json"));
    const helperPath = path.join(packageRoot, "prebuilds", `darwin-${process.arch}`, "spawn-helper");
    if (!fs.existsSync(helperPath)) return;
    const stat = fs.statSync(helperPath);
    if ((stat.mode & 0o111) !== 0) return;
    fs.chmodSync(helperPath, stat.mode | 0o755);
  } catch {
    // node-pty will surface the real spawn error if the helper still cannot run.
  }
}

function resolveOsc7Cwd(rawValue: string): string | null {
  const slashIndex = rawValue.indexOf("/");
  if (slashIndex < 0) return null;
  const pathname = rawValue.slice(slashIndex);
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

function appendBuffer(buffer: string, output: string): string {
  const next = `${buffer}${output}`;
  if (next.length <= MAX_REPLAY_BUFFER_LENGTH) return next;
  return next.slice(next.length - MAX_REPLAY_BUFFER_LENGTH);
}

export class TerminalPtyManager {
  private static instance: TerminalPtyManager | null = null;
  private tabs = new Map<string, TerminalPtyRuntime>();

  static getInstance(): TerminalPtyManager {
    if (!TerminalPtyManager.instance) {
      TerminalPtyManager.instance = new TerminalPtyManager();
    }
    return TerminalPtyManager.instance;
  }

  createTab(params: {
    workspaceId: string;
    workspacePath: string;
    cwd?: string;
    title?: string;
    cols?: number;
    rows?: number;
  }): ShellSessionInfo {
    const existingTabs = this.listTabs(params.workspaceId).sort((a, b) => a.updatedAt - b.updatedAt);
    if (existingTabs.length >= MAX_TERMINAL_TABS_PER_WORKSPACE) {
      throw new Error(`Terminal tabs are limited to ${MAX_TERMINAL_TABS_PER_WORKSPACE} per workspace.`);
    }

    const now = Date.now();
    const tabToken = `tab-${now}-${Math.random().toString(16).slice(2, 8)}`;
    const cwd = params.cwd
      ? path.isAbsolute(params.cwd)
        ? params.cwd
        : path.resolve(params.workspacePath, params.cwd)
      : params.workspacePath;
    const info: ShellSessionInfo = {
      id: `tab:${params.workspaceId}:${tabToken}`,
      taskId: tabToken,
      workspaceId: params.workspaceId,
      scope: "tab",
      cwd,
      status: "inactive",
      retained: true,
      commandCount: 0,
      aliases: [],
      envKeys: [],
      createdAt: now,
      updatedAt: now,
      lastCommand: params.title?.trim() || undefined,
    };
    const runtime: TerminalPtyRuntime = {
      info,
      process: null,
      listeners: new Map(),
      buffer: "",
      cols: params.cols || DEFAULT_COLS,
      rows: params.rows || DEFAULT_ROWS,
      closeRequested: false,
      cwdParseBuffer: "",
    };
    this.tabs.set(info.id, runtime);
    this.spawn(runtime);
    return { ...runtime.info };
  }

  listTabs(workspaceId?: string): ShellSessionInfo[] {
    return Array.from(this.tabs.values())
      .filter((runtime) => !workspaceId || runtime.info.workspaceId === workspaceId)
      .map((runtime) => ({ ...runtime.info }));
  }

  attachTerminalTabOutput(
    tabId: string,
    listenerKey: string,
    listener: TerminalPtyOutputListener,
  ): ShellSessionInfo {
    const runtime = this.getRuntime(tabId);
    const listenerAlreadyAttached = runtime.listeners.has(listenerKey);
    runtime.listeners.set(listenerKey, listener);
    if (!runtime.process) this.spawn(runtime);
    if (!listenerAlreadyAttached && runtime.buffer) {
      queueMicrotask(() =>
        listener({
          stream: "stdout",
          output: runtime.buffer,
          cwd: runtime.info.cwd,
          status: runtime.info.status,
        }),
      );
    }
    return { ...runtime.info };
  }

  writeToTab(tabId: string, input: string): ShellSessionInfo {
    const runtime = this.getRuntime(tabId);
    if (!runtime.process) this.spawn(runtime);
    if (input) {
      runtime.process?.write(input);
      this.updateInfo(runtime, {
        status: "active",
        commandCount: runtime.info.commandCount + (input.includes("\r") || input.includes("\n") ? 1 : 0),
      });
    }
    return { ...runtime.info };
  }

  resizeTab(tabId: string, cols: number, rows: number): ShellSessionInfo {
    const runtime = this.getRuntime(tabId);
    const nextCols = Math.max(2, Math.floor(cols || DEFAULT_COLS));
    const nextRows = Math.max(1, Math.floor(rows || DEFAULT_ROWS));
    runtime.cols = nextCols;
    runtime.rows = nextRows;
    runtime.process?.resize(nextCols, nextRows);
    this.updateInfo(runtime, { status: runtime.info.status === "inactive" ? "active" : runtime.info.status });
    return { ...runtime.info };
  }

  stopTab(tabId: string): ShellSessionInfo | null {
    const runtime = this.tabs.get(tabId);
    if (!runtime) return null;
    runtime.closeRequested = false;
    runtime.process?.kill();
    runtime.process = null;
    this.updateInfo(runtime, { status: "inactive" });
    return { ...runtime.info };
  }

  closeTab(tabId: string): ShellSessionInfo | null {
    const runtime = this.tabs.get(tabId);
    if (!runtime) return null;
    runtime.closeRequested = true;
    runtime.process?.kill();
    runtime.listeners.clear();
    this.tabs.delete(tabId);
    this.updateInfo(runtime, { status: "ended" });
    return { ...runtime.info };
  }

  runCommandInTab(tabId: string, command: string): ShellSessionInfo {
    const runtime = this.getRuntime(tabId);
    const input = process.platform === "win32" ? `${command}\r` : `${command}\r`;
    this.writeToTab(tabId, input);
    this.updateInfo(runtime, {
      lastCommand: command,
      lastCommandAt: Date.now(),
      status: "active",
    });
    return { ...runtime.info };
  }

  private getRuntime(tabId: string): TerminalPtyRuntime {
    const runtime = this.tabs.get(tabId);
    if (!runtime) throw new Error("Terminal tab not found.");
    return runtime;
  }

  private spawn(runtime: TerminalPtyRuntime): void {
    ensureNodePtySpawnHelperExecutable();
    const shell = resolveTerminalShellExecutable();
    const args = getTerminalShellArgs(shell);
    runtime.closeRequested = false;
    runtime.process = pty.spawn(shell, args, {
      name: "xterm-256color",
      cols: runtime.cols,
      rows: runtime.rows,
      cwd: runtime.info.cwd,
      env: buildTerminalEnv(),
    });
    this.updateInfo(runtime, { status: "active" });
    runtime.process.onData((output) => {
      runtime.buffer = appendBuffer(runtime.buffer, output);
      this.consumeCwd(runtime, output);
      for (const listener of runtime.listeners.values()) {
        listener({
          stream: "stdout",
          output,
          cwd: runtime.info.cwd,
          status: runtime.info.status,
        });
      }
    });
    runtime.process.onExit(({ exitCode }) => {
      runtime.process = null;
      if (runtime.closeRequested || !this.tabs.has(runtime.info.id)) return;
      this.updateInfo(runtime, {
        status: "ended",
        lastExitCode: typeof exitCode === "number" ? exitCode : null,
      });
    });

  }

  private updateInfo(runtime: TerminalPtyRuntime, patch: Partial<ShellSessionInfo>): void {
    runtime.info = {
      ...runtime.info,
      ...patch,
      updatedAt: Date.now(),
    };
  }

  private consumeCwd(runtime: TerminalPtyRuntime, output: string): void {
    const text = `${runtime.cwdParseBuffer}${output}`;
    let lastMatchEnd = 0;
    for (const match of text.matchAll(OSC7_PATTERN)) {
      lastMatchEnd = (match.index || 0) + match[0].length;
      const cwd = resolveOsc7Cwd(match[1] || "");
      if (cwd) {
        this.updateInfo(runtime, { cwd });
      }
    }
    runtime.cwdParseBuffer = text.slice(Math.max(lastMatchEnd, text.length - 512));
  }
}
