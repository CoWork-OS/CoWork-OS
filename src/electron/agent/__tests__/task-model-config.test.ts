import { describe, expect, it } from "vitest";
import { effectiveTaskModelConfig, effectiveTaskModelConfigFor } from "../task-model-config";

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

  it("ignores a bot model that names no provider, and an empty one", () => {
    // A bare key would be forced onto whichever provider is current after a global switch.
    expect(effectiveTaskModelConfig(undefined, { modelKey: "fake-beta" })).toBeUndefined();
    const config = { botConversation: true };
    expect(effectiveTaskModelConfig(config, { modelKey: "  " })).toBe(config);
    expect(effectiveTaskModelConfig(config, null)).toBe(config);
  });

  it("looks the bot up for a task, for callers outside the executor", async () => {
    const lookup = async (id: string) =>
      id === "role-1" ? { modelKey: "opus-4-5", providerType: "anthropic" as const } : null;
    expect(
      await effectiveTaskModelConfigFor(
        { agentConfig: { botConversation: true }, assignedAgentRoleId: "role-1" },
        lookup,
      ),
    ).toMatchObject({ providerType: "anthropic", modelKey: "opus-4-5", modelPinned: true });
    expect(await effectiveTaskModelConfigFor({ agentConfig: undefined }, lookup)).toBeUndefined();
    expect(
      await effectiveTaskModelConfigFor({ assignedAgentRoleId: "role-1" }, () => {
        throw new Error("db down");
      }),
    ).toBeUndefined();
  });
});
