/**
 * Shared contracts for model-context compaction.
 *
 * Compaction is a projection change: the complete transcript remains durable,
 * while the model receives a smaller replacement history.  Keep the event
 * payload deliberately provider-neutral so the renderer, replay protocol, and
 * runtime snapshots can share the same lifecycle contract.
 */

export type ContextCompactionTrigger =
  | "automatic"
  | "manual"
  | "continuation"
  | "capacity_recovery";

export type ContextCompactionPhase = "pre_turn" | "mid_turn" | "post_turn" | "manual";

export type ContextCompactionStatus = "started" | "completed" | "failed" | "interrupted";

export type ContextCompactionEventType =
  | "context_compaction_started"
  | "context_compaction_completed"
  | "context_compaction_failed";

export interface ContextCompactionEventPayload {
  /** Stable for one compaction lifecycle, including provider retries. */
  compactionId: string;
  /** Unique for one summary/provider attempt. */
  attemptId?: string;
  status: ContextCompactionStatus;
  trigger: ContextCompactionTrigger;
  phase: ContextCompactionPhase;
  reason?: string;

  historyGenerationBefore: number;
  historyGenerationAfter?: number;

  inputTokens?: number;
  replacementTokens?: number;
  inputMessageCount?: number;
  replacementMessageCount?: number;
  removedMessageCount?: number;
  removedApproxTokens?: number;
  thresholdRatio?: number;
  targetRatio?: number;
  contextWindowTokens?: number;
  accountingSource?: "estimate" | "provider";

  summaryPreview?: string;
  summaryRef?: string;
  fallbackUsed?: boolean;
  retryable?: boolean;
  failureStage?: string;
  errorCode?: string;

  /** Extra provider/runtime fields remain forward-compatible. */
  [key: string]: unknown;
}

export const DEFAULT_CONTEXT_COMPACTION_TRIGGER_RATIO = 0.9;
export const DEFAULT_CONTEXT_COMPACTION_TARGET_RATIO = 0.55;
export const CONTEXT_COMPACTION_OVERFLOW_TARGET_RATIO = 0.35;
export const CONTEXT_COMPACTION_MIN_HEADROOM_TOKENS = 512;
export const CONTEXT_COMPACTION_RECENT_USER_MESSAGE_MAX_TOKENS = 20_000;

export interface ContextCompactionPolicyInput {
  availableTokens: number;
  currentTokens: number;
  triggerRatio?: number;
  targetRatio?: number;
  overflow?: boolean;
}

export interface ContextCompactionPolicy {
  availableTokens: number;
  currentTokens: number;
  triggerRatio: number;
  targetRatio: number;
  triggerTokens: number;
  targetTokens: number;
  shouldCompact: boolean;
}

function clampRatio(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0.1, Math.min(0.95, value as number));
}

/**
 * Resolve the single context policy used by normal, continuation, and
 * recovery compaction.  The caller supplies the model-specific available
 * budget; this helper intentionally does not know provider model limits.
 */
export function resolveContextCompactionPolicy(
  input: ContextCompactionPolicyInput,
): ContextCompactionPolicy {
  const availableTokens = Math.max(0, Math.floor(input.availableTokens || 0));
  const currentTokens = Math.max(0, Math.floor(input.currentTokens || 0));
  const triggerRatio = clampRatio(input.triggerRatio, DEFAULT_CONTEXT_COMPACTION_TRIGGER_RATIO);
  const requestedTarget = input.overflow
    ? CONTEXT_COMPACTION_OVERFLOW_TARGET_RATIO
    : (input.targetRatio ?? DEFAULT_CONTEXT_COMPACTION_TARGET_RATIO);
  const targetRatio = Math.min(
    clampRatio(requestedTarget, DEFAULT_CONTEXT_COMPACTION_TARGET_RATIO),
    Math.max(0.1, triggerRatio - 0.05),
  );
  const triggerTokens = Math.max(1, Math.floor(availableTokens * triggerRatio));
  const targetTokens = Math.max(0, Math.floor(availableTokens * targetRatio));

  return {
    availableTokens,
    currentTokens,
    triggerRatio,
    targetRatio,
    triggerTokens,
    targetTokens,
    shouldCompact:
      availableTokens > 0 && (currentTokens >= triggerTokens || currentTokens > availableTokens),
  };
}

export function isContextCompactionEventType(value: unknown): value is ContextCompactionEventType {
  return (
    value === "context_compaction_started" ||
    value === "context_compaction_completed" ||
    value === "context_compaction_failed"
  );
}

export function isContextCompactionEventPayload(
  value: unknown,
): value is ContextCompactionEventPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  const statuses = new Set<ContextCompactionStatus>([
    "started",
    "completed",
    "failed",
    "interrupted",
  ]);
  const triggers = new Set<ContextCompactionTrigger>([
    "automatic",
    "manual",
    "continuation",
    "capacity_recovery",
  ]);
  const phases = new Set<ContextCompactionPhase>(["pre_turn", "mid_turn", "post_turn", "manual"]);
  return (
    typeof payload.compactionId === "string" &&
    payload.compactionId.trim().length > 0 &&
    typeof payload.status === "string" &&
    statuses.has(payload.status as ContextCompactionStatus) &&
    typeof payload.trigger === "string" &&
    triggers.has(payload.trigger as ContextCompactionTrigger) &&
    typeof payload.phase === "string" &&
    phases.has(payload.phase as ContextCompactionPhase) &&
    typeof payload.historyGenerationBefore === "number" &&
    Number.isFinite(payload.historyGenerationBefore)
  );
}

export function compactPreview(value: unknown, maxCharacters = 360): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length > maxCharacters
    ? `${normalized.slice(0, Math.max(0, maxCharacters - 1)).trimEnd()}…`
    : normalized;
}
