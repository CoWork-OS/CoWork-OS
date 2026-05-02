import { describe, expect, it } from "vitest";

/**
 * Tests for gateway router ambient mode logic and self-message capture.
 *
 * These test the core decision logic extracted from the router's handleMessage method
 * without needing to instantiate the full router with all its dependencies.
 */

describe("Gateway ambient mode logic", () => {
  // Extract the core decision logic from handleMessage
  function computeIngestOnly(opts: {
    ambientMode: boolean;
    messageIngestOnly: boolean;
    text: string;
  }): boolean {
    const textTrimmed = (opts.text || "").trim();
    const looksLikePairingCode = /^[A-Z0-9]{6,8}$/i.test(textTrimmed);
    const ambientIngestOnly =
      opts.ambientMode && !(textTrimmed.startsWith("/") || looksLikePairingCode);
    return opts.messageIngestOnly || ambientIngestOnly;
  }

  function computeSilentUnauthorized(opts: {
    channelSilentUnauthorized?: boolean;
    ambientMode: boolean;
    channelType?: string;
  }): boolean {
    return (
      opts.channelSilentUnauthorized === true ||
      opts.ambientMode ||
      opts.channelType === "email"
    );
  }

  describe("ingestOnly computation", () => {
    it("normal message in ambient mode is ingest-only", () => {
      expect(
        computeIngestOnly({ ambientMode: true, messageIngestOnly: false, text: "Hello there" }),
      ).toBe(true);
    });

    it("slash command in ambient mode is NOT ingest-only", () => {
      expect(
        computeIngestOnly({ ambientMode: true, messageIngestOnly: false, text: "/brief" }),
      ).toBe(false);
    });

    it("pairing code in ambient mode is NOT ingest-only", () => {
      expect(
        computeIngestOnly({ ambientMode: true, messageIngestOnly: false, text: "ABC123" }),
      ).toBe(false);
    });

    it("8-char pairing code in ambient mode is NOT ingest-only", () => {
      expect(
        computeIngestOnly({ ambientMode: true, messageIngestOnly: false, text: "ABCD1234" }),
      ).toBe(false);
    });

    it("9-char code in ambient mode IS ingest-only (too long for pairing)", () => {
      expect(
        computeIngestOnly({ ambientMode: true, messageIngestOnly: false, text: "ABCDE12345" }),
      ).toBe(true);
    });

    it("normal message without ambient mode is NOT ingest-only", () => {
      expect(
        computeIngestOnly({ ambientMode: false, messageIngestOnly: false, text: "Hello" }),
      ).toBe(false);
    });

    it("message with ingestOnly flag is always ingest-only", () => {
      expect(
        computeIngestOnly({ ambientMode: false, messageIngestOnly: true, text: "Hello" }),
      ).toBe(true);
    });

    it("empty text in ambient mode is ingest-only", () => {
      expect(computeIngestOnly({ ambientMode: true, messageIngestOnly: false, text: "" })).toBe(
        true,
      );
    });

    it("whitespace-only text in ambient mode is ingest-only", () => {
      expect(computeIngestOnly({ ambientMode: true, messageIngestOnly: false, text: "   " })).toBe(
        true,
      );
    });
  });

  describe("silentUnauthorized computation", () => {
    it("is true when ambient mode is on", () => {
      expect(
        computeSilentUnauthorized({ channelSilentUnauthorized: false, ambientMode: true }),
      ).toBe(true);
    });

    it("is true when channelSilentUnauthorized is explicitly set", () => {
      expect(
        computeSilentUnauthorized({ channelSilentUnauthorized: true, ambientMode: false }),
      ).toBe(true);
    });

    it("is false when both are off", () => {
      expect(
        computeSilentUnauthorized({ channelSilentUnauthorized: false, ambientMode: false }),
      ).toBe(false);
    });

    it("is true by default for email channels", () => {
      expect(computeSilentUnauthorized({ ambientMode: false, channelType: "email" })).toBe(true);
    });

    it("cannot be disabled for email channels", () => {
      expect(
        computeSilentUnauthorized({
          channelSilentUnauthorized: false,
          ambientMode: false,
          channelType: "email",
        }),
      ).toBe(true);
    });
  });
});

describe("Gateway outgoing_user direction logic", () => {
  function computeDirection(messageDirection?: "incoming" | "outgoing_user"): string {
    return messageDirection === "outgoing_user" ? "outgoing_user" : "incoming";
  }

  it("maps outgoing_user direction correctly", () => {
    expect(computeDirection("outgoing_user")).toBe("outgoing_user");
  });

  it("defaults to incoming for undefined direction", () => {
    expect(computeDirection(undefined)).toBe("incoming");
  });

  it("defaults to incoming for incoming direction", () => {
    expect(computeDirection("incoming")).toBe("incoming");
  });
});

describe("looksLikePairingCode", () => {
  function looksLikePairingCode(text: string): boolean {
    return /^[A-Z0-9]{6,8}$/i.test(text);
  }

  it("matches 6-char alphanumeric", () => {
    expect(looksLikePairingCode("ABC123")).toBe(true);
  });

  it("matches 7-char alphanumeric", () => {
    expect(looksLikePairingCode("ABCDEF7")).toBe(true);
  });

  it("matches 8-char alphanumeric", () => {
    expect(looksLikePairingCode("ABCDEF78")).toBe(true);
  });

  it("rejects 5-char string (too short)", () => {
    expect(looksLikePairingCode("ABC12")).toBe(false);
  });

  it("rejects 9-char string (too long)", () => {
    expect(looksLikePairingCode("ABC123456")).toBe(false);
  });

  it("rejects string with special chars", () => {
    expect(looksLikePairingCode("ABC-12")).toBe(false);
  });

  it("rejects string with spaces", () => {
    expect(looksLikePairingCode("ABC 12")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(looksLikePairingCode("abc123")).toBe(true);
  });
});

describe("Chat transcript outgoing_user formatting", () => {
  function formatSpeaker(direction: string, agentName: string): string {
    if (direction === "outgoing") return agentName;
    if (direction === "outgoing_user") return "Me";
    return "User";
  }

  it('labels outgoing_user as "Me"', () => {
    expect(formatSpeaker("outgoing_user", "CoWork")).toBe("Me");
  });

  it("labels outgoing as agent name", () => {
    expect(formatSpeaker("outgoing", "CoWork")).toBe("CoWork");
  });

  it('labels incoming as "User"', () => {
    expect(formatSpeaker("incoming", "CoWork")).toBe("User");
  });
});
