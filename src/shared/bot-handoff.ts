import type { TaskEvent } from "./types";

/**
 * Prompt-only boundary for a teammate handoff.
 *
 * Bot conversations keep their durable transcript for the user, but the model
 * should not inherit unfinished work from an older handoff. This helper keeps
 * that distinction explicit: the boundary is sent to the model only and is
 * never persisted as a user-facing transcript message.
 */
export function buildFreshBotHandoffPrompt(
  message: string,
  senderLabel?: string,
  senderTaskId?: string,
  correlation?: {
    inReplyToMessageId?: string;
    inReplyToTaskId?: string;
  },
): string {
  const sender =
    typeof senderLabel === "string" && senderLabel.trim() ? senderLabel.trim() : "a teammate";
  const senderTask =
    typeof senderTaskId === "string" && senderTaskId.trim() ? senderTaskId.trim() : "";
  const isCorrelatedReply = Boolean(
    typeof correlation?.inReplyToMessageId === "string" &&
    correlation.inReplyToMessageId.trim() &&
    typeof correlation?.inReplyToTaskId === "string" &&
    correlation.inReplyToTaskId.trim(),
  );
  return [
    isCorrelatedReply ? "[CORRELATED TEAM REPLY]" : "[NEW TEAMMATE HANDOFF]",
    isCorrelatedReply
      ? `This message is a durable reply from ${sender} to your earlier handoff. Treat it as a delivery receipt, not a new request. Do not call send_agent_message or send another message in response unless the request below explicitly asks for a new action.`
      : `This is a new, independent request from ${sender}. Treat earlier conversation turns as archived reference only; do not continue, merge, or mention unfinished work from them unless this request explicitly asks you to.`,
    isCorrelatedReply
      ? "Record the received result and finish this turn concisely."
      : "Complete only the request below. Use the available tools as needed, and return one concise, evidence-backed result to the requesting teammate.",
    isCorrelatedReply
      ? "No teammate reply is required for this correlated receipt."
      : senderTask
        ? `Reply to that requesting teammate with send_agent_message using task_id="${senderTask}" so the durable reply is correlated to this handoff. Do not default to Atlas unless Atlas is the requester.`
        : "Reply to the requesting teammate with send_agent_message using that teammate's bot handle; do not default to Atlas unless Atlas is the requester.",
    "REQUEST:",
    message,
  ].join("\n");
}

export interface BotHandoffReplyRequirement {
  inboundMessageId: string;
  senderTaskId: string;
  senderLabel: string;
  message: string;
}

export interface PendingBotHandoff {
  messageId: string;
  recipientTaskId: string;
  recipientLabel: string;
  message: string;
  deliveryStatus: "accepted" | "queued" | "started" | "delivered";
  acceptedAt?: number;
  queuedAt?: number;
  startedAt?: number;
  deliveredAt?: number;
}

export interface BotHandoffScope {
  /** Ignore handoffs and inbound requests that belong to earlier turns. */
  sinceTimestamp?: number;
  /** Parent task that owns the boundary event, when known. */
  sinceTaskId?: string;
  /** Durable parent-task sequence for same-millisecond boundaries. */
  sinceSeq?: number;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(payload: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function eventType(event: TaskEvent): string {
  return typeof event.legacyType === "string" ? event.legacyType : event.type;
}

function eventTimestamp(event: TaskEvent): number {
  const payload = asRecord(event.payload);
  const candidate =
    payload.timestamp ??
    payload.deliveredAt ??
    payload.startedAt ??
    payload.queuedAt ??
    payload.acceptedAt;
  return typeof candidate === "number" && Number.isFinite(candidate)
    ? candidate
    : event.timestamp || event.ts || 0;
}

function compareEventOrder(left: TaskEvent, right: TaskEvent): number {
  const timestampDifference = eventTimestamp(left) - eventTimestamp(right);
  if (timestampDifference !== 0) return timestampDifference;
  if (left.taskId !== right.taskId) return 0;
  if (typeof left.seq === "number" && typeof right.seq === "number") {
    return left.seq - right.seq;
  }
  return 0;
}

function scopeForEvent(event: TaskEvent): BotHandoffScope {
  return {
    sinceTimestamp: eventTimestamp(event),
    ...(event.taskId ? { sinceTaskId: event.taskId } : {}),
    ...(typeof event.seq === "number" && Number.isFinite(event.seq) ? { sinceSeq: event.seq } : {}),
  };
}

/** Whether an event belongs to a turn boundary, including same-ms sequence order. */
export function isBotHandoffEventInScope(event: TaskEvent, scope?: BotHandoffScope): boolean {
  if (!scope || scope.sinceTimestamp === undefined) return true;
  const timestamp = eventTimestamp(event);
  if (timestamp > scope.sinceTimestamp) return true;
  if (timestamp < scope.sinceTimestamp) return false;
  if (
    scope.sinceTaskId &&
    event.taskId === scope.sinceTaskId &&
    typeof scope.sinceSeq === "number" &&
    Number.isFinite(scope.sinceSeq) &&
    typeof event.seq === "number" &&
    Number.isFinite(event.seq)
  ) {
    return event.seq >= scope.sinceSeq;
  }
  return true;
}

function deliveryStatus(payload: Record<string, unknown>): string {
  return String(payload.deliveryStatus ?? payload.delivery_status ?? payload.status ?? "accepted")
    .trim()
    .toLowerCase();
}

function isTerminalDelivery(status: string): boolean {
  return status === "failed" || status === "quarantined";
}

function isTerminalReply(payload: Record<string, unknown>): boolean {
  return payload.replyStatus === "received" || payload.replyStatus === "timed_out";
}

function isAgentInbound(payload: Record<string, unknown>): boolean {
  return payload.messageSource === "agent" && payload.deliveryMode === "message";
}

interface BotHandoffReplyCorrelation {
  handoffMessageIds: Set<string>;
  replyMessageIds: Set<string>;
}

/**
 * The sender's durable handoff row is updated when the recipient sends a
 * reply. The receiver may already have a user_message copy of that reply, so
 * keep both sides of the correlation in one place and use it to avoid treating
 * a completed reply as a fresh request.
 *
 * Older queue receipts did not always persist `inReplyToMessageId` on the
 * receiver-side user_message. When that field is absent, the recipient task
 * and message order are still a durable, bounded correlation: the first
 * non-terminal inbound message from the handoff target after the handoff
 * answers that handoff. Claims are one-to-one so two outbound messages to the
 * same teammate cannot both consume one reply.
 */
function getBotHandoffReplyCorrelation(events: TaskEvent[]): BotHandoffReplyCorrelation {
  const ordered = [...events].sort(compareEventOrder);
  const handoffMessageIds = new Set<string>();
  const replyMessageIds = new Set<string>();
  const receiverReplies = ordered
    .filter((event) => eventType(event) === "user_message")
    .map((event) => {
      const payload = asRecord(event.payload);
      if (!isAgentInbound(payload)) return null;
      const messageId = readString(payload, "messageId", "message_id") || event.id;
      const senderTaskId = readString(payload, "senderTaskId", "sender_task_id");
      if (!messageId || !senderTaskId || isTerminalDelivery(deliveryStatus(payload))) return null;
      return { messageId, senderTaskId, timestamp: eventTimestamp(event) };
    })
    .filter(
      (reply): reply is { messageId: string; senderTaskId: string; timestamp: number } =>
        reply !== null,
    );
  const claimedReplyIds = new Set<string>();

  for (const event of ordered) {
    if (eventType(event) !== "agent_message") continue;
    const payload = asRecord(event.payload);
    const messageId = readString(payload, "messageId", "message_id");
    if (!messageId) continue;

    if (payload.replyStatus === "received") {
      handoffMessageIds.add(messageId);
      const replyMessageId = readString(payload, "replyMessageId", "reply_message_id");
      if (replyMessageId) replyMessageIds.add(replyMessageId);
      continue;
    }
    if (
      payload.senderType !== "agent" ||
      payload.deliveryMode !== "message" ||
      !readString(payload, "botTeamId", "bot_team_id") ||
      isTerminalDelivery(deliveryStatus(payload)) ||
      isTerminalReply(payload)
    ) {
      continue;
    }

    const targetTaskId = readString(payload, "targetTaskId", "target_task_id");
    if (!targetTaskId) continue;
    const reply = receiverReplies.find(
      (candidate) =>
        candidate.senderTaskId === targetTaskId &&
        !claimedReplyIds.has(candidate.messageId) &&
        candidate.timestamp >= eventTimestamp(event),
    );
    if (!reply) continue;
    claimedReplyIds.add(reply.messageId);
    handoffMessageIds.add(messageId);
    replyMessageIds.add(reply.messageId);
  }

  return { handoffMessageIds, replyMessageIds };
}

function isCorrelatedInboundReply(
  payload: Record<string, unknown>,
  correlatedReplyMessageIds: Set<string>,
): boolean {
  // Newer queue receipts carry the correlation directly. Older receipts only
  // have the replyMessageId projection on the originating agent_message row.
  return Boolean(
    readString(payload, "inReplyToMessageId", "in_reply_to_message_id") ||
    (readString(payload, "messageId", "message_id") &&
      correlatedReplyMessageIds.has(readString(payload, "messageId", "message_id"))),
  );
}

/**
 * Find the durable boundary for the active bot turn.
 *
 * Persistent bot conversations intentionally retain their transcript, so a
 * raw scan of every historical handoff makes an old unresolved message block
 * a new request. Human turns use their latest user message as the boundary.
 * A teammate turn uses its latest inbound message, unless that inbound is a
 * reply to a handoff that is still active from the latest human turn; in that
 * case the human turn remains the active coordination scope while the other
 * teammate replies arrive.
 */
export function getCurrentBotHandoffScope(events: TaskEvent[]): BotHandoffScope | undefined {
  const ordered = [...events].sort(compareEventOrder);
  const { replyMessageIds: correlatedReplyMessageIds, handoffMessageIds } =
    getBotHandoffReplyCorrelation(ordered);
  const humanMessages = ordered.filter((event) => {
    if (eventType(event) !== "user_message") return false;
    const payload = asRecord(event.payload);
    return !isAgentInbound(payload);
  });
  const agentInbound = ordered.filter((event) => {
    if (eventType(event) !== "user_message") return false;
    const payload = asRecord(event.payload);
    return (
      isAgentInbound(payload) &&
      !isTerminalDelivery(deliveryStatus(payload)) &&
      !isCorrelatedInboundReply(payload, correlatedReplyMessageIds)
    );
  });
  const latestHuman = humanMessages[humanMessages.length - 1];
  const latestInbound = agentInbound[agentInbound.length - 1];
  if (!latestInbound) return latestHuman ? scopeForEvent(latestHuman) : undefined;
  if (!latestHuman || compareEventOrder(latestHuman, latestInbound) > 0) {
    return scopeForEvent(latestHuman || latestInbound);
  }

  const inboundPayload = asRecord(latestInbound.payload);
  const senderTaskId = readString(inboundPayload, "senderTaskId", "sender_task_id");
  const humanBoundary = scopeForEvent(latestHuman);
  const hasActiveParentHandoff = ordered.some((event) => {
    if (eventType(event) !== "agent_message") return false;
    const payload = asRecord(event.payload);
    const messageId = readString(payload, "messageId", "message_id");
    if (!isBotHandoffEventInScope(event, humanBoundary)) return false;
    if (readString(payload, "targetTaskId", "target_task_id") !== senderTaskId) return false;
    const status = deliveryStatus(payload);
    return (
      !handoffMessageIds.has(messageId) &&
      payload.senderType === "agent" &&
      payload.deliveryMode === "message" &&
      !readString(payload, "inReplyToMessageId", "in_reply_to_message_id") &&
      !isTerminalDelivery(status) &&
      !isTerminalReply(payload)
    );
  });

  return hasActiveParentHandoff ? humanBoundary : scopeForEvent(latestInbound);
}

/** Backwards-compatible timestamp-only view of the active turn boundary. */
export function getCurrentBotHandoffScopeStart(events: TaskEvent[]): number | undefined {
  return getCurrentBotHandoffScope(events)?.sinceTimestamp;
}

/**
 * Return the newest inbound teammate message that has no durable correlated
 * reply yet. This is intentionally event-based so completion and recovery can
 * enforce the same contract without depending on renderer state.
 */
export function getOutstandingBotHandoffReply(
  events: TaskEvent[],
  scope?: BotHandoffScope,
): BotHandoffReplyRequirement | null {
  const ordered = [...events].sort(compareEventOrder);
  const resolvedScope = scope ?? getCurrentBotHandoffScope(ordered);
  const inboundById = new Map<string, BotHandoffReplyRequirement>();
  const repliedMessageIds = new Set<string>();
  const { replyMessageIds: correlatedReplyMessageIds } = getBotHandoffReplyCorrelation(ordered);

  for (const event of ordered) {
    const payload = asRecord(event.payload);
    const type = eventType(event);
    if (type === "user_message") {
      if (!isAgentInbound(payload)) continue;
      if (isCorrelatedInboundReply(payload, correlatedReplyMessageIds)) continue;
      if (!isBotHandoffEventInScope(event, resolvedScope)) continue;
      const inboundMessageId = readString(payload, "messageId", "message_id");
      const senderTaskId = readString(payload, "senderTaskId", "sender_task_id");
      const status = deliveryStatus(payload);
      if (!inboundMessageId || !senderTaskId || isTerminalDelivery(status)) continue;
      inboundById.set(inboundMessageId, {
        inboundMessageId,
        senderTaskId,
        senderLabel: readString(payload, "senderLabel", "sender") || "teammate",
        message: readString(payload, "message"),
      });
      continue;
    }
    if (type !== "agent_message") continue;
    const replyTo = readString(payload, "inReplyToMessageId", "in_reply_to_message_id");
    if (!replyTo) continue;
    const status = deliveryStatus(payload);
    if (!isTerminalDelivery(status)) repliedMessageIds.add(replyTo);
  }

  for (const requirement of [...inboundById.values()].reverse()) {
    if (!repliedMessageIds.has(requirement.inboundMessageId)) return requirement;
  }
  return null;
}

/**
 * Return the newest bot-team handoff whose recipient has not acknowledged a
 * reply. Generic child-task steering is excluded by requiring botTeamId.
 */
export function getPendingBotHandoff(
  events: TaskEvent[],
  scope?: BotHandoffScope,
): PendingBotHandoff | null {
  const ordered = [...events].sort(compareEventOrder);
  const resolvedScope = scope ?? getCurrentBotHandoffScope(ordered);
  const { handoffMessageIds } = getBotHandoffReplyCorrelation(ordered);
  const latestByMessageId = new Map<
    string,
    { payload: Record<string, unknown>; event: TaskEvent }
  >();
  for (const event of ordered) {
    if (eventType(event) !== "agent_message") continue;
    const payload = asRecord(event.payload);
    if (payload.senderType !== "agent" || payload.deliveryMode !== "message") continue;
    if (!readString(payload, "botTeamId", "bot_team_id")) continue;
    const messageId = readString(payload, "messageId", "message_id");
    if (!messageId) continue;
    latestByMessageId.set(messageId, { payload, event });
  }

  const pending = [...latestByMessageId.entries()]
    .map(([messageId, entry]) => ({ messageId, ...entry }))
    .filter(({ payload, event }) => {
      if (!isBotHandoffEventInScope(event, resolvedScope)) return false;
      const status = deliveryStatus(payload);
      const messageId = readString(payload, "messageId", "message_id");
      return (
        !handoffMessageIds.has(messageId) &&
        !readString(payload, "inReplyToMessageId", "in_reply_to_message_id") &&
        !isTerminalDelivery(status) &&
        !isTerminalReply(payload)
      );
    })
    .sort((a, b) => compareEventOrder(a.event, b.event));
  const latest = pending[pending.length - 1];
  if (!latest) return null;
  const status = deliveryStatus(latest.payload);
  if (
    status !== "accepted" &&
    status !== "queued" &&
    status !== "started" &&
    status !== "delivered"
  ) {
    return null;
  }
  return {
    messageId: latest.messageId,
    recipientTaskId: readString(latest.payload, "targetTaskId", "target_task_id"),
    recipientLabel:
      readString(latest.payload, "recipientLabel", "recipient", "targetLabel") || "teammate",
    message: readString(latest.payload, "message"),
    deliveryStatus: status,
    ...(typeof latest.payload.acceptedAt === "number"
      ? { acceptedAt: latest.payload.acceptedAt }
      : {}),
    ...(typeof latest.payload.queuedAt === "number" ? { queuedAt: latest.payload.queuedAt } : {}),
    ...(typeof latest.payload.startedAt === "number"
      ? { startedAt: latest.payload.startedAt }
      : {}),
    ...(typeof latest.payload.deliveredAt === "number"
      ? { deliveredAt: latest.payload.deliveredAt }
      : {}),
  };
}
