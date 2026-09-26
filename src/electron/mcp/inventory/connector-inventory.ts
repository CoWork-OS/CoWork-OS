import type { MCPRegistryEntry } from "../types";
import type { ChannelType } from "../../gateway/channels/types";

export type IntegrationType = "native-app" | "gateway-channel" | "mcp-server" | "skill";

export type IntegrationAction =
  | "read"
  | "write"
  | "inbound-message"
  | "outbound-message"
  | "event-trigger";

/**
 * Lifecycle of an integration on a given install. The generated inventory can
 * only assert `available` (it ships in the build); the remaining states are
 * runtime facts reported by settings and health checks.
 */
export type ConnectionState = "available" | "configured" | "connected" | "exercised";

export type IntegrationRequirement =
  | "macos-only"
  | "local-service"
  | "public-webhook"
  | "oauth-consent"
  | "api-key"
  | "cli-binary"
  | "personal-account-session";

export type IntegrationProvenance = "first-party-api" | "third-party-package" | "skill-cli";

export interface InventoryRow {
  id: string;
  name: string;
  integrationType: IntegrationType;
  actions: IntegrationAction[];
  requirements: IntegrationRequirement[];
  provenance: IntegrationProvenance;
  category?: string;
  source: string;
}

export interface ConnectorInventory {
  rows: InventoryRow[];
  counts: Record<IntegrationType, number>;
}

export interface SkillManifestSummary {
  id: string;
  name: string;
  category?: string;
  requires?: { bins?: string[]; env?: string[]; os?: string[] } & Record<string, unknown>;
}

export interface NativeIntegrationSpec {
  id: string;
  name: string;
  actions: IntegrationAction[];
  requirements: IntegrationRequirement[];
  /** Repo-relative file that implements the integration; checked by tests. */
  source: string;
}

export interface ChannelInventorySpec {
  name: string;
  requirements: IntegrationRequirement[];
  provenance: IntegrationProvenance;
}

export const NATIVE_INTEGRATIONS: NativeIntegrationSpec[] = [
  {
    id: "mailbox",
    name: "Inbox Agent (Gmail API, Microsoft Graph, IMAP/SMTP, AgentMail)",
    actions: ["read", "write", "event-trigger"],
    requirements: ["oauth-consent"],
    source: "src/electron/agent/tools/mailbox-tools.ts",
  },
  {
    id: "gmail",
    name: "Gmail",
    actions: ["read", "write"],
    requirements: ["oauth-consent"],
    source: "src/electron/agent/tools/gmail-tools.ts",
  },
  {
    id: "google-drive",
    name: "Google Drive",
    actions: ["read", "write"],
    requirements: ["oauth-consent"],
    source: "src/electron/agent/tools/google-drive-tools.ts",
  },
  {
    id: "google-calendar",
    name: "Google Calendar",
    actions: ["read", "write"],
    requirements: ["oauth-consent"],
    source: "src/electron/agent/tools/google-calendar-tools.ts",
  },
  {
    id: "notion",
    name: "Notion",
    actions: ["read", "write"],
    requirements: ["api-key"],
    source: "src/electron/agent/tools/notion-tools.ts",
  },
  {
    id: "box-native",
    name: "Box",
    actions: ["read", "write"],
    requirements: ["oauth-consent"],
    source: "src/electron/agent/tools/box-tools.ts",
  },
  {
    id: "dropbox",
    name: "Dropbox",
    actions: ["read", "write"],
    requirements: ["oauth-consent"],
    source: "src/electron/agent/tools/dropbox-tools.ts",
  },
  {
    id: "onedrive",
    name: "OneDrive",
    actions: ["read", "write"],
    requirements: ["oauth-consent"],
    source: "src/electron/agent/tools/onedrive-tools.ts",
  },
  {
    id: "sharepoint",
    name: "SharePoint",
    actions: ["read", "write"],
    requirements: ["oauth-consent"],
    source: "src/electron/agent/tools/sharepoint-tools.ts",
  },
  {
    id: "apple-calendar",
    name: "Apple Calendar",
    actions: ["read", "write"],
    requirements: ["macos-only"],
    source: "src/electron/agent/tools/apple-calendar-tools.ts",
  },
  {
    id: "apple-reminders",
    name: "Apple Reminders",
    actions: ["read", "write"],
    requirements: ["macos-only"],
    source: "src/electron/agent/tools/apple-reminders-tools.ts",
  },
  {
    id: "x-native",
    name: "X (posting and search)",
    actions: ["read", "write"],
    requirements: ["api-key"],
    source: "src/electron/agent/tools/x-tools.ts",
  },
  {
    id: "teams-meetings",
    name: "Teams meeting transcripts",
    actions: ["read", "event-trigger"],
    requirements: ["oauth-consent"],
    source: "src/electron/meetings/teams/teams-artifact-pipeline.ts",
  },
  {
    id: "voice-call",
    name: "Voice calls",
    actions: ["outbound-message"],
    requirements: ["api-key"],
    source: "src/electron/agent/tools/voice-call-tools.ts",
  },
];

export const CHANNEL_INVENTORY: Record<ChannelType, ChannelInventorySpec> = {
  telegram: { name: "Telegram", requirements: ["api-key"], provenance: "third-party-package" },
  discord: { name: "Discord", requirements: ["api-key"], provenance: "third-party-package" },
  slack: { name: "Slack", requirements: ["api-key"], provenance: "third-party-package" },
  whatsapp: {
    name: "WhatsApp (personal, WhatsApp Web)",
    requirements: ["personal-account-session"],
    provenance: "third-party-package",
  },
  imessage: {
    name: "iMessage",
    requirements: ["macos-only", "cli-binary"],
    provenance: "skill-cli",
  },
  signal: {
    name: "Signal",
    requirements: ["cli-binary", "personal-account-session"],
    provenance: "skill-cli",
  },
  mattermost: { name: "Mattermost", requirements: ["api-key"], provenance: "first-party-api" },
  matrix: { name: "Matrix", requirements: ["api-key"], provenance: "third-party-package" },
  twitch: { name: "Twitch", requirements: ["oauth-consent"], provenance: "first-party-api" },
  line: {
    name: "LINE",
    requirements: ["api-key", "public-webhook"],
    provenance: "first-party-api",
  },
  bluebubbles: {
    name: "BlueBubbles (iMessage relay)",
    requirements: ["local-service"],
    provenance: "first-party-api",
  },
  email: { name: "Email (IMAP/SMTP)", requirements: ["api-key"], provenance: "first-party-api" },
  teams: {
    name: "Microsoft Teams",
    requirements: ["oauth-consent", "public-webhook"],
    provenance: "third-party-package",
  },
  googlechat: {
    name: "Google Chat",
    requirements: ["oauth-consent", "public-webhook"],
    provenance: "first-party-api",
  },
  feishu: {
    name: "Feishu / Lark",
    requirements: ["api-key", "public-webhook"],
    provenance: "first-party-api",
  },
  wecom: {
    name: "WeCom",
    requirements: ["api-key", "public-webhook"],
    provenance: "first-party-api",
  },
  x: { name: "X (mentions)", requirements: ["api-key"], provenance: "first-party-api" },
  whatsapp_cloud: {
    name: "WhatsApp Business Cloud API",
    requirements: ["api-key", "public-webhook"],
    provenance: "first-party-api",
  },
  twilio_sms: {
    name: "Twilio SMS",
    requirements: ["api-key", "public-webhook"],
    provenance: "first-party-api",
  },
};

const READ_VERB =
  /(^|[._])(health|list|get|search|read|query|describe|fetch|find|lookup|download|who_am_i|ask|ai_|status|check|preview|export|resolve|geocode|reverse|route|directions|distance|timezone|availability)/i;
const WRITE_VERB =
  /(^|[._])(create|update|delete|remove|send|call|upload|move|add|set|post|patch|put|insert|append|complete|archive|trash|modify|reply|invite|share|publish|trigger|run|execute|import|generate|render|batch|toggle|turn|write|edit|close|merge|assign|comment)/i;

export function classifyToolActions(toolNames: string[]): IntegrationAction[] {
  const actions = new Set<IntegrationAction>();
  for (const name of toolNames) {
    const local = name.includes(".") ? name.slice(name.indexOf(".") + 1) : name;
    if (WRITE_VERB.test(local)) actions.add("write");
    else if (READ_VERB.test(local)) actions.add("read");
    else actions.add("read");
  }
  return orderActions(actions);
}

const LOCAL_URL = /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0)(:|\/|$)/i;

/** Registry entries whose env placeholders do not reflect what is actually required. */
const MCP_REQUIREMENT_OVERRIDES: Record<string, IntegrationRequirement[]> = {
  // GOOGLE_MAPS_API_KEY is optional; the connector falls back to keyless OSM.
  maps: [],
};

export function inferMcpRequirements(entry: MCPRegistryEntry): IntegrationRequirement[] {
  const override = MCP_REQUIREMENT_OVERRIDES[entry.id];
  if (override) return [...override];
  const requirements = new Set<IntegrationRequirement>();
  const envKeys = Object.keys(entry.defaultEnv || {});
  const envValues = Object.values(entry.defaultEnv || {});
  const tags = (entry.tags || []).map((tag) => tag.toLowerCase());
  const text = `${entry.description} ${entry.name}`.toLowerCase();

  if (tags.includes("macos") || /macos only|on macos/.test(text)) requirements.add("macos-only");
  if (
    envValues.some((value) => LOCAL_URL.test(value)) ||
    tags.includes("local") ||
    /local (bridge|server|instance|api)/.test(text)
  ) {
    requirements.add("local-service");
  }
  const hasOAuth =
    tags.includes("oauth") ||
    envKeys.some((key) => /REFRESH_TOKEN|CLIENT_SECRET|OAUTH/.test(key)) ||
    /\boauth\b/.test(text);
  if (hasOAuth) requirements.add("oauth-consent");
  if (
    envKeys.some((key) => /(API_KEY|_TOKEN|_SECRET|_KEY|PASSWORD)$/.test(key)) &&
    !(hasOAuth && envKeys.every((key) => !/API_KEY$/.test(key)))
  ) {
    requirements.add("api-key");
  }
  return [...requirements].sort();
}

export function inferMcpProvenance(entry: MCPRegistryEntry): IntegrationProvenance {
  if (entry.installMethod === "manual" && entry.author === "CoWork OS") return "first-party-api";
  if (entry.transport !== "stdio" && entry.defaultUrl) return "first-party-api";
  return "third-party-package";
}

function orderActions(actions: Set<IntegrationAction>): IntegrationAction[] {
  const order: IntegrationAction[] = [
    "read",
    "write",
    "inbound-message",
    "outbound-message",
    "event-trigger",
  ];
  return order.filter((action) => actions.has(action));
}

export function skillRequirements(skill: SkillManifestSummary): IntegrationRequirement[] {
  const requirements = new Set<IntegrationRequirement>();
  const requires = skill.requires || {};
  if (Array.isArray(requires.bins) && requires.bins.length > 0) requirements.add("cli-binary");
  if (Array.isArray(requires.env) && requires.env.length > 0) requirements.add("api-key");
  if (Array.isArray(requires.os) && requires.os.every((os) => os === "darwin")) {
    requirements.add("macos-only");
  }
  return [...requirements].sort();
}

export function buildConnectorInventory(input: {
  registryEntries: MCPRegistryEntry[];
  channelTypes: readonly ChannelType[];
  skills: SkillManifestSummary[];
  nativeIntegrations?: NativeIntegrationSpec[];
}): ConnectorInventory {
  const rows: InventoryRow[] = [];

  for (const native of input.nativeIntegrations ?? NATIVE_INTEGRATIONS) {
    rows.push({
      id: native.id,
      name: native.name,
      integrationType: "native-app",
      actions: native.actions,
      requirements: [...native.requirements].sort(),
      provenance: "first-party-api",
      source: native.source,
    });
  }

  for (const channelType of input.channelTypes) {
    const spec = CHANNEL_INVENTORY[channelType];
    rows.push({
      id: channelType,
      name: spec.name,
      integrationType: "gateway-channel",
      actions: ["inbound-message", "outbound-message"],
      requirements: [...spec.requirements].sort(),
      provenance: spec.provenance,
      source: "src/electron/gateway/channels/types.ts",
    });
  }

  for (const entry of input.registryEntries) {
    rows.push({
      id: entry.id,
      name: entry.name,
      integrationType: "mcp-server",
      actions: classifyToolActions(entry.tools.map((tool) => tool.name)),
      requirements: inferMcpRequirements(entry),
      provenance: inferMcpProvenance(entry),
      category: entry.category,
      source: "src/electron/mcp/registry/MCPRegistryManager.ts",
    });
  }

  for (const skill of input.skills) {
    rows.push({
      id: skill.id,
      name: skill.name,
      integrationType: "skill",
      actions: ["read", "write"],
      requirements: skillRequirements(skill),
      provenance: "skill-cli",
      category: skill.category,
      source: `resources/skills/${skill.id}.json`,
    });
  }

  const counts: Record<IntegrationType, number> = {
    "native-app": 0,
    "gateway-channel": 0,
    "mcp-server": 0,
    skill: 0,
  };
  for (const row of rows) counts[row.integrationType] += 1;

  return { rows, counts };
}

export function resolveConnectionState(input: {
  configured: boolean;
  connected: boolean;
  lastSuccessfulCallAt?: number | null;
}): ConnectionState {
  if (input.connected && input.lastSuccessfulCallAt) return "exercised";
  if (input.connected) return "connected";
  if (input.configured) return "configured";
  return "available";
}

const TYPE_HEADINGS: Record<IntegrationType, string> = {
  "native-app": "Native app integrations",
  "gateway-channel": "Gateway channels",
  "mcp-server": "MCP connectors (Settings > Connectors)",
  skill: "Bundled skills",
};

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|");
}

export function renderInventoryMarkdown(inventory: ConnectorInventory): string {
  const lines: string[] = [
    "# Connector Inventory",
    "",
    "<!-- Generated by `npm run connectors:inventory`. Do not edit by hand. -->",
    "",
    "One row per shipped integration, generated from the MCP registry, the gateway channel list, the native tool classes and the bundled skill manifests. `npm run test` fails when this page is out of date.",
    "",
    "Every row here is **available** in the build. Whether it is **configured**, **connected** and **successfully exercised** is install-specific: check **Settings > Connectors**, **Settings > Channels**, or the connector's `health` tool.",
    "",
    "| Integration type | Count |",
    "| --- | ---: |",
  ];
  for (const type of Object.keys(TYPE_HEADINGS) as IntegrationType[]) {
    lines.push(`| ${TYPE_HEADINGS[type]} | ${inventory.counts[type]} |`);
  }
  lines.push(
    "",
    "Requirement keys: `macos-only`, `local-service` (a local app or server must be running), `public-webhook` (a reachable HTTPS URL is needed in production), `oauth-consent`, `api-key`, `cli-binary`, `personal-account-session`.",
  );

  for (const type of Object.keys(TYPE_HEADINGS) as IntegrationType[]) {
    const rows = inventory.rows
      .filter((row) => row.integrationType === type)
      .sort((a, b) => a.name.localeCompare(b.name));
    lines.push("", `## ${TYPE_HEADINGS[type]}`, "");
    if (type === "skill") {
      lines.push("| ID | Name | Category | Requirements |", "| --- | --- | --- | --- |");
      for (const row of rows) {
        lines.push(
          `| \`${row.id}\` | ${escapeCell(row.name)} | ${row.category || ""} | ${row.requirements.join(", ")} |`,
        );
      }
      continue;
    }
    lines.push(
      "| ID | Name | Actions | Requirements | Provenance |",
      "| --- | --- | --- | --- | --- |",
    );
    for (const row of rows) {
      lines.push(
        `| \`${row.id}\` | ${escapeCell(row.name)} | ${row.actions.join(", ")} | ${row.requirements.join(", ")} | ${row.provenance} |`,
      );
    }
  }
  lines.push("");
  return lines.join("\n");
}
