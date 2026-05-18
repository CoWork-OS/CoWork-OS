export type DirectResponseMode =
  | "none"
  | "companion"
  | "terminal_quick_answer"
  | "brief_status_then_execute";

export type PreflightGate =
  | "none"
  | "preflight_framing"
  | "workspace_selection"
  | "artifact_presence";

export interface StrategyOverride {
  field: string;
  from: unknown;
  to: unknown;
  reason: string;
  phase: "daemon" | "startup" | "pre_planning" | "step";
}

export interface TaskStrategySnapshot {
  taskIntent: string;
  conversationMode: string;
  executionMode: string;
  taskDomain: string;
  directResponseMode: DirectResponseMode;
  preflightGates: PreflightGate[];
  workflowMode: "none" | "workflow" | "deep_work";
  llmProfileHint?: string;
  confidence: number;
  overrides: StrategyOverride[];
}
