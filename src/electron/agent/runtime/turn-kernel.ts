import type { LLMMessage } from "../llm/types";
import type { LoopBudgetStopReason } from "./LoopBudgetPolicy";

export type TurnKernelStopReason =
  | LoopBudgetStopReason
  | "max_empty_responses"
  | "context_capacity_exhausted"
  | "cancelled"
  | "cancelled_or_completed"
  | "wrap_up_requested"
  | "step_feedback_skip"
  | "step_feedback_retry";

export type TurnKernelMode = "step" | "follow_up";

export interface TurnKernelInput {
  mode: TurnKernelMode;
  messages: LLMMessage[];
  maxIterations: number;
  maxLlmCalls?: number;
  maxEmptyResponses: number;
  maxRecoveredResponses?: number;
  maxRepeatedIterations?: number;
}

export interface TurnKernelIterationState {
  mode: TurnKernelMode;
  messages: LLMMessage[];
  iterationCount: number;
  emptyResponseCount: number;
  continueLoop: boolean;
}

export interface TurnKernelPreparedResponse {
  response: Any;
  availableTools: Any[];
  outputBudget?: Any;
}

export interface TurnKernelRecoveredResponse {
  recovered: true;
  messages: LLMMessage[];
}

export interface TurnKernelStoppedResponse {
  stopped: true;
  messages: LLMMessage[];
  stopReason?: TurnKernelStopReason;
}

export interface TurnKernelDecision {
  continueLoop?: boolean;
  emptyResponseCount?: number;
  repeatIteration?: boolean;
  stopReason?: TurnKernelStopReason;
}

export interface TurnKernelPolicy {
  shouldStopBeforeIteration?: (
    state: TurnKernelIterationState,
  ) => { stop: boolean; reason?: TurnKernelStopReason } | void;
  drainPendingMessages?: (state: TurnKernelIterationState) => Promise<void> | void;
  beforeIteration?: (state: TurnKernelIterationState) => Promise<void> | void;
  requestResponse: (
    state: TurnKernelIterationState,
  ) => Promise<TurnKernelPreparedResponse | TurnKernelRecoveredResponse | TurnKernelStoppedResponse>;
  handleResponse: (
    prepared: TurnKernelPreparedResponse,
    state: TurnKernelIterationState,
  ) => Promise<TurnKernelDecision | void> | TurnKernelDecision | void;
  afterIteration?: (state: TurnKernelIterationState) => Promise<void> | void;
}

export interface TurnKernelOutcome {
  messages: LLMMessage[];
  iterations: number;
  emptyResponseCount: number;
  stopReason?: TurnKernelStopReason;
  loopBudgetStopReason?: LoopBudgetStopReason;
}

export class TurnKernel {
  constructor(
    private readonly input: TurnKernelInput,
    private readonly policy: TurnKernelPolicy,
  ) {}

  async run(): Promise<TurnKernelOutcome> {
    const state: TurnKernelIterationState = {
      mode: this.input.mode,
      messages: this.input.messages,
      iterationCount: 0,
      emptyResponseCount: 0,
      continueLoop: true,
    };
    let stopReason: TurnKernelStopReason | undefined;
    let loopBudgetStopReason: LoopBudgetStopReason | undefined;
    let llmCallCount = 0;
    let recoveredResponseCount = 0;
    let repeatedIterationCount = 0;
    const maxLlmCalls =
      typeof this.input.maxLlmCalls === "number" && Number.isFinite(this.input.maxLlmCalls)
        ? Math.max(0, Math.floor(this.input.maxLlmCalls))
        : Number.POSITIVE_INFINITY;
    const maxRecoveredResponses =
      typeof this.input.maxRecoveredResponses === "number" &&
      Number.isFinite(this.input.maxRecoveredResponses)
        ? Math.max(0, Math.floor(this.input.maxRecoveredResponses))
        : this.input.maxIterations;
    const maxRepeatedIterations =
      typeof this.input.maxRepeatedIterations === "number" &&
      Number.isFinite(this.input.maxRepeatedIterations)
        ? Math.max(0, Math.floor(this.input.maxRepeatedIterations))
        : this.input.maxIterations;

    while (state.continueLoop && state.iterationCount < this.input.maxIterations) {
      if (llmCallCount >= maxLlmCalls) {
        stopReason = "max_llm_calls";
        loopBudgetStopReason = "max_llm_calls";
        break;
      }

      const stopBeforeIteration = this.policy.shouldStopBeforeIteration?.(state);
      if (stopBeforeIteration?.stop) {
        stopReason = stopBeforeIteration.reason;
        break;
      }

      await this.policy.drainPendingMessages?.(state);

      if (state.emptyResponseCount >= this.input.maxEmptyResponses) {
        stopReason = "max_empty_responses";
        break;
      }

      state.iterationCount += 1;
      await this.policy.beforeIteration?.(state);

      llmCallCount += 1;
      const prepared = await this.policy.requestResponse(state);
      if (isTurnKernelStoppedResponse(prepared)) {
        state.messages = prepared.messages;
        stopReason = prepared.stopReason;
        break;
      }
      if (isTurnKernelRecoveredResponse(prepared)) {
        state.messages = prepared.messages;
        recoveredResponseCount += 1;
        state.iterationCount -= 1;
        if (recoveredResponseCount > maxRecoveredResponses) {
          stopReason = "max_recovered_responses";
          loopBudgetStopReason = "max_recovered_responses";
          break;
        }
        continue;
      }

      const decision = (await this.policy.handleResponse(prepared, state)) || {};
      if (Array.isArray(state.messages) !== true) {
        state.messages = this.input.messages;
      }
      if (
        typeof decision.emptyResponseCount === "number" &&
        Number.isFinite(decision.emptyResponseCount)
      ) {
        state.emptyResponseCount = decision.emptyResponseCount;
      }
      if (typeof decision.continueLoop === "boolean") {
        state.continueLoop = decision.continueLoop;
      }
      if (decision.stopReason) {
        stopReason = decision.stopReason;
      }
      if (decision.repeatIteration) {
        repeatedIterationCount += 1;
        state.iterationCount -= 1;
        if (repeatedIterationCount > maxRepeatedIterations) {
          stopReason = "max_repeated_iterations";
          loopBudgetStopReason = "max_repeated_iterations";
          break;
        }
      }

      await this.policy.afterIteration?.(state);
    }

    return {
      messages: state.messages,
      iterations: state.iterationCount,
      emptyResponseCount: state.emptyResponseCount,
      stopReason,
      loopBudgetStopReason,
    };
  }
}

function isTurnKernelRecoveredResponse(
  prepared:
    | TurnKernelPreparedResponse
    | TurnKernelRecoveredResponse
    | TurnKernelStoppedResponse,
): prepared is TurnKernelRecoveredResponse {
  return "recovered" in prepared && prepared.recovered === true;
}

function isTurnKernelStoppedResponse(
  prepared:
    | TurnKernelPreparedResponse
    | TurnKernelRecoveredResponse
    | TurnKernelStoppedResponse,
): prepared is TurnKernelStoppedResponse {
  return "stopped" in prepared && prepared.stopped === true;
}
