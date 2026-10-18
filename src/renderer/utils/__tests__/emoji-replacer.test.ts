import { describe, expect, it } from "vitest";
import { stripAllEmojis, stripLeadingEmoji } from "../emoji-replacer";

describe("emoji sequence handling", () => {
  it.each(["🔬", "👩🏽‍💻", "👨‍👩‍👧‍👦", "🇵🇹"])("removes a complete leading %s sequence", (emoji) => {
    expect(stripLeadingEmoji(`  ${emoji} Researcher`)).toBe("Researcher");
    expect(stripAllEmojis(`Meet ${emoji} the team ${emoji}`)).toBe("Meet the team");
  });
  it("preserves ordinary text and numbers", () => {
    expect(stripLeadingEmoji(" Research team 42 ")).toBe("Research team 42");
    expect(stripAllEmojis("Team 42 - 2026")).toBe("Team 42 - 2026");
  });
});
