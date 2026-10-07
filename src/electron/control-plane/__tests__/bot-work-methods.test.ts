import { describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import type { ControlPlaneServer } from "../server";
const notificationCalls = vi.hoisted(() => ({
  get: vi.fn(),
  update: vi.fn(),
  list: vi.fn(),
  retry: vi.fn(),
}));
vi.mock("../../notifications/BotNotificationService", () => ({
  BotNotificationService: class {
    retry = notificationCalls.retry;
    get = notificationCalls.get;
    update = notificationCalls.update;
    list = notificationCalls.list;
  },
}));
const list = vi.hoisted(() => vi.fn());
const get = vi.hoisted(() => vi.fn());
vi.mock("../../agents/BotWorkResultService", () => ({
  BotWorkResultService: class {
    get = get;
  },
}));
const summary = vi.hoisted(() => vi.fn());
vi.mock("../../agents/BotOutcomeMetricsService", () => ({
  BotOutcomeMetricsService: class {
    summary = summary;
  },
}));
vi.mock("../../agents/BotWorkQueryService", () => ({
  BotWorkQueryService: class {
    list = list;
  },
}));
import { registerBotWorkMethods } from "../registerBotWorkMethods";
import { ErrorCodes, Methods } from "../protocol";

describe("shared bot work Control Plane method", () => {
  function setup(requireScope = vi.fn()) {
    const registerMethod = vi.fn();
    registerBotWorkMethods({
      server: { registerMethod } as unknown as ControlPlaneServer,
      db: {} as Database.Database,
      requireScope,
    });
    const entry = registerMethod.mock.calls.find((call) => call[0] === Methods.BOT_WORK_LIST)!;
    return {
      methods: registerMethod.mock.calls,
      handler: entry[1] as (client: unknown, params: unknown) => Promise<unknown>,
      requireScope,
      resultHandler: registerMethod.mock.calls.find(
        (call) => call[0] === Methods.BOT_WORK_RESULT,
      )![1] as (client: unknown, params: unknown) => Promise<unknown>,
    };
  }
  it("requires write authority for routing changes and read authority for receipts", async () => {
    const { methods, requireScope } = setup();
    const client = {};
    const request = { scope: { workspaceId: "ws", agentRoleId: "bot" } };
    const update = methods.find((call) => call[0] === Methods.BOT_NOTIFICATION_ROUTE_UPDATE)![1];
    await update(client, request);
    expect(requireScope).toHaveBeenLastCalledWith(client, "write");
    expect(notificationCalls.update).toHaveBeenCalledWith(request);
    const receipts = methods.find((call) => call[0] === Methods.BOT_NOTIFICATION_RECEIPTS)![1];
    await receipts(client, request.scope);
    expect(requireScope).toHaveBeenLastCalledWith(client, "read");
    expect(notificationCalls.list).toHaveBeenCalledWith(request.scope);
    const denied = setup(() => {
      throw Error("Denied");
    });
    const before = notificationCalls.update.mock.calls.length;
    await expect(
      denied.methods.find((call) => call[0] === Methods.BOT_NOTIFICATION_ROUTE_UPDATE)![1](
        client,
        request,
      ),
    ).rejects.toThrow("Denied");
    expect(notificationCalls.update).toHaveBeenCalledTimes(before);
  });
  it("protects explicit notification retries with write scope and validates errors", async () => {
    const request = {
      scope: { workspaceId: "ws", agentRoleId: "bot" },
      intentId: "id",
      requestId: "uuid",
      expectedRouteVersion: 1,
    };
    const { methods, requireScope } = setup();
    const handler = methods.find((call) => call[0] === Methods.BOT_NOTIFICATION_RETRY)![1];
    notificationCalls.retry.mockResolvedValueOnce({ state: "queued" });
    await expect(handler({}, request)).resolves.toEqual({ state: "queued" });
    expect(requireScope).toHaveBeenLastCalledWith({}, "write");
    expect(notificationCalls.retry).toHaveBeenCalledWith(request);
    const before = notificationCalls.retry.mock.calls.length;
    const denied = setup(() => {
      throw Error("Denied");
    });
    await expect(
      denied.methods.find((call) => call[0] === Methods.BOT_NOTIFICATION_RETRY)![1]({}, request),
    ).rejects.toThrow("Denied");
    expect(notificationCalls.retry).toHaveBeenCalledTimes(before);
    const invalid = new Error("schema");
    invalid.name = "ZodError";
    notificationCalls.retry.mockRejectedValueOnce(invalid);
    await expect(handler({}, {})).rejects.toMatchObject({ code: ErrorCodes.INVALID_PARAMS });
  });
  it("protects result reads before inspection and shares validation", async () => {
    get.mockReset();
    const denied = { code: ErrorCodes.UNAUTHORIZED };
    await expect(
      setup(() => {
        throw denied;
      }).resultHandler({}, {}),
    ).rejects.toEqual(denied);
    expect(get).not.toHaveBeenCalled();
    const { resultHandler, requireScope } = setup();
    const request = { workspaceId: "ws", agentRoleId: "bot", taskId: "task" };
    get.mockResolvedValueOnce({ request });
    expect(await resultHandler({}, request)).toEqual({ request });
    expect(requireScope).toHaveBeenCalledWith({}, "read");
    expect(get).toHaveBeenCalledWith(request);
    const invalid = new Error("schema");
    invalid.name = "ZodError";
    get.mockRejectedValueOnce(invalid);
    await expect(resultHandler({}, {})).rejects.toMatchObject({ code: ErrorCodes.INVALID_PARAMS });
  });
  it("requires existing read scope before loading anything", async () => {
    list.mockReset();
    const denied = { code: ErrorCodes.UNAUTHORIZED };
    const { handler } = setup(() => {
      throw denied;
    });
    await expect(handler({}, {})).rejects.toEqual(denied);
    expect(list).not.toHaveBeenCalled();
  });
  it("uses the same service for desktop and Node and reports malformed requests", async () => {
    list.mockReset().mockResolvedValueOnce({ items: [] });
    const { handler, requireScope } = setup();
    const client = {};
    const request = { workspaceId: "ws", agentRoleId: "bot", view: "working" };
    expect(await handler(client, request)).toEqual({ items: [] });
    expect(requireScope).toHaveBeenCalledWith(client, "read");
    expect(list).toHaveBeenCalledWith(request);
    const invalid = new Error("schema");
    invalid.name = "ZodError";
    list.mockRejectedValueOnce(invalid);
    await expect(handler(client, {})).rejects.toMatchObject({ code: ErrorCodes.INVALID_PARAMS });
  });
  it("requires read scope before computing the outcome baseline", async () => {
    summary.mockReset();
    const denied = { code: ErrorCodes.UNAUTHORIZED };
    const metricsHandler = (requireScope?: () => void) =>
      setup(requireScope).methods.find((call) => call[0] === Methods.BOT_METRICS_SUMMARY)![1];
    await expect(
      metricsHandler(() => {
        throw denied;
      })({}, {}),
    ).rejects.toEqual(denied);
    expect(summary).not.toHaveBeenCalled();
    const { methods, requireScope } = setup();
    const handler = methods.find((call) => call[0] === Methods.BOT_METRICS_SUMMARY)![1];
    const request = { workspaceId: "ws", agentRoleId: "bot", windowDays: 7 };
    summary.mockResolvedValueOnce({ scope: request });
    expect(await handler({}, request)).toEqual({ scope: request });
    expect(requireScope).toHaveBeenCalledWith({}, "read");
    const invalid = new Error("schema");
    invalid.name = "ZodError";
    summary.mockRejectedValueOnce(invalid);
    await expect(handler({}, {})).rejects.toMatchObject({ code: ErrorCodes.INVALID_PARAMS });
  });
});
