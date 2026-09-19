import { afterEach, describe, expect, it } from "vitest";
import { resolveOutputTokenBudget } from "../output-token-policy";

const envSnapshot = { ...process.env };

afterEach(() => {
  process.env = { ...envSnapshot };
});

describe("local-balanced-v1 output policy integration", () => {
  it("uses bounded local budgets and emits the profile trace", () => {
    process.env.COWORK_LOCAL_MODEL_PROFILE = "local-balanced-v1";
    const budget = resolveOutputTokenBudget({
      providerType: "atomic-chat",
      modelId: "qwen-local",
      messages: [{ role: "user", content: "hello" }],
      system: "system",
      contextManager: { estimateMaxOutputTokens: () => 100_000 } as Any,
      requestKind: "agentic_main",
      phase: "initial",
      tools: [
        {
          name: "read_file",
          description: "Read a file",
          input_schema: { type: "object", properties: {} },
        },
      ],
      evidenceTokens: 128,
      attachmentTokens: 64,
      memoryTokens: 256,
    });

    expect(budget.policyDefault).toBe(1_536);
    expect(budget.transport.value).toBe(1_536);
    expect(budget.localProfileId).toBe("local-balanced-v1");
    expect(budget.localProfileVersion).toBe(1);
    expect(budget.localProfileTrace?.traceKey).toBe("local-balanced-v1:1:atomic-chat:qwen-local");
    expect(budget.localRequestBudget?.components).toMatchObject({
      evidenceTokens: 128,
      attachmentTokens: 64,
      memoryTokens: 256,
    });
    expect(budget.localRequestBudget?.totalReservedTokens).toBeGreaterThan(
      budget.localRequestBudget?.inputTokens || 0,
    );
  });
});
