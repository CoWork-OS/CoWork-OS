import { isAutomatedTaskLike, isSpeculativeTask } from "../../shared/automated-task-detection";
import type {
  CompletionNotificationMode,
  NotificationType,
  Task,
  TraySettings,
} from "../../shared/types";

type CompletionTask = Pick<
  Task,
  "title" | "parentTaskId" | "agentType" | "source" | "promptProvenance" | "agentConfig"
> &
  Partial<Task>;

/**
 * True for a task a person started in a CoWork composer. Everything else reports on its
 * own path and would only add noise here: sub-agents report to their parent, scheduled
 * tasks and bots raise their own notifications, channel tasks answer in the channel.
 */
export function isCompletionAlertCandidate(task: CompletionTask | null | undefined): boolean {
  if (!task) return false;
  if (task.parentTaskId) return false;
  if (task.agentType && task.agentType !== "main") return false;
  if (isSpeculativeTask(task) || isAutomatedTaskLike(task as Task)) return false;
  if (task.agentConfig?.botConversation) return false;
  if (task.agentConfig?.gatewayContext || task.agentConfig?.originChannel) return false;
  return task.promptProvenance === "user_typed" || task.source === "suggested_task";
}

export function wantsCompletionAlert(
  mode: CompletionNotificationMode,
  appFocused: boolean,
): boolean {
  if (mode === "always") return true;
  if (mode === "unfocused") return !appFocused;
  return false;
}

const MAX_MESSAGE_LENGTH = 240;

function firstText(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/** The inbox item and banner for a finished or failed turn. */
export function completionAlertContent(
  task: Pick<Task, "title">,
  outcome: "completed" | "failed",
  payload: Record<string, unknown> | null | undefined,
): { type: NotificationType; title: string; message: string } {
  const name = task.title?.trim();
  const base = outcome === "completed" ? "Finished" : "Failed";
  const summary =
    outcome === "completed"
      ? firstText(payload?.resultSummary, payload?.semanticSummary, payload?.message)
      : firstText(payload?.error, payload?.message, payload?.reason);
  const fallback =
    outcome === "completed" ? "The task is done." : "The task stopped before it finished.";
  const message = summary || fallback;
  return {
    type: outcome === "completed" ? "task_completed" : "task_failed",
    title: name ? `${base} · ${name}` : base,
    message:
      message.length > MAX_MESSAGE_LENGTH
        ? `${message.slice(0, MAX_MESSAGE_LENGTH - 1).trimEnd()}…`
        : message,
  };
}

/**
 * Drops a second alert for the same task inside a short window. The daemon can publish
 * one completion under more than one event name.
 */
export function createCompletionAlertDeduper(windowMs = 3_000, now: () => number = Date.now) {
  const lastAlertAt = new Map<string, number>();
  return (taskId: string): boolean => {
    const at = now();
    for (const [id, seenAt] of lastAlertAt) {
      if (at - seenAt >= windowMs) lastAlertAt.delete(id);
    }
    if (lastAlertAt.has(taskId)) return false;
    lastAlertAt.set(taskId, at);
    return true;
  };
}

interface CompletionAlertDeps {
  daemon: {
    on(event: string, listener: (payload: unknown) => void): unknown;
    getTask(taskId: string): Task | undefined;
  };
  getSettings: () => Pick<TraySettings, "showNotifications" | "completionNotifications">;
  isAppFocused: () => boolean;
  /** True when this task's notifications are delivered by another path (a bot's route). */
  isRoutedElsewhere?: (task: Task) => boolean | Promise<boolean>;
  notify: (notification: {
    type: NotificationType;
    title: string;
    message: string;
    taskId: string;
    workspaceId?: string;
  }) => unknown | Promise<unknown>;
  reportError?: (error: unknown) => void;
}

function eventFields(event: unknown): { taskId: string; payload: Record<string, unknown> } {
  const record = event && typeof event === "object" ? (event as Record<string, unknown>) : {};
  const nested =
    record.payload && typeof record.payload === "object"
      ? (record.payload as Record<string, unknown>)
      : {};
  return {
    taskId: typeof record.taskId === "string" ? record.taskId : "",
    payload: { ...nested, ...record },
  };
}

/**
 * Raise a desktop alert when a task the person started finishes or fails, according to
 * the completion setting. The decision is made when the turn ends, so focus is read then.
 */
export function attachCompletionAlerts(deps: CompletionAlertDeps): void {
  const firstInWindow = createCompletionAlertDeduper();

  const handle = async (event: unknown, outcome: "completed" | "failed"): Promise<void> => {
    const { taskId, payload } = eventFields(event);
    if (!taskId) return;
    const settings = deps.getSettings();
    if (!settings.showNotifications) return;
    if (!wantsCompletionAlert(settings.completionNotifications, deps.isAppFocused())) return;
    const task = deps.daemon.getTask(taskId);
    if (!task || !isCompletionAlertCandidate(task)) return;
    if (await deps.isRoutedElsewhere?.(task)) return;
    if (!firstInWindow(taskId)) return;
    await deps.notify({
      ...completionAlertContent(task, outcome, payload),
      taskId,
      workspaceId: task.workspaceId,
    });
  };

  const listen = (
    eventName: string,
    outcome: "completed" | "failed",
    accept?: (event: unknown) => boolean,
  ) => {
    deps.daemon.on(eventName, (event) => {
      if (accept && !accept(event)) return;
      void handle(event, outcome).catch((error) => deps.reportError?.(error));
    });
  };

  listen("task_completed", "completed");
  listen("follow_up_completed", "completed");
  listen("follow_up_failed", "failed");
  listen("task_status", "failed", (event) => eventFields(event).payload.status === "failed");
}
