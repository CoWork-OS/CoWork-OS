import { describe, expect, it } from "vitest";
import { effectiveTaskModelConfig } from "../task-model-config";

describe("effectiveTaskModelConfig", () => {
  it("keeps the conversation's own pick over the bot's model", () => {
    const config = { providerType: "openai" as const, modelKey: "gpt-4o", modelPinned: true };
    expect(
      effectiveTaskModelConfig(config, { modelKey: "opus-4-5", providerType: "anthropic" }),
    ).toBe(config);
  });

  it("applies the bot's model as an unsaved pin, without touching the stored config", () => {
    const config = { botConversation: true, modelKey: "stale-copy" };
    expect(
      effectiveTaskModelConfig(config, { modelKey: " opus-4-5 ", providerType: "anthropic" }),
    ).toEqual({
      botConversation: true,
      providerType: "anthropic",
      modelKey: "opus-4-5",
      modelPinned: true,
    });
    expect(config).toEqual({ botConversation: true, modelKey: "stale-copy" });
  });

  it("leaves the provider open when the bot names only a model, and ignores an empty one", () => {
    expect(effectiveTaskModelConfig(undefined, { modelKey: "fake-beta" })).toEqual({
      providerType: undefined,
      modelKey: "fake-beta",
      modelPinned: true,
    });
    const config = { botConversation: true };
    expect(effectiveTaskModelConfig(config, { modelKey: "  " })).toBe(config);
    expect(effectiveTaskModelConfig(config, null)).toBe(config);
  });
});
