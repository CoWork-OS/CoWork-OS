import type {
  GatewayContextType,
  PermissionEvaluationResult,
  Workspace,
} from "../../../shared/types";
import { evaluateMontyToolPolicy } from "../../security/monty-tool-policy";
import { isToolAllowedQuick } from "../../security/policy-manager";
import {
  evaluateToolAvailability,
  evaluateToolPolicy,
  type ToolAvailabilityContext,
  type ToolPolicyContext,
} from "../tool-policy-engine";
import { ToolPolicyTraceBuilder } from "./ToolPolicyTrace";

export interface ToolPolicyPipelineOptions {
  workspace: Workspace;
  toolName: string;
  toolInput: unknown;
  gatewayContext?: GatewayContextType;
  availabilityContext?: ToolAvailabilityContext;
  policyContext?: ToolPolicyContext;
  deniedTools?: Set<string>;
  allowedTools?: Set<string>;
  approvalRequired?: boolean;
  permissionEvaluation?: () => Promise<PermissionEvaluationResult>;
}

export interface ToolPolicyPipelineResult {
  decision: "allow" | "deny" | "require_approval";
  reason?: string;
  trace: ReturnType<ToolPolicyTraceBuilder["build"]>;
}

function toStageDecision(
  decision: "allow" | "deny" | "defer" | "require_approval" | "skip" | "ask" | "pass",
): "allow" | "deny" | "defer" | "require_approval" | "skip" {
  switch (decision) {
    case "ask":
      return "require_approval";
    case "pass":
      return "allow";
    default:
      return decision;
  }
}

export async function evaluateToolPolicyPipeline(
  opts: ToolPolicyPipelineOptions,
): Promise<ToolPolicyPipelineResult> {
  const trace = new ToolPolicyTraceBuilder(opts.toolName);

  if (opts.deniedTools?.has(opts.toolName)) {
    trace.add("task_restrictions", "deny", "tool denied by task restrictions");
    return {
      decision: "deny",
      reason: "tool denied by task restrictions",
      trace: trace.build("deny"),
    };
  }

  if (opts.allowedTools && opts.allowedTools.size > 0 && !opts.allowedTools.has(opts.toolName)) {
    trace.add("task_restrictions", "deny", "tool not present in task allowlist");
    return {
      decision: "deny",
      reason: "tool not present in task allowlist",
      trace: trace.build("deny"),
    };
  }
  trace.add("task_restrictions", "allow");

  if (!isToolAllowedQuick(opts.toolName, opts.workspace, opts.gatewayContext)) {
    trace.add("workspace_quick_access", "deny", "blocked by workspace or gateway policy");
    return {
      decision: "deny",
      reason: "blocked by workspace or gateway policy",
      trace: trace.build("deny"),
    };
  }
  trace.add("workspace_quick_access", "allow");

  if (opts.availabilityContext) {
    const availability = evaluateToolAvailability(opts.toolName, opts.availabilityContext);
    trace.add("availability", toStageDecision(availability.decision), availability.reason, {
      lane: availability.metadata.lane,
      exposure: availability.metadata.exposure,
    });
    if (availability.decision !== "allow") {
      return {
        decision: "deny",
        reason: availability.reason || "tool deferred by availability policy",
        trace: trace.build("deny"),
      };
    }
  } else {
    trace.add("availability", "skip");
  }

  if (opts.policyContext) {
    const policy = evaluateToolPolicy(opts.toolName, opts.policyContext);
    trace.add("mode_and_domain", toStageDecision(policy.decision), policy.reason, {
      mode: policy.mode,
      domain: policy.domain,
    });
    if (policy.decision !== "allow") {
      return {
        decision: "deny",
        reason: policy.reason || "blocked by execution mode/domain policy",
        trace: trace.build("deny"),
      };
    }
  } else {
    trace.add("mode_and_domain", "skip");
  }

  try {
    const workspacePolicy = await evaluateMontyToolPolicy({
      workspace: opts.workspace,
      toolName: opts.toolName,
      toolInput: opts.toolInput,
      gatewayContext: opts.gatewayContext,
    });
    trace.add(
      "workspace_script",
      toStageDecision(workspacePolicy.decision),
      workspacePolicy.reason,
    );
    if (workspacePolicy.decision === "deny") {
      return {
        decision: "deny",
        reason: workspacePolicy.reason || "blocked by workspace script policy",
        trace: trace.build("deny"),
      };
    }
    if (workspacePolicy.decision === "require_approval" || opts.approvalRequired) {
      trace.add("approval", "require_approval", workspacePolicy.reason);
      return {
        decision: "require_approval",
        reason: workspacePolicy.reason,
        trace: trace.build("require_approval"),
      };
    }
  } catch (error) {
    if (process.env.COWORK_FAIL_CLOSED_TOOL_POLICY === "1") {
      trace.add("workspace_script", "deny", "workspace policy evaluation failed", {
        error: String((error as { message?: string })?.message || error || ""),
      });
      return {
        decision: "deny",
        reason: "workspace policy evaluation failed",
        trace: trace.build("deny"),
      };
    }
    trace.add("workspace_script", "allow", "workspace policy evaluation failed open", {
      error: String((error as { message?: string })?.message || error || ""),
    });
  }

  if (opts.approvalRequired) {
    trace.add("approval", "require_approval", "approval required by runtime metadata");
    return {
      decision: "require_approval",
      reason: "approval required by runtime metadata",
      trace: trace.build("require_approval"),
    };
  }

  if (opts.permissionEvaluation) {
    const permission = await opts.permissionEvaluation();
    trace.add("permissions", toStageDecision(permission.decision), permission.reason.summary, {
      reasonType: permission.reason.type,
      scopePreview: permission.scopePreview,
      matchedRuleSource: permission.matchedRule?.source,
      matchedScopeKind: permission.matchedRule?.scope?.kind,
    });
    if (permission.decision === "deny") {
      return {
        decision: "deny",
        reason: permission.reason.summary,
        trace: trace.build("deny"),
      };
    }
    if (permission.decision === "ask") {
      return {
        decision: "require_approval",
        reason: permission.reason.summary,
        trace: trace.build("require_approval"),
      };
    }
  } else {
    trace.add("permissions", "skip");
  }

  trace.add("approval", "allow");
  return {
    decision: "allow",
    trace: trace.build("allow"),
  };
}
