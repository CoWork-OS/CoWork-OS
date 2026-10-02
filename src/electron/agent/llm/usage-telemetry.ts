import { randomUUID } from "crypto";
import type { LLMResponse } from "./types";
import { DatabaseManager } from "../../database/schema";
import { UsageInsightsProjector } from "../../reports/UsageInsightsProjector";
import { normalizeLlmProviderType } from "../../../shared/llmProviderDisplay";
import { calculateCost } from "./pricing";
import type { LlmCallRow } from "../../database/llm-call-events";
import { serviceStatements } from "../../database/service-statements";

export type LlmCallTelemetryInput = {
  workspaceId?: string | null;
  taskId?: string | null;
  sourceKind: string;
  sourceId?: string | null;
  providerType?: string | null;
  modelKey?: string | null;
  modelId?: string | null;
  timestamp?: number;
};

function redactErrorMessage(value: string): string {
  return String(value || "")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
    .replace(
      /([?&](?:api[_-]?key|token|access[_-]?token|refresh[_-]?token)=)[^&\s]+/gi,
      "$1[REDACTED]",
    )
    .replace(
      /((?:api[_-]?key|token|access[_-]?token|refresh[_-]?token)\s*[:=]\s*)[^\s,;]+/gi,
      "$1[REDACTED]",
    )
    .replace(/\b(?:sk|rk|pk|ghp|github_pat)_[A-Za-z0-9._-]+\b/g, "[REDACTED]")
    .slice(0, 500);
}

function getDb() {
  try {
    return DatabaseManager.getInstance().getDatabase();
  } catch {
    return null;
  }
}

/** Build the usage row for a successful call; the host or the database worker inserts it. */
export function prepareLlmCallSuccess(
  input: LlmCallTelemetryInput,
  usage?: LLMResponse["usage"],
): LlmCallRow {
  const inputTokens = Math.max(0, Number(usage?.inputTokens || 0));
  const outputTokens = Math.max(0, Number(usage?.outputTokens || 0));
  const cachedTokens = Math.max(0, Number(usage?.cachedTokens || 0));
  const cacheWriteTokens = Math.max(0, Number(usage?.cacheWriteTokens || 0));
  const modelId = input.modelId || input.modelKey || "";
  const providerType = normalizeLlmProviderType(input.providerType) || null;
  const cost =
    inputTokens > 0 || outputTokens > 0 || cachedTokens > 0 || cacheWriteTokens > 0
      ? calculateCost(
          modelId,
          inputTokens,
          outputTokens,
          cachedTokens,
          cacheWriteTokens,
          "inclusive",
          {
            providerType,
            cacheTtl: usage?.cacheWriteTtl,
          },
        )
      : 0;
  const timestamp = input.timestamp || Date.now();
  return {
    workspaceId: input.workspaceId || null,
    timestamp,
    params: [
      randomUUID(),
      timestamp,
      input.workspaceId || null,
      input.taskId || null,
      input.sourceKind,
      input.sourceId || null,
      providerType,
      input.modelKey || input.modelId || null,
      input.modelId || input.modelKey || null,
      inputTokens,
      outputTokens,
      cachedTokens,
      cost,
      1,
      null,
      null,
    ],
  };
}

/** Build the usage row for a failed call; the host or the database worker inserts it. */
export function prepareLlmCallError(input: LlmCallTelemetryInput, error: unknown): LlmCallRow {
  const errorObj =
    error && typeof error === "object"
      ? (error as { code?: unknown; message?: unknown; name?: unknown })
      : null;
  const errorCode =
    typeof errorObj?.code === "string"
      ? errorObj.code
      : typeof errorObj?.name === "string"
        ? errorObj.name
        : "llm_error";
  const errorMessage =
    typeof errorObj?.message === "string"
      ? redactErrorMessage(errorObj.message)
      : redactErrorMessage(String(error || "LLM error"));
  const providerType = normalizeLlmProviderType(input.providerType) || null;
  const timestamp = input.timestamp || Date.now();
  return {
    workspaceId: input.workspaceId || null,
    timestamp,
    params: [
      randomUUID(),
      timestamp,
      input.workspaceId || null,
      input.taskId || null,
      input.sourceKind,
      input.sourceId || null,
      providerType,
      input.modelKey || input.modelId || null,
      input.modelId || input.modelKey || null,
      0,
      0,
      0,
      0,
      0,
      errorCode,
      errorMessage,
    ],
  };
}

/** Host-only follow-up once a usage row is committed. */
export function afterLlmCallRow(row: LlmCallRow): void {
  UsageInsightsProjector.getIfInitialized()?.enqueueLlmTelemetry(row.workspaceId, row.timestamp);
}

/**
 * Insert a prepared usage row (best effort, like the recorders): one services-domain unit,
 * started without holding up the caller; the host follow-up runs once it commits.
 */
export function commitLlmCallRow(row: LlmCallRow): void {
  const db = getDb();
  if (!db) return;
  void serviceStatements(db)
    .unit("usageTelemetry_insertLlmCall", [row])
    .then(() => afterLlmCallRow(row))
    .catch(() => {
      // Best-effort telemetry only.
    });
}

export function recordLlmCallSuccess(
  input: LlmCallTelemetryInput,
  usage?: LLMResponse["usage"],
): void {
  try {
    commitLlmCallRow(prepareLlmCallSuccess(input, usage));
  } catch {
    // Best-effort telemetry only.
  }
}

export function recordLlmCallError(input: LlmCallTelemetryInput, error: unknown): void {
  try {
    commitLlmCallRow(prepareLlmCallError(input, error));
  } catch {
    // Best-effort telemetry only.
  }
}

export interface TaskCostEstimate {
  modelId: string;
  /** Number of past tasks the estimate is based on. */
  sampleSize: number;
  medianCost: number;
  /** Cost that 90% of past tasks stayed under. */
  p90Cost: number;
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index];
}

/**
 * Typical cost of a task on this model, from the user's own recent tasks (last 30 with
 * a known cost). Returns null when there is too little history to say anything useful.
 * Nothing leaves the machine; this only reads the local llm_call_events table.
 */
export async function estimateTaskCost(
  modelId: string,
  minSamples = 3,
): Promise<TaskCostEstimate | null> {
  const db = getDb();
  const model = String(modelId || "").trim();
  if (!db || !model) return null;
  try {
    const totals = (await serviceStatements(db).unit("usageTelemetry_taskCostTotals", [model]))
      .filter((value) => Number.isFinite(value) && value > 0)
      .sort((a, b) => a - b);
    if (totals.length < minSamples) return null;
    return {
      modelId: model,
      sampleSize: totals.length,
      medianCost: percentile(totals, 0.5),
      p90Cost: percentile(totals, 0.9),
    };
  } catch {
    return null;
  }
}
