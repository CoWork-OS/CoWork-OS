import { describe, expect, it, vi } from "vitest";
import type { DecisionProvider } from "../../decisions";
import { decideTaskStrategyWithJev } from "../task-strategy-decision";

function provider(answers: Record<string, unknown>): DecisionProvider {
  return {
    decide: vi.fn(async () => ({
      model: "jev-test",
      answers: answers as never,
      usage: { input_tokens: 1, output_tokens: 1 },
    })),
    testConnection: vi.fn(),
    health: vi.fn(),
  } as unknown as DecisionProvider;
}

const highConfidence = {
  strategy: {
    type: "choice",
    choice: "team",
    confidence: 0.9,
    probabilities: { team: 0.9 },
  },
  profile: {
    type: "choice",
    choice: "strong",
    confidence: 0.9,
    probabilities: { strong: 0.9 },
  },
};

describe("decideTaskStrategyWithJev", () => {
  it("selects a bounded team strategy and profile", async () => {
    const result = await decideTaskStrategyWithJev({
      provider: provider(highConfidence),
      model: "jev-test",
      prompt: "Investigate and implement a large change",
      complexity: "high",
      baselineProfile: "cheap",
    });

    expect(result).toMatchObject({ status: "selected", strategy: "team", profile: "strong" });
  });

  it("preserves explicit hard constraints without calling Jev", async () => {
    const p = provider(highConfidence);
    const result = await decideTaskStrategyWithJev({
      provider: p,
      model: "jev-test",
      prompt: "Do this",
      complexity: "high",
      baselineProfile: "cheap",
      explicitMultitask: true,
    });

    expect(result).toMatchObject({ status: "skipped", strategy: "multitask" });
    expect(p.decide).not.toHaveBeenCalled();
  });

  it("keeps low-complexity work on one agent", async () => {
    const p = provider(highConfidence);
    const result = await decideTaskStrategyWithJev({
      provider: p,
      model: "jev-test",
      prompt: "Rename one variable",
      complexity: "low",
      baselineProfile: "cheap",
    });

    expect(result).toMatchObject({ status: "skipped", strategy: "single_agent" });
    expect(p.decide).not.toHaveBeenCalled();
  });

  it("does not expand an ordinary medium task into a more expensive strategy", async () => {
    const result = await decideTaskStrategyWithJev({
      provider: provider(highConfidence),
      model: "jev-test",
      prompt: "Create the requested files in the workspace",
      complexity: "medium",
      baselineProfile: "cheap",
    });

    expect(result).toMatchObject({ status: "abstain", strategy: "abstain", reason: "cost_guard" });
  });

  it("allows an explicit parallel-work signal when Jev is highly confident", async () => {
    const result = await decideTaskStrategyWithJev({
      provider: provider(highConfidence),
      model: "jev-test",
      prompt: "Investigate the issue and compare independent implementation options in parallel",
      complexity: "medium",
      baselineProfile: "cheap",
    });

    expect(result).toMatchObject({ status: "selected", strategy: "team", profile: "strong" });
  });

  it("abstains on malformed provider output", async () => {
    const result = await decideTaskStrategyWithJev({
      provider: provider({ strategy: { type: "choice", choice: "invented" }, profile: {} }),
      model: "jev-test",
      prompt: "Investigate this",
      complexity: "high",
      baselineProfile: "cheap",
    });

    expect(result).toMatchObject({ status: "abstain", strategy: "abstain" });
  });
});
