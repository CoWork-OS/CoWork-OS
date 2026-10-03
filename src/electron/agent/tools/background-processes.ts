/**
 * Background processes started by `run_command` with `background: true`.
 *
 * Lifecycle (process-wide, keyed by task ID so a follow-up turn of the same
 * task can reach a server started by an earlier turn, even when the daemon
 * has evicted and recreated the task's executor):
 * - started only by ShellTools after the normal run_command approval, policy
 *   and sandbox path;
 * - at most MAX_BACKGROUND_PROCESSES_PER_TASK running per task and
 *   MAX_BACKGROUND_PROCESSES_TOTAL overall;
 * - a turn finishing does NOT stop them (the user may still be looking at a
 *   dev server the task opened);
 * - stopped by stop_process, when the task is cancelled (executor cancel and
 *   daemon cancelTask, which task deletion also goes through), when nobody
 *   has polled or started anything for BACKGROUND_PROCESS_IDLE_TIMEOUT_MS,
 *   on daemon shutdown, and synchronously on process exit as a backstop;
 * - when the leading process exits, whatever is left of its process group is
 *   killed so no untracked server outlives its record.
 *
 * Output is kept in memory only (a bounded tail per process), never written
 * into the workspace. Chunks are normalized and redacted as they arrive and
 * redacted again when read.
 */

import type { ChildProcess } from "child_process";
import { randomBytes } from "crypto";
import { boundOutput } from "../sandbox/bounded-output";
import { createLogger } from "../../utils/logger";

const log = createLogger("BackgroundProcesses");

export const MAX_BACKGROUND_PROCESSES_PER_TASK = 5;
export const MAX_BACKGROUND_PROCESSES_TOTAL = 20;
export const BACKGROUND_PROCESS_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_STARTUP_WAIT_MS = 5_000;
export const MAX_STARTUP_WAIT_MS = 30_000;
export const MAX_OUTPUT_WAIT_MS = 15_000;
const MAX_BUFFERED_OUTPUT_CHARS = 512 * 1024;
const DEFAULT_READ_CHARS = 16_000;
const MAX_READ_CHARS = 64_000;
const MAX_FINISHED_RECORDS_PER_TASK = 10;
const FINISHED_RECORD_TTL_MS = 30 * 60 * 1000;
const STOP_GRACE_MS = 2_000;
const STOP_KILL_WAIT_MS = 3_000;
const SWEEP_INTERVAL_MS = 60_000;
const MAX_URLS = 5;

// A line that says a server or watcher is up. Checked against recent output.
const READY_PATTERN =
  /\b(?:listening|ready in|ready on|ready -|started server|server (?:is )?running|serving|running (?:at|on)|available on|watching for (?:file )?changes|compiled successfully|local:\s+https?:\/\/)/i;
const LOCAL_URL_PATTERN =
  /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d{1,5})?(?:\/[^\s"'<>)\]]*)?/gi;

export type BackgroundProcessStatus = "running" | "exited" | "stopped";

export interface BackgroundProcessLaunch {
  child: ChildProcess;
  sandboxType: string;
  /** Signal the whole process tree. Must be safe to call after exit. */
  signalTree: (signal: NodeJS.Signals) => void;
  /** Release launch resources (sandbox profile, temp dir). Called once, after exit. */
  release?: () => void;
  /** False when the process runs where the host cannot connect to it (Docker). */
  reachableFromHost: boolean;
  notes?: string[];
}

export interface BackgroundProcessStartOptions {
  taskId: string;
  command: string;
  cwd: string;
  launch: BackgroundProcessLaunch;
  /** Applied to every output chunk as it arrives (control codes, redaction). */
  normalizeChunk: (chunk: string) => string;
  /** Applied again to every slice handed to the model. */
  redact: (text: string) => string;
  onExit?: (summary: BackgroundProcessSummary) => void;
}

export interface BackgroundProcessSummary {
  process_id: string;
  pid: number | null;
  command: string;
  cwd: string;
  status: BackgroundProcessStatus;
  running: boolean;
  exit_code: number | null;
  signal: string | null;
  uptime_ms: number;
  urls: string[];
  sandbox: string;
  reachable_from_host: boolean;
  stop_reason?: string;
  notes?: string[];
}

export interface BackgroundProcessOutput {
  output: string;
  next_offset: number;
  truncated: boolean;
  dropped_chars?: number;
}

interface ProcessRecord {
  id: string;
  taskId: string;
  command: string;
  cwd: string;
  pid: number | null;
  launch: BackgroundProcessLaunch;
  normalizeChunk: (chunk: string) => string;
  redact: (text: string) => string;
  onExit?: (summary: BackgroundProcessSummary) => void;
  startedAt: number;
  lastAccessAt: number;
  endedAt?: number;
  status: BackgroundProcessStatus;
  stopReason?: string;
  exitCode: number | null;
  signal: string | null;
  buffer: string;
  bufferStart: number;
  readCursor: number;
  ready: boolean;
  urls: string[];
  waiters: Set<() => void>;
  exited: Promise<void>;
  released: boolean;
  silenced: boolean;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === "string" && value.trim() ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

export class BackgroundProcessManager {
  private readonly records = new Map<string, ProcessRecord>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private exitHookInstalled = false;

  constructor(private readonly now: () => number = Date.now) {}

  /** Throws when the task may not start another background process. */
  assertCanStart(taskId: string): void {
    const running = this.list(taskId).filter((record) => record.status === "running");
    if (running.length >= MAX_BACKGROUND_PROCESSES_PER_TASK) {
      throw new Error(
        `This task already has ${running.length} background processes running ` +
          `(${running.map((record) => record.process_id).join(", ")}), the maximum. ` +
          "Stop one with stop_process before starting another.",
      );
    }
    const total = Array.from(this.records.values()).filter((r) => r.status === "running");
    if (total.length >= MAX_BACKGROUND_PROCESSES_TOTAL) {
      throw new Error(
        "Too many background processes are running across all tasks. Stop one with stop_process first.",
      );
    }
  }

  start(options: BackgroundProcessStartOptions): BackgroundProcessSummary {
    const { child } = options.launch;
    const now = this.now();
    let resolveExited: () => void = () => undefined;
    const record: ProcessRecord = {
      id: `bg-${randomBytes(4).toString("hex")}`,
      taskId: options.taskId,
      command: options.command,
      cwd: options.cwd,
      pid: typeof child.pid === "number" ? child.pid : null,
      launch: options.launch,
      normalizeChunk: options.normalizeChunk,
      redact: options.redact,
      onExit: options.onExit,
      startedAt: now,
      lastAccessAt: now,
      status: "running",
      exitCode: null,
      signal: null,
      buffer: "",
      bufferStart: 0,
      readCursor: 0,
      ready: false,
      urls: [],
      waiters: new Set(),
      exited: new Promise<void>((resolve) => {
        resolveExited = resolve;
      }),
      released: false,
      silenced: false,
    };
    this.records.set(record.id, record);
    this.installExitHook();
    this.ensureSweep();

    const onData = (data: Buffer | string) => {
      this.append(record, record.normalizeChunk(data.toString()));
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    // Nobody can answer prompts; a process that reads stdin gets EOF.
    child.stdin?.end();

    const finish = (code: number | null, signal: NodeJS.Signals | null, error?: Error) => {
      if (record.endedAt !== undefined) return;
      record.endedAt = this.now();
      record.exitCode = code;
      record.signal = signal;
      if (record.status === "running") record.status = "exited";
      if (error) this.append(record, `\n[failed to start: ${error.message}]\n`);
      // The leader is gone; do not leave the rest of its group running untracked.
      try {
        record.launch.signalTree("SIGKILL");
      } catch {
        // Nothing left to stop.
      }
      this.notify(record);
      resolveExited();
      if (!record.silenced && record.onExit) {
        try {
          record.onExit(this.summarize(record));
        } catch (callbackError) {
          log.warn("Background process exit callback failed", callbackError);
        }
      }
    };
    child.once("exit", (code, signal) => finish(code, signal));
    child.once("error", (error) => finish(null, null, error));
    child.once("close", () => this.release(record));
    if (record.pid === null) {
      // spawn() failed synchronously enough that no PID exists; "error" follows.
      log.warn(`Background process ${record.id} has no PID`);
    }
    return this.summarize(record);
  }

  /** Wait until the process prints a ready line, exits, or the time is up. */
  async waitForStartup(
    taskId: string,
    processId: string,
    waitMs: unknown,
    signal?: AbortSignal,
  ): Promise<void> {
    const record = this.get(taskId, processId);
    const deadline =
      this.now() + clampNumber(waitMs, 0, MAX_STARTUP_WAIT_MS, DEFAULT_STARTUP_WAIT_MS);
    while (record.status === "running" && !record.ready && !signal?.aborted) {
      const remaining = deadline - this.now();
      if (remaining <= 0) break;
      await this.waitForChange(record, remaining, signal);
    }
  }

  read(
    taskId: string,
    processId: string,
    options: { sinceOffset?: unknown; tailLines?: unknown; maxChars?: unknown } = {},
  ): BackgroundProcessOutput {
    const record = this.get(taskId, processId);
    record.lastAccessAt = this.now();
    const total = record.bufferStart + record.buffer.length;
    const requested = clampNumber(options.sinceOffset, 0, total, record.readCursor);
    const from = Math.max(requested, record.bufferStart);
    let text = record.buffer.slice(from - record.bufferStart);
    const tailLines = clampNumber(options.tailLines, 0, 10_000, 0);
    if (tailLines > 0) {
      const lines = text.split("\n");
      const trailingNewline = lines.length > 0 && lines[lines.length - 1] === "";
      const kept = lines.slice(-(tailLines + (trailingNewline ? 1 : 0)));
      text = kept.join("\n");
    }
    const bounded = boundOutput(
      record.redact(text),
      clampNumber(options.maxChars, 1_000, MAX_READ_CHARS, DEFAULT_READ_CHARS),
    );
    record.readCursor = total;
    return {
      output: bounded.text,
      next_offset: total,
      truncated: bounded.truncated,
      ...(from > requested ? { dropped_chars: from - requested } : {}),
    };
  }

  /** Wait (bounded) for output after `sinceOffset`, or for the process to end. */
  async waitForOutput(
    taskId: string,
    processId: string,
    sinceOffset: unknown,
    waitMs: unknown,
    signal?: AbortSignal,
  ): Promise<void> {
    const record = this.get(taskId, processId);
    const total = () => record.bufferStart + record.buffer.length;
    const from = clampNumber(sinceOffset, 0, Number.MAX_SAFE_INTEGER, record.readCursor);
    const deadline = this.now() + clampNumber(waitMs, 0, MAX_OUTPUT_WAIT_MS, 0);
    while (record.status === "running" && total() <= from && !signal?.aborted) {
      const remaining = deadline - this.now();
      if (remaining <= 0) break;
      await this.waitForChange(record, remaining, signal);
    }
  }

  /** Add a line from CoWork itself (not the process) to the process output. */
  appendNotice(taskId: string, processId: string, text: string): void {
    this.append(this.get(taskId, processId), text);
  }

  summary(taskId: string, processId: string): BackgroundProcessSummary {
    const record = this.get(taskId, processId);
    record.lastAccessAt = this.now();
    return this.summarize(record);
  }

  list(taskId: string): BackgroundProcessSummary[] {
    return Array.from(this.records.values())
      .filter((record) => record.taskId === taskId)
      .map((record) => this.summarize(record));
  }

  /** Stop one process and its tree. Resolves once it has exited (or been SIGKILLed). */
  async stop(
    taskId: string,
    processId: string,
    reason = "stop_process",
  ): Promise<BackgroundProcessSummary> {
    const record = this.get(taskId, processId);
    record.lastAccessAt = this.now();
    await this.stopRecord(record, reason);
    return this.summarize(record);
  }

  /** Stop and forget every process of a task (task cancelled or deleted). */
  async stopAllForTask(taskId: string, reason: string): Promise<number> {
    const records = Array.from(this.records.values()).filter((record) => record.taskId === taskId);
    const running = records.filter((record) => record.status === "running");
    for (const record of records) record.silenced = true;
    await Promise.all(running.map((record) => this.stopRecord(record, reason)));
    for (const record of records) this.records.delete(record.id);
    this.stopSweepIfIdle();
    if (running.length > 0) {
      log.info(`Stopped ${running.length} background process(es) for task ${taskId} (${reason})`);
    }
    return running.length;
  }

  async stopAll(reason: string): Promise<number> {
    const taskIds = new Set(Array.from(this.records.values()).map((record) => record.taskId));
    let stopped = 0;
    for (const taskId of taskIds) stopped += await this.stopAllForTask(taskId, reason);
    return stopped;
  }

  /** Synchronous last resort for process exit: SIGKILL every running tree. */
  killAllSync(): void {
    for (const record of this.records.values()) {
      if (record.status !== "running") continue;
      record.silenced = true;
      try {
        record.launch.signalTree("SIGKILL");
      } catch {
        // Best effort during exit.
      }
    }
  }

  /** Stop processes nobody has touched for the idle timeout; forget old finished ones. */
  sweep(): void {
    const now = this.now();
    const finishedByTask = new Map<string, ProcessRecord[]>();
    for (const record of this.records.values()) {
      if (record.status === "running") {
        if (now - record.lastAccessAt >= BACKGROUND_PROCESS_IDLE_TIMEOUT_MS) {
          void this.stopRecord(record, "idle_timeout");
        }
        continue;
      }
      if (record.endedAt !== undefined && now - record.endedAt >= FINISHED_RECORD_TTL_MS) {
        this.records.delete(record.id);
        continue;
      }
      const finished = finishedByTask.get(record.taskId) || [];
      finished.push(record);
      finishedByTask.set(record.taskId, finished);
    }
    for (const finished of finishedByTask.values()) {
      finished
        .sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0))
        .slice(MAX_FINISHED_RECORDS_PER_TASK)
        .forEach((record) => this.records.delete(record.id));
    }
    this.stopSweepIfIdle();
  }

  private get(taskId: string, processId: string): ProcessRecord {
    const id = String(processId || "").trim();
    const record = this.records.get(id);
    // Another task's processes are indistinguishable from unknown ones.
    if (!record || record.taskId !== taskId) {
      const known = this.list(taskId).map((entry) => `${entry.process_id} (${entry.status})`);
      throw new Error(
        `No background process "${id}" in this task. ` +
          (known.length > 0
            ? `Known: ${known.join(", ")}.`
            : "It may have been stopped when the task was cancelled, after being idle, or when the app restarted; start it again with run_command background: true."),
      );
    }
    return record;
  }

  private async stopRecord(record: ProcessRecord, reason: string): Promise<void> {
    if (record.status === "running") {
      record.status = "stopped";
      record.stopReason = reason;
      try {
        record.launch.signalTree("SIGTERM");
      } catch (error) {
        log.warn(`Could not signal background process ${record.id}`, error);
      }
      if (!(await this.waitForExit(record, STOP_GRACE_MS))) {
        try {
          record.launch.signalTree("SIGKILL");
        } catch {
          // Already gone.
        }
        await this.waitForExit(record, STOP_KILL_WAIT_MS);
      }
    }
    this.release(record);
  }

  private async waitForExit(record: ProcessRecord, timeoutMs: number): Promise<boolean> {
    if (record.endedAt !== undefined) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const exited = await Promise.race([
      record.exited.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    return exited;
  }

  private release(record: ProcessRecord): void {
    if (record.released) return;
    record.released = true;
    try {
      record.launch.release?.();
    } catch (error) {
      log.warn(`Could not release resources of background process ${record.id}`, error);
    }
  }

  private append(record: ProcessRecord, text: string): void {
    if (!text) return;
    record.buffer += text;
    const overflow = record.buffer.length - MAX_BUFFERED_OUTPUT_CHARS;
    if (overflow > 0) {
      record.buffer = record.buffer.slice(overflow);
      record.bufferStart += overflow;
    }
    const recent = record.buffer.slice(-(text.length + 512));
    if (!record.ready && READY_PATTERN.test(recent)) record.ready = true;
    for (const match of recent.match(LOCAL_URL_PATTERN) || []) {
      const url = match.replace(/[.,;:]+$/, "");
      if (record.urls.length < MAX_URLS && !record.urls.includes(url)) {
        record.urls.push(url);
        record.ready = true;
      }
    }
    this.notify(record);
  }

  private notify(record: ProcessRecord): void {
    const waiters = Array.from(record.waiters);
    record.waiters.clear();
    for (const waiter of waiters) waiter();
  }

  private waitForChange(
    record: ProcessRecord,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = () => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        record.waiters.delete(done);
        resolve();
      };
      timer = setTimeout(done, Math.max(0, timeoutMs));
      record.waiters.add(done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }

  private summarize(record: ProcessRecord): BackgroundProcessSummary {
    const end = record.endedAt ?? this.now();
    return {
      process_id: record.id,
      pid: record.pid,
      command: record.command,
      cwd: record.cwd,
      status: record.status,
      running: record.status === "running" && record.endedAt === undefined,
      exit_code: record.exitCode,
      signal: record.signal,
      uptime_ms: Math.max(0, end - record.startedAt),
      urls: [...record.urls],
      sandbox: record.launch.sandboxType,
      reachable_from_host: record.launch.reachableFromHost,
      ...(record.stopReason ? { stop_reason: record.stopReason } : {}),
      ...(record.launch.notes && record.launch.notes.length > 0
        ? { notes: [...record.launch.notes] }
        : {}),
    };
  }

  private installExitHook(): void {
    if (this.exitHookInstalled) return;
    this.exitHookInstalled = true;
    process.once("exit", () => this.killAllSync());
  }

  private ensureSweep(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
  }

  private stopSweepIfIdle(): void {
    if (this.records.size > 0 || !this.sweepTimer) return;
    clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }
}

let sharedManager: BackgroundProcessManager | null = null;

export function getBackgroundProcessManager(): BackgroundProcessManager {
  sharedManager ||= new BackgroundProcessManager();
  return sharedManager;
}
