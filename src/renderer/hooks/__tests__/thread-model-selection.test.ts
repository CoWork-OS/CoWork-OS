import { describe, expect, it } from "vitest";
import { resolveThreadModelSelection } from "../useThreadModelSelection";

describe("resolveThreadModelSelection", () => {
  it("uses the conversation's pinned model", () => {
    expect(
      resolveThreadModelSelection(
        { agentConfig: { providerType: "anthropic", modelKey: "opus-4-5", modelPinned: true } },
        "gpt-4o",
        "openai",
      ),
    ).toEqual({ modelKey: "opus-4-5", providerType: "anthropic", pinned: true, source: "thread" });
  });

  it("follows the global model when the conversation has no pin", () => {
    expect(
      resolveThreadModelSelection(
        { agentConfig: { providerType: "anthropic", modelKey: "opus-4-5" } },
        "gpt-4o",
        "openai",
      ),
    ).toEqual({ modelKey: "gpt-4o", providerType: "openai", pinned: false, source: "global" });
    expect(resolveThreadModelSelection(undefined, "gpt-4o", "openai").pinned).toBe(false);
  });

  it("ignores an incomplete pin", () => {
    expect(
      resolveThreadModelSelection(
        { agentConfig: { modelKey: "  ", providerType: "anthropic", modelPinned: true } },
        "gpt-4o",
        "openai",
      ).pinned,
    ).toBe(false);
  });

  it("shows the bot's model when the conversation has no pick of its own", () => {
    expect(
      resolveThreadModelSelection({ agentConfig: { botConversation: true } }, "gpt-4o", "openai", {
        modelKey: "opus-4-5",
        providerType: "anthropic",
      }),
    ).toEqual({ modelKey: "opus-4-5", providerType: "anthropic", pinned: false, source: "bot" });
    // A bot model without a provider is ignored, as the executor ignores it.
    expect(
      resolveThreadModelSelection(undefined, "gpt-4o", "openai", { modelKey: "gpt-4o-mini" }),
    ).toMatchObject({ modelKey: "gpt-4o", providerType: "openai", source: "global" });
    expect(
      resolveThreadModelSelection(
        { agentConfig: { providerType: "openai", modelKey: "gpt-4o-mini", modelPinned: true } },
        "gpt-4o",
        "openai",
        { modelKey: "opus-4-5", providerType: "anthropic" },
      ),
    ).toMatchObject({ modelKey: "gpt-4o-mini", source: "thread", pinned: true });
  });
});
