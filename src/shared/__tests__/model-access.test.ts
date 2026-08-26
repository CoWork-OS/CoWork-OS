import { describe, expect, it } from "vitest";
import {
  getModelAccessDescriptor,
  groupProvidersByModelAccess,
  MODEL_ACCESS_GROUP_LABELS,
} from "../model-access";

describe("model access taxonomy", () => {
  it("distinguishes account, gateway, local, and orchestration routes", () => {
    expect(getModelAccessDescriptor("openai").kind).toBe("mixed");
    expect(getModelAccessDescriptor("vercel-ai-gateway").group).toBe("gateways");
    expect(getModelAccessDescriptor("ollama").group).toBe("local");
    expect(getModelAccessDescriptor("moa").group).toBe("orchestration");
  });

  it("marks provider routes with unresolved authorization as experimental", () => {
    expect(getModelAccessDescriptor("xai-oauth").releaseStatus).toBe("experimental");
    expect(getModelAccessDescriptor("github-copilot").releaseStatus).toBe("experimental");
  });

  it("groups providers without dropping entries", () => {
    const providers = [
      { type: "openai" as const },
      { type: "openrouter" as const },
      { type: "openai-compatible" as const },
      { type: "ollama" as const },
    ];

    const grouped = groupProvidersByModelAccess(providers);

    expect(Object.values(grouped).flat()).toHaveLength(providers.length);
    expect(grouped.accounts[0]?.type).toBe("openai");
    expect(grouped.apis[0]?.type).toBe("openrouter");
    expect(grouped.gateways[0]?.type).toBe("openai-compatible");
    expect(MODEL_ACCESS_GROUP_LABELS.local).toBe("Local models");
  });
});
