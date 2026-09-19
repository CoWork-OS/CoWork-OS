import { describe, expect, it, vi } from "vitest";
import type { DecisionProvider } from "../../decisions";
import { decideLoopActionWithJev } from "../loop-decision";

function provider(answer: unknown): DecisionProvider {
  return {
    decide: vi.fn(async () => ({
      model: "jev-test",
      answers: { decision: answer as never },
      usage: { input_tokens: 1, output_tokens: 1 },
    })),
    testConnection: vi.fn(),
    health: vi.fn(),
  } as unknown as DecisionProvider;
}

const base = {
  provider: provider({
    type: "choice",
    choice: "continue",
    confidence: 0.9,
    probabilities: { continue: 0.9 },
  }),
  model: "jev-test",
  progressScore: 0.7,
  loopRiskIndex: 0.1,
  repeatedFingerprintCount: 0,
  noProgressStreak: 0,
  pendingSteps: 2,
};

describe("decideLoopActionWithJev", () => {
  it("selects continue for meaningful progress", async () => {
    await expect(decideLoopActionWithJev(base)).resolves.toMatchObject({
      status: "selected",
      action: "continue",
    });
  });

  it("returns a deterministic stop without a provider call for hard evidence", async () => {
    const p = provider({});
    const result = await decideLoopActionWithJev({ ...base, provider: p, hardStopReason: "cap" });

    expect(result).toMatchObject({ status: "selected", action: "stop", reason: "hard_stop" });
    expect(p.decide).not.toHaveBeenCalled();
  });

  it("abstains on malformed answers", async () => {
    const result = await decideLoopActionWithJev({
      ...base,
      provider: provider({ type: "choice", choice: "invented", confidence: 1, probabilities: {} }),
    });

    expect(result).toMatchObject({
      status: "abstain",
      action: "abstain",
      reason: "invalid_answer",
    });
  });

  it("fails closed when Jev is unavailable", async () => {
    const p = provider({});
    p.decide = vi.fn(async () => {
      throw new Error("offline");
    });
    const result = await decideLoopActionWithJev({ ...base, provider: p });

    expect(result).toMatchObject({
      status: "unavailable",
      action: "abstain",
      reason: "provider_error",
    });
  });
});
