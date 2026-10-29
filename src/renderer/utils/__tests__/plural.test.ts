import { describe, expect, it } from "vitest";

import { formatCount, pluralize } from "../plural";

describe("pluralize", () => {
  it("uses the singular only for exactly one", () => {
    expect(pluralize(1, "tool")).toBe("tool");
    expect(pluralize(0, "tool")).toBe("tools");
    expect(pluralize(2, "tool")).toBe("tools");
  });

  it("accepts an irregular plural", () => {
    expect(pluralize(1, "Day Together", "Days Together")).toBe("Day Together");
    expect(pluralize(4, "Day Together", "Days Together")).toBe("Days Together");
  });
});

describe("formatCount", () => {
  it("joins the count and the matching noun", () => {
    expect(formatCount(1, "session")).toBe("1 session");
    expect(formatCount(0, "session")).toBe("0 sessions");
    expect(formatCount(12, "day")).toBe("12 days");
  });
});
