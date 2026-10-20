import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { OPENROUTER_FREE_MODEL_ID } from "../../../shared/llm-provider-catalog";
import { resolveOpenRouterSignIn } from "../settings-llm-helpers";

const source = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8").replace(/\s+/g, " ");

describe("OpenRouter sign-in in Settings", () => {
  it("shows the stored key and the model main chose", () => {
    expect(
      resolveOpenRouterSignIn(
        { model: OPENROUTER_FREE_MODEL_ID },
        { openrouter: { apiKey: "sk-or-v1-disposable", model: "openai/gpt-5" } },
      ),
    ).toEqual({ apiKey: "sk-or-v1-disposable", model: OPENROUTER_FREE_MODEL_ID });
  });

  it("falls back to the saved model, then the free router", () => {
    expect(resolveOpenRouterSignIn({}, { openrouter: { model: "openai/gpt-5" } })).toEqual({
      apiKey: "",
      model: "openai/gpt-5",
    });
    expect(resolveOpenRouterSignIn({}, null)).toEqual({
      apiKey: "",
      model: OPENROUTER_FREE_MODEL_ID,
    });
  });

  it("offers the browser sign-in above the API key field", () => {
    const settings = source("../Settings.tsx");
    const signIn = settings.indexOf("<h3>OpenRouter Account</h3>");
    expect(signIn).toBeGreaterThan(-1);
    expect(signIn).toBeLessThan(settings.indexOf("<h3>OpenRouter API Key</h3>"));
    expect(settings).toContain("window.electronAPI.openrouterOAuthStart()");
    expect(settings).toContain('hasHostMethods("openrouterOAuthStart")');
  });
});

describe("onboarding local model offer", () => {
  it("has no separate Ollama-detected step", () => {
    expect(source("../../hooks/useOnboardingFlow.ts")).not.toContain("ollama_detected");
    expect(source("../Onboarding/Onboarding.tsx")).not.toContain("renderOllamaDetection");
  });
});
