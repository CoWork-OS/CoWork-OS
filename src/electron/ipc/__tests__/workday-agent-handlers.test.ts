import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  app: { getPath: vi.fn().mockReturnValue("/mock/user/data") },
  safeStorage: { isEncryptionAvailable: vi.fn().mockReturnValue(false) },
}));

import { IPC_CHANNELS } from "../../../shared/types";
import { McpSignInCancelledError } from "../../mcp/oauth/mcp-oauth";
import { createWorkdayAgentIpcHandlers } from "../workday-agent-handlers";

const WID = "3cf962648a6a10001482cdbe30920000";
const agent = {
  name: "CoWork",
  description: "CoWork OS desktop agent",
  version: "1.0",
  skills: [
    {
      id: "time_off_balances",
      name: "Time Off Balances",
      description: "",
      executionMode: "Delegate",
      tools: [{ toolName: "find_absence_balances", wid: WID, description: "" }],
    },
  ],
};

function setup() {
  const service = {
    saveConnection: vi.fn((input: { serverId: string }) => ({
      tenant: "acme",
      tenantHost: "impl.wd5.myworkday.com",
      servicesHost: "impl-services1.wd5.myworkday.com",
      clientId: "admin",
      hasClientSecret: true,
      usePkce: false,
      signedIn: false,
      serverId: input.serverId,
    })),
    // A token in the service's answer must never cross IPC.
    signIn: vi.fn(async (_serverId: string, options: { openUrl: (url: string) => unknown }) => {
      await options.openUrl("https://impl.wd5.myworkday.com/acme/authorize?state=x");
      return { expiresAt: 123, accessToken: "admin-token" } as { expiresAt?: number };
    }),
    cancel: vi.fn(() => true),
    list: vi.fn(async () => ({ status: "signed_out" as const })),
    search: vi.fn(async () => ({ resources: [], matched: 0 })),
    save: vi.fn(async () => ({
      status: "saved" as const,
      name: "CoWork",
      skills: ["time_off_balances"],
      toolCount: 1,
    })),
  };
  const openExternal = vi.fn(async () => undefined);
  const checkRateLimit = vi.fn();
  const handlers = createWorkdayAgentIpcHandlers({
    openExternal,
    checkRateLimit,
    service: service as never,
  });
  return { handlers, service, openExternal, checkRateLimit };
}

describe("Workday agent setup IPC handlers", () => {
  it("validates the admin connection strictly in main", async () => {
    const { handlers, service, checkRateLimit } = setup();
    const save = handlers[IPC_CHANNELS.WORKDAY_AGENT_ADMIN_SAVE_CONNECTION]!;
    const valid = {
      serverId: randomUUID(),
      tenantHost: "impl.wd5.myworkday.com",
      clientId: "admin",
      clientSecret: "secret",
      usePkce: false,
    };
    for (const bad of [
      { ...valid, serverId: "nope" },
      { ...valid, clientId: "" },
      { ...valid, usePkce: "yes" },
      { ...valid, token: "x" },
      { ...valid, tenantHost: "x".repeat(400) },
      "string",
      undefined,
    ])
      await expect(save(bad)).rejects.toThrow(/Invalid Workday admin connection/);
    expect(service.saveConnection).not.toHaveBeenCalled();
    await expect(save(valid)).resolves.toMatchObject({ hasClientSecret: true });
    expect(checkRateLimit).toHaveBeenCalledWith(IPC_CHANNELS.WORKDAY_AGENT_ADMIN_SAVE_CONNECTION);
  });

  it("returns only the sign-in status and expiry, never the admin token", async () => {
    const { handlers, openExternal } = setup();
    const signIn = handlers[IPC_CHANNELS.WORKDAY_AGENT_ADMIN_SIGN_IN]!;
    await expect(signIn("not-a-uuid")).rejects.toThrow(/Invalid server ID/);
    const result = await signIn(randomUUID());
    expect(result).toEqual({ status: "signed_in", expiresAt: 123 });
    expect(JSON.stringify(result)).not.toContain("admin-token");
    expect(openExternal).toHaveBeenCalledTimes(1);
  });

  it("opens https sign-in pages only", async () => {
    const { handlers, service, openExternal } = setup();
    service.signIn.mockImplementationOnce(async (_id, options) => {
      await options.openUrl("http://impl.wd5.myworkday.com/acme/authorize");
      return { expiresAt: 1 };
    });
    await expect(handlers[IPC_CHANNELS.WORKDAY_AGENT_ADMIN_SIGN_IN]!(randomUUID())).rejects.toThrow(
      /must use https/,
    );
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("reports a cancelled sign-in as a result, not an error", async () => {
    const { handlers, service } = setup();
    service.signIn.mockRejectedValueOnce(new McpSignInCancelledError("superseded"));
    await expect(
      handlers[IPC_CHANNELS.WORKDAY_AGENT_ADMIN_SIGN_IN]!(randomUUID()),
    ).resolves.toEqual({ status: "cancelled", reason: "superseded" });
    const cancel = handlers[IPC_CHANNELS.WORKDAY_AGENT_ADMIN_CANCEL]!;
    await expect(cancel({ serverId: randomUUID() })).rejects.toThrow(/Invalid server ID/);
    await expect(cancel(randomUUID())).resolves.toEqual({ cancelled: true });
  });

  it("validates search and save payloads before calling Workday", async () => {
    const { handlers, service, checkRateLimit } = setup();
    const search = handlers[IPC_CHANNELS.WORKDAY_AGENT_SEARCH]!;
    const serverId = randomUUID();
    for (const bad of [
      { serverId, query: "" },
      { serverId, query: "x".repeat(201) },
      { serverId: "x", query: "absence" },
      { serverId, query: "absence", host: "evil.example" },
    ])
      await expect(search(bad)).rejects.toThrow(/Invalid Workday tool search/);
    expect(service.search).not.toHaveBeenCalled();
    await search({ serverId, query: " absence " });
    expect(service.search).toHaveBeenLastCalledWith(serverId, "absence", { mcpOnly: true });
    await search({ serverId, query: "workers", includeOperations: true });
    expect(service.search).toHaveBeenLastCalledWith(serverId, "workers", { mcpOnly: false });

    const save = handlers[IPC_CHANNELS.WORKDAY_AGENT_SAVE]!;
    for (const bad of [
      { serverId, agent: { ...agent, name: "" } },
      { serverId, agent: { ...agent, skills: [{ ...agent.skills[0], id: "Not Valid" }] } },
      {
        serverId,
        agent: {
          ...agent,
          skills: [{ ...agent.skills[0], tools: [{ toolName: "a b", wid: WID, description: "" }] }],
        },
      },
      { serverId, agent, extra: 1 },
      { agent },
    ])
      await expect(save(bad)).rejects.toThrow(/Invalid Workday agent definition/);
    expect(service.save).not.toHaveBeenCalled();
    await expect(save({ serverId, agent })).resolves.toMatchObject({ status: "saved" });
    expect(checkRateLimit).toHaveBeenCalledWith(IPC_CHANNELS.WORKDAY_AGENT_SAVE);
  });

  it("surfaces the admin policy block from the service", async () => {
    const { handlers, service } = setup();
    service.list.mockRejectedValueOnce(
      new Error('MCP server "Workday" is blocked by your administrator'),
    );
    await expect(handlers[IPC_CHANNELS.WORKDAY_AGENT_LIST]!(randomUUID())).rejects.toThrow(
      /blocked by your administrator/,
    );
    await expect(handlers[IPC_CHANNELS.WORKDAY_AGENT_LIST]!(42)).rejects.toThrow(
      /Invalid server ID/,
    );
  });
});
