import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";
import { IPC_CHANNELS } from "../../shared/types";
import type {
  AgentSecurityFindingQuery,
  AgentSecurityFindingStatus,
} from "../../shared/agent-security";
import { getNumbatService } from "../security/numbat";

const FINDING_STATUSES = new Set<AgentSecurityFindingStatus>([
  "open",
  "acknowledged",
  "resolved",
  "false_positive",
]);

function service() {
  const instance = getNumbatService();
  if (!instance) throw new Error("Agent security service is not initialized");
  return instance;
}

function boundedLimit(value: unknown, fallback = 100): number {
  const numeric =
    typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(500, Math.max(1, numeric));
}

function validateAgentName(value: unknown): string {
  const agent = typeof value === "string" ? value.trim() : "";
  if (!agent) throw new Error("Agent name is required");
  return agent;
}

async function confirmSecurityMutation(
  event: IpcMainInvokeEvent,
  action: "install" | "uninstall" | "prune",
  target?: string,
): Promise<void> {
  const descriptions = {
    install: `Install the Numbat hook for ${target || "this agent"}?`,
    uninstall: `Uninstall the Numbat hook for ${target || "this agent"}?`,
    prune: "Permanently prune expired agent-security history?",
  } as const;
  const options = {
    type: "warning" as const,
    buttons: ["Cancel", "Continue"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: "Confirm agent-security change",
    message: descriptions[action],
    detail: "This confirmation is enforced by the main process.",
  };
  const owner = BrowserWindow.fromWebContents(event.sender);
  const result = owner
    ? await dialog.showMessageBox(owner, options)
    : await dialog.showMessageBox(options);
  if (result.response !== 1) throw new Error("Agent-security change cancelled");
}

export function setupAgentSecurityHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.AGENT_SECURITY_STATUS, async (_, refresh?: boolean) =>
    service().getStatus(refresh === true),
  );
  ipcMain.handle(
    IPC_CHANNELS.AGENT_SECURITY_FINDINGS_LIST,
    async (_, query?: AgentSecurityFindingQuery) =>
      service().listFindings({
        taskId: typeof query?.taskId === "string" ? query.taskId : undefined,
        severity: query?.severity,
        status: query?.status,
        limit: boundedLimit(query?.limit),
        offset:
          typeof query?.offset === "number" && Number.isFinite(query.offset)
            ? Math.max(0, Math.floor(query.offset))
            : 0,
      }),
  );
  ipcMain.handle(
    IPC_CHANNELS.AGENT_SECURITY_FINDING_UPDATE,
    async (_, findingId: unknown, status: unknown) => {
      if (typeof findingId !== "string" || !findingId.trim()) {
        throw new Error("Finding ID is required");
      }
      if (!FINDING_STATUSES.has(status as AgentSecurityFindingStatus)) {
        throw new Error("Invalid finding status");
      }
      return service().updateFindingStatus(findingId.trim(), status as AgentSecurityFindingStatus);
    },
  );
  ipcMain.handle(
    IPC_CHANNELS.AGENT_SECURITY_DECISIONS_LIST,
    async (_, taskId?: unknown, limit?: unknown) =>
      service().listDecisions(
        typeof taskId === "string" && taskId.trim() ? taskId.trim() : undefined,
        boundedLimit(limit),
      ),
  );
  ipcMain.handle(IPC_CHANNELS.AGENT_SECURITY_DIAGNOSTICS_LIST, async (_, limit?: unknown) =>
    service().listDiagnostics(boundedLimit(limit)),
  );
  ipcMain.handle(IPC_CHANNELS.AGENT_SECURITY_INVENTORY_LIST, async () => service().listInventory());
  ipcMain.handle(IPC_CHANNELS.AGENT_SECURITY_INVENTORY_REFRESH, async () =>
    service().refreshInventory(),
  );
  ipcMain.handle(IPC_CHANNELS.AGENT_SECURITY_SCAN, async () => service().runScan());
  ipcMain.handle(IPC_CHANNELS.AGENT_SECURITY_RULES_CHECK, async () => service().checkRules());
  ipcMain.handle(IPC_CHANNELS.AGENT_SECURITY_HOOK_STATUS, async (_, agent: unknown) =>
    service().hookStatus(validateAgentName(agent)),
  );
  ipcMain.handle(IPC_CHANNELS.AGENT_SECURITY_HOOK_INSTALL, async (event, agent: unknown) => {
    const validatedAgent = validateAgentName(agent);
    await confirmSecurityMutation(event, "install", validatedAgent);
    return service().installHook(validatedAgent);
  });
  ipcMain.handle(IPC_CHANNELS.AGENT_SECURITY_HOOK_UNINSTALL, async (event, agent: unknown) => {
    const validatedAgent = validateAgentName(agent);
    await confirmSecurityMutation(event, "uninstall", validatedAgent);
    return service().uninstallHook(validatedAgent);
  });
  ipcMain.handle(
    IPC_CHANNELS.AGENT_SECURITY_CASE_BUILD,
    async (_, caseId: unknown, taskId: unknown) =>
      service().buildCase(validateAgentName(caseId), validateAgentName(taskId)),
  );
  ipcMain.handle(IPC_CHANNELS.AGENT_SECURITY_CASE_VERIFY, async (_, bundleName: unknown) =>
    service().verifyCase(validateAgentName(bundleName)),
  );
  ipcMain.handle(IPC_CHANNELS.AGENT_SECURITY_PRUNE, async (event) => {
    await confirmSecurityMutation(event, "prune");
    return service().prune();
  });
}
