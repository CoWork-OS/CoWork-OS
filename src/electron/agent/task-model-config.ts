import type { AgentConfig, AgentRole } from "../../shared/types";

/**
 * The model config a task runs on: the person's choice for this conversation (`modelPinned`)
 * first, then the bot's own model (its `AgentRole`), otherwise the config as is (the global
 * model, since unpinned task model keys are ignored). The bot's model is applied as a pin that
 * is never stored, so changing the bot's model takes effect on its next turn.
 */
export function effectiveTaskModelConfig(
  agentConfig: AgentConfig | undefined,
  role: Pick<AgentRole, "modelKey" | "providerType"> | null | undefined,
): AgentConfig | undefined {
  if (agentConfig?.modelPinned === true) return agentConfig;
  const modelKey = typeof role?.modelKey === "string" ? role.modelKey.trim() : "";
  if (!modelKey) return agentConfig;
  return {
    ...agentConfig,
    // No provider on the bot: its model is for the current default provider.
    providerType: role?.providerType || undefined,
    modelKey,
    modelPinned: true,
  };
}
