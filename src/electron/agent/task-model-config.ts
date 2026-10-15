import type { AgentConfig, AgentRole, Task } from "../../shared/types";

/**
 * The model config a task runs on: the person's choice for this conversation (`modelPinned`)
 * first, then the bot's own model (its `AgentRole`), otherwise the config as is (the global
 * model, since unpinned task model keys are ignored). The bot's model is applied as a pin that
 * is never stored, so changing the bot's model takes effect on its next turn. A bot that names
 * a model but no provider is not a pin: a bare model key would be forced onto whichever
 * provider is current.
 */
export function effectiveTaskModelConfig(
  agentConfig: AgentConfig | undefined,
  role: Pick<AgentRole, "modelKey" | "providerType"> | null | undefined,
): AgentConfig | undefined {
  if (agentConfig?.modelPinned === true) return agentConfig;
  const modelKey = typeof role?.modelKey === "string" ? role.modelKey.trim() : "";
  if (!modelKey || !role?.providerType) return agentConfig;
  return {
    ...agentConfig,
    providerType: role.providerType,
    modelKey,
    modelPinned: true,
  };
}

/**
 * `effectiveTaskModelConfig` for a task, looking its bot up with `lookupRole`. Every
 * task-scoped model resolution (the executor, title generation, composer predictions) goes
 * through this so they agree on the bot's model.
 */
export async function effectiveTaskModelConfigFor(
  task: Pick<Task, "agentConfig" | "assignedAgentRoleId">,
  lookupRole: (
    roleId: string,
  ) =>
    | Pick<AgentRole, "modelKey" | "providerType">
    | null
    | undefined
    | Promise<Pick<AgentRole, "modelKey" | "providerType"> | null | undefined>,
): Promise<AgentConfig | undefined> {
  const roleId = task.assignedAgentRoleId;
  let role: Pick<AgentRole, "modelKey" | "providerType"> | null | undefined;
  try {
    role = roleId ? await lookupRole(roleId) : undefined;
  } catch {
    role = undefined;
  }
  return effectiveTaskModelConfig(task.agentConfig, role);
}
