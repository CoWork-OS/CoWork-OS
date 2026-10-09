/**
 * Wires the PACT runtime to the agent daemon: approvals, the durable consent wait (an input
 * request of the `pact_authorization` kind), task events, and workspace network context. Shared by
 * the desktop main process, the Node daemon and `cowork run`, so it imports no Electron UI.
 */
import type Database from "better-sqlite3";
import type { PactAuthorizationState, PactAuthorizationView } from "../../shared/pact";
import type { Workspace } from "../../shared/types";
import { loadPolicies } from "../admin/policies";
import {
  applyAccessProfileToWorkspace,
  resolveEffectiveAccessProfile,
} from "../security/access-profile-resolver";
import type { NetworkPolicyDecision } from "../security/network-policy";
import { PermissionSettingsManager } from "../security/permission-settings-manager";
import type { NetworkPolicyContext } from "../security/policy-checked-fetch";
import { PactRuntime, type PactHost } from "./runtime";
import { SecureSettingsPactSecretStore } from "./secret-store";
import { PactSettingsManager } from "./settings";
import { createPactTransport } from "./transport-node";

/** The daemon surface the host needs; structural so pact/ does not import the daemon module. */
export interface PactDaemonLike {
  requestApproval(
    taskId: string,
    type: string,
    description: string,
    details: unknown,
    opts?: {
      requireExplicitApproval?: boolean;
      allowAutoApprove?: boolean;
      noStandingApproval?: boolean;
    },
  ): Promise<boolean>;
  openPactAuthorizationWait(taskId: string, view: PactAuthorizationView): Promise<string>;
  settlePactAuthorizationWait(
    inputRequestId: string,
    state: PactAuthorizationState,
    message: string,
  ): Promise<void>;
  logEvent(taskId: string, type: string, payload: unknown): void;
  isTaskWaitingForInput(taskId: string): Promise<boolean>;
  getWorkspaceForPact(workspaceId: string): Workspace | undefined;
  /** A task's workspace with its own access profile applied (what its live tool calls use). */
  getEffectiveWorkspaceForTask(taskId: string): Workspace | undefined;
}

export function networkContextOf(workspace: Workspace | undefined): NetworkPolicyContext | null {
  if (!workspace) return null;
  return {
    // Missing permissions mean no network, not "unspecified".
    networkEnabled: workspace.permissions?.network === true,
    accessNetworkMode: workspace.permissions?.accessNetworkMode,
    profileDomainRules: workspace.permissions?.accessDomainRules,
  };
}

/** The default access profile's network rules, for calls outside any workspace. */
export function defaultNetworkContext(): NetworkPolicyContext {
  const profile = resolveEffectiveAccessProfile({
    settings: PermissionSettingsManager.loadSettings(),
    adminPolicies: loadPolicies(),
  });
  return {
    networkEnabled: profile.networkEnabled,
    accessNetworkMode: profile.definition.network,
    profileDomainRules: profile.definition.domainRules,
  };
}

/** Effective (access-profile-applied) workspace for calls made outside a task. */
export function effectiveWorkspace(workspace: Workspace): Workspace {
  const profile = resolveEffectiveAccessProfile({
    workspace,
    settings: PermissionSettingsManager.loadSettings(),
    adminPolicies: loadPolicies(),
  });
  return applyAccessProfileToWorkspace(workspace, profile);
}

export class DaemonPactHost implements PactHost {
  constructor(private readonly daemon: PactDaemonLike) {}

  requestLocalApproval(
    taskId: string,
    summary: string,
    details: Record<string, unknown>,
    options: { requireExplicit: boolean },
  ): Promise<boolean> {
    return this.daemon.requestApproval(taskId, "external_service", summary, details, {
      requireExplicitApproval: options.requireExplicit,
      // A business operation is approved one at a time: no auto-approval by mode or rule, and
      // no standing (recurring or session) approval reused for a later message.
      allowAutoApprove: !options.requireExplicit,
      noStandingApproval: options.requireExplicit,
    });
  }

  openAuthorizationWait(taskId: string, view: PactAuthorizationView): Promise<string> {
    return this.daemon.openPactAuthorizationWait(taskId, view);
  }

  settleAuthorizationWait(inputRequestId: string, state: PactAuthorizationState, message: string) {
    return this.daemon.settlePactAuthorizationWait(inputRequestId, state, message);
  }

  logEvent(taskId: string, type: string, payload: Record<string, unknown>): void {
    this.daemon.logEvent(taskId, type, payload);
  }

  logInteractiveApprovalUnavailable(taskId: string, message: string): void {
    // Same structured record the daemon writes when an approval cannot be asked for.
    this.daemon.logEvent(taskId, "log", {
      type: "tool_authorization",
      decision: "deny",
      reason: "interactive_approval_unavailable",
      approvalType: "external_service",
      message,
    });
  }

  async networkContextForWorkspace(
    workspaceId: string | null,
    taskId?: string | null,
  ): Promise<NetworkPolicyContext | null> {
    if (taskId) {
      // A resumed wait keeps its task's own access profile, not the workspace default.
      return networkContextOf(this.daemon.getEffectiveWorkspaceForTask(taskId));
    }
    if (!workspaceId) return defaultNetworkContext();
    const workspace = this.daemon.getWorkspaceForPact(workspaceId);
    return networkContextOf(workspace ? effectiveWorkspace(workspace) : undefined);
  }

  taskStillWaiting(taskId: string): Promise<boolean> {
    return this.daemon.isTaskWaitingForInput(taskId);
  }
}

export function createDaemonPactRuntime(
  daemon: PactDaemonLike,
  db: Database.Database,
): PactRuntime {
  return new PactRuntime({
    db,
    secrets: new SecureSettingsPactSecretStore(),
    host: new DaemonPactHost(daemon),
    settings: () => PactSettingsManager.loadSettings(),
    policies: () => loadPolicies(),
    transportFor: (networkContext, taskId) =>
      createPactTransport({
        networkContext,
        // Loopback is reachable only for the development signer and a local reference stack.
        allowLoopback: PactSettingsManager.loadSettings().identity.deployment === "development",
        ...(taskId
          ? {
              onDecision: (decision: NetworkPolicyDecision) =>
                daemon.logEvent(taskId, "network_policy_decision", decision),
            }
          : {}),
      }),
  });
}
