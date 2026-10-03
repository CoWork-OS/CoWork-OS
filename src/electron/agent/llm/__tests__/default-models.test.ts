/**
 * Built-in defaults pointed at models that providers have retired or
 * superseded: OpenRouter at anthropic/claude-3.5-sonnet, Gemini and Google
 * Vertex at gemini-2.0-flash, and the "smarter" sub-agent preference at
 * Opus 4.5. Each default must be a model the app's own catalogue lists.
 */
import { describe, expect, it } from "vitest";
import { resolveModelMetadata } from "../../../../shared/model-metadata";
import { CUSTOM_PROVIDER_MAP } from "../../../../shared/llm-provider-catalog";
import { resolveModelPreferenceToModelKey } from "../../../../shared/agent-preferences";
import { OPENROUTER_DEFAULT_MODEL } from "../openrouter-provider";
import { GeminiProvider } from "../gemini-provider";
import { LLMProviderFactory } from "../provider-factory";
import { GEMINI_MODELS, MODELS, OPENROUTER_MODELS } from "../types";

describe("built-in default models", () => {
  it("defaults OpenRouter to a current Sonnet listed in the catalogue", () => {
    expect(OPENROUTER_DEFAULT_MODEL).toBe("anthropic/claude-sonnet-4.6");
    expect(resolveModelMetadata(OPENROUTER_DEFAULT_MODEL)).not.toBeNull();
    expect(Object.keys(OPENROUTER_MODELS)).toContain(OPENROUTER_DEFAULT_MODEL);
    expect(Object.keys(OPENROUTER_MODELS)).not.toContain("anthropic/claude-3.5-sonnet");
  });

  it("defaults Gemini and Google Vertex to gemini-2.5-flash", () => {
    expect(LLMProviderFactory.getModelId("sonnet-4-6", "gemini")).toBe("gemini-2.5-flash");
    const provider = new GeminiProvider({ type: "gemini", geminiApiKey: "test-key" });
    expect((provider as Any).defaultModel).toBe("gemini-2.5-flash");
    expect(CUSTOM_PROVIDER_MAP.get("google-vertex")?.defaultModel).toBe("gemini-2.5-flash");
    expect(resolveModelMetadata("gemini-2.5-flash")).not.toBeNull();
    expect(Object.values(GEMINI_MODELS).map((model) => model.id)).toContain("gemini-2.5-flash");
  });

  it('maps "smarter" to the newest Opus in the Anthropic model map', () => {
    expect(resolveModelPreferenceToModelKey("smarter")).toBe("opus-4-6");
    expect(resolveModelPreferenceToModelKey("opus")).toBe("opus-4-6");
    expect(Object.keys(MODELS)).toContain("opus-4-6");
  });
});
