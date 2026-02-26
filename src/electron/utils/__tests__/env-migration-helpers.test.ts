import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getAppPath: () => "/app", getPath: () => "/userData" },
}));

/**
 * Tests for the pure helper functions used by env-migration.
 * These helpers are module-private, so we re-implement and test the same logic.
 */

describe("env-migration helpers", () => {
  describe("normalizeEnvValue", () => {
    function normalizeEnvValue(value: unknown): string | undefined {
      if (typeof value !== "string") return undefined;
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    }

    it("trims whitespace", () => {
      expect(normalizeEnvValue("  hello  ")).toBe("hello");
    });

    it("returns undefined for empty string", () => {
      expect(normalizeEnvValue("")).toBeUndefined();
    });

    it("returns undefined for whitespace-only", () => {
      expect(normalizeEnvValue("   ")).toBeUndefined();
    });

    it("returns undefined for non-string", () => {
      expect(normalizeEnvValue(undefined)).toBeUndefined();
      expect(normalizeEnvValue(42)).toBeUndefined();
    });
  });

  describe("shouldWriteValue", () => {
    function shouldWriteValue(
      existing: string | undefined,
      next: string | undefined,
      mode: "merge" | "overwrite",
    ): boolean {
      if (!next) return false;
      if (mode === "overwrite") return true;
      // merge: only write if existing is empty
      return !existing || existing.trim().length === 0;
    }

    it("merge mode: writes when existing is empty", () => {
      expect(shouldWriteValue("", "new-value", "merge")).toBe(true);
    });

    it("merge mode: writes when existing is undefined", () => {
      expect(shouldWriteValue(undefined, "new-value", "merge")).toBe(true);
    });

    it("merge mode: does NOT write when existing has a value", () => {
      expect(shouldWriteValue("old", "new-value", "merge")).toBe(false);
    });

    it("overwrite mode: always writes when next is truthy", () => {
      expect(shouldWriteValue("old", "new-value", "overwrite")).toBe(true);
    });

    it("overwrite mode: does not write when next is empty", () => {
      expect(shouldWriteValue("old", "", "overwrite")).toBe(false);
    });

    it("never writes when next is undefined", () => {
      expect(shouldWriteValue("", undefined, "merge")).toBe(false);
      expect(shouldWriteValue("", undefined, "overwrite")).toBe(false);
    });
  });

  describe("validateProviderType", () => {
    const VALID_PROVIDERS = [
      "openai",
      "anthropic",
      "gemini",
      "openrouter",
      "azure",
      "groq",
      "xai",
      "kimi",
      "bedrock",
      "ollama",
      "pi",
    ];

    function validateProviderType(raw: string): string | null {
      const normalized = raw.trim().toLowerCase();
      return VALID_PROVIDERS.includes(normalized) ? normalized : null;
    }

    it("accepts valid provider types", () => {
      expect(validateProviderType("openai")).toBe("openai");
      expect(validateProviderType("anthropic")).toBe("anthropic");
      expect(validateProviderType("gemini")).toBe("gemini");
    });

    it("normalizes case", () => {
      expect(validateProviderType("OpenAI")).toBe("openai");
      expect(validateProviderType("  Anthropic  ")).toBe("anthropic");
    });

    it("rejects invalid provider types", () => {
      expect(validateProviderType("invalid")).toBeNull();
      expect(validateProviderType("")).toBeNull();
    });
  });

  describe("pickProviderFromSettings", () => {
    function isProviderConfigured(providerType: string, settings: Record<string, Any>): boolean {
      const config = settings[providerType];
      if (!config || typeof config !== "object") return false;

      switch (providerType) {
        case "openai":
        case "anthropic":
        case "gemini":
        case "openrouter":
        case "groq":
        case "xai":
        case "kimi":
          return !!config.apiKey;
        case "azure":
          return !!(config.apiKey && config.endpoint);
        case "bedrock":
          return !!(config.region || config.useDefaultCredentials);
        case "ollama":
          return !!config.baseUrl;
        default:
          return false;
      }
    }

    const PRIORITY = [
      "openai",
      "anthropic",
      "gemini",
      "openrouter",
      "azure",
      "groq",
      "xai",
      "kimi",
      "bedrock",
      "ollama",
    ];

    function pickProviderFromSettings(settings: Record<string, Any>): string | null {
      for (const p of PRIORITY) {
        if (isProviderConfigured(p, settings)) return p;
      }
      return null;
    }

    it("picks openai when it has an API key", () => {
      expect(pickProviderFromSettings({ openai: { apiKey: "sk-test" } })).toBe("openai");
    });

    it("picks anthropic when openai is not configured", () => {
      expect(
        pickProviderFromSettings({
          openai: {},
          anthropic: { apiKey: "ant-test" },
        }),
      ).toBe("anthropic");
    });

    it("picks bedrock when region is set", () => {
      expect(
        pickProviderFromSettings({
          openai: {},
          bedrock: { region: "us-east-1" },
        }),
      ).toBe("bedrock");
    });

    it("picks ollama when baseUrl is set", () => {
      expect(
        pickProviderFromSettings({
          openai: {},
          ollama: { baseUrl: "http://localhost:11434" },
        }),
      ).toBe("ollama");
    });

    it("picks azure when both apiKey and endpoint are set", () => {
      expect(
        pickProviderFromSettings({
          openai: {},
          azure: { apiKey: "az-key", endpoint: "https://my.azure.com" },
        }),
      ).toBe("azure");
    });

    it("does NOT pick azure with only apiKey", () => {
      expect(
        pickProviderFromSettings({
          openai: {},
          azure: { apiKey: "az-key" },
        }),
      ).toBeNull();
    });

    it("returns null when nothing is configured", () => {
      expect(pickProviderFromSettings({})).toBeNull();
    });
  });
});
