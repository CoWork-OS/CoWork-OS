import { afterEach, describe, expect, it } from "vitest";
import {
  LOCAL_BALANCED_PROFILE,
  LOCAL_MODEL_EXECUTION_PROFILE_ID,
  estimateLocalRequestTokenBudget,
  isLocalInferenceProvider,
  resolveLocalModelExecutionProfile,
  selectLocalToolSet,
} from "../local-model-execution-profile";

afterEach(() => {
  delete process.env.COWORK_LOCAL_MODEL_PROFILE;
});

describe("local-model-execution-profile", () => {
  it("is disabled by default and only accepts the exact versioned opt-in", () => {
    expect(
      resolveLocalModelExecutionProfile({ providerType: "ollama", modelId: "llama3.2" }).profile,
    ).toBeNull();
    expect(
      resolveLocalModelExecutionProfile({
        providerType: "ollama",
        modelId: "llama3.2",
        requestedProfile: "local-balanced-v2",
      }).profile,
    ).toBeNull();
  });

  it("resolves a stable trace for supported local backends", () => {
    const result = resolveLocalModelExecutionProfile({
      providerType: "atomic-chat",
      modelId: "qwen-local",
      requestedProfile: LOCAL_MODEL_EXECUTION_PROFILE_ID,
      now: 123,
    });

    expect(result.profile).toBe(LOCAL_BALANCED_PROFILE);
    expect(result.trace).toMatchObject({
      id: LOCAL_MODEL_EXECUTION_PROFILE_ID,
      version: 1,
      providerType: "atomic-chat",
      modelId: "qwen-local",
      resolvedAt: 123,
      traceKey: "local-balanced-v1:1:atomic-chat:qwen-local",
    });
  });

  it("recognizes loopback generic endpoints but not remote compatible gateways", () => {
    expect(isLocalInferenceProvider("openai-compatible", "http://127.0.0.1:1234/v1")).toBe(true);
    expect(isLocalInferenceProvider("openai-compatible", "https://example.test/v1")).toBe(false);
    expect(isLocalInferenceProvider("mlx")).toBe(true);
  });

  it("accounts for system, tools, history, evidence, attachments, output, and safety", () => {
    const budget = estimateLocalRequestTokenBudget({
      systemText: "system instructions",
      tools: [
        {
          name: "read_file",
          description: "Read a file",
          input_schema: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
      history: [{ role: "user", content: "hello" }],
      evidenceTokens: 100,
      attachmentTokens: 50,
      memoryTokens: 20,
      outputTokens: 200,
      safetyMarginTokens: 30,
    });

    expect(budget.inputTokens).toBeGreaterThan(0);
    expect(budget.totalReservedTokens).toBe(budget.inputTokens + 200 + 30);
    expect(budget.components).toMatchObject({
      evidenceTokens: 100,
      attachmentTokens: 50,
      memoryTokens: 20,
    });
  });

  it("selects deterministically from an already permission-filtered tool set", () => {
    const tools = ["write_file", "read_file", "search_web"].map((name) => ({
      name,
      description: name,
      input_schema: { type: "object", properties: {} },
    }));
    const result = selectLocalToolSet({
      visibleTools: tools,
      phase: "plan",
      taskDomain: "code",
      requiredToolNames: ["write_file"],
      maxTools: 2,
    });

    expect(result.tools.map((tool) => tool.name)).toEqual(["write_file", "read_file"]);
    expect(result.droppedToolNames).toEqual(["search_web"]);
    expect(result.toolSetVersion).toMatch(/^[a-f0-9]{16}$/);
  });
});
