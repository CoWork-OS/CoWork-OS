/** The live sources behind BotCapabilityService, as the running app reads them. */
import { resolveAccessProfileDefinitionWithStatus } from "../../shared/access-profiles";
import { taskAgentConfigForCreation } from "../../shared/security/task-entrypoint";
import type { AgentRole, ChannelData } from "../../shared/types";
import { loadPolicies } from "../admin/policies";
import { BotDesktopManager } from "../computer-use/bot-desktop-manager";
import { listIntegrationMentionOptions } from "../integrations/integration-mention-options";
import { isCodexComputerUseServer } from "../mcp/codex-computer-use";
import { MCPSettingsManager } from "../mcp/settings";
import { botMemoryCount } from "../memory/repo/memory-repo-bots";
import { MemoryRepoService } from "../memory/repo/MemoryRepoService";
import { resolveEffectiveAccessProfile } from "../security/access-profile-resolver";
import { PermissionSettingsManager } from "../security/permission-settings-manager";
import { MemoryFeaturesManager } from "../settings/memory-features-manager";
import type { BotCapabilityServiceDeps } from "./BotCapabilityService";

/** The label TeamView's "May do alone" picker shows for each choice. */
function accessLimitLabel(ceiling: string | undefined): string {
  if (!ceiling) return "No limit: each session's own access";
  const resolution = resolveAccessProfileDefinitionWithStatus(
    ceiling,
    PermissionSettingsManager.loadSettings().accessProfiles || [],
  );
  return resolution.status === "resolved" && resolution.definition
    ? resolution.definition.label
    : "Unavailable profile";
}

export function createBotCapabilityDeps(sources: {
  findRole: BotCapabilityServiceDeps["findRole"];
  workspaceExists: BotCapabilityServiceDeps["workspaceExists"];
  listBotWork: BotCapabilityServiceDeps["listBotWork"];
  listResponsibilities: BotCapabilityServiceDeps["listResponsibilities"];
  listChannels: () => Promise<ChannelData[]>;
}): BotCapabilityServiceDeps {
  return {
    ...sources,
    listServices: async () => listIntegrationMentionOptions(await sources.listChannels()),
    mcpSettings: () => {
      const settings = MCPSettingsManager.loadSettings();
      return {
        prefix: settings.toolNamePrefix || "mcp_",
        servers: (settings.servers || []).map((server) => ({
          id: server.id,
          transport: server.transport,
          desktopDriver: isCodexComputerUseServer(server),
        })),
      };
    },
    memoryCount: (botId) => botMemoryCount(MemoryRepoService.get(), botId),
    recallPastChats: () => MemoryFeaturesManager.loadSettings().sessionRecallEnabled !== false,
    access: (role: AgentRole) => {
      const settings = PermissionSettingsManager.loadSettings();
      const ceiling = role.accessProfileId?.trim() || undefined;
      // A chat you start: the default profile, narrowed to the bot's limit as the daemon stamps it.
      const agentConfig = taskAgentConfigForCreation(
        ceiling ? { accessCeilingProfileId: ceiling } : {},
        settings,
      );
      const profile = resolveEffectiveAccessProfile({
        task: { agentConfig: agentConfig ?? {} },
        settings,
        adminPolicies: loadPolicies(),
      });
      return { label: accessLimitLabel(ceiling), approvalInChats: profile.definition.approval };
    },
    desktopWorkFolder: (role: AgentRole) => {
      if (role.worksOn !== "own_desktop") return false;
      try {
        return Boolean(BotDesktopManager.getInstance().hostWorkFolder(role.id));
      } catch {
        // The desktop service is not running: the daemon falls back to the plain own folder too.
        return false;
      }
    },
  };
}
