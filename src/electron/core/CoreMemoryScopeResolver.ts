import type { CoreMemoryScopeKind } from "../../shared/types";
import type { SubconsciousTargetRef } from "../../shared/subconscious";

export interface ResolvedCoreMemoryScope {
  scopeKind: CoreMemoryScopeKind;
  scopeRef: string;
  workspaceId?: string;
}

export class CoreMemoryScopeResolver {
  resolveFromTarget(
    target: Pick<
      SubconsciousTargetRef,
      "kind" | "key" | "workspaceId" | "agentRoleId" | "codeWorkspacePath" | "pullRequestId"
    >,
    profileId?: string,
  ): ResolvedCoreMemoryScope {
    switch (target.kind) {
      case "global":
        return { scopeKind: "global", scopeRef: "global" };
      case "workspace":
        return {
          scopeKind: "workspace",
          scopeRef: target.workspaceId || target.key,
          workspaceId: target.workspaceId,
        };
      case "agent_role":
        return {
          scopeKind: "automation_profile",
          scopeRef: profileId || target.agentRoleId || target.key,
          workspaceId: target.workspaceId,
        };
      case "code_workspace":
        return {
          scopeKind: "code_workspace",
          scopeRef: target.codeWorkspacePath || target.key,
          workspaceId: target.workspaceId,
        };
      case "pull_request":
        return {
          scopeKind: "pull_request",
          scopeRef: target.pullRequestId || target.key,
          workspaceId: target.workspaceId,
        };
      default:
        return {
          scopeKind: "workspace",
          scopeRef: target.workspaceId || target.key,
          workspaceId: target.workspaceId,
        };
    }
  }

  resolveProfileScope(profileId: string, workspaceId?: string): ResolvedCoreMemoryScope {
    return {
      scopeKind: "automation_profile",
      scopeRef: profileId,
      workspaceId,
    };
  }

  assertWritableScope(scopeKind: CoreMemoryScopeKind, scopeRef: string): void {
    if (!scopeRef || !scopeRef.trim()) {
      throw new Error(`Invalid core memory scope ref for ${scopeKind}`);
    }
  }
}
