import { describe, it, expect, vi } from "vitest";
import type Database from "better-sqlite3";
import type { AgentDaemon } from "../../agent/daemon";
import type { ControlPlaneServer } from "../server";
const calls = vi.hoisted(() => ({ stop: vi.fn(), read: vi.fn(), futureState: vi.fn() }));
vi.mock("../../automation/BotWorkControlService", () => ({
  BotWorkControlService: class {
    stop = calls.stop;
    read = calls.read;
    futureState = calls.futureState;
  },
}));
import { registerBotWorkControlMethods } from "../registerBotWorkControlMethods";
import { Methods } from "../protocol";
describe("bot work control method authority", () => {
  it("checks write/read scope before looking up work or receipts", async () => {
    const handlers = new Map<string, (client: unknown, params: unknown) => Promise<unknown>>();
    const requireScope = vi.fn((_client: unknown, scope: string) => {
      if (scope === "write") throw new Error("write denied");
    });
    calls.stop.mockReset();
    calls.read.mockReset();
    registerBotWorkControlMethods({
      db: {} as Database.Database,
      agentDaemon: {} as AgentDaemon,
      server: {
        registerMethod: (
          name: string,
          handler: (client: unknown, params: unknown) => Promise<unknown>,
        ) => handlers.set(name, handler),
      } as unknown as ControlPlaneServer,
      requireScope,
    });
    await expect(handlers.get(Methods.BOT_WORK_STOP)!({}, {})).rejects.toThrow("write denied");
    expect(calls.stop).not.toHaveBeenCalled();
    const query = { scope: { workspaceId: "ws", agentRoleId: "bot" }, requestId: "receipt" };
    await handlers.get(Methods.BOT_WORK_CONTROL_GET)!({}, query);
    expect(calls.read).toHaveBeenCalledWith(query);
    expect(requireScope).toHaveBeenLastCalledWith({}, "read");
    await handlers.get(Methods.BOT_WORK_CONTROL_STATE)!({}, { scope: query.scope });
    expect(calls.futureState).toHaveBeenCalledWith({ scope: query.scope });
    expect(requireScope).toHaveBeenLastCalledWith({}, "read");
  });
});
