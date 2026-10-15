import { describe, expect, it } from "vitest";
import { readOnlyReviewSystemRestrictions } from "../phone-tool-visibility";

describe("restored Android tool visibility", () => {
  it.each(["Review Android app code", "Search local source files", "Review a report"])(
    "keeps the system restriction for ordinary reviews: %s",
    (prompt) => {
      expect(readOnlyReviewSystemRestrictions(prompt)).toEqual(["group:system"]);
    },
  );
  it.each([
    "On Android, tap Settings search and type a query",
    "Observe emulator-5554",
    "Use android_phone_observe for my selected device",
  ])("preserves requested phone tools while restricting host desktop tools: %s", (prompt) => {
    const denied = readOnlyReviewSystemRestrictions(prompt);
    expect(denied).not.toContain("group:system");
    expect(denied).toContain("native_app");
    expect(denied).toContain("screenshot");
    expect(denied).toContain("read_clipboard");
    expect(denied.some((name) => name.startsWith("android_phone_"))).toBe(false);
  });
});
