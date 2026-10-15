import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  app: { getPath: vi.fn().mockReturnValue("/mock/user/data") },
  safeStorage: { isEncryptionAvailable: vi.fn().mockReturnValue(false) },
}));

import { IPC_CHANNELS } from "../../../shared/types";
import { McpSignInCancelledError } from "../../mcp/oauth/mcp-oauth";
import { createMcpOAuthIpcHandlers } from "../mcp-oauth-handlers";

const workday = {
  name: "Workday",
  kind: "workday",
  region: "us",
  tenant: "acme",
  grant: "authorization_code",
  clientId: "c",
};

function setup() {
  const service = {
    add: vi.fn(() => ({ id: randomUUID(), name: "Workday" }) as never),
    update: vi.fn(async (input: { serverId: string }) => ({
      server: { id: input.serverId, name: "Workday" } as never,
      signedOut: true,
    })),
    discover: vi.fn(async () => ({})),
    authorize: vi.fn(async () => ({ grant: "authorization_code" as const, expiresAt: 1 })),
    cancel: vi.fn(() => true),
  };
  const openExternal = vi.fn(async () => undefined);
  const checkRateLimit = vi.fn();
  const handlers = createMcpOAuthIpcHandlers({
    openExternal,
    checkRateLimit,
    service: service as never,
  });
  return { handlers, service, openExternal, checkRateLimit };
}

describe("remote MCP OAuth IPC handlers", () => {
  it("validates edits strictly in main before touching settings", async () => {
    const { handlers, service, checkRateLimit } = setup();
    const update = handlers[IPC_CHANNELS.MCP_UPDATE_REMOTE_OAUTH_SERVER]!;
    for (const bad of [
      { serverId: "not-a-uuid", server: workday },
      { serverId: randomUUID(), server: { ...workday, kind: "other" } },
      { serverId: randomUUID(), server: { ...workday, redirectUri: "https://evil.example/cb" } },
      { serverId: randomUUID(), server: workday, extra: 1 },
      { serverId: randomUUID() },
      "string",
    ])
      await expect(update(bad)).rejects.toThrow(/Invalid remote OAuth server/);
    expect(service.update).not.toHaveBeenCalled();
    const serverId = randomUUID();
    await expect(update({ serverId, server: workday })).resolves.toEqual({
      id: serverId,
      name: "Workday",
      signedOut: true,
    });
    expect(checkRateLimit).toHaveBeenCalledWith(IPC_CHANNELS.MCP_UPDATE_REMOTE_OAUTH_SERVER);
  });

  it("cancels only for a valid server ID", async () => {
    const { handlers, service } = setup();
    const cancel = handlers[IPC_CHANNELS.MCP_OAUTH_CANCEL]!;
    for (const bad of ["x", 42, { serverId: randomUUID() }, undefined])
      await expect(cancel(bad)).rejects.toThrow(/Invalid server ID/);
    expect(service.cancel).not.toHaveBeenCalled();
    const serverId = randomUUID();
    await expect(cancel(serverId)).resolves.toEqual({ cancelled: true });
    expect(service.cancel).toHaveBeenCalledWith(serverId);
  });

  it("reports a cancelled or replaced sign-in as a result, not an error", async () => {
    const { handlers, service } = setup();
    const authorize = handlers[IPC_CHANNELS.MCP_OAUTH_AUTHORIZE]!;
    await expect(authorize("nope")).rejects.toThrow(/Invalid server ID/);
    await expect(authorize(randomUUID())).resolves.toEqual({
      status: "signed_in",
      grant: "authorization_code",
      expiresAt: 1,
    });
    service.authorize.mockRejectedValueOnce(new McpSignInCancelledError("superseded"));
    await expect(authorize(randomUUID())).resolves.toEqual({
      status: "cancelled",
      reason: "superseded",
    });
    service.authorize.mockRejectedValueOnce(new McpSignInCancelledError("cancelled"));
    await expect(authorize(randomUUID())).resolves.toEqual({
      status: "cancelled",
      reason: "cancelled",
    });
    service.authorize.mockRejectedValueOnce(new Error("Authorization timed out"));
    await expect(authorize(randomUUID())).rejects.toThrow(/timed out/);
  });

  it("opens only https sign-in pages (http only on loopback)", async () => {
    const { handlers, service, openExternal } = setup();
    let openUrl!: (url: string) => Promise<void>;
    service.authorize.mockImplementationOnce(async (_id: string, options: Any) => {
      openUrl = options.openUrl;
      return { grant: "authorization_code" as const, expiresAt: 1 };
    });
    await handlers[IPC_CHANNELS.MCP_OAUTH_AUTHORIZE]!(randomUUID());
    await expect(openUrl("http://idp.example/authorize")).rejects.toThrow(/https/);
    await expect(openUrl("file:///etc/passwd")).rejects.toThrow(/https/);
    await openUrl("https://idp.example/authorize");
    await openUrl("http://127.0.0.1:9000/authorize");
    expect(openExternal).toHaveBeenCalledTimes(2);
  });
});
