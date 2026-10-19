import { getCustomSkillLoader } from "../agent/custom-skill-loader";
import { LLMProviderFactory } from "../agent/llm/provider-factory";
import { getCoworkVersion } from "../gateway/router-helpers";
import { MCPClientManager } from "../mcp/client/MCPClientManager";
import { MCPSettingsManager } from "../mcp/settings";
import { ControlPlaneSettingsManager } from "../control-plane/settings";
import { buildCoworkAgentCard, type AgentCardInput } from "./agent-card";
import type { AgentCard } from "../pact/upstream/protocol";

/**
 * What this CoWork runtime can do right now: its enabled task skills, its enabled MCP
 * connectors with their tools (live from connected servers, else the tools cached at the last
 * connection) and the default model.
 */
export async function collectAgentCardInput(): Promise<AgentCardInput> {
  const loader = getCustomSkillLoader();
  await loader.initialize();
  const skills = loader
    .listTaskSkills()
    .filter((skill) => skill.enabled !== false)
    .map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      category: skill.category,
    }));
  let manager: MCPClientManager | null = null;
  try {
    manager = MCPClientManager.getInstance();
  } catch {
    manager = null;
  }
  const mcpServers = MCPSettingsManager.loadSettings().servers.map((server) => {
    const live = manager?.getServerTools(server.id) ?? [];
    return {
      id: server.id,
      name: server.name,
      enabled: server.enabled,
      tools: live.length > 0 ? live : (server.tools ?? []),
    };
  });
  let model: AgentCardInput["model"];
  try {
    const status = LLMProviderFactory.getConfigStatus();
    model = { provider: status.currentProvider, modelId: status.currentModel };
  } catch {
    model = undefined;
  }
  return { version: getCoworkVersion(), skills, mcpServers, model };
}

export async function currentCoworkAgentCard(): Promise<AgentCard> {
  return buildCoworkAgentCard(await collectAgentCardInput());
}

/** The card when this profile publishes it (Control Plane `publishAgentCard`), else null. */
export async function publishedAgentCard(): Promise<AgentCard | null> {
  if (ControlPlaneSettingsManager.loadSettings().publishAgentCard !== true) return null;
  return currentCoworkAgentCard();
}
