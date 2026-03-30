import { describe, expect, it } from "vitest";
import {
  formatPeerSupervisorMessage,
  getSupervisorMarker,
  parseSupervisorProtocolMessage,
} from "../protocol";

describe("discord supervisor protocol parser", () => {
  const config = {
    peerBotUserIds: ["111", "222"],
    strictMode: true,
  };

  it("parses a valid strict protocol message", () => {
    const parsed = parseSupervisorProtocolMessage(
      "<@111> [CW_STATUS_REQUEST]\nReview the latest output.",
      config,
    );

    expect(parsed?.intent).toBe("status_request");
    expect(parsed?.mentionedPeerUserId).toBe("111");
    expect(parsed?.markerCount).toBe(1);
    expect(parsed?.mentionCount).toBe(1);
  });

  it("rejects multiple markers in strict mode", () => {
    const parsed = parseSupervisorProtocolMessage(
      "<@111> [CW_STATUS_REQUEST] [CW_ACK]\nBad message.",
      config,
    );

    expect(parsed).toBeNull();
  });

  it("rejects messages without an allowed peer mention", () => {
    const parsed = parseSupervisorProtocolMessage(
      "<@333> [CW_STATUS_REQUEST]\nBad peer.",
      config,
    );

    expect(parsed).toBeNull();
  });

  it("allows lenient parsing for generated outputs", () => {
    const parsed = parseSupervisorProtocolMessage(
      "prefix <@222> [CW_REVIEW_REQUEST] [CW_EXCHANGE:550e8400-e29b-41d4-a716-446655440000]\nLooks good.",
      {
        peerBotUserIds: ["222"],
        strictMode: false,
      },
    );

    expect(parsed?.intent).toBe("review_request");
    expect(parsed?.mentionedPeerUserId).toBe("222");
    expect(parsed?.exchangeId).toBe("550e8400-e29b-41d4-a716-446655440000");
  });

  it("formats peer messages with a single marker", () => {
    const text = formatPeerSupervisorMessage("111", "ack", "Looks good.");

    expect(text).toContain("<@111>");
    expect(text).toContain(getSupervisorMarker("ack"));
    expect(text.match(/\[CW_ACK\]/g)?.length).toBe(1);
  });

  it("includes the exchange token when formatting protocol messages", () => {
    const text = formatPeerSupervisorMessage("111", "ack", "Looks good.", {
      exchangeId: "550e8400-e29b-41d4-a716-446655440000",
    });

    expect(text).toContain("[CW_EXCHANGE:550e8400-e29b-41d4-a716-446655440000]");
  });
});
