import { describe, expect, it } from "vitest";

import {
  buildClaudeCredentialInput,
  resolveClaudeAuthMethod,
  selectClaudeModelKey,
} from "../settings-llm-helpers";

describe("settings-llm-helpers", () => {
  it("derives Claude subscription credentials from saved settings", () => {
    const credentials = buildClaudeCredentialInput({
      apiKey: "sk-ant-api-key",
      subscriptionToken: "sk-ant-oat01-subscription-token",
    });

    expect(credentials).toEqual({
      apiKey: "sk-ant-api-key",
      subscriptionToken: "sk-ant-oat01-subscription-token",
      authMethod: "subscription",
    });
  });

  it("keeps the persisted Claude model when the refreshed list still includes it", () => {
    expect(
      selectClaudeModelKey(
        [
          { key: "sonnet-4-6" },
          { key: "opus-4-6" },
        ],
        "opus-4-6",
      ),
    ).toBe("opus-4-6");
  });

  it("falls back to API-key auth when no subscription token is present", () => {
    expect(
      resolveClaudeAuthMethod({
        apiKey: "sk-ant-api-key",
      }),
    ).toBe("api_key");
  });
});
