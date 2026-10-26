import { describe, expect, it, vi } from "vitest";
import type { LLMProvider, LLMProviderConfig, LLMRequest } from "../types";
import {
  providerConfigHasSecretReferences,
  resolveProviderConfigSecrets,
  wrapProviderWithSecretReferences,
} from "../secret-reference-provider";

const request = { messages: [] } as unknown as LLMRequest;

function fakeProvider(label: string): LLMProvider {
  return {
    type: "openai",
    createMessage: vi.fn(async () => ({ content: [{ type: "text", text: label }] }) as never),
    testConnection: vi.fn(async () => ({ success: true })),
  };
}

describe("vault references in provider config", () => {
  it("notices a reference in any key field", () => {
    expect(providerConfigHasSecretReferences({ type: "openai", model: "m" })).toBe(false);
    expect(
      providerConfigHasSecretReferences({
        type: "openai",
        model: "m",
        openaiApiKey: "sk-plain",
      }),
    ).toBe(false);
    expect(
      providerConfigHasSecretReferences({
        type: "bedrock",
        model: "m",
        awsSecretAccessKey: "op://AWS/bedrock/secret access key",
      }),
    ).toBe(true);
  });

  it("replaces only reference fields", async () => {
    const resolve = vi.fn(async (value?: string) => `resolved:${value}`);
    const config: LLMProviderConfig = {
      type: "openrouter",
      model: "m",
      openrouterApiKey: "bw://OpenRouter/password",
      openaiApiKey: "sk-plain",
    };
    await expect(resolveProviderConfigSecrets(config, resolve)).resolves.toMatchObject({
      openrouterApiKey: "resolved:bw://OpenRouter/password",
      openaiApiKey: "sk-plain",
    });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(config.openrouterApiKey).toBe("bw://OpenRouter/password");
  });

  it("builds the real provider with the resolved key and reuses it", async () => {
    const built: LLMProviderConfig[] = [];
    const wrapped = wrapProviderWithSecretReferences(
      { type: "openai", model: "m", openaiApiKey: "op://Private/OpenAI/credential" },
      (resolved) => {
        built.push(resolved);
        return fakeProvider("real");
      },
      async () => "sk-from-vault",
    );

    expect(wrapped.type).toBe("openai");
    await wrapped.createMessage(request);
    await wrapped.createMessage(request);
    expect(built).toHaveLength(1);
    expect(built[0].openaiApiKey).toBe("sk-from-vault");
  });

  it("rebuilds the provider when the vault value changes", async () => {
    let value = "sk-first";
    const build = vi.fn(() => fakeProvider("real"));
    const wrapped = wrapProviderWithSecretReferences(
      { type: "openai", model: "m", openaiApiKey: "op://Private/OpenAI/credential" },
      build,
      async () => value,
    );
    await wrapped.createMessage(request);
    value = "sk-rotated";
    await wrapped.createMessage(request);
    expect(build).toHaveBeenCalledTimes(2);
  });

  it("fails the request, and the connection test, with the vault's explanation", async () => {
    const build = vi.fn(() => fakeProvider("real"));
    const wrapped = wrapProviderWithSecretReferences(
      { type: "openai", model: "m", openaiApiKey: "bw://OpenAI/password" },
      build,
      async () => {
        throw new Error("Bitwarden could not read bw://OpenAI/password: the vault is locked.");
      },
    );
    await expect(wrapped.createMessage(request)).rejects.toThrow("the vault is locked");
    await expect(wrapped.testConnection()).resolves.toEqual({
      success: false,
      error: "Bitwarden could not read bw://OpenAI/password: the vault is locked.",
    });
    expect(build).not.toHaveBeenCalled();
  });
});
