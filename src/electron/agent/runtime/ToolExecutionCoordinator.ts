import type { ToolPolicyTrace } from "../../../shared/types";
import type { ToolRegistry } from "../tools/registry";
import type { ToolInvocationContext } from "./ToolInvocationContext";
import { buildToolResultEnvelope } from "./tool-result-envelope";

export interface CoordinatedToolExecutionResult {
  result?: Any;
  error?: unknown;
  durationMs: number;
  resultJson: string;
  envelope: ReturnType<typeof buildToolResultEnvelope>;
  policyTrace?: ToolPolicyTrace;
}

export class ToolExecutionCoordinator {
  constructor(private readonly toolRegistry: ToolRegistry) {}

  private getModelReminder(result: unknown): string | undefined {
    if (!result || typeof result !== "object" || Array.isArray(result)) return undefined;
    const reminder = (result as { immediateReminder?: unknown }).immediateReminder;
    return typeof reminder === "string" && reminder.trim().length > 0 ? reminder.trim() : undefined;
  }

  async executeTool(
    toolName: string,
    input: Any,
    context: ToolInvocationContext,
    toolUseId = `${toolName}:${Date.now()}`,
  ): Promise<CoordinatedToolExecutionResult> {
    const startedAt = Date.now();
    const toolTimeoutMs = context.timeoutMsResolver?.(toolName, input) ?? 30_000;
    const stopHeartbeat = context.beginHeartbeat?.(toolName, toolTimeoutMs, input);

    try {
      const executionWithRuntime = await this.toolRegistry.executeToolWithRuntime(toolName, input, {
        toolPolicyContext: context.toolPolicyContext,
        signal: context.signal,
        targetPaths: context.targetPaths,
        followUp: context.followUp,
        stepId: context.stepId,
      });
      const result = executionWithRuntime?.result;
      const policyTrace = executionWithRuntime?.policyTrace;
      const modelReminder = this.getModelReminder(result);
      const envelope = buildToolResultEnvelope({
        toolUseId,
        toolName,
        status: result?.success === false ? "error" : "success",
        result,
        retryable: false,
        policyTrace,
        modelReminder,
        userSummary: `${toolName} ${result?.success === false ? "failed" : "completed"}`,
      });
      context.emitEvent?.("log", {
        metric: "tool_runtime_trace",
        tool: toolName,
        toolUseId,
        envelope,
        policyTrace,
      });
      return {
        result,
        durationMs: Date.now() - startedAt,
        resultJson: envelope.modelPayload,
        policyTrace,
        envelope,
      };
    } catch (error) {
      const recovery = await context.workspaceRecovery?.({
        toolName,
        input,
        errorMessage: String((error as { message?: string })?.message || error || ""),
        toolTimeoutMs,
        stepId: context.stepId,
        targetPaths: context.targetPaths,
        followUp: context.followUp,
      });
      if (recovery?.recovered) {
        const recoveredResult = recovery.result;
        const recoveredReminder = this.getModelReminder(recoveredResult);
        const envelope = buildToolResultEnvelope({
          toolUseId,
          toolName,
          status: "success",
          result: recoveredResult,
          modelReminder: recoveredReminder,
          userSummary: `${toolName} recovered and completed`,
        });
        return {
          result: recoveredResult,
          durationMs: Date.now() - startedAt,
          resultJson: envelope.modelPayload,
          envelope,
        };
      }
      const envelope = buildToolResultEnvelope({
        toolUseId,
        toolName,
        status: "error",
        error,
        retryable: false,
        userSummary: `${toolName} failed`,
      });
      context.emitEvent?.("log", {
        metric: "tool_runtime_trace",
        tool: toolName,
        toolUseId,
        envelope,
      });
      return {
        error,
        durationMs: Date.now() - startedAt,
        resultJson: "",
        envelope,
      };
    } finally {
      if (typeof stopHeartbeat === "function") {
        stopHeartbeat();
      }
    }
  }
}
