import type { TaskEvent, TaskFollowUpInput } from "../../shared/types";

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
