import type { IntegrationMentionOption } from "../../shared/types";
import type { AddToolsSelection } from "../components/AddToolsPanel";

export interface ContextualConnector {
  id: string;
  name: string;
  aliases: string[];
  selection: AddToolsSelection;
}

const native = (
  id: string,
  name: string,
  targetId = id,
  aliases: string[] = [name],
): ContextualConnector => ({
  id,
  name,
  aliases,
  selection: { id, name, targetId, kind: "native", source: "builtin" },
});
const mcp = (id: string, name: string): ContextualConnector => ({
  id,
  name,
  aliases: [name],
  selection: { id, name, targetId: id, kind: "mcp", source: "mcp" },
});

// Only named, supported apps are suggested. An inbox alone does not imply Gmail.
export const CONTEXTUAL_CONNECTORS: ContextualConnector[] = [
  native("gmail", "Gmail", "googleworkspace"),
  native("google-drive", "Google Drive", "googleworkspace"),
  native("google-calendar", "Google Calendar", "googleworkspace"),
  native("notion", "Notion"),
  native("box", "Box"),
  native("dropbox", "Dropbox"),
  native("onedrive", "OneDrive"),
  native("sharepoint", "SharePoint"),
  mcp("linear", "Linear"),
  mcp("jira", "Jira"),
  mcp("asana", "Asana"),
  mcp("salesforce", "Salesforce"),
  mcp("hubspot", "HubSpot"),
  mcp("figma", "Figma"),
];

export function findContextualConnectors(prompt: string): ContextualConnector[] {
  // Scope negation to a sentence/clause so "do not send" doesn't hide "read Gmail".
  const clauses = prompt
    .split(/[.!?;\n]|\bbut\b/i)
    .filter((clause) => !/\b(?:do not|don't|without|avoid|never)\b/i.test(clause));
  return CONTEXTUAL_CONNECTORS.filter((connector) =>
    connector.aliases.some((alias) => {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const namedSource = new RegExp(
        `(?:\\b(?:my|our|from|in|on|using|with|read|search|summarize|triage|check|review)\\s+(?:my\\s+|our\\s+)?|@)${escaped}\\b`,
        "i",
      );
      const localExport = new RegExp(`\\b${escaped}\\s+(?:exports?|backups?|csv|json)\\b`, "i");
      return clauses.some((clause) => namedSource.test(clause) && !localExport.test(clause));
    }),
  );
}

export function hasConnectedMention(
  connector: ContextualConnector,
  options: IntegrationMentionOption[],
): boolean {
  return options.some(
    (option) =>
      option.status === "connected" &&
      (option.providerKey === connector.id ||
        option.id === `builtin:${connector.id}` ||
        (option.source === "mcp" &&
          (option.iconKey === connector.id ||
            option.label.toLowerCase() === connector.name.toLowerCase()))),
  );
}

export interface ConnectorReadiness {
  connected: boolean;
  account?: string;
  error?: string;
}

async function loadConnectorReadiness(connector: ContextualConnector): Promise<ConnectorReadiness> {
  try {
    const api = window.electronAPI;
    if (connector.selection.kind === "native") {
      // A user may already use an MCP route for a native integration.
      const options = await api.listIntegrationMentionOptions?.().catch(() => []);
      if (hasConnectedMention(connector, options ?? [])) return { connected: true };
    }
    if (["gmail", "google-drive", "google-calendar"].includes(connector.id)) {
      const status = await api.getGoogleWorkspaceStatus();
      return {
        connected:
          status.connected &&
          !status.missingScopes?.length &&
          (connector.id === "gmail" || status.connectionMode === "workspace"),
        account: status.name,
        error:
          status.error ||
          (status.missingScopes?.length
            ? "Reconnect with the permissions this task needs."
            : undefined),
      };
    }
    const nativeStatus = {
      notion: () => api.getNotionStatus(),
      box: () => api.getBoxStatus(),
      dropbox: () => api.getDropboxStatus(),
      onedrive: () => api.getOneDriveStatus(),
      sharepoint: () => api.getSharePointStatus(),
    }[connector.id];
    if (nativeStatus) {
      const status = await nativeStatus();
      return { connected: status.connected, account: status.name, error: status.error };
    }
    const options = await api.listIntegrationMentionOptions();
    return { connected: hasConnectedMention(connector, options) };
  } catch (error) {
    return {
      connected: false,
      error: error instanceof Error ? error.message : "Could not check connection. Try again.",
    };
  }
}

export async function readConnectorReadiness(
  connector: ContextualConnector,
): Promise<ConnectorReadiness> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      loadConnectorReadiness(connector),
      new Promise<ConnectorReadiness>((resolve) => {
        timer = setTimeout(
          () =>
            resolve({
              connected: false,
              error: "Connection check timed out. Open setup or try again.",
            }),
          6000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
