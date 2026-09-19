import { describe, expect, it } from "vitest";
import {
  ModelCapabilityRegistry,
  createUnknownModelCapabilityProfile,
  modelCapabilityKey,
} from "../model-capability-profile";

describe("model capability profiles", () => {
  const key = {
    endpoint: "http://127.0.0.1:1337/v1/",
    modelId: "qwen-local",
    backend: "atomic-chat",
    backendVersion: "unknown",
    template: "unknown",
  };

  it("keeps capability status unknown until evidence is recorded", () => {
    const profile = createUnknownModelCapabilityProfile(key);
    expect(profile.capabilities).toEqual({
      tools: "unknown",
      multiple_tool_calls: "unknown",
      images: "unknown",
      streaming: "unknown",
      reasoning: "unknown",
      structured_output: "unknown",
      context_limit: "unknown",
    });
    expect(profile.evidence).toEqual({});
  });

  it("keys profiles by endpoint, model, backend, version, and template", () => {
    expect(modelCapabilityKey(key)).toBe(
      "http://127.0.0.1:1337/v1|qwen-local|atomic-chat|unknown|unknown",
    );
  });

  it("retains evidence for verified or unsupported capabilities", () => {
    const registry = new ModelCapabilityRegistry();
    const first = registry.record(key, "tools", "verified", {
      source: "fixture_tool_round_trip",
      observedAt: 123,
    });
    expect(first.capabilities.tools).toBe("verified");
    expect(first.evidence.tools).toEqual({
      source: "fixture_tool_round_trip",
      observedAt: 123,
    });

    const second = registry.record(key, "streaming", "unsupported", {
      source: "adapter_non_streaming_contract",
      observedAt: 456,
    });
    expect(second).toBe(first);
    expect(second.capabilities.streaming).toBe("unsupported");
  });
});
