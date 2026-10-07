/**
 * Admission for remote ACP/A2A graph dispatch.
 *
 * Local graph nodes become tasks that pass `graphAdmission` and then the per-tool
 * policy and approval middleware on every call. A remote node has no such
 * middleware: one dispatch sends the delegated prompt, dependency output and
 * parent context to another host. This module is the explicit decision for that
 * single effect, and `OrchestrationGraphEngine` refuses to dispatch without it.
 *
 * Every layer can only tighten the result (deny wins over approval, approval
 * wins over allow):
 * 1. Endpoint shape (`validateRemoteAgentEndpoint`).
 * 2. `SecurityPolicyManager` under `REMOTE_ACP_INVOCATION_TOOL`, whose
 *    tool-specific rule requires approval for every remote invocation.
 * 3. The workspace `tools.monty` policy, which can deny or require approval for
 *    the same tool name. Its `pass` never lifts the rule above.
 * 4. Workspace and access-profile network policy for the endpoint URL.
 * 5. DNS: the endpoint must not resolve to an internal address. pinnedFetch
 *    repeats this per request; checking here makes a refused destination fail
 *    before the effect boundary instead of as an unknown remote outcome.
 */
import type { GatewayContextType, GuardrailSettings, Workspace } from "../../../shared/types";
import type { AccessDomainRule, AccessNetworkMode } from "../../../shared/access-profiles";
import type { ACPAgentCard } from "../../acp/types";
import { validateRemoteAgentEndpoint } from "../../acp/remote-invoker";
import { assertResolvedHostAllowed, normalizeHostname } from "../../security/address-classes";
import { evaluateMontyToolPolicy } from "../../security/monty-tool-policy";
import {
  evaluateNetworkPolicy,
  toLogSafeNetworkPolicyUrl,
  type NetworkPolicyDecision,
} from "../../security/network-policy";
import { resolvePinnedAddresses, usesEnvProxy } from "../../security/pinned-fetch";
import { createPolicyManager, REMOTE_ACP_INVOCATION_TOOL } from "../../security/policy-manager";

export { REMOTE_ACP_INVOCATION_TOOL };

export type RemoteAcpAdmissionDecision =
  | { decision: "allow"; reason?: string }
  | { decision: "deny"; reason: string }
  | { decision: "require_approval"; reason: string };

/** What the engine is about to send; `prompt` is the exact outbound text. */
export interface RemoteAcpDispatchRequest {
  runId: string;
  nodeId: string;
  rootTaskId: string;
  workspaceId: string;
  agent: ACPAgentCard;
  title: string;
  prompt: string;
  /** Secret values replaced in `prompt` before it was offered for admission. */
  redactedSecretCount: number;
}

/** Engine dependency: the policy decision plus the approval flow behind it. */
export interface RemoteAcpAdmissionGate {
  evaluate(request: RemoteAcpDispatchRequest): Promise<RemoteAcpAdmissionDecision>;
  /** Resolves once the approval is answered; false must carry a visible reason. */
  requestApproval(
    request: RemoteAcpDispatchRequest,
    reason: string,
  ): Promise<{ approved: boolean; reason?: string }>;
}

export interface RemoteAcpPolicyInput {
  workspace: Workspace | undefined;
  guardrails: GuardrailSettings;
  gatewayContext?: GatewayContextType;
  agent: Pick<ACPAgentCard, "id" | "name" | "endpoint">;
  networkEnabled?: boolean;
  accessNetworkMode?: AccessNetworkMode;
  profileDomainRules?: AccessDomainRule[];
}

export type RemoteAcpPolicyResult = RemoteAcpAdmissionDecision & {
  networkDecision?: NetworkPolicyDecision;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function resolvedDestinationDenial(endpoint: URL): Promise<string | undefined> {
  try {
    // Same preflight pinnedFetch runs: pin through a local lookup, or, when an
    // environment proxy connects for us, the lenient resolved-host check.
    if (usesEnvProxy(endpoint)) {
      await assertResolvedHostAllowed(normalizeHostname(endpoint.hostname));
    } else {
      await resolvePinnedAddresses(endpoint.toString());
    }
    return undefined;
  } catch (error) {
    return `endpoint destination refused: ${errorMessage(error)}`;
  }
}

export async function evaluateRemoteAcpPolicy(
  input: RemoteAcpPolicyInput,
): Promise<RemoteAcpPolicyResult> {
  const { workspace, agent } = input;
  if (!workspace) {
    return { decision: "deny", reason: "workspace for the orchestration run is unavailable" };
  }
  if (!agent.endpoint) {
    return { decision: "deny", reason: `remote agent ${agent.id} has no endpoint` };
  }

  let endpoint: URL;
  try {
    endpoint = validateRemoteAgentEndpoint(agent.endpoint);
  } catch (error) {
    return { decision: "deny", reason: errorMessage(error) };
  }

  let approvalReason: string | undefined;

  const policy = createPolicyManager(
    workspace,
    input.guardrails,
    input.gatewayContext,
  ).checkToolAccess(REMOTE_ACP_INVOCATION_TOOL);
  if (!policy.allowed) {
    return { decision: "deny", reason: policy.reason || "remote ACP invocation is not permitted" };
  }
  if (policy.requiresApproval) {
    approvalReason = policy.approvalReason || "Remote ACP/A2A agent invocations require approval";
  }

  const montyDecision = await evaluateMontyToolPolicy({
    workspace,
    toolName: REMOTE_ACP_INVOCATION_TOOL,
    toolInput: {
      agentId: agent.id,
      agentName: agent.name,
      endpoint: toLogSafeNetworkPolicyUrl(endpoint),
      host: normalizeHostname(endpoint.hostname),
    },
    gatewayContext: input.gatewayContext,
  });
  if (montyDecision.decision === "deny") {
    return {
      decision: "deny",
      reason: `workspace tool policy: ${montyDecision.reason || "denied"}`,
    };
  }
  if (montyDecision.decision === "require_approval") {
    approvalReason ??= `workspace tool policy: ${montyDecision.reason || "approval required"}`;
  }

  const networkDecision = evaluateNetworkPolicy({
    url: endpoint.toString(),
    toolName: REMOTE_ACP_INVOCATION_TOOL,
    networkEnabled: input.networkEnabled,
    accessNetworkMode: input.accessNetworkMode,
    profileDomainRules: input.profileDomainRules,
  });
  if (networkDecision.action === "deny") {
    return {
      decision: "deny",
      reason: `network policy: ${networkDecision.reason}`,
      networkDecision,
    };
  }

  const destinationDenial = await resolvedDestinationDenial(endpoint);
  if (destinationDenial) {
    return { decision: "deny", reason: destinationDenial, networkDecision };
  }

  return approvalReason
    ? { decision: "require_approval", reason: approvalReason, networkDecision }
    : { decision: "allow", networkDecision };
}
