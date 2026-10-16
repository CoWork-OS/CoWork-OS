/**
 * Single active computer-use session with minimal guards:
 * - one task owns computer use at a time (macOS has one cursor and one focus)
 * - other tasks wait their turn in order, for a bounded time, instead of failing
 * - Esc aborts the active session
 * - no per-app approval, overlay, or isolation layer
 */

import type { BrowserWindow } from "electron";
import { ShortcutGuard } from "./shortcut-guard";
import { COMPUTER_USE_WAIT_MS } from "../../shared/computer-use-contract";

export type ComputerUseSessionEndReason = "completed" | "aborted" | "manual";

export type ComputerUseSessionEvent =
  | { type: "session_started"; taskId: string }
  | { type: "session_waiting"; taskId: string; holderTaskId: string }
  | {
      type: "session_ended";
      taskId: string;
      reason: ComputerUseSessionEndReason;
    };

/** Minimal daemon surface to avoid circular imports with AgentDaemon. */
export interface ComputerUseDaemonLike {
  requestApproval(
    taskId: string,
    approvalType: string,
    description: string,
    details: Record<string, unknown>,
    opts?: { allowAutoApprove?: boolean },
  ): Promise<boolean>;
  logEvent(taskId: string, eventType: string, payload: Record<string, unknown>): void;
}

export class ComputerUseSessionManager {
  private static instance: ComputerUseSessionManager | null = null;

  static getInstance(): ComputerUseSessionManager {
    if (!ComputerUseSessionManager.instance) {
      ComputerUseSessionManager.instance = new ComputerUseSessionManager();
    }
    return ComputerUseSessionManager.instance;
  }

  static resetForTesting(): void {
    ComputerUseSessionManager.instance = null;
  }

  private activeTaskId: string | null = null;
  private daemon: ComputerUseDaemonLike | null = null;
  private readonly shortcutGuard = new ShortcutGuard();
  private aborted = false;
  private mainWindowGetter: (() => BrowserWindow | null) | null = null;
  private notifyHandler: ((e: ComputerUseSessionEvent) => void) | null = null;
  /** Tasks waiting for the computer, first come first served. */
  private waiters: Array<{
    taskId: string;
    daemon: ComputerUseDaemonLike;
    options: { background?: boolean };
    resolve: () => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  private constructor() {}

  setMainWindowGetter(getter: () => BrowserWindow | null): void {
    this.mainWindowGetter = getter;
  }

  setNotifyHandler(handler: ((e: ComputerUseSessionEvent) => void) | null): void {
    this.notifyHandler = handler;
  }

  getActiveTaskId(): string | null {
    return this.activeTaskId;
  }

  getAppPermissionManagerOrNull(): null {
    return null;
  }

  isAborted(): boolean {
    return this.aborted;
  }

  acquire(
    taskId: string,
    daemon: ComputerUseDaemonLike,
    options: { background?: boolean } = {},
  ): void {
    if (this.activeTaskId && this.activeTaskId !== taskId) {
      throw new Error(
        "Computer use is already active for another task. Finish or cancel that task first.",
      );
    }

    if (this.activeTaskId) {
      return;
    }

    this.activeTaskId = taskId;
    this.daemon = daemon;
    this.aborted = false;
    void (this.mainWindowGetter?.() ?? null);

    if (!options.background)
      this.shortcutGuard.enable(() => {
        void this.abortSession(taskId);
      });

    daemon.logEvent(taskId, "computer_use_session_started", { mode: "helper_runtime" });
    this.emitNotify({ type: "session_started", taskId });
  }

  /**
   * Takes the computer for this task, waiting in line while another task has it. Rejects when
   * the wait runs out or the task ends while waiting.
   */
  async acquireOrWait(
    taskId: string,
    daemon: ComputerUseDaemonLike,
    options: { background?: boolean; waitMs?: number } = {},
  ): Promise<void> {
    if (!this.activeTaskId || this.activeTaskId === taskId) {
      this.acquire(taskId, daemon, options);
      return;
    }
    const holderTaskId = this.activeTaskId;
    const waitMs = Math.max(0, options.waitMs ?? COMPUTER_USE_WAIT_MS);
    daemon.logEvent(taskId, "computer_use_waiting", {
      holderTaskId,
      position: this.waiters.length + 1,
      waitMs,
    });
    this.emitNotify({ type: "session_waiting", taskId, holderTaskId });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeWaiter(taskId, timer);
        reject(
          new Error(
            `This computer is busy with another task. Waited ${Math.round(waitMs / 1000)} seconds; ` +
              "try again later, or work without the computer.",
          ),
        );
      }, waitMs);
      this.waiters.push({ taskId, daemon, options, resolve, reject, timer });
    });
  }

  /** Stops a task from waiting for the computer (it ended or was cancelled). */
  cancelWaiting(taskId: string): void {
    for (const waiter of this.waiters.filter((entry) => entry.taskId === taskId)) {
      this.removeWaiter(taskId, waiter.timer);
      waiter.reject(new Error("The task ended while waiting for the computer."));
    }
  }

  getWaitingTaskIds(): string[] {
    return this.waiters.map((waiter) => waiter.taskId);
  }

  private removeWaiter(taskId: string, timer: ReturnType<typeof setTimeout>): void {
    clearTimeout(timer);
    this.waiters = this.waiters.filter(
      (waiter) => !(waiter.taskId === taskId && waiter.timer === timer),
    );
  }

  /** Hands the computer to the next waiting task, so no other caller can take it in between. */
  private wakeNextWaiter(): void {
    while (!this.activeTaskId && this.waiters.length > 0) {
      const next = this.waiters.shift()!;
      clearTimeout(next.timer);
      try {
        this.acquire(next.taskId, next.daemon, next.options);
        next.resolve();
      } catch (error) {
        next.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  updateActionStatus(_label: string): void {}

  checkNotAborted(): void {
    if (this.aborted) {
      throw new Error("Computer use was stopped (Esc). Start a new action when ready.");
    }
  }

  async refreshIsolation(): Promise<void> {}

  async onAppPermissionGranted(): Promise<void> {}

  endSessionIfOwner(taskId: string, reason: ComputerUseSessionEndReason = "completed"): void {
    if (this.activeTaskId !== taskId) return;
    void this.cleanupInternal(taskId, reason);
  }

  async abortSession(taskId: string): Promise<void> {
    if (this.activeTaskId !== taskId) return;
    this.aborted = true;
    this.daemon?.logEvent(taskId, "computer_use_session_aborted", { reason: "escape_or_manual" });
    await this.cleanupInternal(taskId, "aborted");
  }

  async endSessionManual(): Promise<void> {
    if (!this.activeTaskId) return;
    const taskId = this.activeTaskId;
    this.daemon?.logEvent(taskId, "computer_use_session_ended", { reason: "manual" });
    await this.cleanupInternal(taskId, "manual");
  }

  private emitNotify(event: ComputerUseSessionEvent): void {
    try {
      this.notifyHandler?.(event);
    } catch {
      // ignore renderer IPC failures
    }
  }

  private async cleanupInternal(
    taskId: string,
    reason: ComputerUseSessionEndReason,
  ): Promise<void> {
    if (this.activeTaskId !== taskId) return;

    this.shortcutGuard.disable();

    this.activeTaskId = null;
    const daemon = this.daemon;
    this.daemon = null;

    if (reason === "completed") {
      daemon?.logEvent(taskId, "computer_use_session_ended", { reason: "task_finished" });
    }

    this.emitNotify({ type: "session_ended", taskId, reason });
    this.aborted = false;
    this.wakeNextWaiter();
  }
}
