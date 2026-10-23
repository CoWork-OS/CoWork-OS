import type { ToolPolicyContext } from "../tool-policy-engine";

export interface ToolBatchCorrelationMetaLite {
  toolUseId: string;
  toolCallIndex: number;
  phase: "step" | "follow_up";
  groupId?: string;
}

export interface ToolInvocationContext {
  /** Added only by the host's application gateway, never by model tool arguments. */
  applicationAttempt?: {
    operationId: string;
    attemptId: string;
    generation: number;
    phase: "prepare" | "execute" | "observe" | "verify" | "cancel";
  };
  /**
   * The recorded attempt of a call that can change something. Added only by the executor from
   * its attempt record, never by model tool arguments; MCP calls forward it in `_meta`.
   */
  toolAttempt?: { idempotencyKey: string; attemptId: string };
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
