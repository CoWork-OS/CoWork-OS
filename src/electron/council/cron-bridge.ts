import type { Task } from "../../shared/types";

/**
 * Combine cron's requested task settings with Council's prepared runtime
 * settings. Council owns its execution fields; the cron request still owns
 * entrypoint policy such as the selected access profile.
 */
export function mergeCouncilCronAgentConfig(
  requestedConfig: Task["agentConfig"] | undefined,
  preparedConfig: Task["agentConfig"] | undefined,
  scheduledJobId?: string,
): NonNullable<Task["agentConfig"]> {
  const requestedPolicy = requestedConfig
    ? {
        ...(requestedConfig.accessProfileId
          ? { accessProfileId: requestedConfig.accessProfileId }
          : {}),
        ...(requestedConfig.permissionMode
          ? { permissionMode: requestedConfig.permissionMode }
          : {}),
        ...(requestedConfig.shellAccess !== undefined
          ? { shellAccess: requestedConfig.shellAccess }
          : {}),
        ...(requestedConfig.toolRestrictions
          ? { toolRestrictions: requestedConfig.toolRestrictions }
          : {}),
        ...(requestedConfig.allowedTools ? { allowedTools: requestedConfig.allowedTools } : {}),
      }
    : {};
  return {
    ...preparedConfig,
    ...requestedPolicy,
    ...(scheduledJobId ? { scheduledJobId } : {}),
  };
}
