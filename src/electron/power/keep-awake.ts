import type { QueueStatus, Task, TaskStatus } from "../../shared/types";

/** Statuses in which a task is doing work rather than waiting on the person. */
const WORKING_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>(["planning", "executing"]);

interface WorkingTaskSource {
  getQueueStatus(): Pick<QueueStatus, "runningTaskIds">;
  getTask(taskId: string): Pick<Task, "status"> | undefined;
}

/**
 * Tasks that are executing right now. A task that holds a run slot while it waits for an
 * approval or an answer (status "blocked" or "paused") is not counted: it can wait for a
 * day, and neither keeping the computer awake nor a quit warning helps it.
 */
export function countWorkingTasks(source: WorkingTaskSource): number {
  let count = 0;
  for (const taskId of source.getQueueStatus().runningTaskIds) {
    const status = source.getTask(taskId)?.status;
    if (status && WORKING_STATUSES.has(status)) count++;
  }
  return count;
}

/** The part of Electron's `powerSaveBlocker` the controller uses. */
export interface KeepAwakeBlocker {
  start(type: "prevent-app-suspension"): number;
  stop(id: number): unknown;
  isStarted(id: number): boolean;
}

export interface KeepAwakeDeps {
  isEnabled: () => boolean;
  hasWorkingTask: () => boolean;
  blocker: KeepAwakeBlocker;
  log?: (message: string) => void;
}

/**
 * Holds a "prevent-app-suspension" blocker while a task is executing and the setting is
 * on, and lets go as soon as either stops being true. That blocks idle system sleep only:
 * the display may still sleep, and closing the lid or choosing Sleep still sleeps.
 */
export class KeepAwakeController {
  private blockerId: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: KeepAwakeDeps) {}

  get holding(): boolean {
    return this.blockerId !== null;
  }

  /** Match the blocker to the setting and the current work. Never throws. */
  sync(): void {
    let wanted = false;
    try {
      wanted = this.deps.isEnabled() && this.deps.hasWorkingTask();
    } catch {
      // A failed read must not leave the computer awake.
      wanted = false;
    }
    try {
      if (wanted && this.blockerId === null) {
        this.blockerId = this.deps.blocker.start("prevent-app-suspension");
        this.deps.log?.("Keeping the computer awake while a task runs");
      } else if (!wanted && this.blockerId !== null) {
        this.release();
        this.deps.log?.("No task is running; the computer may sleep again");
      }
    } catch {
      this.blockerId = null;
    }
  }

  start(intervalMs = 15_000): void {
    if (this.timer) return;
    this.sync();
    this.timer = setInterval(() => this.sync(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    try {
      this.release();
    } catch {
      this.blockerId = null;
    }
  }

  private release(): void {
    const id = this.blockerId;
    this.blockerId = null;
    if (id !== null && this.deps.blocker.isStarted(id)) this.deps.blocker.stop(id);
  }
}
