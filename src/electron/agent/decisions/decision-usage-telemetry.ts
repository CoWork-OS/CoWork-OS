import { randomUUID } from "node:crypto";
import { DatabaseManager } from "../../database/schema";
import type { JevUsage } from "./types";

export interface JevDecisionTelemetryContext {
  workspaceId?: string | null;
  taskId?: string | null;
  sourceKind?: string | null;
}

export interface JevDecisionTelemetryInput extends JevDecisionTelemetryContext {
  sourceId?: string | null;
  providerType?: string | null;
  modelId?: string | null;
  purpose?: string | null;
  status: string;
  latencyMs?: number;
  fromCache?: boolean;
  requestId?: string | null;
  usage?: JevUsage;
  errorCode?: string | null;
  errorMessage?: string | null;
  timestamp?: number;
}

function getDb() {
  try {
    return DatabaseManager.getInstance().getDatabase();
  } catch {
    return null;
  }
}

function boundedText(value: unknown, maxLength: number): string | null {
  const text = String(value || "").trim();
  return text ? text.slice(0, maxLength) : null;
}

function safeErrorMessage(value: unknown): string | null {
  const text = boundedText(value, 500);
  if (!text) return null;
  return text
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/\b(api[_-]?key|token|secret|password)\b\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .slice(0, 500);
}

function safeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function safeCost(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

/**
 * Persist Jev usage independently from LLM usage.
 *
 * Jev providers report their own token/cost units. We intentionally store the
 * provider-reported cost instead of applying the LLM pricing table.
 */
export function recordJevCall(input: JevDecisionTelemetryInput): void {
  const db = getDb();
  if (!db) return;

  const fromCache = input.fromCache === true;
  const inputTokens = fromCache ? 0 : safeInteger(input.usage?.input_tokens);
  const outputTokens = fromCache ? 0 : safeInteger(input.usage?.output_tokens);
  const cost = fromCache ? 0 : safeCost(input.usage?.cost);
  const status = boundedText(input.status, 40) || "unknown";
  const sourceKind = boundedText(input.sourceKind, 80) || "decision_service";
  const purpose = boundedText(input.purpose, 80) || "decision";
  const providerType = boundedText(input.providerType, 40);
  const modelId = boundedText(input.modelId, 200);
  const sourceId = boundedText(input.sourceId, 200);
  const requestId = boundedText(input.requestId, 200);
  const latencyMs = safeInteger(input.latencyMs);
  const success = status === "success" ? 1 : 0;

  try {
    db.prepare(
      `INSERT INTO jev_call_events (
        id,
        timestamp,
        workspace_id,
        task_id,
        source_kind,
        source_id,
        provider_type,
        model_id,
        purpose,
        input_tokens,
        output_tokens,
        cost,
        latency_ms,
        status,
        from_cache,
        success,
        request_id,
        error_code,
        error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      input.timestamp ?? Date.now(),
      input.workspaceId || null,
      input.taskId || null,
      sourceKind,
      sourceId,
      providerType,
      modelId,
      purpose,
      inputTokens,
      outputTokens,
      cost,
      latencyMs,
      status,
      fromCache ? 1 : 0,
      success,
      requestId,
      boundedText(input.errorCode, 80),
      safeErrorMessage(input.errorMessage),
    );
  } catch {
    // Best-effort telemetry must never affect a decision or task execution.
  }
}
