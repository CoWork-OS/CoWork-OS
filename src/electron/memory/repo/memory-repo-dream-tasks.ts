/**
 * The recent tasks a dream reads (docs/memory-repo-phase2-design.md §2): finished top-level
 * tasks the owner had with the assistant, with the user's own messages and the final reply.
 *
 * Left out: tasks with `<no-memory>`, sub-agent tasks, automated sources whose "user"
 * messages are not the user's words (hooks, improvement and background loops, samples),
 * shared gateway contexts (group, public), channel tasks from anyone but the owner, and
 * workspaces whose memory is off or strict-private. Tool output is never read.
 */
import type { Task, TaskEvent, TaskStatus } from "../../../shared/types";
import { isThirdPartyGatewayTask } from "../../gateway/gateway-sender-identity";
import { createLogger } from "../../utils/logger";
import type { MemoryWorkspacePolicy } from "../MemoryWriter";
import { containsNoMemoryDirective, taskDisablesMemoryCapture } from "../no-memory-directive";
import type { DreamTaskInput } from "./memory-repo-dream-plan";

const logger = createLogger("MemoryRepoDreamTasks");

/** Terminal states whose conversation is over. */
const FINISHED_STATUSES: ReadonlySet<TaskStatus> = new Set(["completed", "failed", "cancelled"]);
/** Task sources whose prompt was not written by the user in this conversation. */
const EXCLUDED_SOURCES: ReadonlySet<string> = new Set([
  "hook",
  "improvement",
  "subconscious",
  "symphony",
]);
/** Most candidate rows read per dream (the repository's own cap). */
const CANDIDATE_LIMIT = 200;
/** Most conversation events read per task (the newest ones). */
const MAX_EVENTS_PER_TASK = 80;
const MAX_USER_MESSAGES = 8;
const MAX_MESSAGE_CHARS = 600;
const MAX_REPLY_CHARS = 800;
const MAX_TITLE_CHARS = 160;

export const DREAM_TASK_EVENT_TYPES = ["user_message", "assistant_message", "task_completed"];

export interface DreamTaskSourceDeps {
  /** Tasks with `startMs <= created_at < endMs`, newest first. */
  findTasksCreatedBetween: (params: {
    startMs: number;
    endMs: number;
    limit: number;
  }) => Promise<Task[]>;
  /** The task's events of these types, oldest first (at most `maxEvents`, the newest). */
  findTaskEvents: (taskId: string, types: string[], maxEvents: number) => Promise<TaskEvent[]>;
  workspaceName?: (workspaceId: string) => Promise<string | null>;
  getWorkspacePolicy?: (workspaceId: string) => Promise<MemoryWorkspacePolicy | null>;
  now?: () => number;
}

function trimText(value: unknown, max: number): string {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Whether the task itself may be read by a dream (before its events are loaded). */
/** Statuses of a task that is running now. */
const IN_PROGRESS_STATUSES: ReadonlySet<TaskStatus> = new Set(["planning", "executing", "queued"]);
/** A task without activity for this long is not waited for. */
const IN_PROGRESS_MAX_IDLE_MS = 6 * 60 * 60 * 1000;

/** A top-level, non-bot task that is running now and was active in the last few hours. */
export function isInProgressTask(task: Task, now: number): boolean {
  if (task.parentTaskId || !IN_PROGRESS_STATUSES.has(task.status)) return false;
  if (task.agentConfig?.botConversation === true) return false;
  const lastActivity = Math.max(task.createdAt || 0, task.updatedAt || 0);
  return now - lastActivity < IN_PROGRESS_MAX_IDLE_MS;
}

export function isDreamCandidateTask(task: Task): boolean {
  if (!FINISHED_STATUSES.has(task.status)) return false;
  if (task.parentTaskId || (typeof task.depth === "number" && task.depth > 0)) return false;
  if (task.agentType === "sub" || task.agentType === "parallel") return false;
  if (task.source && EXCLUDED_SOURCES.has(task.source)) return false;
  if (taskDisablesMemoryCapture(task)) return false;
  const gatewayContext = task.agentConfig?.gatewayContext;
  if (gatewayContext === "group" || gatewayContext === "public") return false;
  if (isThirdPartyGatewayTask(task)) return false;
  return true;
}

function payloadOf(event: TaskEvent): Record<string, unknown> {
  return event.payload && typeof event.payload === "object"
    ? (event.payload as Record<string, unknown>)
    : {};
}

function eventType(event: TaskEvent): string {
  return String(event.legacyType || event.type || "");
}

/**
 * The user's messages (the original prompt first) and the final assistant reply of one
 * task, or null when a message carries `<no-memory>`.
 */
export function extractDreamConversation(
  task: Task,
  events: TaskEvent[],
): { userMessages: string[]; finalReply: string | null } | null {
  const prompt = task.rawPrompt || task.userPrompt || task.prompt;
  const messages: string[] = [];
  let finalReply: string | null = null;
  let completionSummary: string | null = null;
  for (const event of events) {
    const type = eventType(event);
    const payload = payloadOf(event);
    if (type === "user_message") {
      // Messages another agent sent into the task are not the user's words.
      if (payload.messageSource === "agent") continue;
      if (containsNoMemoryDirective(payload.message)) return null;
      const text = trimText(payload.message, MAX_MESSAGE_CHARS);
      if (text) messages.push(text);
    } else if (type === "assistant_message") {
      if (payload.internal === true) continue;
      const text = trimText(payload.message, MAX_REPLY_CHARS);
      if (text) finalReply = text;
    } else if (type === "task_completed") {
      const text = trimText(payload.resultSummary || payload.message, MAX_REPLY_CHARS);
      if (text) completionSummary = text;
    }
  }
  const first = trimText(prompt, MAX_MESSAGE_CHARS);
  const userMessages = first && messages[0] !== first ? [first, ...messages] : messages;
  // Keep the original request and the most recent follow-ups.
  const bounded =
    userMessages.length > MAX_USER_MESSAGES
      ? [userMessages[0], ...userMessages.slice(-(MAX_USER_MESSAGES - 1))]
      : userMessages;
  return { userMessages: bounded, finalReply: finalReply ?? completionSummary };
}

function policyAllows(policy: MemoryWorkspacePolicy | null): boolean {
  if (!policy) return true;
  return policy.enabled && policy.privacyMode !== "disabled" && policy.privacyMode !== "strict";
}

/**
 * `listRecentTasks` for the dreamer: finished tasks created after `sinceMs`, oldest first,
 * stopping before the oldest task that is still running. The dreamer moves its cursor to the
 * newest task it read, so taking the oldest ones first (and never passing a running task)
 * means a later dream reads what this one could not.
 */
export function createDreamTaskLister(
  deps: DreamTaskSourceDeps,
): (sinceMs: number, limit: number) => Promise<DreamTaskInput[]> {
  return async (sinceMs, limit) => {
    const max = Math.max(0, Math.floor(limit));
    if (max === 0) return [];
    const now = (deps.now ?? Date.now)();
    const startMs = Number.isFinite(sinceMs) ? Math.floor(sinceMs) + 1 : 0;
    const created = (
      await deps.findTasksCreatedBetween({ startMs, endMs: now + 1, limit: CANDIDATE_LIMIT })
    ).filter((task) => task.createdAt > sinceMs);
    // Only a task that is really in progress holds the cursor back. Paused, pending or
    // abandoned tasks (and bot tasks, which never finish) would otherwise block it forever,
    // and no dream would ever see a new task.
    const oldestRunning = created
      .filter((task) => isInProgressTask(task, now))
      .reduce((min, task) => Math.min(min, task.createdAt), Number.POSITIVE_INFINITY);
    const candidates = created
      .filter((task) => task.createdAt < oldestRunning && isDreamCandidateTask(task))
      .sort((a, b) => a.createdAt - b.createdAt);
    const policies = new Map<string, boolean>();
    const names = new Map<string, string | null>();
    const result: DreamTaskInput[] = [];
    for (const task of candidates) {
      if (result.length >= max) break;
      try {
        if (deps.getWorkspacePolicy && task.workspaceId) {
          if (!policies.has(task.workspaceId)) {
            policies.set(
              task.workspaceId,
              policyAllows(await deps.getWorkspacePolicy(task.workspaceId)),
            );
          }
          if (!policies.get(task.workspaceId)) continue;
        }
        const events = await deps.findTaskEvents(
          task.id,
          DREAM_TASK_EVENT_TYPES,
          MAX_EVENTS_PER_TASK,
        );
        const conversation = extractDreamConversation(task, events);
        if (!conversation || conversation.userMessages.length === 0) continue;
        if (deps.workspaceName && task.workspaceId && !names.has(task.workspaceId)) {
          names.set(task.workspaceId, await deps.workspaceName(task.workspaceId));
        }
        result.push({
          taskId: task.id,
          title: trimText(task.title, MAX_TITLE_CHARS) || "Untitled task",
          workspaceId: task.workspaceId ?? null,
          workspaceName: names.get(task.workspaceId) ?? null,
          createdAt: task.createdAt,
          userMessages: conversation.userMessages,
          finalReply: conversation.finalReply,
        });
      } catch (error) {
        logger.warn(`Skipping task ${task.id} for the dream:`, error);
      }
    }
    return result;
  };
}
