import type { ToolPolicyContext } from "../tool-policy-engine";

export interface ToolBatchCorrelationMetaLite {
  toolUseId: string;
  toolCallIndex: number;
  phase: "step" | "follow_up";
  groupId?: string;
}

export interface ToolInvocationContext {
  taskId: string;
  stepId?: string;
  phase: "step" | "follow_up";
  targetPaths?: string[];
  followUp?: boolean;
  toolPolicyContext?: ToolPolicyContext;
  signal?: AbortSignal;
  emitEvent?: (type: string, payload: Any) => void;
  beginHeartbeat?: (toolName: string, toolTimeoutMs: number, input: unknown) => (() => void) | void;
  timeoutMsResolver?: (toolName: string, input: unknown) => number;
  workspaceRecovery?: (args: {
    toolName: string;
    input: Any;
    errorMessage: string;
    toolTimeoutMs: number;
    stepId?: string;
    targetPaths?: string[];
    followUp?: boolean;
  }) => Promise<{ recovered: boolean; result?: Any; input?: Any }>;
}
