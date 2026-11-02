import { describe, expect, it } from "vitest";
import { BUILTIN_ACCESS_PROFILE_IDS } from "../../../shared/access-profiles";
import { getInteractionModeSelection } from "../../../shared/interaction-mode";
import { OPENROUTER_FREE_MODEL_ID } from "../../../shared/llm-provider-catalog";
import {
  ONBOARDING_FIRST_TASK_OPTIONS,
  ONBOARDING_FIRST_TASK_PROMPT,
} from "../../../shared/onboarding";
import { LM_STUDIO_BASE_URL, pickLmStudioChatModel } from "../../../shared/onboarding";
import { getOnboardingDefaultModel, ONBOARDING_ACCOUNT_ROUTES } from "../useOnboardingFlow";

describe("onboarding defaults", () => {
  it("runs the first task as Do on Ask for approval", () => {
    expect(ONBOARDING_FIRST_TASK_OPTIONS.accessProfileId).toBe(
      BUILTIN_ACCESS_PROFILE_IDS.askForApproval,
    );
    expect(getInteractionModeSelection(ONBOARDING_FIRST_TASK_OPTIONS.agentConfig)).toEqual({
      mode: "smart",
    });
  });

  it("seeds a concrete first task that saves a file in the workspace", () => {
    expect(ONBOARDING_FIRST_TASK_PROMPT).toMatch(/^Create a small spreadsheet/);
    expect(ONBOARDING_FIRST_TASK_PROMPT).toContain("Save it in this workspace.");
  });

  it("starts OpenRouter on the free-models router", () => {
    expect(getOnboardingDefaultModel("openrouter")).toBe(OPENROUTER_FREE_MODEL_ID);
  });

  it("maps each no-key sign-in to the provider it configures", () => {
    expect(ONBOARDING_ACCOUNT_ROUTES).toEqual({
      openrouter: { label: "OpenRouter", provider: "openrouter" },
      chatgpt: { label: "ChatGPT", provider: "openai" },
      grok: { label: "Grok", provider: "xai-oauth" },
    });
  });

  it("offers the first LM Studio chat model and skips embedding-only models", () => {
    expect(LM_STUDIO_BASE_URL).toBe("http://127.0.0.1:1234/v1");
    expect(
      pickLmStudioChatModel([{ key: "text-embedding-nomic-embed-text-v1.5" }, { key: "qwen3-8b" }]),
    ).toBe("qwen3-8b");
    expect(pickLmStudioChatModel([{ key: "text-embedding-nomic-embed-text-v1.5" }])).toBeNull();
    expect(pickLmStudioChatModel([])).toBeNull();
  });
});
