import { describe, expect, it, vi } from "vitest";
vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/cowork-teams-reference-fixture" },
  BrowserWindow: { getAllWindows: () => [] },
}));
import { ChannelGateway } from "../index";
import { TeamsAdapter } from "../channels/teams";
const reference = {
  channelId: "msteams" as const,
  serviceUrl: "https://smba.trafficmanager.net/amer/",
  bot: { id: "bot" },
  conversation: { id: "chat", tenantId: "tenant" },
};
function fixture(changed = false) {
  const channel = {
    id: "teams-channel",
    type: "teams",
    enabled: true,
    config: { appId: "app", appPassword: "fixture secret", tenantId: "tenant" },
  };
  const teamsReferenceRepo = {
    policy: vi.fn().mockResolvedValue("a".repeat(64)),
    put: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(reference),
  };
  const gateway = {
    assertChannelConfigAvailable: vi.fn(),
    teamsReferenceRepo,
    channelRepo: {
      findById: vi
        .fn()
        .mockResolvedValue(
          changed ? { ...channel, config: { ...channel.config, tenantId: "foreign" } } : channel,
        ),
    },
  };
  const adapter = (ChannelGateway.prototype as Any).createAdapterForChannel.call(
    gateway,
    channel,
  ) as TeamsAdapter;
  return { adapter, repo: teamsReferenceRepo };
}
describe("gateway Teams recovery wiring", () => {
  it("creates the actual Teams adapter with exact channel/app/tenant persistence", async () => {
    const f = fixture();
    expect(f.adapter).toBeInstanceOf(TeamsAdapter);
    try {
      const persistence = (f.adapter as Any).decisionReferencePersistence;
      await persistence.save(reference);
      expect(f.repo.put).toHaveBeenCalledWith({
        channelId: "teams-channel",
        appId: "app",
        tenantId: "tenant",
        policyHash: "a".repeat(64),
        reference,
      });
      await persistence.load("chat");
      expect(f.repo.get).toHaveBeenCalledWith({
        channelId: "teams-channel",
        chatId: "chat",
        appId: "app",
        tenantId: "tenant",
        policyHash: "a".repeat(64),
      });
    } finally {
      await f.adapter.disconnect();
    }
  });
  it("does not bind a changed configuration to the old adapter", async () => {
    const f = fixture(true);
    try {
      const persistence = (f.adapter as Any).decisionReferencePersistence;
      await expect(persistence.save(reference)).rejects.toThrow(/binding unavailable/);
      expect(await persistence.load("chat")).toBeUndefined();
      expect(f.repo.put).not.toHaveBeenCalled();
      expect(f.repo.get).not.toHaveBeenCalled();
    } finally {
      await f.adapter.disconnect();
    }
  });
  it.each([
    [true, "config"],
    [false, "config"],
    [true, "security"],
    [false, "security"],
  ] as const)(
    "replaces a changed Teams binding, reconnecting only a connected adapter (%s, %s)",
    async (connected, setting) => {
      const channel = {
        id: "teams-channel",
        type: "teams",
        enabled: true,
        config: { appId: "app", appPassword: "fixture", tenantId: "tenant" },
      };
      const oldAdapter = {
        status: connected ? "connected" : "disconnected",
        disconnect: vi.fn().mockResolvedValue(undefined),
      };
      const replacement = { connect: vi.fn().mockResolvedValue(undefined) };
      const gateway = {
        channelRepo: {
          update: vi.fn().mockResolvedValue(undefined),
          findById: vi.fn().mockResolvedValue(channel),
        },
        assertChannelConfigAvailable: vi.fn(),
        createAdapterForChannel: vi.fn().mockReturnValue(replacement),
        router: {
          getAdapterByChannelId: () => oldAdapter,
          unregisterAdapter: vi.fn(),
          registerAdapter: vi.fn(),
        },
      };
      await ChannelGateway.prototype.updateChannel.call(
        gateway as Any,
        channel.id,
        setting === "config"
          ? { config: { decisionMessagesEnabled: true } }
          : { securityConfig: { mode: "pairing" } },
      );
      expect(oldAdapter.disconnect).toHaveBeenCalledTimes(1);
      expect(gateway.router.unregisterAdapter).toHaveBeenCalledWith(channel.id);
      expect(gateway.router.registerAdapter).toHaveBeenCalledWith(replacement, channel.id);
      expect(replacement.connect).toHaveBeenCalledTimes(connected ? 1 : 0);
    },
  );
});
