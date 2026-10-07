import { describe, expect, it } from "vitest";
import { normalizeBotDisplayName, normalizeBotProfileText } from "../bot-profile";

describe("normalizeBotProfileText", () => {
  it("keeps meaningful multiline profile text while trimming outer whitespace", () => {
    expect(normalizeBotProfileText("  first line\r\nsecond line\n\n  third line  ")).toBe(
      "first line\nsecond line\n\n  third line",
    );
  });

  it("normalizes missing profile text to an empty string", () => {
    expect(normalizeBotProfileText(undefined)).toBe("");
  });
});

describe("normalizeBotDisplayName", () => {
  it("saves one line without emoji, the same for create and edit", () => {
    expect(normalizeBotDisplayName("  🔬  Research\n bot ")).toBe("Research bot");
    expect(normalizeBotDisplayName("🤖")).toBe("");
  });
});
