/**
 * Single active computer-use session with minimal guards:
 * - one task owns computer use at a time
 * - Esc aborts the active session
 * - no per-app approval, overlay, or isolation layer
 */

import type { BrowserWindow } from "electron";
import { ShortcutGuard } from "./shortcut-guard";

export type ComputerUseSessionEndReason = "completed" | "aborted" | "manual";

export type ComputerUseSessionEvent =
  | { type: "session_started"; taskId: string }
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
  }
}
