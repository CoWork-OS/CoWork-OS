import type { TaskEvent, TaskFollowUpInput } from "../../shared/types";
import type { LLMMessage } from "../agent/llm/types";

/** Events must be in timeline order with their legacy type resolved by the daemon. */
export function findUnfinishedBotUserTurn(
  events: TaskEvent[],
): Pick<TaskFollowUpInput, "message" | "messageSource" | "messageId"> | undefined {
  let index = events.length - 1;
  while (index >= 0 && events[index].type !== "user_message") index--;
  if (index < 0) return undefined;
  const payload = events[index].payload as Record<string, unknown>;
  const message = typeof payload?.message === "string" ? payload.message.trim() : "";
  if (
    !message ||
    /^Start chatting with .+\.?$/i.test(message) ||
    payload.messageSource === "agent" ||
    payload.providerDispatchStatus === "completed"
  )
    return undefined;
  const completed = events
    .slice(index + 1)
    .some(
      (event) =>
        event.type === "task_completed" ||
        (event.type === "follow_up_completed" &&
          (String(event.payload?.followUpMessage || "").trim() === message ||
            (payload.messageId && event.payload?.messageId === payload.messageId))),
    );
  if (completed) return undefined;
  return {
    message,
    messageSource: "user",
    ...(typeof payload.messageId === "string" ? { messageId: payload.messageId } : {}),
  };
}

/** An event after which the next user message starts a new turn. */
function endsTurn(event: TaskEvent): boolean {
  if (
    event.type === "task_completed" ||
    event.type === "follow_up_completed" ||
    event.type === "follow_up_failed"
  )
    return true;
  if (event.type !== "task_status") return false;
  const status = (event.payload as Record<string, unknown> | undefined)?.status;
  return status === "completed" || status === "failed" || status === "cancelled";
}

const PLAN_EVENT_TYPES: ReadonlySet<string> = new Set([
  "plan_created",
  "plan_updated",
  "plan_revised",
]);

/**
 * The person's follow-up that a restart left unanswered: the latest user message, sent after
 * an earlier turn ended, with no turn end after it. A crash in the task's first turn is not
 * one (the task recovers through its plan or snapshot), and neither is a follow-up whose own
 * plan already started (plan recovery continues that plan).
 * Events must be in timeline order with their legacy type resolved by the daemon.
 */
export function findUnfinishedUserFollowUp(
  events: TaskEvent[],
): Pick<TaskFollowUpInput, "message" | "messageSource" | "messageId"> | undefined {
  const turn = findUnfinishedBotUserTurn(events);
  if (!turn) return undefined;
  let index = events.length - 1;
  while (index >= 0 && events[index].type !== "user_message") index--;
  if (!events.slice(0, index).some(endsTurn)) return undefined;
  const after = events.slice(index + 1);
  if (after.some((event) => endsTurn(event) || PLAN_EVENT_TYPES.has(event.type))) return undefined;
  return turn;
}

function messageText(entry: LLMMessage): string {
  if (typeof entry.content === "string") return entry.content;
  return entry.content
    .map((block) => ("text" in block && typeof block.text === "string" ? block.text : ""))
    .join("\n");
}

/**
 * Whether the restored history already holds this message in its unfinished turn: the
 * entries after the last assistant reply that called no tools (a reply that ended a turn).
 * An earlier turn with the same words ("continue") does not count.
 */
export function unfinishedTurnContainsMessage(history: LLMMessage[], message: string): boolean {
  for (let index = history.length - 1; index >= 0; index--) {
    const entry = history[index];
    if (entry.role === "assistant") {
      const callsTools =
        Array.isArray(entry.content) && entry.content.some((block) => block.type === "tool_use");
      if (!callsTools) return false;
      continue;
    }
    if (messageText(entry).includes(message)) return true;
  }
  return false;
}
