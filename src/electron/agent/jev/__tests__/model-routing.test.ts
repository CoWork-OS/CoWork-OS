import { describe, expect, it, vi } from "vitest";
import type { DecisionProvider } from "../../decisions";
import { routeModelWithJev } from "../model-routing";

function provider(answer: unknown): DecisionProvider {
  return {
    decide: vi.fn(async () => ({
      model: "jev-test",
      answers: { route: answer as never },
      usage: { input_tokens: 1, output_tokens: 1 },
    })),
    testConnection: vi.fn(),
    health: vi.fn(),
  } as unknown as DecisionProvider;
}

const base = {
  model: "jev-test",
  prompt: "Implement a small localized change",
  baselineProfile: "cheap" as const,
};

describe("routeModelWithJev", () => {
  it("accepts a high-confidence eligible profile", async () => {
    const result = await routeModelWithJev({
      ...base,
      provider: provider({
        type: "choice",
        choice: "strong",
        confidence: 0.92,
        probabilities: { cheap: 0.05, strong: 0.92, abstain: 0.03 },
      }),
    });

    expect(result).toMatchObject({ status: "selected", route: "strong", reason: "selected" });
  });

  it("abstains on low confidence", async () => {
    const result = await routeModelWithJev({
      ...base,
      provider: provider({
        type: "choice",
        choice: "strong",
        confidence: 0.4,
        probabilities: { cheap: 0.4, strong: 0.4, abstain: 0.2 },
      }),
    });

    expect(result.status).toBe("abstain");
    expect(result.reason).toBe("low_confidence");
  });

  it("does not upgrade an ordinary medium task to the strong profile", async () => {
    const result = await routeModelWithJev({
      ...base,
      complexity: "medium",
      provider: provider({
        type: "choice",
        choice: "strong",
        confidence: 0.92,
        probabilities: { cheap: 0.05, strong: 0.92, abstain: 0.03 },
      }),
    });

    expect(result).toMatchObject({ status: "abstain", reason: "cost_guard" });
  });

  it("does not route explicit model selections", async () => {
    const jev = provider({
      type: "choice",
      choice: "strong",
      confidence: 1,
      probabilities: { strong: 1 },
    });
    const result = await routeModelWithJev({ ...base, provider: jev, explicitModel: true });

    expect(result).toEqual({ status: "skipped", reason: "explicit_model" });
    expect(jev.decide).not.toHaveBeenCalled();
  });

  it("does not call Jev for low-complexity tasks", async () => {
    const jev = provider({
      type: "choice",
      choice: "strong",
      confidence: 1,
      probabilities: { strong: 1 },
    });
    const result = await routeModelWithJev({ ...base, provider: jev, complexity: "low" });

    expect(result).toEqual({ status: "skipped", reason: "low_complexity" });
    expect(jev.decide).not.toHaveBeenCalled();
  });

  it("fails closed when the provider is unavailable", async () => {
    const result = await routeModelWithJev({
      ...base,
      provider: {
        ...provider({}),
        decide: vi.fn(async () => {
          throw new Error("offline");
        }),
      },
    });

    expect(result).toMatchObject({ status: "unavailable", reason: "provider_error" });
  });
});
