import { describe, expect, it } from "vitest";
import { isToolDeniedByRestrictions, parseToolRestrictions } from "../tool-restrictions";
import { TOOL_GROUPS } from "../types";

describe("tool restrictions", () => {
  it("parses '*', group names and exact tool names", () => {
    const parsed = parseToolRestrictions(["*", "group:memory", " gmail_action ", "", 7]);
    expect(parsed.denyAll).toBe(true);
    expect(Array.from(parsed.groups)).toEqual(["group:memory"]);
    expect(Array.from(parsed.tools)).toEqual(["gmail_action"]);
  });

  it("denies exact names, every tool of a denied group, and everything for '*'", () => {
    const parsed = parseToolRestrictions(["group:network", "gmail_action"]);
    expect(isToolDeniedByRestrictions("gmail_action", parsed)).toBe(true);
    for (const tool of TOOL_GROUPS["group:network"]) {
      expect(isToolDeniedByRestrictions(tool, parsed)).toBe(true);
    }
    expect(isToolDeniedByRestrictions("read_file", parsed)).toBe(false);
    expect(isToolDeniedByRestrictions("read_file", parseToolRestrictions(["*"]))).toBe(true);
  });

  it("denies nothing without restrictions", () => {
    expect(isToolDeniedByRestrictions("run_command", parseToolRestrictions())).toBe(false);
  });
});
