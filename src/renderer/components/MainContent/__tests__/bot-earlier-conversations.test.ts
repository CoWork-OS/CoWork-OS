import { describe, expect, it } from "vitest";
import { buildBotMascotLookup, formatBotHistoryDay } from "../bot-earlier-conversations";

describe("formatBotHistoryDay", () => {
  const now = new Date(2026, 9, 7, 15).getTime();
  it("names recent days", () => {
    expect(formatBotHistoryDay(new Date(2026, 9, 7, 9).getTime(), now)).toBe("Today");
    expect(formatBotHistoryDay(new Date(2026, 9, 6, 23).getTime(), now)).toBe("Yesterday");
  });
  it("includes the year only for other years", () => {
    expect(formatBotHistoryDay(new Date(2025, 2, 4).getTime(), now)).toContain("2025");
    expect(formatBotHistoryDay(new Date(2026, 2, 4).getTime(), now)).not.toContain("2026");
  });
});

describe("buildBotMascotLookup", () => {
  it("finds a teammate's character by display name or handle", () => {
    const lookup = buildBotMascotLookup([
      { displayName: "Scribe — Author and Publisher", name: "scribe", icon: "mascot:write" },
    ]);
    expect(lookup("Scribe  — Author and Publisher")).toBe("write");
    expect(lookup("SCRIBE")).toBe("write");
    expect(lookup("Unknown bot")).toBeNull();
  });
});
