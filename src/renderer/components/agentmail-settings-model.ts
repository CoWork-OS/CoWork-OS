import type {
  AgentMailApiKeySummary,
  AgentMailListEntry,
  AgentMailPod,
  AgentMailStatus,
} from "../../shared/types";

/** The AgentMail calls that reach the AgentMail API, so they need a saved org API key. */
export interface AgentMailKeyedApi {
  listAgentMailPods: () => Promise<AgentMailPod[]>;
  listAgentMailListEntries: (payload: {
    workspaceId: string;
    inboxId?: string;
  }) => Promise<AgentMailListEntry[]>;
  listAgentMailInboxApiKeys: (payload: {
    workspaceId: string;
    inboxId: string;
  }) => Promise<AgentMailApiKeySummary[]>;
}

/** The message of an error from main, without Electron's "Error invoking remote method" prefix. */
export function agentMailErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const cleaned = raw
    .replace(/^Error invoking remote method '[^']+':\s*(?:\w*Error:\s*)?/, "")
    .replace(/^Error:\s*/, "")
    .trim();
  return cleaned || "Something went wrong. Try again.";
}

/** True once an org API key is saved; until then the API-backed lists stay empty. */
export function agentMailApiKeyConfigured(status: AgentMailStatus | null | undefined): boolean {
  return Boolean(status?.configured);
}

/** Pods for the "Bind existing pod" picker. Without a key nothing is fetched. */
export async function loadAgentMailPods(
  api: AgentMailKeyedApi,
  configured: boolean,
): Promise<AgentMailPod[]> {
  if (!configured) return [];
  return api.listAgentMailPods().catch(() => []);
}

/** Allow and block list entries for a scope. Without a key nothing is fetched. */
export async function loadAgentMailListEntries(
  api: AgentMailKeyedApi,
  configured: boolean,
  scope: { workspaceId: string; inboxId?: string },
): Promise<AgentMailListEntry[]> {
  if (!configured || !scope.workspaceId) return [];
  return api.listAgentMailListEntries(scope);
}

/** Inbox-scoped API keys for one inbox. Without a key nothing is fetched. */
export async function loadAgentMailInboxApiKeys(
  api: AgentMailKeyedApi,
  configured: boolean,
  scope: { workspaceId: string; inboxId?: string },
): Promise<AgentMailApiKeySummary[]> {
  if (!configured || !scope.workspaceId || !scope.inboxId) return [];
  return api.listAgentMailInboxApiKeys({ workspaceId: scope.workspaceId, inboxId: scope.inboxId });
}
