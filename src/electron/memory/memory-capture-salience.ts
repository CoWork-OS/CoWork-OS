import type { MemoryType } from "../database/repositories";

/**
 * Salience-gated archive capture of task events (audit DATA-2).
 *
 * The archive used to receive one row per task event: tool calls and results, step
 * start/completion, raw plan JSON, every assistant message. Most of that is telemetry
 * that the task timeline already keeps. Only events that are worth recalling in a later
 * task are archived now:
 *   - the task outcome (completion summary),
 *   - user feedback / decisions,
 *   - errors that affected the task (compact), and verification failures.
 * User corrections are captured separately, once, where they are detected (daemon).
 */

/**
 * Tools whose output is recalled memory (or memory writes). Their events are never
 * archived: archiving a recall re-captures memories as new ones.
 */
export const MEMORY_RECALL_TOOL_NAMES: ReadonlySet<string> = new Set([
  // Consolidated memory tools (audit §8.3): recall output is never captured again, and a
  // remember/forget call already is the memory write.
  "memory_recall",
  "memory_remember",
  "memory_forget",
  "context_recall",
  // Deprecated aliases (still executable for one release).
  "memory_search_index",
  "memory_timeline",
  "memory_details",
  "memory_topics_load",
  "memory_curated_read",
  "memory_curate",
  "memory_save",
  "search_memories",
  "search_quotes",
  "search_sessions",
  "context_grep",
  "context_describe",
  "supermemory_profile",
  "supermemory_search",
  "supermemory_remember",
  "supermemory_forget",
  "kg_search",
  "kg_get_neighbors",
  "kg_get_subgraph",
  "kg_create_entity",
  "kg_update_entity",
  "kg_delete_entity",
  "kg_create_edge",
  "kg_delete_edge",
  "kg_invalidate_edge",
  "kg_add_observation",
  "task_events",
  "task_history",
  "scratchpad_read",
]);

export function isMemoryRecallTool(name: unknown): boolean {
  return typeof name === "string" && MEMORY_RECALL_TOOL_NAMES.has(name.trim());
}

export interface SalientTaskEventCapture {
  memoryType: MemoryType;
  content: string;
}

export interface SalientTaskContext {
  title?: string | null;
  prompt?: string | null;
}

const MAX_CONTENT_CHARS = 2_000;
const MAX_ERROR_CHARS = 500;

function text(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value instanceof Error) return value.message.trim();
  return "";
}

function clip(value: string, max: number): string {
  const normalized = value.replace(/\s+\n/g, "\n").trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function errorText(payload: Record<string, unknown>): string {
  const error = payload.error;
  const fromObject =
    error && typeof error === "object" ? text((error as Record<string, unknown>).message) : "";
  return clip(
    text(error) || fromObject || text(payload.message) || text(payload.reason) || "Unknown error",
    MAX_ERROR_CHARS,
  );
}

/**
 * The archive row for one task event, or `null` when the event is not salient.
 * `type` is the event's legacy type (for example `tool_error`, `task_completed`).
 */
export function buildSalientTaskEventCapture(
  type: string,
  rawPayload: unknown,
  task: SalientTaskContext = {},
): SalientTaskEventCapture | null {
  const payload =
    rawPayload && typeof rawPayload === "object" && !Array.isArray(rawPayload)
      ? (rawPayload as Record<string, unknown>)
      : {};
  const toolName = text(payload.tool) || text(payload.name);
  const title = text(task.title);

  switch (type) {
    case "task_completed": {
      const outcome = text(payload.resultSummary) || text(payload.message);
      if (!outcome) return null;
      const lines = [
        `Task completed${title ? `: "${clip(title, 200)}"` : ""}`,
        task.prompt ? `Request: ${clip(text(task.prompt), 300)}` : "",
        `Outcome: ${clip(outcome, MAX_CONTENT_CHARS)}`,
      ].filter(Boolean);
      return { memoryType: "summary", content: lines.join("\n") };
    }
    case "user_feedback": {
      const decision = text(payload.decision);
      const reason = text(payload.reason);
      if (!decision && !reason) return null;
      const content = [
        decision ? `Decision: ${clip(decision, 200)}` : "Feedback received",
        reason ? `Reason: ${clip(reason, MAX_CONTENT_CHARS)}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      return { memoryType: "decision", content };
    }
    case "tool_error": {
      if (isMemoryRecallTool(toolName)) return null;
      return {
        memoryType: "error",
        content: `Tool error for ${toolName || "unknown tool"}: ${errorText(payload)}`,
      };
    }
    case "step_failed": {
      const step = payload.step as Record<string, unknown> | undefined;
      const description = clip(text(step?.description), 200);
      return {
        memoryType: "error",
        content: `Step failed${description ? `: ${description}` : ""}\nError: ${errorText(payload)}`,
      };
    }
    case "error":
      return { memoryType: "error", content: `Task error: ${errorText(payload)}` };
    case "verification_failed":
      return {
        memoryType: "error",
        content: `Verification failed: ${clip(
          text(payload.message) || text(payload.error) || "Unknown failure",
          MAX_CONTENT_CHARS,
        )}`,
      };
    default:
      // Raw telemetry: tool_call, tool_result, step_started, step_completed,
      // plan_created / plan_revised, assistant/user messages, file events,
      // verification_passed. The task timeline keeps these.
      return null;
  }
}
