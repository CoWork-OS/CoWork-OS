import { BotNotificationService } from "../notifications/BotNotificationService";
import { BotWorkResultService } from "../agents/BotWorkResultService";
import { BotOutcomeMetricsService } from "../agents/BotOutcomeMetricsService";
import type Database from "better-sqlite3";
import { BotWorkQueryService } from "../agents/BotWorkQueryService";
import type { ControlPlaneServer } from "./server";
import { ErrorCodes, Methods } from "./protocol";

export function registerBotWorkMethods(input: {
  server: ControlPlaneServer;
  db: Database.Database;
  requireScope: (client: unknown, scope: "read" | "write") => void;
}): void {
  const service = new BotWorkQueryService(input.db);
  const notifications = new BotNotificationService(input.db);
  for (const [method, scope, run] of [
    [Methods.BOT_NOTIFICATION_RETRY, "write", (params: unknown) => notifications.retry(params)],
    [Methods.BOT_NOTIFICATION_ROUTE_GET, "read", (params: unknown) => notifications.get(params)],
    [
      Methods.BOT_NOTIFICATION_ROUTE_UPDATE,
      "write",
      (params: unknown) => notifications.update(params),
    ],
    [Methods.BOT_NOTIFICATION_RECEIPTS, "read", (params: unknown) => notifications.list(params)],
  ] as const)
    input.server.registerMethod(method, async (client, params) => {
      input.requireScope(client, scope);
      try {
        return await run(params);
      } catch (error) {
        if (error instanceof Error && error.name === "ZodError")
          throw { code: ErrorCodes.INVALID_PARAMS, message: "Invalid bot notification request" };
        throw error;
      }
    });
  const metrics = new BotOutcomeMetricsService(input.db);
  input.server.registerMethod(Methods.BOT_METRICS_SUMMARY, async (client, params) => {
    input.requireScope(client, "read");
    try {
      return await metrics.summary(params);
    } catch (error) {
      if (error instanceof Error && error.name === "ZodError")
        throw { code: ErrorCodes.INVALID_PARAMS, message: "Invalid bot metrics request" };
      throw error;
    }
  });
  const results = new BotWorkResultService(input.db);
  input.server.registerMethod(Methods.BOT_WORK_RESULT, async (client, params) => {
    input.requireScope(client, "read");
    try {
      return await results.get(params);
    } catch (error) {
      if (error instanceof Error && error.name === "ZodError")
        throw { code: ErrorCodes.INVALID_PARAMS, message: "Invalid bot result request" };
      throw error;
    }
  });
  input.server.registerMethod(Methods.BOT_WORK_LIST, async (client, params) => {
    input.requireScope(client, "read");
    try {
      return await service.list(params);
    } catch (error) {
      // Schema/cursor failures are client errors; storage/runtime failures retain
      // their normal server error path instead of being mislabeled as user input.
      if (
        error instanceof Error &&
        (error.name === "ZodError" ||
          error.message.startsWith("Invalid bot work cursor") ||
          error.message.startsWith("Bot work cursor belongs"))
      ) {
        throw { code: ErrorCodes.INVALID_PARAMS, message: "Invalid bot work query or cursor" };
      }
      throw error;
    }
  });
}
