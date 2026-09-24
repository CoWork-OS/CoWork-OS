import type {
  ApprovalType,
  GatewayContextType,
  PermissionEvaluationResult,
  Workspace,
} from "../../../shared/types";
import type { AgentSecurityEvaluationResult } from "../../../shared/agent-security";
import {
  evaluateMontyToolPolicy,
  TOOL_POLICY_UNAVAILABLE_REASON,
} from "../../security/monty-tool-policy";
import { isToolAllowedQuick } from "../../security/policy-manager";
import {
  evaluateToolAvailability,
  evaluateToolPolicy,
  type ToolAvailabilityContext,
  type ToolPolicyContext,
} from "../tool-policy-engine";
import { ToolPolicyTraceBuilder } from "./ToolPolicyTrace";
import { approvalPromptsDisabled } from "../approval-policy";

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
  runtimeApprovalType?: ApprovalType | null;
  permissionApprovalType?: ApprovalType | null;
  permissionEvaluation?: (opts?: {
    approvalType?: ApprovalType | null;
  }) => Promise<PermissionEvaluationResult>;
  agentSecurityEvaluation?: () => Promise<AgentSecurityEvaluationResult>;
  /**
   * Optional review. This runs only after deterministic policy and permission
   * checks have not denied the call. Observe mode records evidence only;
   * active mode escalates only a concrete concerning assessment into the
   * existing approval path. Uncertainty or provider unavailability remains
   * advisory so bounded JEV context cannot add a second blocking policy on
   * top of the authoritative deterministic checks.
   */
  semanticReviewEvaluation?: () => Promise<{
    mode?: "observe" | "active";
    status: "benign" | "concerning" | "uncertain" | "unavailable";
    reasonCodes?: string[];
    model?: string;
    latencyMs?: number;
    stateDigest?: string;
    requestId?: string;
  }>;
  /** Preserve the configured mode if the evaluator throws before returning. */
  semanticReviewMode?: "observe" | "active";
  /**
   * Headless full-authority runtimes cannot surface a second approval prompt.
   * When explicitly enabled by the caller, an active Jev concern is retained
   * in the policy trace but does not override an already-authorized operation.
   * The default remains the interactive approval path.
   */
  headlessSemanticReviewPolicy?: "allow_if_authorized";
  /**
   * Bot conversations can run unattended. Permit only credential-free,
   * idempotent public reads when the configured profile asks for network
   * consent but the runtime has no approval prompt surface. Hard network
   * denials, domain rules, and mutating requests still win before this lane.
   */
  allowReadOnlyNetworkWhenApprovalDisabled?: boolean;
}

export interface ToolPolicyPipelineResult {
  decision: "allow" | "deny" | "require_approval";
  reason?: string;
  trace: ReturnType<ToolPolicyTraceBuilder["build"]>;
  agentSecurity?: AgentSecurityEvaluationResult;
  approvalSource?: "permission" | "workspace_policy" | "runtime_metadata" | "semantic_review";
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

function isCredentialFreeReadOnlyNetworkRequest(toolName: string, toolInput: unknown): boolean {
  const normalizedToolName = toolName.trim().toLowerCase();
  if (normalizedToolName === "web_fetch") {
    const input =
      toolInput && typeof toolInput === "object" && !Array.isArray(toolInput)
        ? (toolInput as Record<string, unknown>)
        : undefined;
    if (!input || typeof input.url !== "string" || input.url.trim().length === 0) {
      return false;
    }
    return (
      input.credentialId === undefined ||
      input.credentialId === null ||
      (typeof input.credentialId === "string" && input.credentialId.trim().length === 0)
    );
  }
  if (normalizedToolName !== "http_request") return false;
  const input =
    toolInput && typeof toolInput === "object" && !Array.isArray(toolInput)
      ? (toolInput as Record<string, unknown>)
      : undefined;
  if (!input || typeof input.url !== "string" || input.url.trim().length === 0) {
    return false;
  }
  const method = typeof input.method === "string" ? input.method.trim().toUpperCase() : "GET";
  if (method !== "GET" && method !== "HEAD") return false;
  if (
    input.credentialId !== undefined &&
    input.credentialId !== null &&
    !(typeof input.credentialId === "string" && input.credentialId.trim().length === 0)
  ) {
    return false;
  }
  // A GET body or caller-supplied headers can still be an outbound write or
  // credential channel. Keep the unattended lane deliberately narrow.
  if (
    input.body !== undefined &&
    input.body !== null &&
    !(typeof input.body === "string" && input.body.trim().length === 0)
  ) {
    return false;
  }
  if (input.headers !== undefined && input.headers !== null) {
    if (
      typeof input.headers !== "object" ||
      Array.isArray(input.headers) ||
      Object.keys(input.headers as Record<string, unknown>).length > 0
    ) {
      return false;
    }
  }
  return true;
}

export async function evaluateToolPolicyPipeline(
  opts: ToolPolicyPipelineOptions,
): Promise<ToolPolicyPipelineResult> {
  const trace = new ToolPolicyTraceBuilder(opts.toolName);
  const requestedPermissionApprovalType = opts.permissionApprovalType ?? null;
  const resolvedPermissionApprovalType =
    requestedPermissionApprovalType ?? opts.runtimeApprovalType ?? null;
  let workspaceApprovalReason: string | undefined;
  let runtimeRequirementAuthorized = false;
  // The default local runtime is full-auto: permission checks and hard policy
  // denials still run, but an approval decision never opens a durable prompt.
  // Operators can restore the legacy queue with COWORK_APPROVAL_PROMPTS=on.
  const canRequestApproval =
    !approvalPromptsDisabled() && opts.workspace.permissions.accessApprovalPolicy !== "never";

  if (opts.deniedTools?.has(opts.toolName)) {
    trace.add("task_restrictions", "deny", "tool denied by task restrictions");
    return {
      decision: "deny",
      reason: "tool denied by task restrictions",
      trace: trace.build("deny"),
    };
  }

  // An allowlist Set that is present but does not contain the tool denies it.
  // An empty Set therefore denies every tool — this is the intended "read-only"
  // posture (e.g. side-chat tasks set `allowedTools: []`). Callers that mean
  // "no restriction" must pass `undefined`, not an empty Set. This matches the
  // availability filter in SessionRuntime.getAvailableTools.
  if (opts.allowedTools && !opts.allowedTools.has(opts.toolName)) {
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
    if (workspacePolicy.decision === "require_approval") {
      workspaceApprovalReason = workspacePolicy.reason || "approval required by workspace policy";
    }
    // Workspace allow/pass does not discharge runtime approval metadata; it is
    // still evaluated by the permission engine or final runtime fallback below.
  } catch {
    trace.add("workspace_script", "deny", TOOL_POLICY_UNAVAILABLE_REASON);
    return {
      decision: "deny",
      reason: TOOL_POLICY_UNAVAILABLE_REASON,
      trace: trace.build("deny"),
    };
  }

  let agentSecurity: AgentSecurityEvaluationResult | undefined;
  if (opts.agentSecurityEvaluation) {
    agentSecurity = await opts.agentSecurityEvaluation();
    trace.add(
      "agent_security",
      agentSecurity.decision === "deny" ? "deny" : "allow",
      agentSecurity.reason,
      {
        health: agentSecurity.health,
        decisionId: agentSecurity.decisionId,
        durationMs: agentSecurity.durationMs,
        failureCode: agentSecurity.failureCode,
      },
    );
    if (agentSecurity.decision === "deny") {
      return {
        decision: "deny",
        reason:
          agentSecurity.reason || "Action denied. Do not retry or attempt an equivalent action.",
        trace: trace.build("deny"),
        agentSecurity,
      };
    }
  } else {
    trace.add("agent_security", "skip");
  }

  if (opts.permissionEvaluation) {
    const permission = await opts.permissionEvaluation({
      approvalType: resolvedPermissionApprovalType,
    });
    trace.add("permissions", toStageDecision(permission.decision), permission.reason.summary, {
      reasonType: permission.reason.type,
      runtimeApprovalType: opts.runtimeApprovalType,
      requestedPermissionApprovalType,
      resolvedPermissionApprovalType,
      scopePreview: permission.scopePreview,
      matchedRuleSource: permission.matchedRule?.source,
      matchedScopeKind: permission.matchedRule?.scope?.kind,
      policyVersion: permission.metadata?.accessPolicyVersion,
      shadowDecision: permission.metadata?.boundaryDecision,
    });
    if (permission.decision === "deny") {
      return {
        decision: "deny",
        reason: permission.reason.summary,
        trace: trace.build("deny"),
        agentSecurity,
      };
    }
    if (permission.decision === "ask") {
      if (!canRequestApproval) {
        if (
          opts.allowReadOnlyNetworkWhenApprovalDisabled === true &&
          workspaceApprovalReason === undefined &&
          permission.reason.type === "workspace_capability" &&
          permission.reason.capability === "network" &&
          isCredentialFreeReadOnlyNetworkRequest(opts.toolName, opts.toolInput)
        ) {
          const reason =
            "Credential-free read-only network access allowed for an unattended bot research turn.";
          trace.add("approval", "allow", reason, {
            source: "bot_research_read_lane",
            originalReason: permission.reason.summary,
          });
          return {
            decision: "allow",
            trace: trace.build("allow"),
            agentSecurity,
          };
        }
        // Preserve the permission engine's concrete boundary explanation. A
        // generic approval error hides a correctable path mistake (for example,
        // a file in a sibling temporary workspace) from the agent and user.
        const reason =
          "This operation needs additional authority, but approval requests are disabled. " +
          permission.reason.summary;
        trace.add("approval", "deny", reason);
        return { decision: "deny", reason, trace: trace.build("deny"), agentSecurity };
      }
      return {
        decision: "require_approval",
        reason: permission.reason.summary,
        trace: trace.build("require_approval"),
        agentSecurity,
        approvalSource: "permission",
      };
    }
    // Named profiles evaluate typed requirements themselves. Do not reinstate a
    // blanket shell/destructive/etc gate after the authority has allowed it.
    // Unknown runtime metadata still requires explicit consent below.
    runtimeRequirementAuthorized = Boolean(
      opts.workspace.permissions.accessProfileId &&
      opts.runtimeApprovalType &&
      resolvedPermissionApprovalType === opts.runtimeApprovalType,
    );
  } else {
    trace.add("permissions", "skip");
  }

  const approvalWouldBeDenied =
    !canRequestApproval &&
    Boolean(workspaceApprovalReason || (opts.approvalRequired && !runtimeRequirementAuthorized));
  if (opts.semanticReviewEvaluation && !approvalWouldBeDenied) {
    let review: Awaited<ReturnType<NonNullable<typeof opts.semanticReviewEvaluation>>>;
    try {
      review = await opts.semanticReviewEvaluation();
    } catch {
      review = { mode: opts.semanticReviewMode, status: "unavailable" };
    }
    const reasonByStatus = {
      benign: "Jev observation: no concern detected",
      concerning: "Jev observation: potential concern detected",
      uncertain: "Jev observation: context was insufficient for a confident assessment",
      unavailable: "Jev observation unavailable",
    } as const;
    const reviewMode = review.mode === "active" ? "active" : "observe";
    const metadata: Record<string, unknown> = {
      mode: reviewMode,
      status: review.status,
    };
    if (review.reasonCodes && review.reasonCodes.length > 0) {
      metadata.reasonCodes = review.reasonCodes.slice(0, 8);
    }
    if (review.model) metadata.model = review.model;
    if (typeof review.latencyMs === "number") metadata.latencyMs = review.latencyMs;
    if (review.stateDigest) metadata.stateDigest = review.stateDigest;
    if (review.requestId) metadata.requestId = review.requestId;

    if (reviewMode === "active" && review.status === "concerning") {
      const reason = reasonByStatus[review.status];
      if (opts.headlessSemanticReviewPolicy === "allow_if_authorized") {
        trace.add(
          "semantic_review",
          "allow",
          "Jev concern recorded; explicit headless authority remains authoritative",
          metadata,
        );
        return {
          decision: "allow",
          trace: trace.build("allow"),
          agentSecurity,
        };
      }
      const decision = canRequestApproval ? "require_approval" : "deny";
      trace.add("semantic_review", decision, reason, metadata);
      if (decision === "deny") {
        return {
          decision: "deny",
          reason,
          trace: trace.build("deny"),
          agentSecurity,
        };
      }
      return {
        decision: "require_approval",
        reason,
        trace: trace.build("require_approval"),
        agentSecurity,
        approvalSource: "semantic_review",
      };
    }

    trace.add("semantic_review", "allow", reasonByStatus[review.status], metadata);
  }

  if (workspaceApprovalReason || (opts.approvalRequired && !runtimeRequirementAuthorized)) {
    const reason = workspaceApprovalReason || "approval required by runtime metadata";
    const decision = canRequestApproval ? "require_approval" : "deny";
    trace.add("approval", decision, reason);
    return {
      decision,
      reason,
      trace: trace.build(decision),
      agentSecurity,
      approvalSource: workspaceApprovalReason ? "workspace_policy" : "runtime_metadata",
    };
  }

  trace.add("approval", "allow");
  return {
    decision: "allow",
    trace: trace.build("allow"),
    agentSecurity,
  };
}
