import { describe, expect, it, vi } from "vitest";
vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/cowork-test" },
  BrowserWindow: { getAllWindows: () => [] },
}));
import { ChannelGateway } from "../index";

describe("gateway retired channel rows", () => {
  it("does not list rows of channel types that no longer have an adapter", async () => {
    const rows = [
      { id: "tg", type: "telegram", name: "Telegram", enabled: true },
      { id: "tw", type: "twitch", name: "Twitch", enabled: true },
      { id: "x", type: "x", name: "X", enabled: true },
      { id: "sl", type: "slack", name: "Slack", enabled: false },
    ];
    const gateway = { channelRepo: { findAll: vi.fn(() => rows) } };

    const channels = await ChannelGateway.prototype.getChannels.call(gateway as Any);

    expect(channels.map((channel) => channel.id)).toEqual(["tg", "sl"]);
  });
});
