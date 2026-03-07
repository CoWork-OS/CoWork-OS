import { describe, it, expect, vi, beforeEach } from "vitest";
import { ChannelPersonaAdapter } from "../ChannelPersonaAdapter";

// ── Mocks ─────────────────────────────────────────────────────────────

let mockGuardrails: Record<string, unknown> = {
  channelPersonaEnabled: true,
};

vi.mock("../../guardrails/guardrail-manager", () => ({
  GuardrailManager: {
    loadSettings: () => mockGuardrails,
  },
}));

// ── Tests ─────────────────────────────────────────────────────────────

describe("ChannelPersonaAdapter", () => {
  beforeEach(() => {
    mockGuardrails = { channelPersonaEnabled: true };
  });

  describe("adaptForChannel", () => {
    it("returns empty when disabled", () => {
      mockGuardrails.channelPersonaEnabled = false;
      const result = ChannelPersonaAdapter.adaptForChannel("slack", "private");
      expect(result).toBe("");
    });

    it("returns empty when no channel type provided", () => {
      const result = ChannelPersonaAdapter.adaptForChannel(undefined, "private");
      expect(result).toBe("");
    });

    it("generates slack-specific directive", () => {
      const result = ChannelPersonaAdapter.adaptForChannel("slack", "private");
      expect(result).toContain("CHANNEL COMMUNICATION GUIDELINES");
      expect(result).toContain("Slack");
      expect(result).toContain("concise");
    });

    it("generates email-specific directive with formal framing", () => {
      const result = ChannelPersonaAdapter.adaptForChannel("email", "private");
      expect(result).toContain("email");
      expect(result).toContain("greeting");
      expect(result).toContain("sign-off");
    });

    it("generates whatsapp-specific directive", () => {
      const result = ChannelPersonaAdapter.adaptForChannel("whatsapp", "private");
      expect(result).toContain("WhatsApp");
      expect(result).toContain("short");
    });

    it("generates discord-specific directive with markdown hints", () => {
      const result = ChannelPersonaAdapter.adaptForChannel("discord", "private");
      expect(result).toContain("Discord");
      expect(result).toContain("markdown");
    });

    it("generates teams-specific directive", () => {
      const result = ChannelPersonaAdapter.adaptForChannel("teams", "private");
      expect(result).toContain("Teams");
      expect(result).toContain("professional");
    });

    it("generates telegram-specific directive", () => {
      const result = ChannelPersonaAdapter.adaptForChannel("telegram", "private");
      expect(result).toContain("Telegram");
      expect(result).toContain("concise");
    });

    it("adds group context overlay when in group mode", () => {
      const result = ChannelPersonaAdapter.adaptForChannel("slack", "group");
      expect(result).toContain("group conversation");
      expect(result).toContain("sensitive information");
    });

    it("adds public context overlay when in public mode", () => {
      const result = ChannelPersonaAdapter.adaptForChannel("slack", "public");
      expect(result).toContain("public channel");
      expect(result).toContain("professionalism");
    });

    it("does not add context overlay in private mode", () => {
      const result = ChannelPersonaAdapter.adaptForChannel("slack", "private");
      expect(result).not.toContain("group conversation");
      expect(result).not.toContain("public channel");
    });

    it("prefers shorter responses for messaging channels", () => {
      const whatsapp = ChannelPersonaAdapter.adaptForChannel("whatsapp", "private");
      expect(whatsapp).toContain("shorter");
    });

    it("allows longer responses for email", () => {
      const email = ChannelPersonaAdapter.adaptForChannel("email", "private");
      expect(email).toContain("Thorough");
    });
  });

  describe("getChannelProfile", () => {
    it("returns profile for known channel", () => {
      const profile = ChannelPersonaAdapter.getChannelProfile("slack");
      expect(profile).toBeDefined();
      expect(profile!.lengthHint).toBe("shorter");
      expect(profile!.structuredFormatting).toBe(true);
    });

    it("returns undefined for unknown channel", () => {
      const profile = ChannelPersonaAdapter.getChannelProfile("nonexistent" as never);
      expect(profile).toBeUndefined();
    });
  });

  describe("getSupportedChannels", () => {
    it("returns all supported channel types", () => {
      const channels = ChannelPersonaAdapter.getSupportedChannels();
      expect(channels).toContain("slack");
      expect(channels).toContain("email");
      expect(channels).toContain("whatsapp");
      expect(channels).toContain("discord");
      expect(channels).toContain("teams");
      expect(channels.length).toBeGreaterThan(10);
    });
  });
});
