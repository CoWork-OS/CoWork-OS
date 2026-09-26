import { randomUUID } from "crypto";
import type { LLMResponse } from "./types";
import { DatabaseManager } from "../../database/schema";
import { UsageInsightsProjector } from "../../reports/UsageInsightsProjector";
import { normalizeLlmProviderType } from "../../../shared/llmProviderDisplay";
import { calculateCost, getCacheTokenAccounting } from "./pricing";

type LlmCallTelemetryInput = {
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

export function recordLlmCallSuccess(
  input: LlmCallTelemetryInput,
  usage?: LLMResponse["usage"],
): void {
  const db = getDb();
  if (!db) return;

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
          getCacheTokenAccounting(providerType, modelId),
          {
            providerType,
            cacheTtl: usage?.cacheWriteTtl,
          },
        )
      : 0;

  try {
    const timestamp = input.timestamp || Date.now();
    db.prepare(
      `INSERT INTO llm_call_events (
        id,
        timestamp,
        workspace_id,
        task_id,
        source_kind,
        source_id,
        provider_type,
        model_key,
        model_id,
        input_tokens,
        output_tokens,
        cached_tokens,
        cost,
        success,
        error_code,
        error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, NULL)`,
    ).run(
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
    );
    UsageInsightsProjector.getIfInitialized()?.enqueueLlmTelemetry(
      input.workspaceId || null,
      timestamp,
    );
  } catch {
    // Best-effort telemetry only.
  }
}

export function recordLlmCallError(input: LlmCallTelemetryInput, error: unknown): void {
  const db = getDb();
  if (!db) return;

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

  try {
    const timestamp = input.timestamp || Date.now();
    db.prepare(
      `INSERT INTO llm_call_events (
        id,
        timestamp,
        workspace_id,
        task_id,
        source_kind,
        source_id,
        provider_type,
        model_key,
        model_id,
        input_tokens,
        output_tokens,
        cached_tokens,
        cost,
        success,
        error_code,
        error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, ?, ?)`,
    ).run(
      randomUUID(),
      timestamp,
      input.workspaceId || null,
      input.taskId || null,
      input.sourceKind,
      input.sourceId || null,
      providerType,
      input.modelKey || input.modelId || null,
      input.modelId || input.modelKey || null,
      errorCode,
      errorMessage,
    );
    UsageInsightsProjector.getIfInitialized()?.enqueueLlmTelemetry(
      input.workspaceId || null,
      timestamp,
    );
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
export function estimateTaskCost(modelId: string, minSamples = 3): TaskCostEstimate | null {
  const db = getDb();
  const model = String(modelId || "").trim();
  if (!db || !model) return null;
  try {
    const rows = db
      .prepare(
        `SELECT task_id, SUM(cost) AS total
           FROM llm_call_events
          WHERE (model_id = ? OR model_key = ?) AND task_id IS NOT NULL AND success = 1
          GROUP BY task_id
         HAVING SUM(cost) > 0
          ORDER BY MAX(timestamp) DESC
          LIMIT 30`,
      )
      .all(model, model) as Array<{ task_id: string; total: number }>;
    const totals = rows
      .map((row) => Number(row.total))
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
