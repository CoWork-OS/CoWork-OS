import type { BotConversationState } from "../../../shared/bot-lifecycle";
import type { TaskStatus, TaskStatusStripState } from "../../../shared/types";
import type { MascotExpression } from "./mascot-eyes";

/** How a mascot looks while its bot conversation is in each state. */
export function mascotExpressionForConversation(
  state: BotConversationState | null | undefined,
): MascotExpression {
  switch (state) {
    case "working":
      return "working";
    // Waiting on a teammate: eyes drift aside rather than staring at the user.
    case "waiting":
      return "thinking";
    case "needs_input":
      return "attention";
    case "completed":
      return "happy";
    case "failed":
      return "error";
    default:
      return "idle";
  }
}

/**
 * The open conversation's mascot. A pending approval or question outranks the
 * conversation state, which still reads as working while a run waits on one.
 */
export function mascotExpressionForBotConversation(
  state: BotConversationState | null | undefined,
  taskState: TaskStatusStripState | null | undefined,
): MascotExpression {
  if (taskState === "waiting_for_approval" || taskState === "waiting_for_input") {
    return "attention";
  }
  if (state) return mascotExpressionForConversation(state);
  switch (taskState) {
    case "working":
      return "working";
    case "completed":
      return "happy";
    case "failed":
      return "error";
    case "paused":
    case "blocked":
      return "attention";
    default:
      return "idle";
  }
}

/** For surfaces that only know the task's status, not a conversation projection. */
export function mascotExpressionForTaskStatus(
  status: TaskStatus | null | undefined,
): MascotExpression {
  switch (status) {
    case "pending":
    case "queued":
    case "planning":
    case "executing":
      return "working";
    case "paused":
    case "blocked":
    case "interrupted":
      return "attention";
    case "failed":
      return "error";
    case "completed":
      return "happy";
    default:
      return "idle";
  }
}
