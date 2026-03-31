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

  it("detects analyze mode for analysis keywords", () => {
    const result = detectModeSuggestions("Analyze the performance of the API endpoints");
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].mode).toBe("analyze");
  });

  it("detects verified mode for production/deploy keywords", () => {
    const result = detectModeSuggestions("Deploy this to production carefully");
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].mode).toBe("verified");
    expect(result[0].confidence).toBeGreaterThanOrEqual(0.44);
  });

  it("detects collaborative mode for team keywords", () => {
    const result = detectModeSuggestions("Let the team brainstorm different perspectives on this");
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].mode).toBe("collaborative");
  });

  it("detects execute mode for implementation keywords", () => {
    const result = detectModeSuggestions("Build a login page and implement authentication");
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].mode).toBe("execute");
  });

  it("returns multiple suggestions for mixed prompts", () => {
    const result = detectModeSuggestions("Plan and implement the user auth system", {
      maxResults: 3,
    });
    expect(result.length).toBe(2);
    const modes = result.map((s) => s.mode);
    expect(modes).toContain("plan");
    expect(modes).toContain("execute");
  });

  it("respects excludeModes option", () => {
    const result = detectModeSuggestions("Plan the architecture", {
      excludeModes: ["plan"],
    });
    const modes = result.map((s) => s.mode);
    expect(modes).not.toContain("plan");
  });

  it("respects maxResults option", () => {
    const result = detectModeSuggestions(
      "Plan and build and review and deploy carefully",
      { maxResults: 1 },
    );
    expect(result.length).toBe(1);
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

  it("detects debug mode for bug / reproduction keywords", () => {
    const result = detectModeSuggestions(
      "Intermittent bug with stack trace — help me find root cause and reproduce",
    );
    expect(result.length).toBeGreaterThan(0);
    expect(result.map((s) => s.mode)).toContain("debug");
  });
});
