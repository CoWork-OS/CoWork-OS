import { describe, expect, it } from "vitest";
import { containsNoMemoryDirective, taskDisablesMemoryCapture } from "../no-memory-directive";

describe("no-memory directives", () => {
  it("recognizes the tag case-insensitively with optional whitespace and slash", () => {
    expect(containsNoMemoryDirective("<no-memory />")).toBe(true);
    expect(containsNoMemoryDirective("< NO-MEMORY >")).toBe(true);
    expect(containsNoMemoryDirective("ordinary text")).toBe(false);
  });

  it("suppresses task capture when the original user prompt carries the directive", () => {
    expect(
      taskDisablesMemoryCapture({
        prompt: "Formatted execution prompt without the directive",
        rawPrompt: "Run this synthetic check. <no-memory />",
      }),
    ).toBe(true);
  });

  it("does not suppress ordinary tasks", () => {
    expect(taskDisablesMemoryCapture({ prompt: "Summarize this file" })).toBe(false);
    expect(taskDisablesMemoryCapture(undefined)).toBe(false);
  });
});
