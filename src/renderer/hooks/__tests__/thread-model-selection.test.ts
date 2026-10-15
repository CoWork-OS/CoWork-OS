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
    ).toEqual({ modelKey: "opus-4-5", providerType: "anthropic", pinned: true });
  });

  it("follows the global model when the conversation has no pin", () => {
    expect(
      resolveThreadModelSelection(
        { agentConfig: { providerType: "anthropic", modelKey: "opus-4-5" } },
        "gpt-4o",
        "openai",
      ),
    ).toEqual({ modelKey: "gpt-4o", providerType: "openai", pinned: false });
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
});
