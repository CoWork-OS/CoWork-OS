import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as pty from "node-pty";
import type { ShellSessionInfo } from "../../shared/types";

type TerminalPtyOutputListener = (event: {
  stream: "stdout";
  output: string;
  /** Absolute position in the PTY output stream, measured in UTF-16 code units. */
  offset: number;
  /** First offset after this output chunk, measured in UTF-16 code units. */
  nextOffset: number;
  cwd: string;
  status: ShellSessionInfo["status"];
}) => void;

type TerminalPtyRuntime = {
  info: ShellSessionInfo;
  process: pty.IPty | null;
  listeners: Map<string, TerminalPtyOutputListener>;
  buffer: string;
  /** Absolute number of UTF-16 code units emitted for the lifetime of this tab. */
  outputOffset: number;
  cols: number;
  rows: number;
  closeRequested: boolean;
  cwdParseBuffer: string;
  /** Secret in this tab's shell-integration marks, so command output cannot fake them. */
  markNonce: string;
  /** The task whose code block run opened this tab (TerminalBlockRunner), if one did. */
  codeBlockTaskId?: string;
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

export type TerminalShellIntegration = "zsh" | "bash" | "none";

/** Which shell-integration marks this machine's terminal tabs emit (see buildZshPromptSetup). */
export function getTerminalShellIntegration(): TerminalShellIntegration {
  if (process.platform === "win32") return "none";
  const shellName = path.basename(resolveTerminalShellExecutable());
  if (shellName === "zsh") return "zsh";
  if (shellName === "bash") return "bash";
  return "none";
}

function getTerminalShellArgs(shell: string): string[] {
  if (process.platform === "win32") {
    return shell.toLowerCase().endsWith("cmd.exe") ? ["/Q"] : [];
  }
  return ["-l"];
}

function buildTerminalEnv(markNonce: string): Record<string, string> {
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
  const shellName = getTerminalShellIntegration();
  if (shellName === "zsh") {
    env.ZDOTDIR = ensureTerminalZdotdir();
    env.COWORK_TERMINAL_ZDOTDIR = env.ZDOTDIR;
    env.COWORK_TERMINAL_MARK_NONCE = markNonce;
  } else if (shellName === "bash") {
    const doneMark = buildBashDoneMarkPromptCommand(markNonce);
    env.PROMPT_COMMAND = env.PROMPT_COMMAND ? `${doneMark}; ${env.PROMPT_COMMAND}` : doneMark;
  }
  return env;
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function buildZshSourceLine(filePath: string): string {
  return `[[ -r ${shellSingleQuote(filePath)} ]] && source ${shellSingleQuote(filePath)}\n`;
}

/**
 * Shell-integration marks (OSC 133) let code block runs find where a command's output
 * starts (C) and where it finished, with its exit status (D). Each mark carries the tab's
 * nonce, which the shell takes out of its environment so commands cannot print a valid
 * mark. The done mark runs first among the precmd hooks so it sees the command's status.
 */
function buildZshPromptSetup(): string {
  return [
    "PROMPT='%1~ %# '",
    "PS1=$PROMPT",
    "RPROMPT=''",
    "RPS1=''",
    "function __cowork_terminal_emit_cwd() {",
    '  printf \'\\e]7;file://%s%s\\a\' "$HOST" "${PWD// /%20}"',
    "}",
    "if [[ -n ${COWORK_TERMINAL_MARK_NONCE-} ]]; then",
    "  typeset -g __cowork_mark_nonce=$COWORK_TERMINAL_MARK_NONCE",
    "  unset COWORK_TERMINAL_MARK_NONCE",
    "fi",
    "function __cowork_terminal_mark_start() {",
    "  printf '\\e]133;C;%s\\a' \"$__cowork_mark_nonce\"",
    "}",
    "function __cowork_terminal_mark_done() {",
    "  local exit_status=$?",
    '  printf \'\\e]133;D;%s;%s\\a\' "$__cowork_mark_nonce" "$exit_status"',
    "}",
    "autoload -Uz add-zsh-hook 2>/dev/null",
    "if (( $+functions[add-zsh-hook] )); then",
    "  add-zsh-hook precmd __cowork_terminal_emit_cwd",
    "  add-zsh-hook chpwd __cowork_terminal_emit_cwd",
    "  add-zsh-hook preexec __cowork_terminal_mark_start",
    "fi",
    "precmd_functions=(__cowork_terminal_mark_done ${precmd_functions:#__cowork_terminal_mark_done})",
    "",
  ].join("\n");
}

/**
 * Bash has no preexec hook, so it only reports the done mark, from PROMPT_COMMAND. The
 * first prompt un-exports PROMPT_COMMAND so commands do not see the nonce.
 */
function buildBashDoneMarkPromptCommand(markNonce: string): string {
  return `__cowork_ec=$?; export -n PROMPT_COMMAND 2>/dev/null; printf "\\033]133;D;${markNonce};%s\\007" "$__cowork_ec"; (exit $__cowork_ec)`;
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
    const helperPath = path.join(
      packageRoot,
      "prebuilds",
      `darwin-${process.arch}`,
      "spawn-helper",
    );
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
  let start = next.length - MAX_REPLAY_BUFFER_LENGTH;
  if (
    start > 0 &&
    start < next.length &&
    isHighSurrogate(next.charCodeAt(start - 1)) &&
    isLowSurrogate(next.charCodeAt(start))
  ) {
    start += 1;
  }
  return next.slice(start);
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
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
    /** Set by TerminalBlockRunner: the task whose code block run opens this tab. */
    codeBlockTaskId?: string;
  }): ShellSessionInfo {
    const existingTabs = this.listTabs(params.workspaceId).sort(
      (a, b) => a.updatedAt - b.updatedAt,
    );
    if (existingTabs.length >= MAX_TERMINAL_TABS_PER_WORKSPACE) {
      throw new Error(
        `Terminal tabs are limited to ${MAX_TERMINAL_TABS_PER_WORKSPACE} per workspace.`,
      );
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
      outputOffset: 0,
      cols: params.cols || DEFAULT_COLS,
      rows: params.rows || DEFAULT_ROWS,
      closeRequested: false,
      cwdParseBuffer: "",
      markNonce: crypto.randomBytes(12).toString("hex"),
      ...(params.codeBlockTaskId ? { codeBlockTaskId: params.codeBlockTaskId } : {}),
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

  /** Stop every retained PTY in a workspace after shell capability revocation. */
  stopTabsForWorkspace(workspaceId: string, reason = "Shell access revoked"): number {
    let stopped = 0;
    for (const runtime of this.tabs.values()) {
      if (runtime.info.workspaceId !== workspaceId) continue;
      if (runtime.process) {
        runtime.closeRequested = false;
        runtime.process.kill();
        runtime.process = null;
        stopped += 1;
      }
      this.updateInfo(runtime, {
        status: "inactive",
        lastTerminationReason: "user_stopped",
        lastError: reason,
      });
    }
    return stopped;
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
      const output = runtime.buffer;
      const offset = runtime.outputOffset - runtime.buffer.length;
      const nextOffset = runtime.outputOffset;
      const cwd = runtime.info.cwd;
      const status = runtime.info.status;
      queueMicrotask(() => {
        if (runtime.listeners.get(listenerKey) !== listener) return;
        listener({
          stream: "stdout",
          output,
          offset,
          nextOffset,
          cwd,
          status,
        });
      });
    }
    return { ...runtime.info };
  }

  /** Remove one keyed output subscriber without stopping or changing the PTY. */
  detachTerminalTabOutput(tabId: string, listenerKey: string): boolean {
    return this.tabs.get(tabId)?.listeners.delete(listenerKey) ?? false;
  }

  writeToTab(tabId: string, input: string): ShellSessionInfo {
    const runtime = this.getRuntime(tabId);
    if (!runtime.process) this.spawn(runtime);
    if (input) {
      runtime.process?.write(input);
      this.updateInfo(runtime, {
        status: runtime.info.status === "running" ? "running" : "active",
        commandCount:
          runtime.info.commandCount + (input.includes("\r") || input.includes("\n") ? 1 : 0),
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
    this.updateInfo(runtime, {
      status: runtime.info.status === "inactive" ? "active" : runtime.info.status,
    });
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
      status: "running",
    });
    return { ...runtime.info };
  }

  /** The secret this tab's shell-integration marks carry (see buildZshPromptSetup). */
  getShellMarkNonce(tabId: string): string {
    return this.getRuntime(tabId).markNonce;
  }

  /** Total output the tab has produced so far, in UTF-16 code units (see the listener offsets). */
  getOutputOffset(tabId: string): number {
    return this.getRuntime(tabId).outputOffset;
  }

  /**
   * The tab's recent raw output, escapes included: the same buffer a new window replays.
   * startOffset is where it begins in the tab's output stream; above 0, earlier output
   * was dropped and the first line may be cut.
   */
  getRecentOutput(tabId: string): { output: string; startOffset: number } {
    const runtime = this.getRuntime(tabId);
    return {
      output: runtime.buffer,
      startOffset: runtime.outputOffset - runtime.buffer.length,
    };
  }

  /** The task whose code block run opened the tab, or undefined for a tab the user opened. */
  getCodeBlockTaskId(tabId: string): string | undefined {
    return this.tabs.get(tabId)?.codeBlockTaskId;
  }

  /** Send Ctrl-C to the tab's foreground command, as a user pressing it would. */
  interruptTab(tabId: string): ShellSessionInfo {
    const runtime = this.getRuntime(tabId);
    runtime.process?.write(String.fromCharCode(3));
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
      env: buildTerminalEnv(runtime.markNonce),
    });
    this.updateInfo(runtime, { status: "active" });
    runtime.process.onData((output) => {
      const offset = runtime.outputOffset;
      runtime.outputOffset += output.length;
      runtime.buffer = appendBuffer(runtime.buffer, output);
      this.consumeCwd(runtime, output);
      for (const listener of runtime.listeners.values()) {
        listener({
          stream: "stdout",
          output,
          offset,
          nextOffset: runtime.outputOffset,
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
        this.updateInfo(runtime, { cwd, status: "active" });
      }
    }
    runtime.cwdParseBuffer = text.slice(Math.max(lastMatchEnd, text.length - 512));
  }
}
