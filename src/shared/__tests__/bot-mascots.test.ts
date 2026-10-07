import { describe, expect, it } from "vitest";
import {
  BOT_MASCOT_IDS,
  botIconText,
  botMascotIcon,
  isBotMascotId,
  parseBotMascotIcon,
  resolveBotMascot,
} from "../bot-mascots";

describe("bot mascots", () => {
  it("round-trips every mascot through its icon value", () => {
    for (const id of BOT_MASCOT_IDS) {
      expect(parseBotMascotIcon(botMascotIcon(id))).toBe(id);
    }
  });

  it("ignores lucide keys, emoji, unknown mascots and empty values", () => {
    expect(parseBotMascotIcon("Bot")).toBeNull();
    expect(parseBotMascotIcon("🤖")).toBeNull();
    expect(parseBotMascotIcon("mascot:unicorn")).toBeNull();
    expect(parseBotMascotIcon("code")).toBeNull();
    expect(parseBotMascotIcon("")).toBeNull();
    expect(parseBotMascotIcon(undefined)).toBeNull();
    expect(isBotMascotId("code")).toBe(true);
    expect(isBotMascotId("mascot:code")).toBe(false);
  });

  it("prints mascots as an emoji on text-only surfaces and leaves other icons alone", () => {
    expect(botIconText("mascot:browse")).toBe("🦊");
    for (const id of BOT_MASCOT_IDS) {
      const text = botIconText(botMascotIcon(id));
      expect(text).not.toContain("mascot:");
      expect(text.length).toBeGreaterThan(0);
    }
    expect(botIconText("💻")).toBe("💻");
    expect(botIconText("Laptop")).toBe("Laptop");
    expect(botIconText(undefined)).toBe("");
  });

  it("draws every bot as a character, keeping a chosen one", () => {
    expect(resolveBotMascot("mascot:focus")).toBe("focus");
    expect(resolveBotMascot("Laptop")).toBe("code");
    expect(resolveBotMascot("ClipboardList")).toBe("plan");
    expect(resolveBotMascot("✍️")).toBe("write");
    expect(resolveBotMascot("✍")).toBe("write");
    expect(resolveBotMascot("🤖")).toBe("assist");
    expect(resolveBotMascot(undefined)).toBe("assist");
    expect(resolveBotMascot("")).toBe("assist");
    // Text stand-ins read back to their character.
    for (const id of BOT_MASCOT_IDS) {
      expect(resolveBotMascot(botIconText(botMascotIcon(id)))).toBe(id);
    }
    // Anything else gets a stable character.
    expect(resolveBotMascot("🦄")).toBe(resolveBotMascot("🦄"));
    expect(BOT_MASCOT_IDS).toContain(resolveBotMascot("🦄"));
  });
});
