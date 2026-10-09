import type { TaskEvent } from "../../shared/types";
import { getEffectiveTaskEventType } from "./task-event-compat";
import { getTaskEventIdentity } from "./task-event-stream";

/** Cumulative usage carried by one `llm_usage` event (its `totals`, or the payload itself). */
export type LlmUsageTotals = {
  inputTokens: number;
  outputTokens: number;
  cost: number;
  /** False when a model had no known price, so `cost` is a lower bound. */
  costKnown: boolean;
};

/**
 * Usage accumulated for one task from every `llm_usage` event the renderer has seen,
 * independent of how many timeline events are retained. Token and cost totals are the
 * highest cumulative values reported, and each distinct usage event counts as one call,
 * so the numbers never go backwards when older events are evicted or history is refetched.
 */
export type TaskUsageTotals = LlmUsageTotals & {
  llmCallCount: number;
  countedEventKeys: ReadonlySet<string>;
};

export type TaskUsageTotalsByTaskId = Readonly<Record<string, TaskUsageTotals>>;

function toFiniteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function isLlmUsageEvent(event: TaskEvent): boolean {
  return getEffectiveTaskEventType(event) === "llm_usage";
}

export function readLlmUsageTotals(event: TaskEvent): LlmUsageTotals {
  const payload =
    event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
      ? (event.payload as Record<string, unknown>)
      : {};
  const totals =
    payload.totals && typeof payload.totals === "object" && !Array.isArray(payload.totals)
      ? (payload.totals as Record<string, unknown>)
      : payload;
  return {
    inputTokens: toFiniteNumber(totals.inputTokens ?? totals.input_tokens),
    outputTokens: toFiniteNumber(totals.outputTokens ?? totals.output_tokens),
    cost: toFiniteNumber(totals.cost ?? totals.totalCost ?? payload.totalCost),
    costKnown: totals.costKnown !== false,
  };
}

function getUsageEventKeys(event: TaskEvent, totals: LlmUsageTotals): [string, string] {
  // A usage event can reach the renderer twice (live and through a history refetch),
  // possibly under different identities. Its cumulative totals identify it as well.
  return [
    getTaskEventIdentity(event),
    `totals:${totals.inputTokens}:${totals.outputTokens}:${totals.cost}`,
  ];
}

/**
 * Fold `llm_usage` events into per-task cumulative usage. Returns `previous` unchanged
 * when no event adds a new call or a higher total, so it is safe as a state updater.
 */
export function accumulateTaskUsage(
  previous: TaskUsageTotalsByTaskId,
  events: readonly TaskEvent[],
): TaskUsageTotalsByTaskId {
  let next: Record<string, TaskUsageTotals> | null = null;
  for (const event of events) {
    if (!event?.taskId || !isLlmUsageEvent(event)) continue;
    const totals = readLlmUsageTotals(event);
    const [identityKey, totalsKey] = getUsageEventKeys(event, totals);
    const current = (next ?? previous)[event.taskId];
    const alreadyCounted =
      current?.countedEventKeys.has(identityKey) || current?.countedEventKeys.has(totalsKey);
    const updated: TaskUsageTotals = {
      inputTokens: Math.max(current?.inputTokens ?? 0, totals.inputTokens),
      outputTokens: Math.max(current?.outputTokens ?? 0, totals.outputTokens),
      cost: Math.max(current?.cost ?? 0, totals.cost),
      // An unpriced model makes every later total a lower bound, so this never resets.
      costKnown: (current?.costKnown ?? true) && totals.costKnown,
      llmCallCount: (current?.llmCallCount ?? 0) + (alreadyCounted ? 0 : 1),
      countedEventKeys: alreadyCounted
        ? (current?.countedEventKeys ?? new Set<string>())
        : new Set([...(current?.countedEventKeys ?? []), identityKey, totalsKey]),
    };
    if (
      current &&
      alreadyCounted &&
      updated.inputTokens === current.inputTokens &&
      updated.outputTokens === current.outputTokens &&
      updated.cost === current.cost &&
      updated.costKnown === current.costKnown
    ) {
      continue;
    }
    next ??= { ...previous };
    next[event.taskId] = updated;
  }
  return next ?? previous;
}

/** Drop accumulated usage for tasks outside `taskIds`; returns `previous` when nothing changes. */
export function retainTaskUsage(
  previous: TaskUsageTotalsByTaskId,
  taskIds: Iterable<string>,
): TaskUsageTotalsByTaskId {
  const keep = new Set(taskIds);
  const keys = Object.keys(previous);
  if (keys.every((taskId) => keep.has(taskId))) return previous;
  const next: Record<string, TaskUsageTotals> = {};
  for (const taskId of keys) {
    if (keep.has(taskId)) next[taskId] = previous[taskId];
  }
  return next;
}
