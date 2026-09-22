import type { Task, TaskEvent } from "./types";
import { getCurrentBotHandoffScopeStart, getPendingBotHandoff } from "./bot-handoff";

/**
 * Read-side lifecycle projection for persistent Bot conversations.
 *
 * Task/TaskEvent remain the compatibility source of truth. This projection is
 * deliberately pure so the renderer, CLI, and future control-plane surfaces
 * can agree on the same human-facing vocabulary without parsing prose.
 */
export type BotConversationState =
  | "ready"
  | "working"
  | "waiting"
  | "needs_input"
  | "completed"
  | "failed";

export type BotHandoffState =
  | "accepted"
  | "queued"
  | "started"
  | "delivered"
  | "failed"
  | "quarantined";

export interface BotHandoffProjection {
  id: string;
  state: BotHandoffState;
  senderLabel: string;
  recipientLabel: string;
  targetTaskId?: string;
  preview: string;
  timestamp: number;
  messageId?: string;
  correlationId?: string;
  replyState?: "pending" | "received" | "timed_out";
  replyMessageId?: string;
  error?: string;
}

export interface BotAttentionProjection {
  kind: "input" | "blocked" | "failed" | "delivery";
  title: string;
  detail: string;
  handoffId?: string;
}

export interface BotOutcomeProjection {
  state: "completed" | "partial" | "failed";
  summary: string;
}

export type BotTeammateState = "working" | "waiting" | "needs_input" | "completed" | "failed";

export interface BotTeammateProjection {
  id: string;
  label: string;
  state: BotTeammateState;
  detail: string;
}

export interface BotConversationProjection {
  state: BotConversationState;
  stateLabel: string;
  stateDetail: string;
  activityLabel: string;
  lastActivityAt: number;
  collaborators: string[];
  teammates: BotTeammateProjection[];
  collaborationSummary: string;
  handoffs: BotHandoffProjection[];
  attention: BotAttentionProjection | null;
  outcome: BotOutcomeProjection | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(payload: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return "";
}

function readTimestamp(event: TaskEvent): number {
  const payload = asRecord(event.payload);
  const candidate = payload.timestamp ?? payload.deliveredAt ?? payload.queuedAt;
  return typeof candidate === "number" && Number.isFinite(candidate)
    ? candidate
    : event.timestamp || event.ts || 0;
}

function getEventType(event: TaskEvent): string {
  return typeof event.legacyType === "string" ? event.legacyType : event.type;
}

function cleanPreview(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (normalized.length <= 160) return normalized;
  return `${normalized.slice(0, 157).trimEnd()}…`;
}

function stripMarkdownForOutcome(value: string): string {
  return value
    .replace(/\\([\\`*_\[\]{}()#+.!~-])/g, "$1")
    .replace(/!\[([^\]]*)\]\([^\)\n]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^\)\n]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/```[ \t]*[A-Za-z0-9_+-]*[ \t]*(?:\r?\n|$)/g, "")
    .replace(/```/g, "")
    .replace(/(^|\n)\s{0,3}(?:[-+*]|\d+[.)])\s+/gm, "$1")
    .replace(/(^|\n)\s{0,3}>\s?/gm, "$1")
    .replace(/(^|\n)\s{0,3}(?:([-*_])\s*){3,}(?=\n|$)/gm, "$1")
    .replace(/(^|[\s])#{1,6}(?=[\s]|$)/g, "$1")
    .replace(/(\*\*|__)([\s\S]*?)\1/g, "$2")
    .replace(/~~([\s\S]*?)~~/g, "$1")
    .replace(/(^|[^\p{L}\p{N}])([*_])(?=\S)([\s\S]*?\S)\2(?=$|[^\p{L}\p{N}])/gu, "$1$3")
    .replace(/(^|[\s([{])[*_~`]+(?=\S)/g, "$1")
    .replace(/[*_~`]+(?=$|[\s)\]}.,!?;:])/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanOutcomeSummary(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  try {
    const parsed = JSON.parse(normalized) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return cleanPreview(stripMarkdownForOutcome(value));
    }
    const status = parsed.deliveryStatus ?? parsed.delivery_status ?? parsed.status;
    const messageId = parsed.messageId ?? parsed.message_id;
    if (typeof status !== "string" || (typeof messageId !== "string" && parsed.success !== true)) {
      return cleanPreview(stripMarkdownForOutcome(value));
    }
    if (status === "failed" || parsed.success === false) {
      return cleanPreview(
        stripMarkdownForOutcome(
          typeof parsed.error === "string" ? parsed.error : "Message delivery failed",
        ),
      );
    }
    if (status === "queued") return "Message queued for the next turn";
    if (status === "started") return "Message started on the next turn";
    if (status === "delivered") return "Message delivered";
    if (status === "quarantined") return "Message quarantined for recovery";
    return "Message accepted";
  } catch {
    return cleanPreview(stripMarkdownForOutcome(value));
  }
}

function normalizeHandoffState(value: unknown): BotHandoffState {
  if (
    value === "accepted" ||
    value === "queued" ||
    value === "started" ||
    value === "delivered" ||
    value === "failed" ||
    value === "quarantined"
  ) {
    return value;
  }
  return "accepted";
}

function stateFromTask(
  task: Pick<Task, "status" | "error" | "resultSummary">,
): BotConversationState {
  switch (task.status) {
    case "pending":
    case "queued":
    case "planning":
    case "executing":
      return "working";
    case "paused":
    case "blocked":
    case "interrupted":
      return "needs_input";
    case "failed":
      return "failed";
    case "completed":
      return "completed";
    case "cancelled":
      return task.resultSummary ? "completed" : "failed";
    default:
      return task.error ? "failed" : "ready";
  }
}

function teammateStateFromTask(
  task: Pick<Task, "status" | "error" | "resultSummary">,
): BotTeammateState {
  switch (task.status) {
    case "pending":
    case "queued":
    case "planning":
    case "executing":
      return "working";
    case "paused":
    case "blocked":
    case "interrupted":
      return "needs_input";
    case "failed":
      return "failed";
    case "completed":
    case "cancelled":
      return "completed";
    default:
      return task.error ? "failed" : "working";
  }
}

function getTeammateDetail(state: BotTeammateState): string {
  switch (state) {
    case "working":
      return "Working";
    case "waiting":
      return "Waiting for a reply";
    case "needs_input":
      return "Needs attention";
    case "completed":
      return "Finished";
    case "failed":
      return "Needs recovery";
  }
}

function buildCollaborationSummary(teammates: BotTeammateProjection[]): string {
  if (teammates.length === 0) return "No teammates involved";
  const counts = new Map<BotTeammateState, number>();
  for (const teammate of teammates) {
    counts.set(teammate.state, (counts.get(teammate.state) || 0) + 1);
  }
  const parts = [`${teammates.length} teammate${teammates.length === 1 ? "" : "s"}`];
  const labels: Array<[BotTeammateState, string]> = [
    ["working", "working"],
    ["waiting", "waiting"],
    ["needs_input", "needs attention"],
    ["completed", "finished"],
    ["failed", "failed"],
  ];
  for (const [state, label] of labels) {
    const count = counts.get(state) || 0;
    if (count > 0) parts.push(`${count} ${label}`);
  }
  return parts.join(" · ");
}

function getStateLabel(state: BotConversationState): string {
  switch (state) {
    case "working":
      return "Working with the team";
    case "waiting":
      return "Waiting on a teammate";
    case "needs_input":
      return "Needs your input";
    case "completed":
      return "Finished";
    case "failed":
      return "Couldn’t finish";
    default:
      return "Ready for another message";
  }
}

function getStateToneDetail(state: BotConversationState): string {
  switch (state) {
    case "working":
      return "The team is working on the latest request.";
    case "waiting":
      return "A teammate has the next turn.";
    case "needs_input":
      return "Review the blocker before the team continues.";
    case "completed":
      return "The latest request has a result ready to review.";
    case "failed":
      return "Open the activity details to see what needs recovery.";
    default:
      return "Send another request whenever you’re ready.";
  }
}

function getActivityLabel(event: TaskEvent, fallbackBotName: string): string {
  const payload = asRecord(event.payload);
  const type = getEventType(event);
  const recipient =
    readString(payload, "recipientLabel", "recipient", "targetLabel") || "a teammate";
  const agent =
    readString(payload, "childAgentLabel", "childTaskTitle", "agentLabel", "senderLabel") ||
    fallbackBotName;

  if (type === "agent_message") {
    const state = normalizeHandoffState(
      payload.deliveryStatus ?? payload.delivery_status ?? payload.status,
    );
    if (state === "failed" || state === "quarantined") return `Couldn’t message ${recipient}`;
    if (state === "queued") return `Message queued for ${recipient}`;
    if (state === "started") return `Message started for ${recipient}`;
    if (state === "delivered") {
      if (payload.replyStatus === "received") return `Reply received from ${recipient}`;
      if (payload.replyStatus === "timed_out") {
        return `No reply from ${recipient}; partial result available`;
      }
      if (payload.replyStatus === "pending") {
        return `Message delivered to ${recipient}; waiting for a reply`;
      }
      return `Message delivered to ${recipient}`;
    }
    return `Messaging ${recipient}`;
  }
  if (type === "agent_spawn_requested") return `Asking ${agent}`;
  if (type === "agent_spawned") return `${agent} is starting`;
  if (type === "agent_completed") return `${agent} finished`;
  if (type === "agent_failed") return `${agent} needs recovery`;
  if (type === "agent_follow_up_scheduled") return `Follow-up queued for ${recipient}`;
  if (type === "agent_follow_up_started") return `Follow-up started for ${recipient}`;
  return "Team activity updated";
}

function getAttention(
  task: Pick<Task, "status" | "error">,
  handoffs: BotHandoffProjection[],
  latestAgentEvent?: TaskEvent,
): BotAttentionProjection | null {
  const taskError = typeof task.error === "string" ? cleanPreview(task.error) : "";
  const waitingHandoff = handoffs.find(
    (handoff) =>
      (handoff.state === "accepted" ||
        handoff.state === "queued" ||
        handoff.state === "started" ||
        handoff.state === "delivered") &&
      (handoff.replyState === undefined || handoff.replyState === "pending"),
  );
  if (
    waitingHandoff &&
    (task.status === "blocked" || task.status === "paused" || task.status === "interrupted")
  ) {
    return {
      kind: "blocked",
      title: `Waiting on ${waitingHandoff.recipientLabel}`,
      detail: "The teammate has the task. The conversation will continue when its reply arrives.",
      handoffId: waitingHandoff.id,
    };
  }
  const failedHandoff = handoffs.find((handoff) => handoff.state === "failed");
  if (failedHandoff) {
    return {
      kind: "delivery",
      title: `Message to ${failedHandoff.recipientLabel} failed`,
      detail: failedHandoff.error || "Retry the handoff or choose another teammate.",
      handoffId: failedHandoff.id,
    };
  }
  if (task.status === "failed" || taskError) {
    return {
      kind: "failed",
      title: "The bot could not finish",
      detail: taskError || "Review the activity details and retry the request.",
    };
  }
  if (task.status === "blocked" || task.status === "paused" || task.status === "interrupted") {
    return {
      kind: "input",
      title: "The team is waiting for you",
      detail: "Provide the missing decision or resume the conversation to continue.",
    };
  }
  const timedOutHandoff = handoffs.find((handoff) => handoff.replyState === "timed_out");
  if (timedOutHandoff) {
    return {
      kind: "delivery",
      title: `No reply from ${timedOutHandoff.recipientLabel}`,
      detail: "The team kept the partial result so you can review it or retry the handoff.",
      handoffId: timedOutHandoff.id,
    };
  }
  if (latestAgentEvent && getEventType(latestAgentEvent) === "agent_failed") {
    const payload = asRecord(latestAgentEvent.payload);
    return {
      kind: "failed",
      title: "A teammate needs recovery",
      detail:
        cleanPreview(readString(payload, "error", "message")) || "Review the teammate result.",
    };
  }
  return null;
}

/** Derive a compact, human-facing collaboration state from durable events. */
export function deriveBotConversationProjection(input: {
  task: Pick<Task, "status" | "error" | "resultSummary"> & { id?: string };
  botName?: string;
  events?: TaskEvent[];
  childTasks?: Array<
    Pick<Task, "id" | "title" | "status" | "assignedAgentRoleId"> &
      Partial<Pick<Task, "error" | "resultSummary">>
  >;
  childEvents?: TaskEvent[];
}): BotConversationProjection {
  const botName = cleanPreview(input.botName || "Bot") || "Bot";
  const eventTypes = [
    "user_message",
    "agent_message",
    "agent_spawn_requested",
    "agent_spawned",
    "agent_completed",
    "agent_failed",
    "agent_follow_up_scheduled",
    "agent_follow_up_started",
  ];
  const parentEvents = [...(input.events || [])]
    .filter((event) => eventTypes.includes(getEventType(event)))
    .sort((a, b) => readTimestamp(a) - readTimestamp(b));
  const childEvents = [...(input.childEvents || [])]
    .filter((event) => eventTypes.includes(getEventType(event)))
    .sort((a, b) => readTimestamp(a) - readTimestamp(b));
  const allEvents = [...parentEvents, ...childEvents].sort(
    (a, b) => readTimestamp(a) - readTimestamp(b),
  );

  const handoffByKey = new Map<string, BotHandoffProjection>();
  const collaboratorSet = new Set<string>();
  const latestAgentEvent = parentEvents[parentEvents.length - 1];
  const repliesByMessageId = new Map<string, { messageId: string; replyTaskId?: string }>();
  const receiverReplies = parentEvents
    .filter((event) => getEventType(event) === "user_message")
    .map((event) => {
      const payload = asRecord(event.payload);
      if (payload.messageSource !== "agent") return null;
      const senderTaskId = readString(payload, "senderTaskId", "sender_task_id");
      if (!senderTaskId) return null;
      return {
        messageId: readString(payload, "messageId", "message_id") || event.id,
        senderTaskId,
        timestamp: readTimestamp(event),
      };
    })
    .filter(
      (reply): reply is { messageId: string; senderTaskId: string; timestamp: number } =>
        reply !== null,
    );
  const claimedReceiverReplyIds = new Set<string>();
  const inferredRepliesByHandoffKey = new Map<
    string,
    { messageId: string; replyTaskId?: string }
  >();

  for (const event of childEvents) {
    if (getEventType(event) !== "agent_message") continue;
    const payload = asRecord(event.payload);
    const originalMessageId = readString(payload, "inReplyToMessageId");
    if (!originalMessageId) continue;
    const targetTaskId = readString(payload, "targetTaskId");
    if (input.task.id && targetTaskId && targetTaskId !== input.task.id) continue;
    const replyMessageId = readString(payload, "messageId", "message_id");
    if (replyMessageId) {
      repliesByMessageId.set(originalMessageId, {
        messageId: replyMessageId,
        ...(event.taskId ? { replyTaskId: event.taskId } : {}),
      });
    }
  }

  for (const childTask of input.childTasks || []) {
    const label = cleanPreview(childTask.title);
    if (label) collaboratorSet.add(label);
  }

  for (const event of allEvents) {
    const payload = asRecord(event.payload);
    const senderLabel = readString(payload, "senderLabel", "sender") || botName;
    const recipientLabel = readString(payload, "recipientLabel", "recipient", "targetLabel");
    const childLabel = readString(payload, "childAgentLabel", "childTaskTitle", "agentLabel");
    if (senderLabel !== botName) collaboratorSet.add(senderLabel);
    if (recipientLabel) collaboratorSet.add(recipientLabel);
    if (childLabel) collaboratorSet.add(childLabel);

    // A child message addressed to the current conversation is the reply to
    // an existing handoff, not a second outbound request for this header.
    if (
      getEventType(event) !== "agent_message" ||
      (childEvents.includes(event) &&
        input.task.id &&
        readString(payload, "targetTaskId") === input.task.id)
    ) {
      continue;
    }
    const messageId = readString(payload, "messageId", "message_id");
    const correlationId = readString(payload, "correlationId", "correlation_id") || messageId;
    const handoffKey = messageId || correlationId || event.id;
    const directReply = messageId ? repliesByMessageId.get(messageId) : undefined;
    const targetTaskId = readString(payload, "targetTaskId", "target_task_id");
    const inferredReply =
      inferredRepliesByHandoffKey.get(handoffKey) ||
      (targetTaskId
        ? receiverReplies.find(
            (reply) =>
              reply.senderTaskId === targetTaskId &&
              !claimedReceiverReplyIds.has(reply.messageId) &&
              reply.timestamp >= readTimestamp(event),
          )
        : undefined);
    if (inferredReply && !inferredRepliesByHandoffKey.has(handoffKey)) {
      claimedReceiverReplyIds.add(inferredReply.messageId);
      inferredRepliesByHandoffKey.set(handoffKey, {
        messageId: inferredReply.messageId,
      });
    }
    const correlatedReply = directReply || inferredReply;
    const replyState: BotHandoffProjection["replyState"] = correlatedReply
      ? "received"
      : payload.replyStatus === "pending" || payload.replyStatus === "received"
        ? payload.replyStatus
        : payload.replyStatus === "timed_out"
          ? "timed_out"
          : undefined;
    const handoff: BotHandoffProjection = {
      id: handoffKey,
      state: normalizeHandoffState(
        payload.deliveryStatus ?? payload.delivery_status ?? payload.status,
      ),
      senderLabel,
      recipientLabel: recipientLabel || "teammate",
      ...(targetTaskId ? { targetTaskId } : {}),
      preview: cleanPreview(readString(payload, "message")),
      timestamp: readTimestamp(event),
      ...(messageId ? { messageId } : {}),
      ...(correlationId ? { correlationId } : {}),
      ...(replyState ? { replyState } : {}),
      ...(readString(payload, "replyMessageId") || correlatedReply?.messageId
        ? {
            replyMessageId: readString(payload, "replyMessageId") || correlatedReply?.messageId,
          }
        : {}),
      ...(readString(payload, "error")
        ? { error: cleanPreview(readString(payload, "error")) }
        : {}),
    };
    handoffByKey.set(handoffKey, handoff);
  }

  const handoffs = [...handoffByKey.values()];

  const hasActivity = parentEvents.length > 0 || childEvents.length > 0 || handoffs.length > 0;
  const baseState =
    !hasActivity && (input.task.status === "pending" || input.task.status === "queued")
      ? "ready"
      : stateFromTask(input.task);
  const latestHandoff = handoffs[handoffs.length - 1];
  const pendingBotHandoff = getPendingBotHandoff(input.events || []);
  const handoffScopeStart = getCurrentBotHandoffScopeStart(input.events || []);
  const hasScopedPendingHandoff = handoffs.some(
    (handoff) =>
      (handoffScopeStart === undefined || handoff.timestamp >= handoffScopeStart) &&
      (handoff.state === "accepted" ||
        handoff.state === "queued" ||
        handoff.state === "started" ||
        handoff.state === "delivered") &&
      (handoff.replyState === undefined || handoff.replyState === "pending"),
  );
  const isWaitingOnHandoff = Boolean(pendingBotHandoff) || hasScopedPendingHandoff;
  const state: BotConversationState =
    baseState !== "failed" && input.task.status !== "cancelled" && isWaitingOnHandoff
      ? "waiting"
      : baseState;
  const latestActivityAt = Math.max(
    latestAgentEvent ? readTimestamp(latestAgentEvent) : 0,
    latestHandoff?.timestamp || 0,
  );
  const attention = getAttention(input.task, handoffs, latestAgentEvent);
  const teammates = (input.childTasks || []).map((childTask) => {
    const childTaskEvents = childEvents.filter((event) => event.taskId === childTask.id);
    const childState = teammateStateFromTask(childTask);
    const detail =
      childState === "completed" &&
      childTaskEvents.some((event) => getEventType(event) === "user_message")
        ? "Finished"
        : getTeammateDetail(childState);
    return {
      id: childTask.id,
      label: cleanPreview(childTask.title) || "Teammate",
      state: childState,
      detail,
    } satisfies BotTeammateProjection;
  });
  const resultSummary = cleanOutcomeSummary(input.task.resultSummary || "");
  const outcome =
    state === "completed" && resultSummary
      ? { state: "completed" as const, summary: resultSummary }
      : state === "failed"
        ? {
            state: "failed" as const,
            summary: resultSummary || attention?.detail || "The bot run failed.",
          }
        : null;

  return {
    state,
    stateLabel: getStateLabel(state),
    stateDetail: getStateToneDetail(state),
    activityLabel:
      latestHandoff?.replyState === "received"
        ? `Reply received from ${latestHandoff.recipientLabel}`
        : latestHandoff?.replyState === "timed_out"
          ? `No reply from ${latestHandoff.recipientLabel}; partial result available`
          : latestAgentEvent
            ? getActivityLabel(latestAgentEvent, botName)
            : state === "waiting"
              ? "Waiting for a teammate"
              : stateDetailForState(state),
    lastActivityAt: latestActivityAt,
    collaborators: [...collaboratorSet].filter((label) => label !== botName).slice(0, 6),
    teammates,
    collaborationSummary: buildCollaborationSummary(teammates),
    handoffs: handoffs.slice(-8).reverse(),
    attention,
    outcome,
  };
}

function stateDetailForState(state: BotConversationState): string {
  switch (state) {
    case "working":
      return "Working on the latest request";
    case "waiting":
      return "Waiting for a teammate reply";
    case "completed":
      return "Your latest result is ready";
    case "failed":
      return "Review the recovery details";
    case "needs_input":
      return "Waiting for your decision";
    default:
      return "Ready when you are";
  }
}
