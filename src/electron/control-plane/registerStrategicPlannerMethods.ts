import type { ControlPlaneServer } from "./server";
import { ErrorCodes, Methods } from "./protocol";
import type { StrategicPlannerService } from "./StrategicPlannerService";

function requireString(value: unknown, field: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    throw { code: ErrorCodes.INVALID_PARAMS, message: `${field} is required` };
  }
  return normalized;
}

export function registerStrategicPlannerMethods(options: {
  server: ControlPlaneServer;
  plannerService: StrategicPlannerService | null;
  requireScope: (client: Any, scope: "admin" | "read" | "write" | "operator") => void;
}): void {
  const { server, plannerService, requireScope } = options;
  if (!plannerService) return;

  server.registerMethod(Methods.PLANNER_CONFIG_GET, async (client, params) => {
    requireScope(client, "read");
    const companyId = requireString((params as Any)?.companyId, "companyId");
    return { config: plannerService.getConfig(companyId) };
  });

  server.registerMethod(Methods.PLANNER_CONFIG_UPDATE, async (client, params) => {
    requireScope(client, "admin");
    const p = (params || {}) as Any;
    const companyId = requireString(p.companyId, "companyId");
    return {
      config: plannerService.updateConfig(companyId, {
        enabled: typeof p.enabled === "boolean" ? p.enabled : undefined,
        intervalMinutes:
          typeof p.intervalMinutes === "number" && Number.isFinite(p.intervalMinutes)
            ? p.intervalMinutes
            : undefined,
        planningWorkspaceId:
          p.planningWorkspaceId === null
            ? null
            : typeof p.planningWorkspaceId === "string"
              ? p.planningWorkspaceId
              : undefined,
        plannerAgentRoleId:
          p.plannerAgentRoleId === null
            ? null
            : typeof p.plannerAgentRoleId === "string"
              ? p.plannerAgentRoleId
              : undefined,
        autoDispatch: typeof p.autoDispatch === "boolean" ? p.autoDispatch : undefined,
        approvalPreset: typeof p.approvalPreset === "string" ? p.approvalPreset : undefined,
        maxIssuesPerRun:
          typeof p.maxIssuesPerRun === "number" && Number.isFinite(p.maxIssuesPerRun)
            ? p.maxIssuesPerRun
            : undefined,
        staleIssueDays:
          typeof p.staleIssueDays === "number" && Number.isFinite(p.staleIssueDays)
            ? p.staleIssueDays
            : undefined,
      }),
    };
  });

  server.registerMethod(Methods.PLANNER_RUN, async (client, params) => {
    requireScope(client, "admin");
    const p = (params || {}) as Any;
    const companyId = requireString(p.companyId, "companyId");
    return {
      run: await plannerService.runNow({
        companyId,
        trigger:
          p.trigger === "schedule" || p.trigger === "startup" || p.trigger === "manual"
            ? p.trigger
            : "manual",
      }),
    };
  });

  server.registerMethod(Methods.PLANNER_RUN_LIST, async (client, params) => {
    requireScope(client, "read");
    const p = (params || {}) as Any;
    return {
      runs: plannerService.listRuns({
        companyId: typeof p.companyId === "string" ? p.companyId.trim() : undefined,
        limit: typeof p.limit === "number" && Number.isFinite(p.limit) ? p.limit : undefined,
        offset: typeof p.offset === "number" && Number.isFinite(p.offset) ? p.offset : undefined,
      }),
    };
  });
}
