import { describe, expect, it } from "vitest";
import {
  gatewaySenderAgentConfig,
  gatewaySenderRef,
  isGatewayOwnerSender,
  isThirdPartyGatewayTask,
} from "../gateway-sender-identity";

describe("gateway sender identity (SEC-16)", () => {
  it("recognizes the owner only on positive evidence", () => {
    const dm = { userId: "u-1", chatId: "u-1" };
    expect(isGatewayOwnerSender(dm, {})).toBe(false);
    expect(isGatewayOwnerSender(dm, { ownerUserIds: ["u-2"] })).toBe(false);
    expect(isGatewayOwnerSender(dm, { ownerUserIds: [" u-1 "] })).toBe(true);
    expect(isGatewayOwnerSender(dm, { ownerUserIds: "u-1" })).toBe(false);
    expect(isGatewayOwnerSender(dm, { selfChatMode: true })).toBe(true);
  });

  it("never attributes group or ingest-only messages to the owner", () => {
    expect(
      isGatewayOwnerSender({ userId: "u-1", isGroup: true }, { ownerUserIds: ["u-1"] }),
    ).toBe(false);
    expect(isGatewayOwnerSender({ userId: "u-1", ingestOnly: true }, { selfChatMode: true })).toBe(
      false,
    );
    expect(isGatewayOwnerSender({ userId: " " }, { selfChatMode: true })).toBe(false);
  });

  it("builds a bounded contact reference and the task config fields", () => {
    expect(gatewaySenderRef("telegram", "123 456")).toBe("gateway:telegram:123_456");
    expect(gatewaySenderRef("slack", "x".repeat(400)).length).toBeLessThanOrEqual(200);
    expect(gatewaySenderAgentConfig("telegram", { userId: "42" }, {})).toEqual({
      gatewaySenderIsOwner: false,
      gatewaySenderRef: "gateway:telegram:42",
    });
  });

  it("treats channel tasks without owner evidence as third-party", () => {
    expect(isThirdPartyGatewayTask(undefined)).toBe(false);
    expect(isThirdPartyGatewayTask({ agentConfig: {} })).toBe(false);
    expect(isThirdPartyGatewayTask({ agentConfig: { originChannel: "telegram" } })).toBe(true);
    expect(
      isThirdPartyGatewayTask({
        agentConfig: { originChannel: "telegram", gatewaySenderIsOwner: false },
      }),
    ).toBe(true);
    expect(
      isThirdPartyGatewayTask({
        agentConfig: { originChannel: "whatsapp", gatewaySenderIsOwner: true },
      }),
    ).toBe(false);
  });
});
