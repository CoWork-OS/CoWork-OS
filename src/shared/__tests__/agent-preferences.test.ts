import { describe, it, expect } from "vitest";
import {
  resolveModelPreferenceToModelKey,
  resolvePersonalityPreference,
} from "../agent-preferences";

describe("agent-preferences", () => {
  describe("resolveModelPreferenceToModelKey", () => {
    it("returns undefined for empty/same", () => {
      expect(resolveModelPreferenceToModelKey(undefined)).toBeUndefined();
      expect(resolveModelPreferenceToModelKey(null)).toBeUndefined();
      expect(resolveModelPreferenceToModelKey("")).toBeUndefined();
      expect(resolveModelPreferenceToModelKey("same")).toBeUndefined();
    });

    it("maps cheaper aliases to haiku-4-5", () => {
      expect(resolveModelPreferenceToModelKey("cheaper")).toBe("haiku-4-5");
      expect(resolveModelPreferenceToModelKey("haiku")).toBe("haiku-4-5");
    });

    it("maps sonnet and opus", () => {
      expect(resolveModelPreferenceToModelKey("sonnet")).toBe("sonnet-4-6");
      expect(resolveModelPreferenceToModelKey("opus")).toBe("opus-4-6");
      expect(resolveModelPreferenceToModelKey("smarter")).toBe("opus-4-6");
    });
  });

  describe("resolvePersonalityPreference", () => {
    it("returns undefined for empty/same", () => {
      expect(resolvePersonalityPreference(undefined)).toBeUndefined();
      expect(resolvePersonalityPreference(null)).toBeUndefined();
      expect(resolvePersonalityPreference("")).toBeUndefined();
      expect(resolvePersonalityPreference("same")).toBeUndefined();
    });

    it("accepts known personalities", () => {
      expect(resolvePersonalityPreference("technical")).toBe("technical");
      expect(resolvePersonalityPreference("concise")).toBe("concise");
      expect(resolvePersonalityPreference("professional")).toBe("professional");
    });

    it("returns undefined for unknown personality", () => {
      expect(resolvePersonalityPreference("unknown")).toBeUndefined();
    });
  });
});
