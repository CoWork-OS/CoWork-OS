import * as fs from "fs";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/cowork-test" },
  BrowserWindow: { getAllWindows: () => [] },
}));
import { ChannelGateway } from "../index";

describe("gateway retired channel rows", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  it("deletes retired channel rows and their state while keeping supported channels", async () => {
    const rows = [
      { id: "tg", type: "telegram", name: "Telegram", enabled: true },
      { id: "tw-1", type: "twitch", name: "Twitch", enabled: true },
      { id: "tw-2", type: "twitch", name: "Twitch 2", enabled: false },
      { id: "x-1", type: "x", name: "X", enabled: true },
      { id: "sl", type: "slack", name: "Slack", enabled: false },
    ];
    const rm = vi.spyOn(fs.promises, "rm").mockResolvedValue(undefined);
    const gateway = {
      channelRepo: { findAll: vi.fn(async () => rows), delete: vi.fn(async () => undefined) },
      getWebhookStateDir: (id: string) => `/state/${id}`,
    };

    await (ChannelGateway.prototype as Any).removeRetiredChannels.call(gateway);

    expect(gateway.channelRepo.delete.mock.calls.map(([id]) => id)).toEqual([
      "tw-1",
      "tw-2",
      "x-1",
    ]);
    expect(rm.mock.calls.map(([dir]) => dir)).toEqual(["/state/tw-1", "/state/tw-2", "/state/x-1"]);
  });

  it("keeps going when one retired row fails to delete", async () => {
    const rows = [
      { id: "tw-1", type: "twitch", name: "Twitch", enabled: true },
      { id: "x-1", type: "x", name: "X", enabled: true },
      { id: "tg", type: "telegram", name: "Telegram", enabled: true },
    ];
    const rm = vi.spyOn(fs.promises, "rm").mockResolvedValue(undefined);
    const gateway = {
      channelRepo: {
        findAll: vi.fn(async () => rows),
        delete: vi.fn(async (id: string) => {
          if (id === "tw-1") throw new Error("database is locked");
        }),
      },
      getWebhookStateDir: (id: string) => `/state/${id}`,
    };

    await expect(
      (ChannelGateway.prototype as Any).removeRetiredChannels.call(gateway),
    ).resolves.toBeUndefined();

    expect(gateway.channelRepo.delete.mock.calls.map(([id]) => id)).toEqual(["tw-1", "x-1"]);
    expect(rm.mock.calls.map(([dir]) => dir)).toEqual(["/state/x-1"]);
  });

  it("does not block startup when the channel list cannot be read", async () => {
    const gateway = {
      channelRepo: {
        findAll: vi.fn(async () => {
          throw new Error("database is locked");
        }),
        delete: vi.fn(),
      },
      getWebhookStateDir: (id: string) => `/state/${id}`,
    };

    await expect(
      (ChannelGateway.prototype as Any).removeRetiredChannels.call(gateway),
    ).resolves.toBeUndefined();
    expect(gateway.channelRepo.delete).not.toHaveBeenCalled();
  });
});
