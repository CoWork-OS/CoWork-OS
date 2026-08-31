import { describe, it, expect } from "vitest";
import { ModelCapabilityRegistry } from "../llm/ModelCapabilityRegistry";

describe("ModelCapabilityRegistry", () => {
  describe("inferCapabilities", () => {
    it("detects code capability from task text", () => {
      const caps = ModelCapabilityRegistry.inferCapabilities(
        "fix the bug in the TypeScript function",
      );
      expect(caps).toContain("code");
    });

    it("detects vision capability from task text", () => {
      const caps = ModelCapabilityRegistry.inferCapabilities("analyze this screenshot");
      expect(caps).toContain("vision");
    });

    it("detects math capability from task text", () => {
      const caps = ModelCapabilityRegistry.inferCapabilities("solve the integral of x^2");
      expect(caps).toContain("math");
    });

    it("detects research capability", () => {
      const caps = ModelCapabilityRegistry.inferCapabilities("summarize the research paper");
      expect(caps).toContain("research");
    });

    it("detects fast capability", () => {
      const caps = ModelCapabilityRegistry.inferCapabilities("quickly rename this variable");
      expect(caps).toContain("fast");
    });

    it("returns empty for generic tasks", () => {
      const caps = ModelCapabilityRegistry.inferCapabilities("what time is it");
      expect(caps).toHaveLength(0);
    });
  });

  describe("selectForTask", () => {
    it("returns cheaper for fast tasks", () => {
      const model = ModelCapabilityRegistry.selectForTask("quickly list files");
      expect(model).toBe("cheaper");
    });

    it("returns sonnet for vision tasks", () => {
      const model = ModelCapabilityRegistry.selectForTask("analyze this image");
      expect(model).toBe("sonnet");
    });

    it("returns sonnet for math tasks", () => {
      const model = ModelCapabilityRegistry.selectForTask("calculate the probability");
      expect(model).toBe("sonnet");
    });

    it("returns undefined for non-matching text", () => {
      const model = ModelCapabilityRegistry.selectForTask("hello");
      expect(model).toBeUndefined();
    });

    it("returns undefined for empty string", () => {
      const model = ModelCapabilityRegistry.selectForTask("");
      expect(model).toBeUndefined();
    });
  });

  describe("selectForCapability", () => {
    it("returns cheaper for fast capability", () => {
      expect(ModelCapabilityRegistry.selectForCapability("fast")).toBe("cheaper");
    });

    it("returns sonnet for research capability", () => {
      expect(ModelCapabilityRegistry.selectForCapability("research")).toBe("sonnet");
    });

    it("returns sonnet for vision capability", () => {
      expect(ModelCapabilityRegistry.selectForCapability("vision")).toBe("sonnet");
    });
  });

  describe("getProfiles", () => {
    it("returns a non-empty profiles array", () => {
      const profiles = ModelCapabilityRegistry.getProfiles();
      expect(profiles.length).toBeGreaterThan(0);
    });

    it("has at least one profile for each cost tier", () => {
      const profiles = ModelCapabilityRegistry.getProfiles();
      const tiers = new Set(profiles.map((p) => p.costTier));
      expect(tiers.has("cheap")).toBe(true);
      expect(tiers.has("balanced")).toBe(true);
    });
  });
});
