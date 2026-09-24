import type { Task, TaskEvent } from "../../shared/types";
import type { BotHandoffProjection } from "../../shared/bot-lifecycle";
import { isBotHandoffMessageDelivered } from "../../shared/bot-handoff";

function formatHandoffState(state: string): string {
  switch (state) {
    case "queued":
      return "Queued";
    case "delivered":
      return "Delivered";
    case "started":
      return "Started";
    case "failed":
      return "Failed";
    case "quarantined":
      return "Quarantined";
    case "accepted":
      return "Accepted";
    default:
      return state;
  }
}

export function formatHandoffReplyState(handoff: {
  state: string;
  replyState?: "pending" | "received" | "timed_out";
  isReply?: boolean;
}): string {
  // A receiver-side durable reply is stronger evidence than the sender's
  // possibly stale delivery projection. During the queue/delivery race the
  // handoff can still read queued or started even though the teammate has
  // already replied; never hide that result behind the older state.
  if (handoff.replyState === "received") {
    return "Reply received";
  }
  if (handoff.isReply) {
    return `Reply ${formatHandoffState(handoff.state).toLowerCase()}`;
  }
  if (handoff.state === "delivered" && handoff.replyState === "pending") {
    return "Waiting for reply";
  }
  if (handoff.replyState === "timed_out") {
    return "No reply — partial result";
  }
  return formatHandoffState(handoff.state);
}

export function normalizeCollaboratorLabel(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export function resolveCollaboratorConversationIds(input: {
  conversations: Array<Pick<Task, "id" | "title">>;
  events: TaskEvent[];
  handoffs: BotHandoffProjection[];
}): Map<string, string> {
  const ids = new Map<string, string>();
  const knownConversationIds = new Set(input.conversations.map((conversation) => conversation.id));
  const exactTargets: Array<{ label: string; id: string; timestamp: number }> = [];

  for (const handoff of input.handoffs) {
    const label = normalizeCollaboratorLabel(handoff.recipientLabel);
    const targetTaskId = handoff.targetTaskId;
    if (label && targetTaskId && knownConversationIds.has(targetTaskId)) {
      exactTargets.push({ label, id: targetTaskId, timestamp: handoff.timestamp });
    }
  }

  for (const event of input.events) {
    const eventType = event.legacyType || event.type;
    if (eventType !== "user_message") continue;
    const payload = event.payload as Record<string, unknown>;
    if (
      payload.messageSource !== "agent" ||
      payload.deliveryMode !== "message" ||
      !isBotHandoffMessageDelivered(payload)
    ) {
      continue;
    }
    const senderTaskId =
      typeof payload.senderTaskId === "string"
        ? payload.senderTaskId.trim()
        : typeof payload.sender_task_id === "string"
          ? payload.sender_task_id.trim()
          : "";
    const senderLabel =
      typeof payload.senderLabel === "string"
        ? normalizeCollaboratorLabel(payload.senderLabel)
        : "";
    if (senderTaskId && senderLabel && knownConversationIds.has(senderTaskId)) {
      exactTargets.push({
        label: senderLabel,
        id: senderTaskId,
        timestamp: Number(event.timestamp) || 0,
      });
    }
  }

  exactTargets.sort((left, right) => right.timestamp - left.timestamp);
  for (const target of exactTargets) {
    if (!ids.has(target.label)) ids.set(target.label, target.id);
  }

  // Exact task IDs from durable handoffs take precedence. Use the latest
  // conversation for a role only when the event history does not identify a
  // specific transcript to open.
  for (const conversation of input.conversations) {
    const label = normalizeCollaboratorLabel(conversation.title || "");
    if (label && !ids.has(label)) ids.set(label, conversation.id);
  }
  return ids;
}
