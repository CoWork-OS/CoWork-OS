/**
 * The watchdog's view of the runtime. `WatchdogService` talks only to this interface, so the
 * control loop can be tested without an AgentDaemon and the daemon keeps a small surface for it.
 */
import type {
  Task,
  TaskEvent,
  TaskStatus,
  WatchdogDecision,
  WorkSessionActivityLeaseKind,
} from "../../../shared/types";

/** What only the process running a task knows about it. */
export interface WatchdogTaskRuntime {
  /** An executor for this task is cached in this process and still active. */
  hasExecutor: boolean;
  /** That executor is running a turn right now. */
  executorRunning: boolean;
  /** Waiting in this process's queue. */
  queued: boolean;
  /** A transient-retry timer is armed for it. */
  retryPending: boolean;
  /** A person is being asked to decide something for this task. */
  waitingForUser: boolean;
  /** Restart recovery would resume it (a root task from a person, not a sub-agent or hook). */
  autoResumable: boolean;
}

/** An activity lease remembered before a suspend, so it can be reclaimed after waking. */
export interface WatchdogLeaseSnapshotEntry {
  taskId: string;
  sessionId: string;
  turnId?: string;
  kind: WorkSessionActivityLeaseKind;
  operationKey: string;
}

export interface WatchdogNotification {
  taskId: string;
  workspaceId?: string;
  title: string;
  message: string;
}

export interface WatchdogHost {
  listTasks(statuses: TaskStatus[]): Task[];
  getTask(taskId: string): Task | undefined;
  /** The most recent events of a task, oldest first. */
  getRecentEvents(taskId: string, limit: number): TaskEvent[];
  getRuntime(taskId: string): WatchdogTaskRuntime;
  /** True while some operation of the task holds an unexpired activity lease. */
  hasActiveLease(task: Task): boolean;
  /** Append a decision to the task event log (event type "watchdog"). */
  logDecision(decision: WatchdogDecision, message: string): void;
  /** Deliver a steering note to the running task as a runtime notice from "Watchdog". */
  sendSteeringMessage(taskId: string, message: string, messageId: string): Promise<boolean>;
  /** Pause with a reason the person sees in the task. Never cancels. */
  pauseTask(taskId: string, message: string): Promise<boolean>;
  /** Cancel; only used when the user allowed the watchdog to cancel. */
  cancelTask(taskId: string, message: string): Promise<boolean>;
  /** Resume from saved state through the restart path (interrupted, then resumed). */
  recoverTask(
    taskId: string,
    reason: string,
    options?: { allowFailed?: boolean },
  ): Promise<boolean>;
  /** Put a task stuck in transient retry back in the queue. */
  requeueTask(taskId: string, reason: string): Promise<boolean>;
  notify?(notification: WatchdogNotification): void | Promise<void>;

  // Sleep recovery
  /** Tasks whose executor is running a turn in this process. */
  listRunningTaskIds(): string[];
  snapshotLeases(taskIds: string[]): WatchdogLeaseSnapshotEntry[];
  /** Reclaim leases from before a suspend whose operation is still running; returns per-task counts. */
  reclaimLeases(entries: WatchdogLeaseSnapshotEntry[]): Map<string, number>;
  /** Re-scan undelivered background-process completions; returns the number of tasks scanned. */
  rearmBackgroundCompletions(): number;
  /** Suspended time does not count toward the queue's session timeout. */
  creditSuspendedTime(ms: number): void;
}
