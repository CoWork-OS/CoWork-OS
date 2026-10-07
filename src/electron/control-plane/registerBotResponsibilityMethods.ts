import type Database from "better-sqlite3";
import { BotResponsibilityService } from "../automation/BotResponsibilityService";
import type { ControlPlaneServer } from "./server";
import { ErrorCodes, Methods } from "./protocol";
export function registerBotResponsibilityMethods(input: {
  server: ControlPlaneServer;
  db: Database.Database;
  getRoutineService?: () => import("../routines/service").RoutineService | null;
  requireScope: (client: unknown, scope: "read" | "write") => void;
}): void {
  const service = new BotResponsibilityService(input.db, {
    getRoutineService: input.getRoutineService,
  });
  for (const [method, scope, run] of [
    [Methods.BOT_RESPONSIBILITY_ACTIVATE, "write", (params: unknown) => service.activate(params)],
    [
      Methods.BOT_RESPONSIBILITY_FUTURE_RUNS,
      "write",
      (params: unknown) => service.setFutureRuns(params),
    ],
    [Methods.BOT_RESPONSIBILITY_PAUSE, "write", (params: unknown) => service.pause(params)],
    [Methods.BOT_RESPONSIBILITY_RUN, "write", (params: unknown) => service.run(params)],
    [Methods.BOT_RESPONSIBILITY_LIST, "read", (params: unknown) => service.list(params)],
    [Methods.BOT_RESPONSIBILITY_ENGINES, "read", (params: unknown) => service.engines(params)],
    [Methods.BOT_RESPONSIBILITY_PREVIEW, "read", (params: unknown) => service.preview(params)],
    [Methods.BOT_RESPONSIBILITY_CREATE, "write", (params: unknown) => service.create(params)],
    [Methods.BOT_RESPONSIBILITY_REVISE, "write", (params: unknown) => service.revise(params)],
  ] as const)
    input.server.registerMethod(method, async (client, params) => {
      input.requireScope(client, scope);
      try {
        return await run(params);
      } catch (error) {
        if (error instanceof Error && error.name === "ZodError")
          throw { code: ErrorCodes.INVALID_PARAMS, message: "Invalid bot responsibility request" };
        throw error;
      }
    });
}
