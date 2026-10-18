import type { ShellSessionInfo, TerminalBlockRunResult } from "../../shared/types";
import type { TerminalPtyManager, TerminalShellIntegration } from "./TerminalPtyManager";

/**
 * Runs a shell code block from an assistant answer in a terminal tab, the way the user
 * would type it, and reports the command's output and exit status once it finishes.
 *
 * Completion comes from the shell-integration marks the tab's shell emits (OSC 133:
 * C when output starts, D;<status> when the prompt returns), so the command runs in a
 * real interactive shell with the user's environment, aliases and working directory.
 */

type TabHost = Pick<
  TerminalPtyManager,
  | "createTab"
  | "listTabs"
  | "attachTerminalTabOutput"
  | "detachTerminalTabOutput"
  | "runCommandInTab"
  | "interruptTab"
  | "getOutputOffset"
  | "getShellMarkNonce"
>;

export type TerminalBlockRunParams = {
  runId: string;
  workspaceId: string;
  workspacePath: string;
  taskId: string;
  command: string;
  /** Who started the run (the sending window); only they can stop it. */
  ownerId?: string;
  onOutput: (chunk: string, tabId: string) => void;
};

type RunnerOptions = {
  shellIntegration: TerminalShellIntegration;
  /** How long a new tab may take to show its first prompt before the command is sent anyway. */
  firstPromptTimeoutMs?: number;
  /** After Stop, how long to wait for the prompt before giving up on the done mark. */
  stopGraceMs?: number;
  /** Longest a run may take before it is interrupted like Stop. */
  maxDurationMs?: number;
  /** How often to check that the tab still exists. */
  tabCheckIntervalMs?: number;
  /** Output kept per run, in characters; older output is dropped first. */
  outputLimit?: number;
};

type ActiveRun = {
  tabId: string;
  ownerId?: string;
  stop: () => void;
};

// Escapes are built from strings: the formatter rewrites \u escapes as invisible characters.
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;

/** The tab's start mark and done-mark pattern; only marks with its nonce count. */
function buildMarks(nonce: string): { start: string; done: RegExp } {
  const safeNonce = nonce.replace(/[^A-Za-z0-9]/g, "");
  return {
    start: `${ESC}]133;C;${safeNonce}${BEL}`,
    done: new RegExp(`\\u001b\\]133;D;${safeNonce};(-?\\d+)(?:\\u0007|\\u001b\\\\)`),
  };
}
const COMPLETE_ESCAPE_PATTERNS = [
  new RegExp("^\\u001b\\][^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)"),
  new RegExp("^\\u001b\\[[0-?]*[ -/]*[@-~]"),
  // Any other two-byte escape; "[" and "]" open longer sequences handled above.
  new RegExp("^\\u001b[^\\[\\]]"),
];
/**
 * zsh's partial-line marker (PROMPT_SP): a styled "%" or "#", padding to the screen edge,
 * then " \r" to wrap. It is drawn just before the done mark and is not command output.
 */
const PROMPT_SP_PATTERN = new RegExp(
  "(?:\\u001b\\[[0-9;]*m)*[%#](?:\\u001b\\[[0-9;]*m)* *\\r \\r$",
);
/** Longest partial escape sequence held back so a mark split across chunks is still found. */
const MAX_PARTIAL_ESCAPE = 64;

/**
 * Code block text as one shell input. zsh gets several lines (or tabs) as a bracketed
 * paste, so the line editor inserts them literally and runs them as one command list;
 * bash 3.2 has no bracketed paste, so its lines run as one grouped command.
 */
export function toShellInput(
  command: string,
  shell: TerminalShellIntegration,
): { input: string; echoLines: number } {
  const lines = command
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((line) => line.trim() !== "");
  const single = lines.length <= 1;
  if (single && !command.includes("\t")) {
    return { input: (lines[0] ?? "").trim(), echoLines: 1 };
  }
  if (shell === "zsh") {
    return { input: `${PASTE_START}${lines.join("\n")}${PASTE_END}`, echoLines: lines.length };
  }
  if (single) return { input: (lines[0] ?? "").trim(), echoLines: 1 };
  return { input: `{\n${lines.join("\n")}\n}`, echoLines: lines.length + 2 };
}

/** Split off a trailing escape sequence that may still be incomplete. */
function splitPartialEscape(text: string): [string, string] {
  const index = text.lastIndexOf(ESC);
  if (index < 0 || text.length - index > MAX_PARTIAL_ESCAPE) return [text, ""];
  const tail = text.slice(index);
  const complete = COMPLETE_ESCAPE_PATTERNS.some((pattern) => pattern.test(tail));
  return complete ? [text, ""] : [text.slice(0, index), tail];
}

function skipLines(text: string, count: number): string | null {
  let index = 0;
  for (let line = 0; line < count; line += 1) {
    const next = text.indexOf("\n", index);
    if (next < 0) return null;
    index = next + 1;
  }
  return text.slice(index);
}

export class TerminalBlockRunner {
  /** The tab code block runs reuse for each task, keyed by workspace and task. */
  private taskTabs = new Map<string, string>();
  private busyTabs = new Set<string>();
  private runs = new Map<string, ActiveRun>();
  private readonly firstPromptTimeoutMs: number;
  private readonly stopGraceMs: number;
  private readonly maxDurationMs: number;
  private readonly tabCheckIntervalMs: number;
  private readonly outputLimit: number;

  constructor(
    private readonly host: TabHost,
    private readonly options: RunnerOptions,
  ) {
    this.firstPromptTimeoutMs = options.firstPromptTimeoutMs ?? 8_000;
    this.stopGraceMs = options.stopGraceMs ?? 3_000;
    this.maxDurationMs = options.maxDurationMs ?? 60 * 60 * 1000;
    this.tabCheckIntervalMs = options.tabCheckIntervalMs ?? 2_000;
    this.outputLimit = options.outputLimit ?? 256 * 1024;
  }

  isRunning(runId: string): boolean {
    return this.runs.has(runId);
  }

  /** Interrupt a run with Ctrl-C. Returns false when the run is not active or not the caller's. */
  stop(runId: string, ownerId?: string): boolean {
    const run = this.runs.get(runId);
    if (!run || run.ownerId !== ownerId) return false;
    run.stop();
    return true;
  }

  run(params: TerminalBlockRunParams): Promise<TerminalBlockRunResult> {
    if (this.options.shellIntegration === "none") {
      return Promise.reject(
        new Error("Running code blocks needs zsh or bash as the terminal shell."),
      );
    }
    if (this.runs.has(params.runId)) {
      return Promise.reject(new Error("This code block is already running."));
    }
    const { input, echoLines } = toShellInput(params.command, this.options.shellIntegration);
    if (!input) return Promise.reject(new Error("The code block has no command to run."));

    let picked: { tab: ShellSessionInfo; fresh: boolean };
    try {
      picked = this.pickTab(params);
    } catch (error) {
      return Promise.reject(error);
    }
    const { tab, fresh } = picked;
    const tabId = tab.id;
    this.busyTabs.add(tabId);

    return new Promise<TerminalBlockRunResult>((resolve) => {
      const listenerKey = `code-block-run:${params.runId}`;
      const baseline = this.host.getOutputOffset(tabId);
      const marks = buildMarks(this.host.getShellMarkNonce(tabId));
      let phase: "waiting_prompt" | "awaiting_start" | "running" | "done" = fresh
        ? "waiting_prompt"
        : "awaiting_start";
      let pending = "";
      let carry = "";
      let output = "";
      let truncated = false;
      let stopped = false;
      let timedOut = false;
      let promptTimer: ReturnType<typeof setTimeout> | null = null;
      let stopTimer: ReturnType<typeof setTimeout> | null = null;
      const tabCheck = setInterval(() => {
        const current = this.host.listTabs(params.workspaceId).find((t) => t.id === tabId);
        if (!current || current.status === "ended") finish(null, "error");
      }, this.tabCheckIntervalMs);

      const finish = (
        exitCode: number | null,
        reason: TerminalBlockRunResult["terminationReason"],
      ) => {
        if (phase === "done") return;
        phase = "done";
        if (promptTimer) clearTimeout(promptTimer);
        if (stopTimer) clearTimeout(stopTimer);
        clearTimeout(durationTimer);
        clearInterval(tabCheck);
        this.host.detachTerminalTabOutput(tabId, listenerKey);
        this.busyTabs.delete(tabId);
        this.runs.delete(params.runId);
        output = output.replace(PROMPT_SP_PATTERN, "");
        const finalTab = this.host.listTabs(params.workspaceId).find((t) => t.id === tabId);
        resolve({
          runId: params.runId,
          tabId,
          cwd: finalTab?.cwd ?? tab.cwd,
          output,
          truncated,
          exitCode,
          terminationReason: timedOut ? "timeout" : stopped ? "user_stopped" : reason,
        });
      };

      const appendOutput = (text: string) => {
        if (!text) return;
        output += text;
        if (output.length > this.outputLimit) {
          output = output.slice(output.length - this.outputLimit);
          truncated = true;
        }
        params.onOutput(text, tabId);
      };

      const consumeRunning = (text: string) => {
        const combined = carry + text;
        carry = "";
        const done = marks.done.exec(combined);
        if (done) {
          appendOutput(combined.slice(0, done.index));
          finish(done[1] === undefined ? null : Number(done[1]), "normal");
          return;
        }
        const [body, partial] = splitPartialEscape(combined);
        carry = partial;
        appendOutput(body);
      };

      const consumeBeforeStart = (text: string) => {
        pending += text;
        const done = marks.done.exec(pending);
        const startIndex =
          this.options.shellIntegration === "zsh" ? pending.indexOf(marks.start) : -1;
        if (startIndex >= 0 && (!done || startIndex < done.index)) {
          const rest = pending.slice(startIndex + marks.start.length);
          pending = "";
          phase = "running";
          consumeRunning(rest);
          return;
        }
        if (done) {
          // The prompt came back without a start mark: bash, or a line zsh could not parse.
          const beforeDone = pending.slice(0, done.index);
          appendOutput(skipLines(beforeDone, echoLines) ?? "");
          finish(done[1] === undefined ? null : Number(done[1]), "normal");
          return;
        }
        if (this.options.shellIntegration === "bash") {
          const rest = skipLines(pending, echoLines);
          if (rest !== null) {
            pending = "";
            phase = "running";
            consumeRunning(rest);
          }
        }
      };

      const sendCommand = () => {
        if (phase !== "waiting_prompt" && phase !== "awaiting_start") return;
        if (promptTimer) clearTimeout(promptTimer);
        promptTimer = null;
        phase = "awaiting_start";
        pending = "";
        try {
          this.host.runCommandInTab(tabId, input);
        } catch {
          finish(null, "error");
        }
      };

      const interrupt = () => {
        if (phase === "done" || stopTimer) return;
        if (phase === "waiting_prompt") {
          finish(null, "user_stopped");
          return;
        }
        try {
          this.host.interruptTab(tabId);
        } catch {
          finish(null, "user_stopped");
          return;
        }
        stopTimer = setTimeout(() => {
          // The command ignored Ctrl-C and still owns the shell: never type into it again.
          this.retireTab(tabId);
          finish(null, "user_stopped");
        }, this.stopGraceMs);
      };
      const durationTimer = setTimeout(() => {
        timedOut = true;
        interrupt();
      }, this.maxDurationMs);

      this.runs.set(params.runId, {
        tabId,
        ownerId: params.ownerId,
        stop: () => {
          stopped = true;
          interrupt();
        },
      });

      try {
        this.host.attachTerminalTabOutput(tabId, listenerKey, (event) => {
          if (phase === "done") return;
          // Attaching replays the tab's earlier output; only what comes after the baseline counts.
          if (event.nextOffset <= baseline) return;
          const text =
            event.offset < baseline ? event.output.slice(baseline - event.offset) : event.output;
          if (phase === "waiting_prompt") {
            pending += text;
            if (marks.done.test(pending)) sendCommand();
            return;
          }
          if (phase === "awaiting_start") consumeBeforeStart(text);
          else consumeRunning(text);
        });
      } catch {
        finish(null, "error");
        return;
      }

      if (phase === "waiting_prompt") {
        promptTimer = setTimeout(sendCommand, this.firstPromptTimeoutMs);
      } else {
        sendCommand();
      }
    });
  }

  /** A tab whose command ignored Ctrl-C is never reused, so the next run gets a fresh shell. */
  private retireTab(tabId: string): void {
    for (const [key, mapped] of this.taskTabs) {
      if (mapped === tabId) this.taskTabs.delete(key);
    }
  }

  private pickTab(params: TerminalBlockRunParams): { tab: ShellSessionInfo; fresh: boolean } {
    const key = `${params.workspaceId}/${params.taskId}`;
    const tabs = this.host.listTabs(params.workspaceId);
    const knownId = this.taskTabs.get(key);
    const known = knownId ? tabs.find((tab) => tab.id === knownId) : undefined;
    if (known && known.status !== "ended" && !this.busyTabs.has(known.id)) {
      return { tab: known, fresh: false };
    }
    if (knownId && !known) this.taskTabs.delete(key);
    const tab = this.host.createTab({
      workspaceId: params.workspaceId,
      workspacePath: params.workspacePath,
      title: "Code blocks",
      codeBlockTaskId: params.taskId,
    });
    // A second tab only covers an overlapping run; later runs go back to the task's tab.
    if (!this.taskTabs.has(key) || known?.status === "ended") this.taskTabs.set(key, tab.id);
    return { tab, fresh: true };
  }
}
