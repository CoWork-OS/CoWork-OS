import type { RuntimeToolConcurrencyClass } from "../../../shared/types";
import type { LLMToolResult, LLMToolUse } from "../llm/types";
import {
  resolveToolExecutionScopeKeys,
  serializeToolExecutionScopeKey,
  type RuntimeToolSchedulerSpec,
  type ToolExecutionScopeKey,
} from "./runtime-tool-scheduler-spec";

export interface SchedulableToolCall {
  index: number;
  toolUse: LLMToolUse;
}

/**
 * Keep malformed provider arguments as a protocol result while preventing the
 * call from reaching policy hooks, scheduler preparation, or tool execution.
 * The original call ID is required so the model transcript remains paired.
 */
export function buildRejectedToolArgumentResult(toolUse: LLMToolUse): LLMToolResult {
  const inputError = toolUse.inputError;
  return {
    type: "tool_result",
    tool_use_id: toolUse.id,
    content: JSON.stringify({
      error: inputError?.message || "Tool call arguments were rejected before dispatch.",
      rejected: true,
      reason: "invalid_tool_arguments",
      code: inputError?.code || "invalid_shape",
    }),
    is_error: true,
  };
}

type ToolSchedulerHook = "prepare" | "post_execution_effect" | "finalize" | "summarize_batch";

function describeSchedulerError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  if (typeof error === "string" && error.trim().length > 0) return error;
  return fallback;
}

function buildCancelledToolResult(toolUse: LLMToolUse): LLMToolResult {
  return {
    type: "tool_result",
    tool_use_id: toolUse.id,
    content: JSON.stringify({
      error: "Tool execution cancelled",
      cancelled: true,
    }),
    is_error: true,
  };
}

function buildSchedulerHookFailureMetadata(
  hook: ToolSchedulerHook,
  error: unknown,
): Record<string, unknown> {
  return {
    schedulerHookFailure: hook,
    schedulerHookError: describeSchedulerError(error, "Tool scheduler hook failed"),
  };
}

function buildSchedulerHookFailureResult(
  call: SchedulableToolCall,
  hook: ToolSchedulerHook,
  error: unknown,
): LLMToolResult {
  return {
    type: "tool_result",
    tool_use_id: call.toolUse.id,
    content: JSON.stringify({
      error: `Tool scheduler ${hook} failed: ${describeSchedulerError(error, "unknown error")}`,
      schedulerHookFailure: hook,
    }),
    is_error: true,
  };
}

export interface ToolScheduleRawExecutionOutcome {
  result?: Any;
  error?: unknown;
  durationMs?: number;
  resultJson?: string;
  metadata?: Record<string, unknown>;
}

export interface ToolScheduledExecutionOutcome {
  toolResult: LLMToolResult;
  metadata?: Record<string, unknown>;
}

export interface PreparedSchedulableToolCall extends SchedulableToolCall {
  toolName: string;
  input: Any;
  spec: RuntimeToolSchedulerSpec;
  scopeKeys?: ToolExecutionScopeKey[];
  onDispatched?: () => Promise<void> | void;
  run: () => Promise<ToolScheduleRawExecutionOutcome>;
  finalize: (
    outcome: ToolScheduleRawExecutionOutcome,
  ) => Promise<ToolScheduledExecutionOutcome> | ToolScheduledExecutionOutcome;
}

export interface ScheduledToolBatch {
  mode: "parallel" | "serial";
  concurrencyClass: RuntimeToolConcurrencyClass;
  calls: PreparedSchedulableToolCall[];
  semanticSummary?: string;
}

export interface ToolScheduleCallReport {
  call: SchedulableToolCall;
  effectiveToolName: string;
  status: "immediate" | "executed";
  toolResult: LLMToolResult;
  batchMode?: "parallel" | "serial";
  concurrencyClass?: RuntimeToolConcurrencyClass;
  metadata?: Record<string, unknown>;
}

export interface ToolScheduleOutcome {
  toolResults: LLMToolResult[];
  batches: ScheduledToolBatch[];
  callReports: ToolScheduleCallReport[];
  /**
   * A dispatch or scheduler hook can fail while the scheduler is assembling a
   * batch. Keep the error visible to the caller even though the scheduler
   * still returns one protocol result per call.
   */
  fatalError?: unknown;
}

export type ToolSchedulerPrepareResult =
  | {
      status: "scheduled";
      call: PreparedSchedulableToolCall;
    }
  | {
      status: "immediate";
      call: SchedulableToolCall;
      effectiveToolName?: string;
      outcome: ToolScheduledExecutionOutcome;
      stopAfter?: boolean;
    };

export interface ToolSchedulerExecuteBatchParams {
  calls: SchedulableToolCall[];
  maxParallel?: number;
  shouldContinue?: () => boolean;
  summarizeBatch?: (
    batch: ScheduledToolBatch,
    reports: ToolScheduleCallReport[],
  ) =>
    | Promise<{ semanticSummary: string; source?: "model" | "fallback" } | undefined>
    | { semanticSummary: string; source?: "model" | "fallback" }
    | undefined;
  prepareCall: (
    call: SchedulableToolCall,
  ) => Promise<ToolSchedulerPrepareResult> | ToolSchedulerPrepareResult;
}

export class ToolScheduler {
  async executeBatch(params: ToolSchedulerExecuteBatchParams): Promise<ToolScheduleOutcome> {
    const entries: ToolSchedulerPrepareResult[] = [];
    let preparationFailure: unknown;
    let cancellationObserved = false;
    const canContinue = (): boolean => {
      if (cancellationObserved) return false;
      if (params.shouldContinue && !params.shouldContinue()) cancellationObserved = true;
      return !cancellationObserved;
    };
    for (let callIndex = 0; callIndex < params.calls.length; callIndex += 1) {
      const call = params.calls[callIndex]!;
      if (call.toolUse.inputError) {
        entries.push({
          status: "immediate",
          call,
          effectiveToolName: call.toolUse.name,
          outcome: {
            toolResult: buildRejectedToolArgumentResult(call.toolUse),
            metadata: {
              rejected: true,
              reason: "invalid_tool_arguments",
              code: call.toolUse.inputError.code,
            },
          },
        });
        continue;
      }

      if (!canContinue()) {
        for (const remainingCall of params.calls.slice(callIndex)) {
          entries.push({
            status: "immediate",
            call: remainingCall,
            effectiveToolName: remainingCall.toolUse.name,
            outcome: {
              toolResult: buildCancelledToolResult(remainingCall.toolUse),
              metadata: {
                cancelled: true,
              },
            },
          });
        }
        break;
      }

      let prepared: ToolSchedulerPrepareResult;
      try {
        prepared = await params.prepareCall(call);
      } catch (error) {
        preparationFailure = error || new Error("Tool preparation failed");
        for (const remainingCall of params.calls.slice(callIndex)) {
          entries.push({
            status: "immediate",
            call: remainingCall,
            outcome: {
              toolResult: buildSchedulerHookFailureResult(
                remainingCall,
                "prepare",
                preparationFailure,
              ),
              metadata: {
                ...buildSchedulerHookFailureMetadata("prepare", preparationFailure),
                dispatchSkipped: true,
              },
            },
          });
        }
        break;
      }
      entries.push(prepared);
      if (prepared.status === "immediate" && prepared.stopAfter) {
        // A model turn still needs one tool_result for every tool_use block.
        // The stopAfter result is already the caller's correctly shaped
        // cancellation/completion result, so clone it for the unprepared tail
        // instead of invoking policy/tool preparation after the global stop.
        for (const remainingCall of params.calls.slice(callIndex + 1)) {
          entries.push({
            status: "immediate",
            call: remainingCall,
            effectiveToolName: remainingCall.toolUse.name,
            outcome: {
              ...prepared.outcome,
              toolResult: {
                ...prepared.outcome.toolResult,
                tool_use_id: remainingCall.toolUse.id,
              },
            },
          });
        }
        break;
      }
    }

    const toolResultSlots = new Map<number, LLMToolResult>();
    const reports: ToolScheduleCallReport[] = [];
    const batches: ScheduledToolBatch[] = [];
    let fatalError: unknown = preparationFailure;
    let dispatchFailureObserved = preparationFailure !== undefined;
    let dispatchFailureCause: unknown = preparationFailure;

    const recordFatalError = (error: unknown, fallback: string): unknown => {
      const failure = error || new Error(fallback);
      if (fatalError === undefined) fatalError = failure;
      return failure;
    };

    const addImmediateEntry = (entry: ToolSchedulerPrepareResult): void => {
      if (entry.status !== "immediate") return;
      toolResultSlots.set(entry.call.index, entry.outcome.toolResult);
      reports.push({
        call: entry.call,
        effectiveToolName: entry.effectiveToolName || entry.call.toolUse.name,
        status: "immediate",
        toolResult: entry.outcome.toolResult,
        metadata: entry.outcome.metadata,
      });
    };

    const createDispatchFailureOutcome = (
      error: unknown,
      skipped: boolean,
    ): ToolScheduleRawExecutionOutcome => ({
      error,
      metadata: {
        dispatchFailed: !skipped,
        dispatchSkipped: skipped,
      },
    });

    const finalizeDispatchSkippedEntry = async (
      entry: Extract<ToolSchedulerPrepareResult, { status: "scheduled" }>,
      error: unknown,
    ): Promise<void> => {
      const rawOutcome = createDispatchFailureOutcome(error, true);
      let finalized: ToolScheduledExecutionOutcome;
      let hookFailureMetadata: Record<string, unknown> = {};
      try {
        finalized = await entry.call.finalize(rawOutcome);
      } catch (finalizeError) {
        const failure = recordFatalError(finalizeError, "Tool finalization failed");
        hookFailureMetadata = buildSchedulerHookFailureMetadata("finalize", failure);
        finalized = {
          toolResult: buildSchedulerHookFailureResult(entry.call, "finalize", failure),
          metadata: hookFailureMetadata,
        };
      }
      toolResultSlots.set(entry.call.index, finalized.toolResult);
      reports.push({
        call: entry.call,
        effectiveToolName: entry.call.toolName,
        status: "immediate",
        toolResult: finalized.toolResult,
        metadata: {
          ...rawOutcome.metadata,
          ...hookFailureMetadata,
          ...finalized.metadata,
        },
      });
    };

    let cursor = 0;
    while (cursor < entries.length) {
      if (dispatchFailureObserved) {
        const dispatchError =
          dispatchFailureCause || fatalError || new Error("Tool dispatch was stopped");
        for (; cursor < entries.length; cursor += 1) {
          const entry = entries[cursor]!;
          if (entry.status === "immediate") {
            addImmediateEntry(entry);
          } else {
            await finalizeDispatchSkippedEntry(entry, dispatchError);
          }
        }
        break;
      }

      const current = entries[cursor]!;
      if (current.status === "immediate") {
        addImmediateEntry(current);
        cursor += 1;
        continue;
      }

      const batchCalls: PreparedSchedulableToolCall[] = [current.call];
      let batchMode: "parallel" | "serial" = this.getBatchMode(current.call);
      let nextIndex = cursor + 1;
      while (nextIndex < entries.length) {
        const candidate = entries[nextIndex]!;
        if (candidate.status !== "scheduled") break;
        if (batchMode !== "parallel" || !this.canShareParallelBatch(batchCalls, candidate.call)) {
          break;
        }
        batchCalls.push(candidate.call);
        nextIndex += 1;
      }

      const batch: ScheduledToolBatch = {
        mode: batchMode,
        concurrencyClass: current.call.spec.concurrencyClass,
        calls: batchCalls,
      };
      batches.push(batch);

      const dispatchedCalls: PreparedSchedulableToolCall[] = [];
      const cancelledCallIndexes = new Set<number>();
      let dispatchFailureError: unknown;
      let dispatchFailureCall: PreparedSchedulableToolCall | undefined;
      for (const call of batchCalls) {
        if (!canContinue()) {
          cancelledCallIndexes.add(call.index);
          continue;
        }
        try {
          await call.onDispatched?.();
          dispatchedCalls.push(call);
        } catch (error) {
          dispatchFailureError = error || new Error("Tool dispatch failed");
          dispatchFailureCall = call;
          break;
        }
      }

      const dispatchedCallIndexes = new Set(dispatchedCalls.map((call) => call.index));
      const executableBatch =
        dispatchedCalls.length > 0 ? { ...batch, calls: dispatchedCalls } : undefined;
      const rawOutcomes = executableBatch
        ? executableBatch.mode === "parallel"
          ? await this.runParallelBatch(executableBatch, params.maxParallel, canContinue)
          : await this.runSerialBatch(executableBatch, canContinue)
        : [];
      const rawOutcomeByCallIndex = new Map<number, ToolScheduleRawExecutionOutcome>();
      for (let index = 0; index < dispatchedCalls.length; index += 1) {
        const call = dispatchedCalls[index]!;
        rawOutcomeByCallIndex.set(call.index, rawOutcomes[index]!);
      }

      if (dispatchFailureError !== undefined) {
        dispatchFailureCause = dispatchFailureError;
        recordFatalError(dispatchFailureError, "Tool dispatch failed");
      }

      for (let index = 0; index < batch.calls.length; index += 1) {
        const call = batch.calls[index]!;
        const rawOutcome = dispatchedCallIndexes.has(call.index)
          ? rawOutcomeByCallIndex.get(call.index)!
          : cancelledCallIndexes.has(call.index)
            ? { error: new Error("Tool execution cancelled"), metadata: { cancelled: true } }
            : createDispatchFailureOutcome(
                dispatchFailureError || new Error("Tool dispatch was stopped"),
                call !== dispatchFailureCall,
              );
        let outcomeForFinalize = rawOutcome;
        let hookFailureMetadata: Record<string, unknown> = {};
        if (
          rawOutcome.metadata?.cancelled !== true &&
          rawOutcome.metadata?.dispatchFailed !== true &&
          rawOutcome.metadata?.dispatchSkipped !== true
        ) {
          try {
            await call.spec.postExecutionEffect?.({
              toolName: call.toolName,
              input: call.input,
              outcome: rawOutcome,
            });
          } catch (postExecutionError) {
            const failure = recordFatalError(
              postExecutionError,
              "Tool post-execution effect failed",
            );
            hookFailureMetadata = buildSchedulerHookFailureMetadata(
              "post_execution_effect",
              failure,
            );
            outcomeForFinalize = {
              ...rawOutcome,
              metadata: {
                ...rawOutcome.metadata,
                ...hookFailureMetadata,
              },
            };
          }
        }
        let finalized: ToolScheduledExecutionOutcome;
        try {
          finalized = await call.finalize(outcomeForFinalize);
        } catch (finalizeError) {
          const failure = recordFatalError(finalizeError, "Tool finalization failed");
          hookFailureMetadata = {
            ...hookFailureMetadata,
            ...buildSchedulerHookFailureMetadata("finalize", failure),
          };
          finalized = {
            toolResult: buildSchedulerHookFailureResult(call, "finalize", failure),
            metadata: buildSchedulerHookFailureMetadata("finalize", failure),
          };
        }
        toolResultSlots.set(call.index, finalized.toolResult);
        const dispatchWasSkipped =
          rawOutcome.metadata?.cancelled === true ||
          rawOutcome.metadata?.dispatchFailed === true ||
          rawOutcome.metadata?.dispatchSkipped === true;
        reports.push({
          call,
          effectiveToolName: call.toolName,
          status: dispatchWasSkipped ? "immediate" : "executed",
          toolResult: finalized.toolResult,
          ...(dispatchWasSkipped
            ? {}
            : {
                batchMode: batch.mode,
                concurrencyClass: batch.concurrencyClass,
              }),
          metadata: {
            ...rawOutcome.metadata,
            ...hookFailureMetadata,
            ...finalized.metadata,
          },
        });
      }

      if (!dispatchFailureError && typeof params.summarizeBatch === "function") {
        const batchReports = reports.filter((report) =>
          batch.calls.some((call) => call.index === report.call.index),
        );
        try {
          const summary = await params.summarizeBatch(batch, batchReports);
          if (summary?.semanticSummary) {
            batch.semanticSummary = summary.semanticSummary;
          }
        } catch (summaryError) {
          recordFatalError(summaryError, "Tool batch summary failed");
        }
      }

      if (fatalError !== undefined) {
        dispatchFailureObserved = true;
      }
      cursor = nextIndex;
    }

    const toolResults = Array.from(toolResultSlots.entries())
      .sort((left, right) => left[0] - right[0])
      .map((entry) => entry[1]);

    const callReports = reports.sort((left, right) => left.call.index - right.call.index);

    return {
      toolResults,
      batches,
      callReports,
      ...(fatalError !== undefined ? { fatalError } : {}),
    };
  }

  private getBatchMode(call: PreparedSchedulableToolCall): "parallel" | "serial" {
    if (call.spec.concurrencyClass === "read_parallel" && call.spec.idempotent) {
      return "parallel";
    }
    if (call.spec.concurrencyClass === "side_effect_parallel" && call.spec.idempotent) {
      return "parallel";
    }
    return "serial";
  }

  private canShareParallelBatch(
    currentBatch: PreparedSchedulableToolCall[],
    candidate: PreparedSchedulableToolCall,
  ): boolean {
    const base = currentBatch[0];
    if (!base) return false;
    if (
      base.spec.concurrencyClass !== candidate.spec.concurrencyClass ||
      !candidate.spec.idempotent
    ) {
      return false;
    }

    if (candidate.spec.concurrencyClass === "read_parallel") {
      return true;
    }

    if (candidate.spec.concurrencyClass !== "side_effect_parallel") {
      return false;
    }

    const seenScopeKeys = new Set<string>();
    for (const call of currentBatch) {
      for (const scopeKey of this.getScopeKeys(call)) {
        seenScopeKeys.add(serializeToolExecutionScopeKey(scopeKey));
      }
    }
    for (const scopeKey of this.getScopeKeys(candidate)) {
      if (seenScopeKeys.has(serializeToolExecutionScopeKey(scopeKey))) {
        return false;
      }
    }
    return true;
  }

  private getScopeKeys(call: PreparedSchedulableToolCall): ToolExecutionScopeKey[] {
    if (Array.isArray(call.scopeKeys)) {
      return call.scopeKeys;
    }
    return resolveToolExecutionScopeKeys({
      spec: call.spec,
      toolName: call.toolName,
      input: call.input,
    });
  }

  private async runSerialBatch(
    batch: ScheduledToolBatch,
    shouldContinue?: () => boolean,
  ): Promise<ToolScheduleRawExecutionOutcome[]> {
    const outcomes: ToolScheduleRawExecutionOutcome[] = [];
    for (const call of batch.calls) {
      outcomes.push(await this.runCall(call, shouldContinue));
    }
    return outcomes;
  }

  private async runParallelBatch(
    batch: ScheduledToolBatch,
    maxParallel = batch.calls.length,
    shouldContinue?: () => boolean,
  ): Promise<ToolScheduleRawExecutionOutcome[]> {
    const outcomes = new Array<ToolScheduleRawExecutionOutcome>(batch.calls.length);
    const concurrency = Math.min(Math.max(1, maxParallel || 1), batch.calls.length);
    let cursor = 0;

    const worker = async () => {
      while (true) {
        const nextIndex = cursor;
        cursor += 1;
        if (nextIndex >= batch.calls.length) {
          break;
        }
        outcomes[nextIndex] = await this.runCall(batch.calls[nextIndex]!, shouldContinue);
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    return outcomes;
  }

  private async runCall(
    call: PreparedSchedulableToolCall,
    shouldContinue?: () => boolean,
  ): Promise<ToolScheduleRawExecutionOutcome> {
    if (shouldContinue && !shouldContinue()) {
      return {
        error: new Error("Tool execution cancelled"),
        metadata: {
          cancelled: true,
        },
      };
    }
    try {
      return await call.run();
    } catch (error) {
      return {
        error,
        metadata: {
          uncaught: true,
        },
      };
    }
  }
}
