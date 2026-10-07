import { describe, expect, it } from "vitest";
import { CHANNEL_TYPES } from "../../../shared/gateway-channel-types";
import { supportedResponsibilityOperation } from "../responsibility-capabilities";
import { fileResponsibilityOperation } from "../responsibility-task-policy";

describe("governed cached channel and mailbox read capabilities", () => {
  it.each(CHANNEL_TYPES)("allows cached read scope for canonical channel %s", (channel) => {
    const operation = {
      connectorId: `gateway:${channel}`,
      method: "channel_history",
      resourceId: "chat-123",
    };
    expect(supportedResponsibilityOperation(operation, "read")).toBe(true);
    expect(supportedResponsibilityOperation(operation, "write")).toBe(false);
    expect(
      fileResponsibilityOperation("channel_history", { channel, chat_id: " chat-123 " }, ""),
    ).toEqual({ ...operation, resourceId: "chat-123", effect: "read" });
  });

  it.each(["list_threads", "get_thread"])(
    "allows read-only responsibility scope for one mailbox account with %s",
    (method) => {
      const operation = {
        connectorId: "mailbox",
        method,
        resourceId: "gmail:user@example.com",
      };
      expect(supportedResponsibilityOperation(operation, "read")).toBe(true);
      expect(supportedResponsibilityOperation(operation, "write")).toBe(false);
      expect(
        fileResponsibilityOperation(
          "mailbox_action",
          { action: method, account_id: operation.resourceId },
          "",
        ),
      ).toEqual({ ...operation, effect: "read" });
    },
  );

  it("keeps unscoped, malformed, write, and other mailbox actions unavailable", () => {
    expect(
      supportedResponsibilityOperation(
        { connectorId: "mailbox", method: "list_threads", resourceId: " " },
        "read",
      ),
    ).toBe(false);
    expect(
      supportedResponsibilityOperation(
        { connectorId: "mailbox", method: "sync", resourceId: "gmail:user@example.com" },
        "read",
      ),
    ).toBe(false);
    expect(
      fileResponsibilityOperation("mailbox_action", { action: "list_threads" }, ""),
    ).toBeNull();
    expect(
      fileResponsibilityOperation(
        "mailbox_action",
        { action: "get_thread", account_id: " gmail:user@example.com" },
        "",
      ),
    ).toBeNull();
    expect(
      fileResponsibilityOperation(
        "mailbox_action",
        { action: "research_contact", account_id: "gmail:user@example.com" },
        "",
      ),
    ).toBeNull();
  });

  it("keeps unknown connectors, empty chats, other methods, and writes unavailable", () => {
    expect(
      supportedResponsibilityOperation(
        { connectorId: "gateway:unknown", method: "channel_history", resourceId: "chat-123" },
        "read",
      ),
    ).toBe(false);
    expect(
      supportedResponsibilityOperation(
        { connectorId: "gateway:slack", method: "channel_history", resourceId: "  " },
        "read",
      ),
    ).toBe(false);
    expect(
      supportedResponsibilityOperation(
        { connectorId: "gateway:slack", method: "fetch_live", resourceId: "chat-123" },
        "read",
      ),
    ).toBe(false);
    expect(
      fileResponsibilityOperation(
        "channel_history",
        { channel: "unknown", chat_id: "chat-123" },
        "",
      ),
    ).toBeNull();
    expect(
      fileResponsibilityOperation("channel_history", { channel: "slack", chat_id: " " }, ""),
    ).toBeNull();
  });
});
