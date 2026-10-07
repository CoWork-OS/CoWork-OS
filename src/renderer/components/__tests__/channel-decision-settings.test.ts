import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ChannelDecisionSettings } from "../ChannelDecisionSettings";
import {
  channelDecisionEnableError,
  saveChannelDecisionSetting,
  type DecisionSettingsChannel,
} from "../channel-decision-settings";
const channel: DecisionSettingsChannel = {
  id: "slack-fixture",
  type: "slack",
  config: { ownerUserIds: ["UOWNER"], progressRelayMode: "curated" },
};
const render = (value: DecisionSettingsChannel) =>
  renderToStaticMarkup(
    React.createElement(ChannelDecisionSettings, { channel: value, onSaved: () => {} }),
  );
describe("channel decision opt-in", () => {
  it("defaults off without changing config or owner accounts", () => {
    const markup = render(channel);
    expect(markup).toContain("Send approval decision cards");
    expect(markup).not.toContain('checked=""');
    expect(channel.config?.decisionMessagesEnabled).toBeUndefined();
  });
  it.each(["slack", "teams"] as const)("shows saved %s opt-in", (type) => {
    expect(
      render({ ...channel, type, config: { ...channel.config, decisionMessagesEnabled: true } }),
    ).toContain('checked=""');
  });
  it("does not offer unsupported channels", () => {
    expect(render({ ...channel, type: "telegram" })).toBe("");
  });
  it.each([undefined, [], ["bad id"], [123]])(
    "requires structurally valid saved owner IDs (%j)",
    (ownerUserIds) => {
      const value = { ...channel, config: { ownerUserIds } } as DecisionSettingsChannel;
      expect(channelDecisionEnableError(value)).toContain("account ID");
      expect(render(value)).toContain('disabled=""');
    },
  );
  it("allows disabling an existing opt-in even after owner removal", async () => {
    const value = { ...channel, config: { decisionMessagesEnabled: true } },
      update = vi.fn().mockResolvedValue(undefined);
    expect(render(value)).not.toContain('disabled=""');
    await saveChannelDecisionSetting(value, false, update);
    expect(update).toHaveBeenCalledWith({
      id: channel.id,
      config: { decisionMessagesEnabled: false },
    });
  });
  it("refuses enablement without an owner or with unreadable configuration before writing", async () => {
    const update = vi.fn();
    for (const value of [
      { ...channel, config: {} },
      { ...channel, configReadError: "unavailable" },
    ])
      await expect(saveChannelDecisionSetting(value, true, update)).rejects.toThrow();
    expect(update).not.toHaveBeenCalled();
  });
  it("writes only the opt-in patch and surfaces failed persistence", async () => {
    const update = vi.fn().mockRejectedValue(new Error("save refused"));
    await expect(saveChannelDecisionSetting(channel, true, update)).rejects.toThrow("save refused");
    expect(update).toHaveBeenCalledWith({
      id: channel.id,
      config: { decisionMessagesEnabled: true },
    });
    expect(channel.config).toEqual({ ownerUserIds: ["UOWNER"], progressRelayMode: "curated" });
  });
});
