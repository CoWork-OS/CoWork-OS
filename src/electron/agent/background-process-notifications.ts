import type { Task, TaskEvent, TaskFollowUpInput } from "../../shared/types";
import { canAnswerInlineApproval } from "./approval-policy";

export function isFreshAgentHandoff(
  input: Pick<TaskFollowUpInput, "messageSource" | "notificationKind"> | undefined,
): boolean {
  return input?.messageSource === "agent" && input.notificationKind !== "background_process";
}

/** A later turn is supported only for a human's native, interactive root session. */
export function canReceiveBackgroundCompletion(
  task: Task | undefined,
  shuttingDown = false,
): boolean {
  return (
    !!task &&
    !shuttingDown &&
    canAnswerInlineApproval(task, { headless: false }) &&
    task.source === "manual" &&
    !task.parentTaskId &&
    (!task.agentType || task.agentType === "main") &&
    !task.agentConfig?.externalRuntime &&
    !task.sessionArchived &&
    ["executing", "planning", "completed", "pending"].includes(task.status)
  );
}

/** Finished jobs wait durably without resuming a paused session or bypassing a decision. */
export function canRetainBackgroundCompletion(
  task: Task | undefined,
  shuttingDown = false,
): boolean {
  return (
    !!task &&
    canReceiveBackgroundCompletion({ ...task, status: "pending" }, shuttingDown) &&
    !["cancelled", "failed"].includes(task.status)
  );
}

export interface BackgroundCompletionNotice {
  id: string;
  message: string;
}

export function pendingBackgroundCompletionNotices(
  events: TaskEvent[],
): BackgroundCompletionNotice[] {
  const pending = new Map<string, BackgroundCompletionNotice>();
  for (const event of events) {
    const p = event.payload;
    const type = event.legacyType || p?.legacyType || event.type;
    if (type !== "log") continue;
    if (p?.backgroundCompletionsCancelled === true) {
      pending.clear();
      continue;
    }
    if (typeof p?.backgroundCompletionId !== "string") continue;
    if (p.backgroundCompletionDelivered === true) pending.delete(p.backgroundCompletionId);
    else if (typeof p.backgroundCompletionMessage === "string")
      pending.set(p.backgroundCompletionId, {
        id: p.backgroundCompletionId,
        message: p.backgroundCompletionMessage,
      });
  }
  return [...pending.values()];
}
