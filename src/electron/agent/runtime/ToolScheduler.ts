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
  summarizeBatch?: (
    batch: ScheduledToolBatch,
    reports: ToolScheduleCallReport[],
  ) => Promise<{ semanticSummary: string; source?: "model" | "fallback" } | undefined> | { semanticSummary: string; source?: "model" | "fallback" } | undefined;
  prepareCall: (
    call: SchedulableToolCall,
  ) => Promise<ToolSchedulerPrepareResult> | ToolSchedulerPrepareResult;
}

export class ToolScheduler {
  async executeBatch(
    params: ToolSchedulerExecuteBatchParams,
  ): Promise<ToolScheduleOutcome> {
    const entries: ToolSchedulerPrepareResult[] = [];
    for (const call of params.calls) {
      const prepared = await params.prepareCall(call);
      entries.push(prepared);
      if (prepared.status === "immediate" && prepared.stopAfter) {
        break;
      }
    }

    const toolResultSlots = new Map<number, LLMToolResult>();
    const reports: ToolScheduleCallReport[] = [];
    const batches: ScheduledToolBatch[] = [];

    let cursor = 0;
    while (cursor < entries.length) {
      const current = entries[cursor]!;
      if (current.status === "immediate") {
        toolResultSlots.set(current.call.index, current.outcome.toolResult);
        reports.push({
          call: current.call,
          effectiveToolName:
            current.effectiveToolName || current.call.toolUse.name,
          status: "immediate",
          toolResult: current.outcome.toolResult,
          metadata: current.outcome.metadata,
        });
        cursor += 1;
        continue;
      }

      const batchCalls: PreparedSchedulableToolCall[] = [current.call];
      let batchMode: "parallel" | "serial" = this.getBatchMode(current.call);
      let nextIndex = cursor + 1;
      while (nextIndex < entries.length) {
        const candidate = entries[nextIndex]!;
        if (candidate.status !== "scheduled") break;
        if (
          batchMode !== "parallel" ||
          !this.canShareParallelBatch(batchCalls, candidate.call)
        ) {
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

      for (const call of batchCalls) {
        await call.onDispatched?.();
      }

      const rawOutcomes =
        batch.mode === "parallel"
          ? await this.runParallelBatch(batch, params.maxParallel)
          : await this.runSerialBatch(batch);

      for (let index = 0; index < batch.calls.length; index += 1) {
        const call = batch.calls[index]!;
        const rawOutcome = rawOutcomes[index]!;
        await call.spec.postExecutionEffect?.({
          toolName: call.toolName,
          input: call.input,
          outcome: rawOutcome,
        });
        const finalized = await call.finalize(rawOutcome);
        toolResultSlots.set(call.index, finalized.toolResult);
        reports.push({
          call,
          effectiveToolName: call.toolName,
          status: "executed",
          toolResult: finalized.toolResult,
          batchMode: batch.mode,
          concurrencyClass: batch.concurrencyClass,
          metadata: finalized.metadata,
        });
      }

      if (typeof params.summarizeBatch === "function") {
        const batchReports = reports.filter((report) =>
          batch.calls.some((call) => call.index === report.call.index),
        );
        const summary = await params.summarizeBatch(batch, batchReports);
        if (summary?.semanticSummary) {
          batch.semanticSummary = summary.semanticSummary;
        }
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
    };
  }

  private getBatchMode(
    call: PreparedSchedulableToolCall,
  ): "parallel" | "serial" {
    if (
      call.spec.concurrencyClass === "read_parallel" &&
      call.spec.idempotent
    ) {
      return "parallel";
    }
    if (
      call.spec.concurrencyClass === "side_effect_parallel" &&
      call.spec.idempotent
    ) {
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

  private getScopeKeys(
    call: PreparedSchedulableToolCall,
  ): ToolExecutionScopeKey[] {
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
  ): Promise<ToolScheduleRawExecutionOutcome[]> {
    const outcomes: ToolScheduleRawExecutionOutcome[] = [];
    for (const call of batch.calls) {
      outcomes.push(await this.runCall(call));
    }
    return outcomes;
  }

  private async runParallelBatch(
    batch: ScheduledToolBatch,
    maxParallel = batch.calls.length,
  ): Promise<ToolScheduleRawExecutionOutcome[]> {
    const outcomes = new Array<ToolScheduleRawExecutionOutcome>(batch.calls.length);
    const concurrency = Math.min(
      Math.max(1, maxParallel || 1),
      batch.calls.length,
    );
    let cursor = 0;

    const worker = async () => {
      while (true) {
        const nextIndex = cursor;
        cursor += 1;
        if (nextIndex >= batch.calls.length) {
          break;
        }
        outcomes[nextIndex] = await this.runCall(batch.calls[nextIndex]!);
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    return outcomes;
  }

  private async runCall(
    call: PreparedSchedulableToolCall,
  ): Promise<ToolScheduleRawExecutionOutcome> {
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
