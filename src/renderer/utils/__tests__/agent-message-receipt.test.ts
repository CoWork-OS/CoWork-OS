import { describe, expect, it } from "vitest";
import {
  formatAgentMessageProtocolForDisplay,
  getAgentMessageReceipt,
  parseAgentMessageProtocolResult,
} from "../agent-message-receipt";

describe("getAgentMessageReceipt", () => {
  it("normalizes delivery state and exposes a compact diagnostic id", () => {
    expect(
      getAgentMessageReceipt({
        messageId: "12345678-1234-1234-1234-123456789012",
        deliveryStatus: "queued",
        senderTaskId: "sender",
        targetTaskId: "target",
      }),
    ).toMatchObject({
      status: "queued",
      label: "Queued for the next turn",
      shortMessageId: "12345678…",
      senderTaskId: "sender",
      targetTaskId: "target",
    });
  });

  it("preserves duplicate and failure meaning", () => {
    expect(
      getAgentMessageReceipt({
        messageId: "message-1",
        status: "delivered",
        duplicate: true,
        error: "not used",
      }),
    ).toMatchObject({
      label: "Already delivered; duplicate ignored",
      duplicate: true,
    });
    expect(getAgentMessageReceipt({ status: "failed", error: "Bot unavailable" })).toMatchObject({
      label: "Delivery failed",
      error: "Bot unavailable",
    });
  });

  it("keeps legacy receipts readable", () => {
    expect(getAgentMessageReceipt({ message: "legacy" })).toMatchObject({
      status: "accepted",
      label: "Accepted — delivery pending",
    });
  });

  it("normalizes the raw send_agent_message JSON result", () => {
    expect(
      parseAgentMessageProtocolResult(
        '{"success":true,"deliveryStatus":"queued","message_id":"2f7d7c8a-cc2c-4f6d-883b-030d73837249"}',
      ),
    ).toMatchObject({
      status: "queued",
      label: "Queued for the next turn",
      messageId: "2f7d7c8a-cc2c-4f6d-883b-030d73837249",
      shortMessageId: "2f7d7c8a…",
    });
  });

  it("normalizes the plain-text receipt echoed by bot runtimes", () => {
    expect(
      parseAgentMessageProtocolResult(
        "success=true, deliveryStatus=queued, message_id=2f7d7c8a-cc2c-4f6d-883b-030d73837249",
      ),
    ).toMatchObject({
      status: "queued",
      label: "Queued for the next turn",
      messageId: "2f7d7c8a-cc2c-4f6d-883b-030d73837249",
    });
  });

  it("does not reinterpret ordinary JSON answers as protocol receipts", () => {
    expect(parseAgentMessageProtocolResult('{"success":true,"answer":"done"}')).toBeNull();
    expect(parseAgentMessageProtocolResult("The message was queued.")).toBeNull();
  });

  it("turns protocol receipts into compact conversation copy", () => {
    expect(
      formatAgentMessageProtocolForDisplay(
        '{"success":true,"deliveryStatus":"queued","message_id":"2f7d7c8a-cc2c-4f6d-883b-030d73837249"}',
      ),
    ).toBe("Queued for the next turn · 2f7d7c8a…");
    expect(formatAgentMessageProtocolForDisplay("A normal bot answer.")).toBe(
      "A normal bot answer.",
    );
  });
});
