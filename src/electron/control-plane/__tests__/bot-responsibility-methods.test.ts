import { describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import type { ControlPlaneServer } from "../server";
const calls = vi.hoisted(() => ({
  activate: vi.fn(),
  setFutureRuns: vi.fn(),
  pause: vi.fn(),
  run: vi.fn(),
  list: vi.fn(),
  engines: vi.fn(),
  preview: vi.fn(),
  create: vi.fn(),
  revise: vi.fn(),
}));
vi.mock("../../automation/BotResponsibilityService", () => ({
  BotResponsibilityService: class {
    activate = calls.activate;
    setFutureRuns = calls.setFutureRuns;
    pause = calls.pause;
    run = calls.run;
    list = calls.list;
    engines = calls.engines;
    preview = calls.preview;
    create = calls.create;
    revise = calls.revise;
  },
}));
import { registerBotResponsibilityMethods } from "../registerBotResponsibilityMethods";
import { Methods, ErrorCodes } from "../protocol";
function setup(requireScope = vi.fn()) {
  Object.values(calls).forEach((call) => call.mockReset());
  const handlers = new Map<string, (client: unknown, params: unknown) => Promise<unknown>>();
  registerBotResponsibilityMethods({
    db: {} as Database.Database,
    server: {
      registerMethod: (
        method: string,
        handler: (client: unknown, params: unknown) => Promise<unknown>,
      ) => handlers.set(method, handler),
    } as unknown as ControlPlaneServer,
    requireScope,
  });
  return { handlers, requireScope };
}
describe("responsibility Control Plane permissions", () => {
  it("checks read/write scopes before loading or mutating any configuration", async () => {
    const denied = { code: ErrorCodes.UNAUTHORIZED };
    const { handlers } = setup(() => {
      throw denied;
    });
    for (const handler of handlers.values()) await expect(handler({}, {})).rejects.toEqual(denied);
    Object.values(calls).forEach((call) => expect(call).not.toHaveBeenCalled());
  });
  it("shares preview/list with read scope and reserves create/revise for write scope", async () => {
    const { handlers, requireScope } = setup();
    const client = {};
    const request = { scope: { workspaceId: "ws", agentRoleId: "bot" } };
    for (const [method, name, scope] of [
      [Methods.BOT_RESPONSIBILITY_ACTIVATE, "activate", "write"],
      [Methods.BOT_RESPONSIBILITY_FUTURE_RUNS, "setFutureRuns", "write"],
      [Methods.BOT_RESPONSIBILITY_PAUSE, "pause", "write"],
      [Methods.BOT_RESPONSIBILITY_RUN, "run", "write"],
      [Methods.BOT_RESPONSIBILITY_LIST, "list", "read"],
      [Methods.BOT_RESPONSIBILITY_ENGINES, "engines", "read"],
      [Methods.BOT_RESPONSIBILITY_PREVIEW, "preview", "read"],
      [Methods.BOT_RESPONSIBILITY_CREATE, "create", "write"],
      [Methods.BOT_RESPONSIBILITY_REVISE, "revise", "write"],
    ] as const) {
      calls[name].mockResolvedValueOnce({ fixture: name });
      expect(await handlers.get(method)!(client, request)).toEqual({ fixture: name });
      expect(requireScope).toHaveBeenLastCalledWith(client, scope);
      expect(calls[name]).toHaveBeenLastCalledWith(request);
    }
  });
  it("maps malformed input without claiming a storage or revision conflict is a client schema error", async () => {
    const { handlers } = setup();
    const invalid = new Error("schema");
    invalid.name = "ZodError";
    calls.preview.mockRejectedValueOnce(invalid);
    await expect(handlers.get(Methods.BOT_RESPONSIBILITY_PREVIEW)!({}, {})).rejects.toMatchObject({
      code: ErrorCodes.INVALID_PARAMS,
    });
    const conflict = new Error("Responsibility revision changed");
    calls.revise.mockRejectedValueOnce(conflict);
    await expect(handlers.get(Methods.BOT_RESPONSIBILITY_REVISE)!({}, {})).rejects.toBe(conflict);
  });
});
