import type { AgentConfig, Task, TaskOriginRefs } from "./types";

/**
 * Chain of Recall: every task carries the IDs of what it came from (parent task, session,
 * trigger event, gateway chat and thread) so the model can recall related context hop by
 * hop with task_get instead of searching. These helpers build and render those IDs.
 *
 * IDs reach the system prompt, so only short identifier-shaped values are kept: no spaces,
 * quotes or line breaks, which keeps a crafted "ID" from carrying instructions.
 */

const REF_ID_RE = /^[A-Za-z0-9][A-Za-z0-9:._@+=/#-]{0,159}$/;

/** The value when it is a plain identifier, otherwise undefined. */
export function sanitizeRefId(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const text = String(value).trim();
  return REF_ID_RE.test(text) ? text : undefined;
}

const ORIGIN_REF_KEYS = [
  "triggerId",
  "triggerEventId",
  "triggerOccurrenceId",
  "threadKey",
  "gatewayChannel",
  "gatewaySessionId",
  "gatewayChatId",
  "gatewayThreadId",
] as const satisfies ReadonlyArray<keyof TaskOriginRefs>;

/** Only identifier-shaped values survive; undefined when nothing is left. */
export function sanitizeTaskOriginRefs(refs: unknown): TaskOriginRefs | undefined {
  if (!refs || typeof refs !== "object" || Array.isArray(refs)) return undefined;
  const source = refs as Record<string, unknown>;
  const out: TaskOriginRefs = {};
  for (const key of ORIGIN_REF_KEYS) {
    const value = sanitizeRefId(source[key]);
    if (value) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function pickField(fields: Record<string, unknown> | undefined, key: string): string | undefined {
  return sanitizeRefId(fields?.[key]);
}

/** Origin of a task an event trigger creates. */
export function buildTriggerOriginRefs(params: {
  triggerId: string;
  occurrenceId?: string;
  event: { source?: string; eventId?: string; fields?: Record<string, unknown> };
}): TaskOriginRefs | undefined {
  const fields = params.event.fields;
  const chatId = pickField(fields, "chatId");
  const channelType = pickField(fields, "channelType");
  const threadKey =
    pickField(fields, "threadKey") ??
    pickField(fields, "threadId") ??
    (chatId
      ? sanitizeRefId(`${channelType || params.event.source || "chat"}:${chatId}`)
      : undefined);
  return sanitizeTaskOriginRefs({
    triggerId: params.triggerId,
    triggerEventId: params.event.eventId,
    triggerOccurrenceId: params.occurrenceId,
    threadKey,
    gatewayChannel: chatId ? channelType : undefined,
    gatewayChatId: chatId,
  });
}

/** agentConfig with origin refs added (unchanged when there are none). */
export function withOriginRefs(
  agentConfig: AgentConfig | undefined,
  refs: TaskOriginRefs | undefined,
): AgentConfig | undefined {
  if (!refs) return agentConfig;
  return { ...agentConfig, originRefs: refs };
}

/** Origin of a task a gateway message creates (its channel session, chat and thread). */
export function buildGatewayOriginRefs(params: {
  channelType: string;
  sessionId: string;
  chatId: string;
  threadId?: string;
}): TaskOriginRefs | undefined {
  const chatId = sanitizeRefId(params.chatId);
  const threadId = sanitizeRefId(params.threadId);
  return sanitizeTaskOriginRefs({
    gatewayChannel: params.channelType,
    gatewaySessionId: params.sessionId,
    gatewayChatId: chatId,
    gatewayThreadId: threadId,
    threadKey: chatId
      ? `${params.channelType}:${chatId}${threadId ? `::thread:${threadId}` : ""}`
      : undefined,
  });
}

/** `task_get(<id>)`, the call that recalls a task by ID. */
export function taskGetCall(taskId: string): string {
  return `task_get(${taskId})`;
}

/**
 * One compact line with this task's own ID and the IDs it is linked to, for the system
 * prompt. Empty when the task has no usable ID.
 */
export function buildTaskIdentityLine(
  task: Pick<Task, "id" | "parentTaskId" | "sessionId" | "branchFromTaskId" | "agentConfig">,
): string {
  const id = sanitizeRefId(task.id);
  if (!id) return "";
  const parts = [`task_id=${id}`];
  const parent = sanitizeRefId(task.parentTaskId);
  if (parent) parts.push(`parent_task_id=${parent}`);
  const branchFrom = sanitizeRefId(task.branchFromTaskId);
  if (branchFrom) parts.push(`branched_from_task_id=${branchFrom}`);
  const session = sanitizeRefId(task.sessionId);
  if (session && session !== id) parts.push(`session_id=${session}`);
  const origin = sanitizeTaskOriginRefs(task.agentConfig?.originRefs);
  if (origin?.triggerId) parts.push(`trigger_id=${origin.triggerId}`);
  if (origin?.triggerEventId) parts.push(`trigger_event_id=${origin.triggerEventId}`);
  if (origin?.gatewaySessionId) parts.push(`gateway_session_id=${origin.gatewaySessionId}`);
  if (origin?.threadKey) parts.push(`thread_key=${origin.threadKey}`);
  return (
    `Task references: ${parts.join(" ")}. ` +
    "Call task_get with any task id to recall that task's status, summary and linked tasks."
  );
}
