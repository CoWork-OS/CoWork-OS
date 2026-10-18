import { createHash, randomUUID } from "node:crypto";
import type { ToolAttempt, ToolAttemptEffect } from "../../../shared/types";
import { createLogger } from "../../utils/logger";
import { normalizeToolOutcome } from "./tool-outcome";
import { suggestedReadBackTool, toolCallTarget } from "./tool-effect";

const logger = createLogger("ToolAttempts");

/** The persistence the tracker needs; `ToolAttemptRepository` in production. */
export interface ToolAttemptPersistence {
  begin(input: {
    id: string;
    taskId: string;
    stepId?: string;
    toolName: string;
    argsHash: string;
    idempotencyKey: string;
    effect: Exclude<ToolAttemptEffect, "read">;
    target?: string;
    startedAt: number;
  }): Promise<ToolAttempt>;
  finish(
    id: string,
    status: "completed" | "failed" | "unknown" | "cancelled" | "checked",
    finishedAt: number,
    reason?: string,
  ): Promise<ToolAttempt | undefined>;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

export function toolArgsHash(input: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(input ?? null)))
    .digest("hex");
}

/**
 * Stable across retries and restarts: it depends only on persisted inputs (task, step, tool,
 * canonical arguments), so the same call always carries the same key.
 */
export function toolIdempotencyKey(
  taskId: string,
  stepId: string | undefined,
  toolName: string,
  input: unknown,
): string {
  return createHash("sha256")
    .update([taskId, stepId ?? "", toolName, toolArgsHash(input)].join("\n"))
    .digest("hex")
    .slice(0, 32);
}

/** Thrown in place of a timeout or lost transport for a call that may have had its effect. */
export class ToolOutcomeUnknownError extends Error {
  readonly outcome = "unknown" as const;

  constructor(
    readonly toolName: string,
    readonly idempotencyKey: string,
    readonly attemptId: string,
    readonly target: string | undefined,
    readonly causeMessage: string,
  ) {
    super(
      `Outcome unknown: ${toolName} may have completed (${causeMessage}). ` +
        "Do not repeat it blindly. " +
        `First check the current state with ${suggestedReadBackTool(toolName, target)}. ` +
        `If you must retry, reuse idempotency key ${idempotencyKey}.`,
    );
    this.name = "ToolOutcomeUnknownError";
  }
}

export function isToolOutcomeUnknownError(error: unknown): error is ToolOutcomeUnknownError {
  return error instanceof ToolOutcomeUnknownError;
}

export interface ToolAttemptHandle {
  attempt: ToolAttempt;
}

/**
 * Per-task bookkeeping for calls that write or whose effect is unknown. Persistence failures
 * are logged and never block the tool call.
 */
export class ToolAttemptTracker {
  /** Unknown-outcome attempts by target, waiting for a read-back. */
  private readonly unknownByTarget = new Map<string, string[]>();

  constructor(
    private readonly store: ToolAttemptPersistence | undefined,
    private readonly taskId: string,
    /** Told when a call of this task ends with an unknown outcome. */
    private readonly onUnknownOutcome?: () => void,
  ) {}

  async begin(
    toolName: string,
    input: unknown,
    effect: ToolAttemptEffect,
    stepId?: string,
  ): Promise<ToolAttemptHandle | null> {
    if (!this.store || effect === "read") return null;
    try {
      const attempt = await this.store.begin({
        id: randomUUID(),
        taskId: this.taskId,
        ...(stepId ? { stepId } : {}),
        toolName,
        argsHash: toolArgsHash(input),
        idempotencyKey: toolIdempotencyKey(this.taskId, stepId, toolName, input),
        effect,
        ...(toolCallTarget(input) ? { target: toolCallTarget(input) } : {}),
        startedAt: Date.now(),
      });
      return { attempt };
    } catch (error) {
      logger.warn(`Could not record the ${toolName} attempt:`, error);
      return null;
    }
  }

  /** The call returned: completed, or failed when the tool reported `success: false`. */
  async completed(handle: ToolAttemptHandle | null, succeeded = true): Promise<void> {
    if (!handle) return;
    await this.finish(handle, succeeded ? "completed" : "failed");
    if (succeeded) this.forgetTarget(handle.attempt);
  }

  /**
   * Record a failed or interrupted call. Returns the error to surface: a ToolOutcomeUnknownError
   * when the call was dispatched and its effect cannot be known, the original error otherwise.
   */
  async failed(
    handle: ToolAttemptHandle | null,
    error: unknown,
    aborted: boolean,
  ): Promise<unknown> {
    if (!handle) return error;
    const { attempt } = handle;
    const outcome = normalizeToolOutcome(undefined, error, {
      effect: attempt.effect,
      aborted,
    });
    const causeMessage =
      error instanceof Error && error.message ? error.message.slice(0, 200) : "no result";
    if (outcome.status === "unknown") {
      await this.finish(handle, "unknown", causeMessage);
      this.onUnknownOutcome?.();
      if (attempt.target) {
        const ids = this.unknownByTarget.get(attempt.target) ?? [];
        this.unknownByTarget.set(attempt.target, [...ids, attempt.id]);
      }
      return new ToolOutcomeUnknownError(
        attempt.toolName,
        attempt.idempotencyKey,
        attempt.id,
        attempt.target,
        causeMessage,
      );
    }
    await this.finish(
      handle,
      outcome.status === "cancelled" ? "cancelled" : "failed",
      causeMessage,
    );
    return error;
  }

  /** A successful read of a target an unknown write touched: the model has now seen its state. */
  async readBack(toolName: string, input: unknown): Promise<void> {
    if (!this.store) return;
    const target = toolCallTarget(input);
    const ids = target ? this.unknownByTarget.get(target) : undefined;
    if (!target || !ids?.length) return;
    this.unknownByTarget.delete(target);
    for (const id of ids) {
      try {
        await this.store.finish(id, "checked", Date.now(), `read_back:${toolName}`);
      } catch (error) {
        logger.warn(`Could not record the read-back of ${target}:`, error);
      }
    }
  }

  private forgetTarget(attempt: ToolAttempt): void {
    // A later completed call on the same target settles earlier unknown ones by the same key.
    if (attempt.target) this.unknownByTarget.delete(attempt.target);
  }

  private async finish(
    handle: ToolAttemptHandle,
    status: "completed" | "failed" | "unknown" | "cancelled",
    reason?: string,
  ): Promise<void> {
    try {
      await this.store?.finish(handle.attempt.id, status, Date.now(), reason);
    } catch (error) {
      logger.warn(`Could not record the ${handle.attempt.toolName} outcome:`, error);
    }
  }
}

/**
 * Calls whose outcome is still unknown at the end of a task: unknown, never read back, and
 * not followed by a completed call with the same idempotency key.
 */
export function unresolvedUnknownAttempts(attempts: readonly ToolAttempt[]): ToolAttempt[] {
  const completedKeys = new Set(
    attempts
      .filter((attempt) => attempt.status === "completed")
      .map((attempt) => attempt.idempotencyKey),
  );
  return attempts.filter(
    (attempt) => attempt.status === "unknown" && !completedKeys.has(attempt.idempotencyKey),
  );
}

export function describeUnverifiedAttempts(attempts: readonly ToolAttempt[]): string {
  const listed = attempts
    .slice(0, 5)
    .map((attempt) =>
      attempt.target ? `${attempt.toolName} on ${attempt.target}` : attempt.toolName,
    );
  const more =
    attempts.length > listed.length ? `, and ${attempts.length - listed.length} more` : "";
  return `Not verified: ${listed.join("; ")}${more}. ${attempts.length === 1 ? "This call" : "These calls"} may or may not have taken effect (the outcome was unknown after a timeout, a lost connection or a stop). Check before relying on this result.`;
}
