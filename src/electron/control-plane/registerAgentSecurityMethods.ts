import type {
  AgentSecurityFindingQuery,
  AgentSecurityFindingStatus,
} from "../../shared/agent-security";
import { getNumbatService } from "../security/numbat";
import { ErrorCodes, Methods } from "./protocol";
import type { ControlPlaneServer } from "./server";

type Scope = "admin" | "read" | "write" | "operator";

const FINDING_STATUSES = new Set<AgentSecurityFindingStatus>([
  "open",
  "acknowledged",
  "resolved",
  "false_positive",
]);

function invalid(message: string): never {
  throw { code: ErrorCodes.INVALID_PARAMS, message };
}

function service() {
  const instance = getNumbatService();
  if (!instance) throw new Error("Agent security service is not initialized");
  return instance;
}

function paramsObject(params: unknown): Record<string, unknown> {
  return params && typeof params === "object" && !Array.isArray(params)
    ? (params as Record<string, unknown>)
    : {};
}

function boundedLimit(value: unknown, fallback = 100): number {
  const numeric =
    typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(500, Math.max(1, numeric));
}

function requiredString(params: unknown, key: string): string {
  const value = paramsObject(params)[key];
  if (typeof value !== "string" || !value.trim()) invalid(`${key} is required`);
  return value.trim();
}

function requireConfirmation(params: unknown, expected: string): void {
  if (paramsObject(params).confirmation !== expected) {
    invalid(`confirmation must exactly match ${expected}`);
  }
}

function findingQuery(params: unknown): AgentSecurityFindingQuery {
  const input = paramsObject(params);
  return {
    taskId:
      typeof input.taskId === "string" && input.taskId.trim() ? input.taskId.trim() : undefined,
    severity:
      input.severity === "info" ||
      input.severity === "low" ||
      input.severity === "medium" ||
      input.severity === "high" ||
      input.severity === "critical"
        ? input.severity
        : undefined,
    status: FINDING_STATUSES.has(input.status as AgentSecurityFindingStatus)
      ? (input.status as AgentSecurityFindingStatus)
      : undefined,
    limit: boundedLimit(input.limit),
    offset:
      typeof input.offset === "number" && Number.isFinite(input.offset)
        ? Math.max(0, Math.floor(input.offset))
        : 0,
  };
}

export function registerAgentSecurityMethods(input: {
  server: ControlPlaneServer;
  requireScope: (client: unknown, scope: Scope) => void;
}): void {
  const { server, requireScope } = input;

  server.registerMethod(Methods.AGENT_SECURITY_STATUS, async (client, params) => {
    requireScope(client, "read");
    const status = await service().getStatus(paramsObject(params).refresh === true);
    return {
      ...status,
      binaryPath: undefined,
      lastError: status.lastError ? "Agent security runtime is unavailable" : undefined,
    };
  });
  server.registerMethod(Methods.AGENT_SECURITY_FINDINGS_LIST, async (client, params) => {
    requireScope(client, "admin");
    return service().listFindings(findingQuery(params));
  });
  server.registerMethod(Methods.AGENT_SECURITY_FINDING_UPDATE, async (client, params) => {
    requireScope(client, "admin");
    const findingId = requiredString(params, "findingId");
    const status = paramsObject(params).status;
    if (!FINDING_STATUSES.has(status as AgentSecurityFindingStatus)) {
      invalid("status must be open, acknowledged, resolved, or false_positive");
    }
    return service().updateFindingStatus(findingId, status as AgentSecurityFindingStatus);
  });
  server.registerMethod(Methods.AGENT_SECURITY_DECISIONS_LIST, async (client, params) => {
    requireScope(client, "admin");
    const inputParams = paramsObject(params);
    const taskId =
      typeof inputParams.taskId === "string" && inputParams.taskId.trim()
        ? inputParams.taskId.trim()
        : undefined;
    return service().listDecisions(taskId, boundedLimit(inputParams.limit));
  });
  server.registerMethod(Methods.AGENT_SECURITY_DIAGNOSTICS_LIST, async (client, params) => {
    requireScope(client, "admin");
    return service().listDiagnostics(boundedLimit(paramsObject(params).limit));
  });
  server.registerMethod(Methods.AGENT_SECURITY_INVENTORY_LIST, async (client) => {
    requireScope(client, "admin");
    return service().listInventory();
  });
  server.registerMethod(Methods.AGENT_SECURITY_INVENTORY_REFRESH, async (client) => {
    requireScope(client, "admin");
    return service().refreshInventory();
  });
  server.registerMethod(Methods.AGENT_SECURITY_SCAN, async (client) => {
    requireScope(client, "admin");
    return service().runScan();
  });
  server.registerMethod(Methods.AGENT_SECURITY_RULES_CHECK, async (client) => {
    requireScope(client, "admin");
    return service().checkRules();
  });
  server.registerMethod(Methods.AGENT_SECURITY_HOOK_STATUS, async (client, params) => {
    requireScope(client, "admin");
    return service().hookStatus(requiredString(params, "agent"));
  });
  server.registerMethod(Methods.AGENT_SECURITY_HOOK_INSTALL, async (client, params) => {
    requireScope(client, "admin");
    const agent = requiredString(params, "agent");
    requireConfirmation(params, `install:${agent}`);
    return service().installHook(agent);
  });
  server.registerMethod(Methods.AGENT_SECURITY_HOOK_UNINSTALL, async (client, params) => {
    requireScope(client, "admin");
    const agent = requiredString(params, "agent");
    requireConfirmation(params, `uninstall:${agent}`);
    return service().uninstallHook(agent);
  });
  server.registerMethod(Methods.AGENT_SECURITY_CASE_BUILD, async (client, params) => {
    requireScope(client, "admin");
    return service().buildCase(requiredString(params, "caseId"), requiredString(params, "taskId"));
  });
  server.registerMethod(Methods.AGENT_SECURITY_CASE_VERIFY, async (client, params) => {
    requireScope(client, "admin");
    return service().verifyCase(requiredString(params, "bundleName"));
  });
  server.registerMethod(Methods.AGENT_SECURITY_PRUNE, async (client, params) => {
    requireScope(client, "admin");
    requireConfirmation(params, "prune");
    return service().prune();
  });
}
