import type { AttentionItem } from "../../shared/attention";

/**
 * The decisions waiting on the user within a view's scope: one workspace (or every workspace)
 * and, when one is chosen, one agent's work, including work it delegated. Non-urgent
 * suggestions are offers, not decisions, so they are left out, as the bell leaves them out.
 */
export function attentionInScope(
  items: readonly AttentionItem[],
  scope: { workspaceId: string | null; agentRoleId?: string | null },
): AttentionItem[] {
  return items.filter(
    (item) =>
      item.urgent &&
      (!scope.workspaceId || item.workspaceId === scope.workspaceId) &&
      (!scope.agentRoleId || (item.ownerAgentRoleIds ?? []).includes(scope.agentRoleId)),
  );
}
