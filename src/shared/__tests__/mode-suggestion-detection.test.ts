import { describe, it, expect } from "vitest";
import { detectModeSuggestions } from "../mode-suggestion-detection";

describe("detectModeSuggestions", () => {
  it("returns empty array for empty input", () => {
    expect(detectModeSuggestions("")).toEqual([]);
    expect(detectModeSuggestions("  ")).toEqual([]);
  });

  it("returns empty array for non-string input", () => {
    expect(detectModeSuggestions(null as unknown as string)).toEqual([]);
    expect(detectModeSuggestions(undefined as unknown as string)).toEqual([]);
  });

  it("detects plan mode for planning keywords", () => {
    const result = detectModeSuggestions("Design a system architecture for the payment module");
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].mode).toBe("plan");
    expect(result[0].confidence).toBeGreaterThanOrEqual(0.3);
  });

  it("detects collaborative mode for team keywords", () => {
    const result = detectModeSuggestions("Let the team brainstorm different perspectives on this");
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].mode).toBe("collaborative");
  });

  it("respects excludeModes option", () => {
    const result = detectModeSuggestions("Plan the architecture", {
      excludeModes: ["plan"],
    });
    const modes = result.map((s) => s.mode);
    expect(modes).not.toContain("plan");
  });

  it("returns multiple suggestions for mixed prompts", () => {
    const result = detectModeSuggestions("Plan the architecture with the team in parallel", {
      maxResults: 3,
    });
    const modes = result.map((s) => s.mode);
    expect(modes).toContain("plan");
    expect(modes).toContain("collaborative");
  });

  it("respects maxResults option", () => {
    const result = detectModeSuggestions("Plan the architecture with the team in parallel", {
      maxResults: 1,
    });
    expect(result.length).toBe(1);
  });

  it("never suggests the folded runtime strategies", () => {
    const modes = detectModeSuggestions(
      "Analyze and review this bug, reproduce the crash, then deploy to production carefully",
      { maxResults: 5, threshold: 0.1 },
    ).map((s) => s.mode);
    expect(modes.every((mode) => mode === "plan" || mode === "collaborative")).toBe(true);
  });

  it("respects threshold option", () => {
    const result = detectModeSuggestions("maybe plan something", {
      threshold: 0.5,
    });
    // Single keyword match scores 0.3, below 0.5 threshold
    const planSuggestion = result.find((s) => s.mode === "plan");
    expect(planSuggestion).toBeUndefined();
  });

  it("ranks higher confidence suggestions first", () => {
    const result = detectModeSuggestions(
      "Design the architecture and outline an approach for the strategy",
      { maxResults: 3 },
    );
    if (result.length > 1) {
      expect(result[0].confidence).toBeGreaterThanOrEqual(result[1].confidence);
    }
  });

  it("caps confidence at 1.0", () => {
    const result = detectModeSuggestions(
      "plan design architect strategy outline roadmap approach propose",
    );
    const planSuggestion = result.find((s) => s.mode === "plan");
    expect(planSuggestion).toBeDefined();
    expect(planSuggestion!.confidence).toBeLessThanOrEqual(1.0);
  });
});
