import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));

import { IPC_CHANNELS } from "../../../shared/types";
import { createPactIpcHandlers } from "../pact-handlers";

function setup(signIn: unknown = null) {
  const service = {
    status: vi.fn(async () => ({ available: true })),
    send: vi.fn(async () => ({ status: "replied" })),
    authorizationSignIn: vi.fn(async () => signIn),
    disconnectGrant: vi.fn(async () => ({ grant: {}, revokedAtBusiness: false })),
    updateSettings: vi.fn(() => ({})),
  };
  const openExternal = vi.fn(async () => undefined);
  const handlers = createPactIpcHandlers({
    service: () => service as never,
    owner: async () => ({ id: "owner", kind: "local_owner", actor: "desktop" }),
    openExternal,
    checkRateLimit: () => undefined,
  });
  return { handlers, service, openExternal };
}

describe("PACT IPC handlers", () => {
  it("validates renderer payloads strictly before reaching the runtime", async () => {
    const { handlers, service } = setup();
    await expect(
      handlers[IPC_CHANNELS.PACT_CONVERSATION_SEND]!({
        businessId: "b",
        text: "x",
        effect: "delete",
      }),
    ).rejects.toThrow(/Invalid/);
    await expect(
      handlers[IPC_CHANNELS.PACT_CONVERSATION_SEND]!({
        businessId: "b",
        text: "x",
        effect: "inspect",
        extra: 1,
      }),
    ).rejects.toThrow(/Invalid/);
    await expect(
      handlers[IPC_CHANNELS.PACT_BUSINESS_DISCOVER]!({
        domain: "a.example",
        cardUrl: "https://b.example",
      }),
    ).rejects.toThrow(/Invalid/);
    await expect(
      handlers[IPC_CHANNELS.PACT_SETTINGS_UPDATE]!({ identity: { deployment: "root" } }),
    ).rejects.toThrow(/Invalid/);
    expect(service.send).not.toHaveBeenCalled();
    await handlers[IPC_CHANNELS.PACT_CONVERSATION_SEND]!({
      businessId: "b",
      text: "Where is it?",
      effect: "inspect",
    });
    expect(service.send).toHaveBeenCalledWith(
      expect.objectContaining({ id: "owner" }),
      expect.objectContaining({ requiredScopes: [], confirmed: false }),
    );
  });

  it("opens the business's sign-in page in the system browser and returns no link", async () => {
    const { handlers, openExternal } = setup({
      id: "a",
      verificationUri: "https://brand.example/login",
      verificationUriComplete: "https://brand.example/login?return_to=x",
      userCode: "WDJB-MJHT",
      verificationOrigin: "https://brand.example",
      expiresAt: Date.now() + 60_000,
    });
    const result = await handlers[IPC_CHANNELS.PACT_AUTHORIZATION_OPEN_SIGN_IN]!({ id: "a" });
    expect(openExternal).toHaveBeenCalledWith("https://brand.example/login?return_to=x");
    expect(JSON.stringify(result)).not.toContain("return_to");
  });

  it("refuses to open non-HTTPS sign-in pages and stale requests", async () => {
    const insecure = setup({
      id: "a",
      verificationUri: "http://brand.example/login",
      verificationUriComplete: "http://brand.example/login",
      userCode: "X",
      verificationOrigin: "http://brand.example",
      expiresAt: Date.now() + 60_000,
    });
    await expect(
      insecure.handlers[IPC_CHANNELS.PACT_AUTHORIZATION_OPEN_SIGN_IN]!({ id: "a" }),
    ).rejects.toThrow(/HTTPS/);
    expect(insecure.openExternal).not.toHaveBeenCalled();
    const stale = setup(null);
    await expect(
      stale.handlers[IPC_CHANNELS.PACT_AUTHORIZATION_OPEN_SIGN_IN]!({ id: "a" }),
    ).rejects.toThrow(/no longer pending/);
  });

  it("registers a handler for every PACT channel", () => {
    const { handlers } = setup();
    const channels = Object.entries(IPC_CHANNELS)
      .filter(([key]) => key.startsWith("PACT_"))
      .map(([, channel]) => channel);
    expect(Object.keys(handlers).sort()).toEqual([...channels].sort());
  });
});
