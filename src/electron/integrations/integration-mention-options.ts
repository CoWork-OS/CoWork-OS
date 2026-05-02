import type {
  AgentMailSettingsData,
  BoxSettingsData,
  ChannelData,
  DropboxSettingsData,
  GoogleWorkspaceSettingsData,
  IntegrationMentionOption,
  NotionSettingsData,
  OneDriveSettingsData,
  SharePointSettingsData,
} from "../../shared/types";
import { AgentMailSettingsManager } from "../settings/agentmail-manager";
import { BoxSettingsManager } from "../settings/box-manager";
import { DropboxSettingsManager } from "../settings/dropbox-manager";
import { GoogleWorkspaceSettingsManager } from "../settings/google-workspace-manager";
import { NotionSettingsManager } from "../settings/notion-manager";
import { OneDriveSettingsManager } from "../settings/onedrive-manager";
import { SharePointSettingsManager } from "../settings/sharepoint-manager";
import {
  detectConnectorCapabilityId,
  isConnectorConfiguredByCapability,
} from "../mcp/connectors/capabilities";
import { MCPClientManager } from "../mcp/client/MCPClientManager";
import { MCPSettingsManager } from "../mcp/settings";
import type { MCPServerStatus, MCPSettings, MCPTool } from "../mcp/types";

type BuiltinIntegrationSettings = {
  notion?: NotionSettingsData;
  box?: BoxSettingsData;
  oneDrive?: OneDriveSettingsData;
  googleWorkspace?: GoogleWorkspaceSettingsData;
  agentMail?: AgentMailSettingsData;
  dropbox?: DropboxSettingsData;
  sharePoint?: SharePointSettingsData;
};

export type IntegrationMentionOptionsState = {
  builtins?: BuiltinIntegrationSettings;
  channels?: ChannelData[];
  mcp?: {
    settings: Pick<MCPSettings, "servers" | "toolNamePrefix">;
    statuses?: MCPServerStatus[];
  };
};

const BUILTIN_DEFS: Array<{
  key: keyof BuiltinIntegrationSettings;
  id: string;
  label: string;
  providerKey: string;
  iconKey: string;
  description: string;
  aliases: string[];
  tools: string[];
  promptHint: string;
  isConfigured: (settings: BuiltinIntegrationSettings[keyof BuiltinIntegrationSettings]) => boolean;
}> = [
  {
    key: "notion",
    id: "builtin:notion",
    label: "Notion",
    providerKey: "notion",
    iconKey: "notion",
    description: "Search and create content on Notion pages.",
    aliases: ["notes", "docs", "workspace"],
    tools: ["notion_action"],
    promptHint: "Use notion_action for Notion search, reading, page creation, and updates.",
    isConfigured: (settings) => Boolean(settings?.enabled && hasText((settings as NotionSettingsData).apiKey)),
  },
  {
    key: "box",
    id: "builtin:box",
    label: "Box",
    providerKey: "box",
    iconKey: "box",
    description: "Search and access Box files.",
    aliases: ["files", "storage"],
    tools: ["box_action"],
    promptHint: "Use box_action for Box folder and file access.",
    isConfigured: (settings) => Boolean(settings?.enabled && hasText((settings as BoxSettingsData).accessToken)),
  },
  {
    key: "oneDrive",
    id: "builtin:onedrive",
    label: "OneDrive",
    providerKey: "onedrive",
    iconKey: "onedrive",
    description: "Search and access OneDrive files.",
    aliases: ["files", "storage", "microsoft"],
    tools: ["onedrive_action"],
    promptHint: "Use onedrive_action for OneDrive folder and file access.",
    isConfigured: (settings) =>
      Boolean(settings?.enabled && hasText((settings as OneDriveSettingsData).accessToken)),
  },
  {
    key: "agentMail",
    id: "builtin:agentmail",
    label: "AgentMail",
    providerKey: "agentmail",
    iconKey: "agentmail",
    description: "Use native agent inboxes and mailbox workflows.",
    aliases: ["mailbox", "email", "inbox"],
    tools: ["mailbox_action"],
    promptHint: "Use mailbox_action for AgentMail mailbox, inbox, and draft workflows.",
    isConfigured: (settings) =>
      Boolean(settings?.enabled && hasText((settings as AgentMailSettingsData).apiKey)),
  },
  {
    key: "dropbox",
    id: "builtin:dropbox",
    label: "Dropbox",
    providerKey: "dropbox",
    iconKey: "dropbox",
    description: "Search and access Dropbox files.",
    aliases: ["files", "storage"],
    tools: ["dropbox_action"],
    promptHint: "Use dropbox_action for Dropbox folder and file access.",
    isConfigured: (settings) =>
      Boolean(settings?.enabled && hasText((settings as DropboxSettingsData).accessToken)),
  },
  {
    key: "sharePoint",
    id: "builtin:sharepoint",
    label: "SharePoint",
    providerKey: "sharepoint",
    iconKey: "sharepoint",
    description: "Search and access SharePoint content.",
    aliases: ["files", "microsoft", "sites"],
    tools: ["sharepoint_action"],
    promptHint: "Use sharepoint_action for SharePoint site, drive, and file access.",
    isConfigured: (settings) =>
      Boolean(settings?.enabled && hasText((settings as SharePointSettingsData).accessToken)),
  },
];

const GOOGLE_WORKSPACE_SPLIT_OPTIONS: IntegrationMentionOption[] = [
  {
    id: "builtin:gmail",
    label: "Gmail",
    source: "builtin",
    providerKey: "google-workspace:gmail",
    iconKey: "gmail",
    description: "Search, read, draft, and send Gmail messages.",
    aliases: ["email", "mail", "inbox", "google mail"],
    tools: ["gmail_action"],
    promptHint: "Use gmail_action for Gmail search, reading, drafting, and sending.",
    status: "configured",
  },
  {
    id: "builtin:google-drive",
    label: "Google Drive",
    source: "builtin",
    providerKey: "google-workspace:drive",
    iconKey: "google-drive",
    description: "Find and access Google Drive files.",
    aliases: ["drive", "docs", "sheets", "slides", "files"],
    tools: ["google_drive_action"],
    promptHint: "Use google_drive_action for Google Drive file discovery and access.",
    status: "configured",
  },
  {
    id: "builtin:google-calendar",
    label: "Google Calendar",
    source: "builtin",
    providerKey: "google-workspace:calendar",
    iconKey: "google-calendar",
    description: "Review and manage Google Calendar events.",
    aliases: ["calendar", "schedule", "meetings", "events"],
    tools: ["calendar_action"],
    promptHint: "Use calendar_action for Google Calendar scheduling and event workflows.",
    status: "configured",
  },
];

const INBOX_AGENT_OPTION: IntegrationMentionOption = {
  id: "builtin:inbox-agent",
  label: "Inbox",
  source: "builtin",
  providerKey: "inbox-agent",
  iconKey: "inbox",
  description: "Ask Inbox using the Inbox Agent module.",
  aliases: ["inbox agent", "ask inbox", "mailbox", "email", "mail"],
  tools: ["mailbox_action"],
  promptHint: "Route this request to the Inbox Agent Ask Inbox module for mailbox questions.",
  status: "configured",
};

const CHANNEL_LABELS: Record<string, { label: string; iconKey: string; aliases: string[] }> = {
  slack: { label: "Slack", iconKey: "slack", aliases: ["channel", "workspace", "messages"] },
  discord: { label: "Discord", iconKey: "discord", aliases: ["channel", "server", "messages"] },
  teams: { label: "Microsoft Teams", iconKey: "teams", aliases: ["teams", "chat", "messages"] },
  googlechat: { label: "Google Chat", iconKey: "google-chat", aliases: ["chat", "messages"] },
  telegram: { label: "Telegram", iconKey: "telegram", aliases: ["chat", "messages"] },
  whatsapp: { label: "WhatsApp", iconKey: "whatsapp", aliases: ["chat", "messages"] },
  signal: { label: "Signal", iconKey: "signal", aliases: ["chat", "messages"] },
  imessage: { label: "iMessage", iconKey: "imessage", aliases: ["messages", "sms"] },
  mattermost: { label: "Mattermost", iconKey: "mattermost", aliases: ["channel", "messages"] },
  matrix: { label: "Matrix", iconKey: "matrix", aliases: ["channel", "messages"] },
  email: { label: "Email", iconKey: "email", aliases: ["mail", "inbox"] },
  x: { label: "X", iconKey: "x", aliases: ["twitter", "social"] },
};

const MCP_SERVICE_DEFS: Array<{
  key: string;
  label: string;
  iconKey: string;
  aliases: string[];
  matches: (toolName: string) => boolean;
}> = [
  {
    key: "gmail",
    label: "Gmail",
    iconKey: "gmail",
    aliases: ["mail", "email", "inbox"],
    matches: (toolName) => /\bgmail\b|gmail[_\-.]|mail[_\-.]/.test(toolName),
  },
  {
    key: "drive",
    label: "Google Drive",
    iconKey: "google-drive",
    aliases: ["drive", "files"],
    matches: (toolName) => /\bdrive\b|drive[_\-.]/.test(toolName),
  },
  {
    key: "calendar",
    label: "Google Calendar",
    iconKey: "google-calendar",
    aliases: ["calendar", "schedule", "events"],
    matches: (toolName) => /\bcalendar\b|calendar[_\-.]/.test(toolName),
  },
  {
    key: "docs",
    label: "Google Docs",
    iconKey: "google-docs",
    aliases: ["docs", "documents"],
    matches: (toolName) => /\bdocs\b|docs[_\-.]|document[_\-.]/.test(toolName),
  },
  {
    key: "sheets",
    label: "Google Sheets",
    iconKey: "google-sheets",
    aliases: ["sheets", "spreadsheet"],
    matches: (toolName) => /\bsheets\b|sheets[_\-.]|spreadsheet[_\-.]/.test(toolName),
  },
  {
    key: "slides",
    label: "Google Slides",
    iconKey: "google-slides",
    aliases: ["slides", "presentations"],
    matches: (toolName) => /\bslides\b|slides[_\-.]|presentation[_\-.]/.test(toolName),
  },
  {
    key: "chat",
    label: "Google Chat",
    iconKey: "google-chat",
    aliases: ["chat", "messages"],
    matches: (toolName) => /\bchat\b|chat[_\-.]/.test(toolName),
  },
];

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function optionFromBuiltin(
  def: (typeof BUILTIN_DEFS)[number],
): IntegrationMentionOption {
  return {
    id: def.id,
    label: def.label,
    source: "builtin",
    providerKey: def.providerKey,
    iconKey: def.iconKey,
    description: def.description,
    aliases: def.aliases,
    tools: def.tools,
    promptHint: def.promptHint,
    status: "configured",
  };
}

function buildBuiltinOptions(settings: BuiltinIntegrationSettings): IntegrationMentionOption[] {
  const options: IntegrationMentionOption[] = [];

  const google = settings.googleWorkspace;
  if (google?.enabled && (hasText(google.accessToken) || hasText(google.refreshToken))) {
    options.push(...GOOGLE_WORKSPACE_SPLIT_OPTIONS);
  }

  const inboxAgentAvailable =
    Boolean(google?.enabled && (hasText(google.accessToken) || hasText(google.refreshToken))) ||
    Boolean(
      settings.agentMail?.enabled &&
        hasText((settings.agentMail as AgentMailSettingsData | undefined)?.apiKey),
    );
  if (inboxAgentAvailable) {
    options.push(INBOX_AGENT_OPTION);
  }

  for (const def of BUILTIN_DEFS) {
    const configured = def.isConfigured(settings[def.key]);
    if (configured) options.push(optionFromBuiltin(def));
  }

  return options;
}

function buildGatewayOptions(channels: ChannelData[] = []): IntegrationMentionOption[] {
  const usable = channels.filter((channel) => channel.enabled && channel.status === "connected");
  const countsByType = usable.reduce<Map<string, number>>((counts, channel) => {
    counts.set(channel.type, (counts.get(channel.type) ?? 0) + 1);
    return counts;
  }, new Map());

  return usable.map((channel) => {
    const meta = CHANNEL_LABELS[channel.type] ?? {
      label: toTitle(channel.type),
      iconKey: channel.type,
      aliases: ["channel", "messages"],
    };
    const duplicateType = (countsByType.get(channel.type) ?? 0) > 1;
    const label = duplicateType && channel.name ? `${meta.label} - ${channel.name}` : meta.label;
    const tools = ["channel_list_chats", "channel_history"];
    if (channel.type === "discord") {
      tools.push("channel_fetch_discord_messages", "channel_download_discord_attachment");
    }
    return {
      id: `gateway:${channel.type}:${channel.id}`,
      label,
      source: "gateway" as const,
      providerKey: channel.type,
      iconKey: meta.iconKey,
      description: `Use ${label} conversations and message history.`,
      aliases: [channel.type, channel.name, ...meta.aliases].filter(hasText) as string[],
      tools,
      promptHint: `Use channel_list_chats and channel_history with channel="${channel.type}" for ${label}.`,
      status: "connected" as const,
    };
  });
}

function toolNamesWithPrefix(prefix: string, tools: MCPTool[] = []): string[] {
  return tools.map((tool) => `${prefix}${tool.name}`);
}

function rawToolNames(tools: MCPTool[] = []): string[] {
  return tools.map((tool) => tool.name);
}

function buildMcpOptions(mcp?: IntegrationMentionOptionsState["mcp"]): IntegrationMentionOption[] {
  if (!mcp) return [];
  const prefix = mcp.settings.toolNamePrefix || "mcp_";
  const statusesById = new Map((mcp.statuses || []).map((status) => [status.id, status]));
  const configsById = new Map(mcp.settings.servers.map((server) => [server.id, server]));
  const ids = new Set<string>([
    ...mcp.settings.servers.map((server) => server.id),
    ...(mcp.statuses || []).map((status) => status.id),
  ]);
  const options: IntegrationMentionOption[] = [];

  for (const id of ids) {
    const config = configsById.get(id);
    const status = statusesById.get(id);
    const name = config?.name || status?.name || id;
    const enabled = config?.enabled !== false;
    const connected = status?.status === "connected";
    const capabilityId = config ? detectConnectorCapabilityId(config) : null;
    const configured = capabilityId
      ? isConnectorConfiguredByCapability(capabilityId, config?.env)
      : false;
    if (!enabled && !connected) continue;
    if (capabilityId ? !configured && !connected : !connected) continue;

    const rawTools = status?.tools?.length ? status.tools : config?.tools || [];
    const exactTools = toolNamesWithPrefix(prefix, rawTools);
    options.push(
      ...splitMcpServerOptions({
        serverId: id,
        serverName: name,
        capabilityId,
        status: connected ? "connected" : "configured",
        exactTools,
        rawToolNames: rawToolNames(rawTools),
      }),
    );
  }

  return options;
}

function splitMcpServerOptions(input: {
  serverId: string;
  serverName: string;
  capabilityId: string | null;
  status: "configured" | "connected";
  exactTools: string[];
  rawToolNames: string[];
}): IntegrationMentionOption[] {
  const groups = new Map<
    string,
    {
      def: (typeof MCP_SERVICE_DEFS)[number];
      exactTools: string[];
    }
  >();

  input.rawToolNames.forEach((rawName, index) => {
    const normalized = rawName.toLowerCase();
    const def = MCP_SERVICE_DEFS.find((candidate) => candidate.matches(normalized));
    if (!def) return;
    const group = groups.get(def.key) ?? { def, exactTools: [] };
    group.exactTools.push(input.exactTools[index]);
    groups.set(def.key, group);
  });

  if (groups.size > 1) {
    return Array.from(groups.values()).map(({ def, exactTools }) => ({
      id: `mcp:${input.serverId}:${def.key}`,
      label: def.label,
      source: "mcp" as const,
      providerKey: `${input.serverId}:${def.key}`,
      iconKey: def.iconKey,
      description: `${input.serverName} ${def.label} tools.`,
      aliases: [input.serverName, def.key, ...def.aliases],
      tools: exactTools,
      promptHint: `Use the selected ${input.serverName} MCP ${def.label} tools when the task needs ${def.label}.`,
      status: input.status,
    }));
  }

  const iconKey = input.capabilityId || slugify(input.serverName) || "mcp";
  return [
    {
      id: `mcp:${input.serverId}`,
      label: input.serverName,
      source: "mcp",
      providerKey: input.serverId,
      iconKey,
      description: input.exactTools.length
        ? `Use ${input.serverName} MCP tools.`
        : `Use ${input.serverName} MCP connector.`,
      aliases: [input.serverName, input.capabilityId || "", "mcp"].filter(hasText) as string[],
      tools: input.exactTools,
      promptHint: input.exactTools.length
        ? `Use ${input.serverName} MCP tools for this integration when relevant.`
        : `Use the ${input.serverName} MCP connector when relevant.`,
      status: input.status,
    },
  ];
}

function toTitle(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function dedupeOptions(options: IntegrationMentionOption[]): IntegrationMentionOption[] {
  const seen = new Set<string>();
  const deduped: IntegrationMentionOption[] = [];
  for (const option of options) {
    if (seen.has(option.id)) continue;
    seen.add(option.id);
    deduped.push({
      ...option,
      aliases: Array.from(new Set(option.aliases.filter(hasText) as string[])),
      tools: Array.from(new Set(option.tools.filter(hasText) as string[])),
    });
  }
  return deduped;
}

export function buildIntegrationMentionOptionsFromState(
  state: IntegrationMentionOptionsState,
): IntegrationMentionOption[] {
  const channelBackedInboxAvailable = (state.channels || []).some(
    (channel) => channel.type === "email" && channel.enabled && channel.status === "connected",
  );
  return dedupeOptions([
    ...buildBuiltinOptions(state.builtins || {}),
    ...(channelBackedInboxAvailable ? [INBOX_AGENT_OPTION] : []),
    ...buildGatewayOptions(state.channels || []),
    ...buildMcpOptions(state.mcp),
  ]);
}

export function listIntegrationMentionOptions(channels: ChannelData[] = []): IntegrationMentionOption[] {
  const builtins: BuiltinIntegrationSettings = {
    notion: NotionSettingsManager.loadSettings(),
    box: BoxSettingsManager.loadSettings(),
    oneDrive: OneDriveSettingsManager.loadSettings(),
    googleWorkspace: GoogleWorkspaceSettingsManager.loadSettings(),
    agentMail: AgentMailSettingsManager.loadSettings(),
    dropbox: DropboxSettingsManager.loadSettings(),
    sharePoint: SharePointSettingsManager.loadSettings(),
  };

  let mcp: IntegrationMentionOptionsState["mcp"] | undefined;
  try {
    const settings = MCPSettingsManager.loadSettings();
    const manager = MCPClientManager.getInstance();
    mcp = {
      settings,
      statuses: manager.getStatus(),
    };
  } catch {
    try {
      mcp = { settings: MCPSettingsManager.loadSettings(), statuses: [] };
    } catch {
      mcp = undefined;
    }
  }

  return buildIntegrationMentionOptionsFromState({ builtins, channels, mcp });
}
