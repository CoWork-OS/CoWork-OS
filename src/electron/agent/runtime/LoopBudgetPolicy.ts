export type LoopBudgetStopReason =
  | "max_llm_calls"
  | "max_recovered_responses"
  | "max_repeated_iterations";

export interface StepLoopBudget {
  maxIterations: number;
  maxLlmCalls: number;
  maxRecoveredResponses: number;
  maxRepeatedIterations: number;
  maxContextRecoveries: number;
  maxMaxTokenRecoveries: number;
}

export function defaultStepLoopBudget(): StepLoopBudget {
  return {
    maxIterations: 32,
    maxLlmCalls: 40,
    maxRecoveredResponses: 2,
    maxRepeatedIterations: 6,
    maxContextRecoveries: 2,
    maxMaxTokenRecoveries: 6,
  };
}
