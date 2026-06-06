import { ipcMain } from "electron";
import { CapabilitySecurityReport, IPC_CHANNELS } from "../../shared/types";
import { PluginRegistry } from "../extensions/registry";
import { MCPClientManager } from "../mcp/client/MCPClientManager";
import { MCPSettingsManager } from "../mcp/settings";
import { getCustomSkillLoader } from "../agent/custom-skill-loader";
import { isPackAllowed, isPackRequired, loadPoliciesStrict } from "../admin/policies";

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
  bestFitWorkflows?: ("support_ops" | "it_ops" | "sales_ops")[];
  outcomeExamples?: string[];
  skills: { id: string; name: string; description: string; icon?: string; enabled?: boolean }[];
  slashCommands: { name: string; description: string; skillId: string }[];
  agentRoles: {
    name: string;
    displayName: string;
    description?: string;
    icon: string;
    color: string;
  }[];
  state: string;
  enabled: boolean;
  /** Whether this pack is blocked by admin policy */
  policyBlocked: boolean;
  /** Whether this pack is required by admin policy (cannot be disabled) */
  policyRequired: boolean;
  /** Security report for managed or unmanaged-local imported packs */
  securityReport?: CapabilitySecurityReport;
}

/**
 * Active context data for the context panel
 */
export interface ActiveContextData {
  connectors: { id: string; name: string; icon: string; status: string; tools: string[] }[];
  skills: { id: string; name: string; icon: string }[];
}

function titleFromSkillId(id: string): string {
  return (
    id
      .split(":")
      .pop()
      ?.split(/[-_\s]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ") || id
  );
}

function listManifestSkills(manifest: {
  skills?: Array<{ id: string; name: string; description: string; icon?: string; enabled?: boolean }>;
  skillDirectories?: Array<{
    id: string;
    name?: string;
    description?: string;
    icon?: string;
    enabled?: boolean;
    path: string;
  }>;
}): PluginPackData["skills"] {
  return [
    ...(manifest.skills || []).map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      icon: s.icon,
      enabled: s.enabled !== false,
    })),
    ...(manifest.skillDirectories || []).map((s) => ({
      id: s.id,
      name: s.name || titleFromSkillId(s.id),
      description: s.description || `Directory-backed skill at ${s.path}`,
      icon: s.icon,
      enabled: s.enabled !== false,
    })),
  ];
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
  const ensureRegistryInitialized = async (): Promise<void> => {
    await registry.initialize();
  };

  // List all plugin packs with their contents
  ipcMain.handle(IPC_CHANNELS.PLUGIN_PACK_LIST, async () => {
    await ensureRegistryInitialized();
    const policies = loadPoliciesStrict();
    const packs = registry.getPluginsByType("pack");
    return packs.map((p): PluginPackData => {
      const m = p.manifest;
      const blocked = !policies || !isPackAllowed(m.name, policies);
      const required = !!policies && isPackRequired(m.name, policies);
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
        bestFitWorkflows: m.bestFitWorkflows,
        outcomeExamples: m.outcomeExamples,
        skills: listManifestSkills(m),
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
        securityReport: p.securityReport,
      };
    });
  });

  // Get a single plugin pack by name
  ipcMain.handle(IPC_CHANNELS.PLUGIN_PACK_GET, async (_, name: string) => {
    await ensureRegistryInitialized();
    if (!name || typeof name !== "string") {
      throw new Error("Pack name is required");
    }
    const plugin = registry.getPlugin(name);
    if (!plugin || plugin.manifest.type !== "pack") {
      return null;
    }
    const policies = loadPoliciesStrict();
    const m = plugin.manifest;
    const blocked = !policies || !isPackAllowed(m.name, policies);
    const required = !!policies && isPackRequired(m.name, policies);
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
      skills: listManifestSkills(m),
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
      state: blocked ? "disabled" : plugin.state,
      enabled: blocked ? false : plugin.state !== "disabled",
      policyBlocked: blocked,
      policyRequired: required,
      securityReport: plugin.securityReport,
    } satisfies PluginPackData;
  });

  // Toggle a plugin pack on/off
  ipcMain.handle(IPC_CHANNELS.PLUGIN_PACK_TOGGLE, async (_, name: string, enabled: boolean) => {
    await ensureRegistryInitialized();
    if (!name || typeof name !== "string") {
      throw new Error("Pack name is required");
    }
    const policies = loadPoliciesStrict();
    if (!policies) {
      throw new Error("Admin policies failed to load; refusing to change plugin pack state");
    }
    // Policy enforcement
    if (!isPackAllowed(name, policies)) {
      throw new Error(`Pack "${name}" is blocked by admin policy`);
    }
    if (!enabled && isPackRequired(name, policies)) {
      throw new Error(`Pack "${name}" is required by admin policy and cannot be disabled`);
    }
    const plugin = registry.getPlugin(name);
    if (!plugin) {
      throw new Error(`Pack "${name}" not found`);
    }

    const currentlyEnabled = plugin.state !== "disabled";
    const previousPersistedState = registry.getPackEnabled(name);
    const previousRuntimeState = plugin.state;
    registry.setPackEnabled(name, enabled);

    // Apply declarative registration state immediately.
    // This keeps runtime skills/connectors aligned with persisted pack state.
    try {
      if (currentlyEnabled !== enabled) {
        if (enabled) {
          await registry.reloadPlugin(name);
        } else {
          await registry.disablePlugin(name);
        }
      }
    } catch (error) {
      try {
        registry.restorePackEnabled(name, previousPersistedState);
        const restored = registry.getPlugin(name);
        if (restored) {
          restored.state = previousRuntimeState;
        }
      } catch (rollbackError) {
        console.warn("[PluginPacks] Failed to roll back pack toggle state:", rollbackError);
      }
      throw error;
    }

    const updated = registry.getPlugin(name);
    if (updated) {
      updated.state = enabled ? "registered" : "disabled";
    }
    return { success: true, name, enabled };
  });

  // Toggle a specific skill within a pack
  ipcMain.handle(
    IPC_CHANNELS.PLUGIN_PACK_TOGGLE_SKILL,
    async (_, packName: string, skillId: string, enabled: boolean) => {
      await ensureRegistryInitialized();
      if (!packName || !skillId) {
        throw new Error("Pack name and skill ID are required");
      }
      const policies = loadPoliciesStrict();
      if (!policies) {
        throw new Error("Admin policies failed to load; refusing to change plugin skill state");
      }
      const plugin = registry.getPlugin(packName);
      if (!plugin || plugin.manifest.type !== "pack") {
        throw new Error(`Pack "${packName}" not found`);
      }
      if (!isPackAllowed(packName, policies)) {
        throw new Error(`Pack "${packName}" is blocked by admin policy`);
      }
      if (!enabled && isPackRequired(packName, policies)) {
        throw new Error(`Pack "${packName}" is required by admin policy and cannot be disabled`);
      }
      const skill = [
        ...(plugin.manifest.skills || []),
        ...(plugin.manifest.skillDirectories || []),
      ].find((s) => s.id === skillId);
      if (!skill) {
        throw new Error(`Skill "${skillId}" not found in pack "${packName}"`);
      }
      const previousSkillState = skill.enabled;
      skill.enabled = enabled;
      // Persist skill states alongside pack states
      try {
        registry.setSkillEnabled(packName, skillId, enabled);
      } catch (error) {
        skill.enabled = previousSkillState;
        throw error;
      }
      return { success: true, packName, skillId, enabled };
    },
  );

  // Get active context (connected MCP servers + enabled skills)
  ipcMain.handle(IPC_CHANNELS.PLUGIN_PACK_GET_CONTEXT, async (): Promise<ActiveContextData> => {
    await ensureRegistryInitialized();
    const connectors: ActiveContextData["connectors"] = [];
    const skills: ActiveContextData["skills"] = [];

    // Get connected MCP servers
    try {
      const mcpManager = MCPClientManager.getInstance();
      const statuses = mcpManager.getStatus();
      const settings = MCPSettingsManager.loadSettings();
      const prefix = settings.toolNamePrefix || "mcp_";
      for (const s of statuses) {
        const serverTools = mcpManager.getServerTools(s.id);
        connectors.push({
          id: s.id,
          name: s.name,
          icon: resolveConnectorIcon(s),
          status: s.status,
          tools: serverTools.map((t) => `${prefix}${t.name}`),
        });
      }
    } catch {
      // MCP not initialized yet
    }

    // Get enabled skills from active packs
    try {
      const skillLoader = getCustomSkillLoader();
      await skillLoader.initialize();
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
