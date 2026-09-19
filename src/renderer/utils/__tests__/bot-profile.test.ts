import { describe, expect, it } from "vitest";
import { normalizeBotProfileText } from "../bot-profile";

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
