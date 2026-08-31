import { describe, expect, it } from "vitest";
import { MULTITASK_DEFAULT_LANE_COUNT, parseMultitaskCommand } from "../multitask-command";

describe("parseMultitaskCommand", () => {
  it("returns non-multitask for ordinary prompts", () => {
    const parsed = parseMultitaskCommand("fix the onboarding flow");
    expect(parsed.isMultitask).toBe(false);
  });

  it("parses /multitask with the default lane count", () => {
    const parsed = parseMultitaskCommand("/multitask fix the onboarding bugs");
    expect(parsed).toMatchObject({
      isMultitask: true,
      valid: true,
      prompt: "fix the onboarding bugs",
      laneCount: MULTITASK_DEFAULT_LANE_COUNT,
      assignmentMode: "auto_split",
    });
  });

  it("parses an explicit lane count", () => {
    const parsed = parseMultitaskCommand("/multitask 6 audit the repo");
    expect(parsed.valid).toBe(true);
    expect(parsed.prompt).toBe("audit the repo");
    expect(parsed.laneCount).toBe(6);
  });

  it("clamps explicit lane counts to the supported range", () => {
    expect(parseMultitaskCommand("/multitask 1 do work").laneCount).toBe(2);
    expect(parseMultitaskCommand("/multitask 99 do work").laneCount).toBe(8);
  });

  it("rejects an empty multitask command", () => {
    const parsed = parseMultitaskCommand("/multitask");
    expect(parsed.isMultitask).toBe(true);
    expect(parsed.valid).toBe(false);
    expect(parsed.error).toContain("request");
  });
});
