import { getAutomationRuntime } from "../automation/AutomationRuntime";
import type Database from "better-sqlite3";
import type { AgentDaemon } from "../agent/daemon";
import type { ControlPlaneServer } from "./server";
import { Methods, ErrorCodes } from "./protocol";
import { BotWorkControlService } from "../automation/BotWorkControlService";
export function registerBotWorkControlMethods(input: {
  server: ControlPlaneServer;
  db: Database.Database;
  agentDaemon: AgentDaemon;
  requireScope: (client: unknown, scope: "read" | "write") => void;
}) {
  const service = new BotWorkControlService(input.db, {
    cancel: (id, workspaceId, authority) =>
      input.agentDaemon.cancelTask(id, {
        cascade: false,
        waitForIdle: true,
        strictCleanup: true,
        scopeWorkspaceId: workspaceId,
        controlAuthority: authority,
      }),
    captureFence: () => {
      const runtime = getAutomationRuntime();
      if (!runtime) throw new Error("Automation runtime is unavailable");
      return runtime.captureFence();
    },
    assertOwnership: async () => {
      const runtime = getAutomationRuntime();
      if (!runtime) throw new Error("Automation runtime is unavailable");
      await runtime.assertOwnership();
    },
    activeTaskIds: () => input.agentDaemon.getActiveWorkTaskIds(),
    isStopped: (id) => input.agentDaemon.isTaskStopConfirmed(id),
    isLocallyStopped: (id) => input.agentDaemon.isLocalWorkStopConfirmed(id),
  });
  for (const [method, scope, run] of [
    [Methods.BOT_WORK_STOP, "write", (raw: unknown) => service.stop(raw)],
    [Methods.BOT_WORK_CONTROL_GET, "read", (raw: unknown) => service.read(raw)],
    [Methods.BOT_WORK_CONTROL_STATE, "read", (raw: unknown) => service.futureState(raw)],
  ] as const)
    input.server.registerMethod(method, async (client, params) => {
      input.requireScope(client, scope);
      try {
        return await run(params);
      } catch (error) {
        if (error instanceof Error && error.name === "ZodError")
          throw { code: ErrorCodes.INVALID_PARAMS, message: "Invalid bot work control request" };
        throw error;
      }
    });
}
