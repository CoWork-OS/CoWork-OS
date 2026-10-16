import { createContext, useContext, useSyncExternalStore } from "react";
import type { TerminalBlockRunResult } from "../../shared/types";

/**
 * Runs of shell code blocks from assistant answers. Each block has a stable key (its
 * message and position), so its output stays under it while the feed re-renders,
 * scrolls, or the user switches conversations and comes back.
 */

export type CodeBlockRunStatus = "running" | "done" | "stopped" | "error";

export type CodeBlockRunState = {
  runId: string;
  command: string;
  status: CodeBlockRunStatus;
  /** Raw terminal output, escapes included. */
  output: string;
  tabId?: string;
  exitCode?: number | null;
  error?: string;
};

/** What a code block needs to run its command and hand the output to the agent. */
export type CodeBlockRunTarget = {
  taskId: string;
  workspaceId: string;
  /** Sends the finished run's output to the conversation. */
  sendOutput: (command: string, result: TerminalBlockRunResult) => void | Promise<void>;
  /** Opens the terminal panel on the tab the command ran in. */
  openTerminalTab?: (tabId: string) => void;
};

/** Window event that asks the app to open the terminal panel on a tab. */
export const OPEN_TERMINAL_TAB_EVENT = "cowork:open-terminal-tab";
export type OpenTerminalTabRequest = { tabId: string };

/** The run target and the key prefix for code blocks in one rendered message segment. */
export type CodeBlockRunScope = { target: CodeBlockRunTarget; keyPrefix: string };

export const CodeBlockRunScopeContext = createContext<CodeBlockRunScope | null>(null);

export function useCodeBlockRunScope(): CodeBlockRunScope | null {
  return useContext(CodeBlockRunScopeContext);
}

const SHELL_LANGUAGES = new Set(["bash", "sh", "shell", "zsh", "shellscript", "shell-session"]);

export function isRunnableShellLanguage(language: string): boolean {
  return SHELL_LANGUAGES.has(language.toLowerCase());
}

/** The command a shell code block runs: prompt markers ("$ ") dropped when every line has one. */
export function extractRunnableCommand(code: string): string {
  const lines = code.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
  const commandLines = lines.filter((line) => line.trim() !== "");
  if (commandLines.length > 0 && commandLines.every((line) => /^\s*\$\s/.test(line))) {
    return lines.map((line) => line.replace(/^\s*\$\s/, "")).join("\n");
  }
  return lines.join("\n");
}

/** Code block runs can happen only in the desktop app and outside Windows. */
export function canRunCodeBlocks(): boolean {
  if (typeof window === "undefined") return false;
  if (window.coworkBrowserHost === true) return false;
  if (typeof window.electronAPI?.runTerminalBlock !== "function") return false;
  return !/Windows/i.test(navigator.userAgent);
}

/** Live output kept per block while it runs, in characters (the main process keeps the same). */
const MAX_LIVE_OUTPUT = 256 * 1024;

const states = new Map<string, CodeBlockRunState>();
const keysByRunId = new Map<string, string>();
const listeners = new Set<() => void>();
let outputUnsubscribe: (() => void) | null = null;

function emit(): void {
  for (const listener of listeners) listener();
}

function setState(key: string, state: CodeBlockRunState): void {
  states.set(key, state);
  emit();
}

function ensureOutputSubscription(): void {
  if (outputUnsubscribe || typeof window.electronAPI?.onTerminalBlockOutput !== "function") {
    return;
  }
  outputUnsubscribe = window.electronAPI.onTerminalBlockOutput((event) => {
    const key = keysByRunId.get(event.runId);
    const current = key ? states.get(key) : undefined;
    if (!key || !current || current.runId !== event.runId || current.status !== "running") return;
    const output = current.output + event.output;
    setState(key, {
      ...current,
      tabId: event.tabId,
      output: output.length > MAX_LIVE_OUTPUT ? output.slice(-MAX_LIVE_OUTPUT) : output,
    });
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getCodeBlockRun(key: string): CodeBlockRunState | undefined {
  return states.get(key);
}

export function useCodeBlockRun(key: string | null): CodeBlockRunState | undefined {
  return useSyncExternalStore(
    subscribe,
    () => (key ? states.get(key) : undefined),
    () => undefined,
  );
}

function newRunId(): string {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  return `run-${random.replace(/[^A-Za-z0-9_-]/g, "")}`.slice(0, 80);
}

/** Run a code block's command; when it finishes on its own, send its output to the agent. */
export async function startCodeBlockRun(
  key: string,
  command: string,
  target: CodeBlockRunTarget,
): Promise<void> {
  if (states.get(key)?.status === "running") return;
  ensureOutputSubscription();
  const runId = newRunId();
  keysByRunId.set(runId, key);
  setState(key, { runId, command, status: "running", output: "" });
  try {
    const result = await window.electronAPI.runTerminalBlock({
      runId,
      workspaceId: target.workspaceId,
      taskId: target.taskId,
      command,
    });
    if (states.get(key)?.runId !== runId) return;
    const stopped = result.terminationReason === "user_stopped";
    setState(key, {
      runId,
      command,
      status: stopped ? "stopped" : result.terminationReason === "error" ? "error" : "done",
      output: result.output,
      tabId: result.tabId,
      exitCode: result.exitCode,
      ...(result.terminationReason === "error" ? { error: "The terminal tab closed." } : {}),
    });
    if (result.terminationReason === "normal") await target.sendOutput(command, result);
  } catch (error) {
    if (states.get(key)?.runId !== runId) return;
    const current = states.get(key);
    setState(key, {
      runId,
      command,
      status: "error",
      output: current?.output ?? "",
      tabId: current?.tabId,
      error: cleanIpcError(error),
    });
  } finally {
    keysByRunId.delete(runId);
  }
}

export function stopCodeBlockRun(key: string): void {
  const current = states.get(key);
  if (!current || current.status !== "running") return;
  void window.electronAPI.stopTerminalBlock({ runId: current.runId }).catch(() => {
    // The run already ended; its result updates the block.
  });
}

/** Electron prefixes errors thrown in handlers with the channel name; the user needs the reason. */
function cleanIpcError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "") || "Run failed."
  );
}

/** Test hook: forget every run. */
export function resetCodeBlockRunsForTests(): void {
  states.clear();
  keysByRunId.clear();
  outputUnsubscribe?.();
  outputUnsubscribe = null;
  emit();
}
