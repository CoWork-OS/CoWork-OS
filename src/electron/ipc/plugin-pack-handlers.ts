import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/types";
import { PluginRegistry } from "../extensions/registry";
import { MCPClientManager } from "../mcp/client/MCPClientManager";
import { getCustomSkillLoader } from "../agent/custom-skill-loader";
import { isPackAllowed, isPackRequired } from "../admin/policies";

/**
 * Serializable pack data sent to the renderer
 */
export interface PluginPackData {
  name: string;
  displayName: string;
  version: string;
  description: string;
  icon?: string;
  category?: string;
  scope?: "personal" | "organization";
  personaTemplateId?: string;
  recommendedConnectors?: string[];
  tryAsking?: string[];
  skills: { id: string; name: string; description: string; icon?: string; enabled?: boolean }[];
  slashCommands: { name: string; description: string; skillId: string }[];
  agentRoles: { name: string; displayName: string; description?: string; icon: string; color: string }[];
  state: string;
  enabled: boolean;
  /** Whether this pack is blocked by admin policy */
  policyBlocked: boolean;
  /** Whether this pack is required by admin policy (cannot be disabled) */
  policyRequired: boolean;
}

/**
 * Active context data for the context panel
 */
export interface ActiveContextData {
  connectors: { id: string; name: string; icon: string; status: string }[];
  skills: { id: string; name: string; icon: string }[];
}

/**
 * Branded icon mapping for known connectors and common MCP servers.
 * Keys are matched against the lowercase server name/ID.
 */
const CONNECTOR_ICON_MAP: Record<string, string> = {
  salesforce: "☁️",
  jira: "🔷",
  hubspot: "🟠",
  zendesk: "💬",
  servicenow: "🔧",
  linear: "📐",
  asana: "📋",
  okta: "🔐",
  resend: "📧",
  slack: "💜",
  discord: "🎮",
  notion: "📝",
  github: "🐙",
  gitlab: "🦊",
  "google-drive": "📁",
  "google drive": "📁",
  gmail: "✉️",
  bigquery: "📊",
  intercom: "💜",
  docusign: "✍️",
  stripe: "💳",
  twilio: "📞",
  sendgrid: "📨",
  datadog: "🐶",
  pagerduty: "🚨",
  confluence: "📖",
  trello: "📌",
  monday: "📅",
  airtable: "🗂️",
  figma: "🎨",
  sentry: "🛡️",
  supabase: "⚡",
  firebase: "🔥",
  postgres: "🐘",
  mongodb: "🍃",
  redis: "🔴",
  elasticsearch: "🔍",
};

/**
 * Resolve the best icon for an MCP server based on its name/ID.
 */
function resolveConnectorIcon(server: { id: string; name: string }): string {
  const lowerName = server.name.toLowerCase();
  const lowerId = server.id.toLowerCase();

  for (const [key, icon] of Object.entries(CONNECTOR_ICON_MAP)) {
    if (lowerName.includes(key) || lowerId.includes(key)) {
      return icon;
    }
  }
  return "🔌";
}

/**
 * Set up Plugin Pack IPC handlers for the Customize panel
 */
export function setupPluginPackHandlers(): void {
  const registry = PluginRegistry.getInstance();

  // List all plugin packs with their contents
  ipcMain.handle(IPC_CHANNELS.PLUGIN_PACK_LIST, async () => {
    const packs = registry.getPluginsByType("pack");
    return packs.map((p): PluginPackData => {
      const m = p.manifest;
      const blocked = !isPackAllowed(m.name);
      const required = isPackRequired(m.name);
      return {
        name: m.name,
        displayName: m.displayName,
        version: m.version,
        description: m.description,
        icon: m.icon,
        category: m.category,
        scope: m.scope,
        personaTemplateId: m.personaTemplateId,
        recommendedConnectors: m.recommendedConnectors,
        tryAsking: m.tryAsking,
        skills: (m.skills || []).map((s) => ({
          id: s.id,
          name: s.name,
          description: s.description,
          icon: s.icon,
          enabled: s.enabled !== false,
        })),
        slashCommands: (m.slashCommands || []).map((c) => ({
          name: c.name,
          description: c.description,
          skillId: c.skillId,
        })),
        agentRoles: (m.agentRoles || []).map((r) => ({
          name: r.name,
          displayName: r.displayName,
          description: r.description,
          icon: r.icon,
          color: r.color,
        })),
        state: blocked ? "disabled" : p.state,
        enabled: blocked ? false : p.state !== "disabled",
        policyBlocked: blocked,
        policyRequired: required,
      };
    });
  });

  // Get a single plugin pack by name
  ipcMain.handle(IPC_CHANNELS.PLUGIN_PACK_GET, async (_, name: string) => {
    if (!name || typeof name !== "string") {
      throw new Error("Pack name is required");
    }
    const plugin = registry.getPlugin(name);
    if (!plugin || plugin.manifest.type !== "pack") {
      return null;
    }
    const m = plugin.manifest;
    return {
      name: m.name,
      displayName: m.displayName,
      version: m.version,
      description: m.description,
      icon: m.icon,
      category: m.category,
      scope: m.scope,
      personaTemplateId: m.personaTemplateId,
      recommendedConnectors: m.recommendedConnectors,
      tryAsking: m.tryAsking,
      skills: (m.skills || []).map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        icon: s.icon,
        enabled: s.enabled !== false,
      })),
      slashCommands: (m.slashCommands || []).map((c) => ({
        name: c.name,
        description: c.description,
        skillId: c.skillId,
      })),
      agentRoles: (m.agentRoles || []).map((r) => ({
        name: r.name,
        displayName: r.displayName,
        description: r.description,
        icon: r.icon,
        color: r.color,
      })),
      state: !isPackAllowed(m.name) ? "disabled" : plugin.state,
      enabled: !isPackAllowed(m.name) ? false : plugin.state !== "disabled",
      policyBlocked: !isPackAllowed(m.name),
      policyRequired: isPackRequired(m.name),
    } satisfies PluginPackData;
  });

  // Toggle a plugin pack on/off
  ipcMain.handle(IPC_CHANNELS.PLUGIN_PACK_TOGGLE, async (_, name: string, enabled: boolean) => {
    if (!name || typeof name !== "string") {
      throw new Error("Pack name is required");
    }
    // Policy enforcement
    if (!isPackAllowed(name)) {
      throw new Error(`Pack "${name}" is blocked by admin policy`);
    }
    if (!enabled && isPackRequired(name)) {
      throw new Error(`Pack "${name}" is required by admin policy and cannot be disabled`);
    }
    const plugin = registry.getPlugin(name);
    if (!plugin) {
      throw new Error(`Pack "${name}" not found`);
    }
    // Toggle the plugin state and persist
    plugin.state = enabled ? "registered" : "disabled";
    registry.setPackEnabled(name, enabled);
    return { success: true, name, enabled };
  });

  // Toggle a specific skill within a pack
  ipcMain.handle(
    IPC_CHANNELS.PLUGIN_PACK_TOGGLE_SKILL,
    async (_, packName: string, skillId: string, enabled: boolean) => {
      if (!packName || !skillId) {
        throw new Error("Pack name and skill ID are required");
      }
      const plugin = registry.getPlugin(packName);
      if (!plugin || plugin.manifest.type !== "pack") {
        throw new Error(`Pack "${packName}" not found`);
      }
      if (!isPackAllowed(packName)) {
        throw new Error(`Pack "${packName}" is blocked by admin policy`);
      }
      if (!enabled && isPackRequired(packName)) {
        throw new Error(`Pack "${packName}" is required by admin policy and cannot be disabled`);
      }
      const skill = (plugin.manifest.skills || []).find((s) => s.id === skillId);
      if (!skill) {
        throw new Error(`Skill "${skillId}" not found in pack "${packName}"`);
      }
      skill.enabled = enabled;
      // Persist skill states alongside pack states
      registry.setSkillEnabled(packName, skillId, enabled);
      return { success: true, packName, skillId, enabled };
    },
  );

  // Get active context (connected MCP servers + enabled skills)
  ipcMain.handle(IPC_CHANNELS.PLUGIN_PACK_GET_CONTEXT, async (): Promise<ActiveContextData> => {
    const connectors: ActiveContextData["connectors"] = [];
    const skills: ActiveContextData["skills"] = [];

    // Get connected MCP servers
    try {
      const mcpManager = MCPClientManager.getInstance();
      const statuses = mcpManager.getStatus();
      for (const s of statuses) {
        connectors.push({
          id: s.id,
          name: s.name,
          icon: resolveConnectorIcon(s),
          status: s.status,
        });
      }
    } catch {
      // MCP not initialized yet
    }

    // Get enabled skills from active packs
    try {
      const skillLoader = getCustomSkillLoader();
      const allSkills = skillLoader.listTaskSkills();
      for (const s of allSkills.slice(0, 50)) {
        skills.push({
          id: s.id,
          name: s.name,
          icon: s.icon || "⚡",
        });
      }
    } catch {
      // Skill loader not initialized yet
    }

    return { connectors, skills };
  });
}
