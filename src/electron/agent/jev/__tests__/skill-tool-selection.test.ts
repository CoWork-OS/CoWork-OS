import { describe, expect, it, vi } from "vitest";
import type { DecisionProvider } from "../../decisions";
import {
  buildJevSkillToolSelectionRequest,
  rerankEligibleSkillToolsWithJev,
} from "../skill-tool-selection";

const candidates = [
  { id: "research", label: "Research", kind: "skill" as const, baselineScore: 0.7 },
  { id: "writer", label: "Writer", kind: "skill" as const, baselineScore: 0.5 },
];

function provider(scores: number[]): DecisionProvider {
  return {
    decide: vi.fn(async (request) => ({
      model: "jev-test",
      answers: Object.fromEntries(
        Object.keys(request.questions).map((key, index) => [
          key,
          {
            type: "score",
            score: scores[index] ?? 0,
            confidence: 0.9,
            probabilities: { high: 0.9 },
          },
        ]),
      ),
      usage: { input_tokens: 1, output_tokens: 1 },
    })),
    testConnection: vi.fn(),
    health: vi.fn(),
  } as unknown as DecisionProvider;
}

describe("rerankEligibleSkillToolsWithJev", () => {
  it("renders only bounded candidate metadata", () => {
    const { request } = buildJevSkillToolSelectionRequest({
      model: "jev-test",
      query: "write a report",
      candidates,
    });

    expect(request.state).toMatchObject({
      schema: "cowork.jev.skill-tool-selection.v1",
      trusted: { eligibleOnly: true },
    });
    expect(Object.keys(request.questions)).toEqual(["relevance_c0", "relevance_c1"]);
    expect(JSON.stringify(request.state)).not.toContain("prompt");
  });

  it("reranks eligible candidates while preserving explicit requests", async () => {
    const result = await rerankEligibleSkillToolsWithJev({
      provider: provider([0.2, 0.95]),
      model: "jev-test",
      query: "write a report",
      candidates,
      explicitCandidateIds: ["research"],
    });

    expect(result).toMatchObject({ status: "selected", orderedIds: ["research", "writer"] });
    expect(result.scores).toEqual({ research: 0.2, writer: 0.95 });
  });

  it("does not change the eligible set when Jev is unavailable", async () => {
    const result = await rerankEligibleSkillToolsWithJev({
      provider: {
        ...provider([0, 0]),
        decide: vi.fn(async () => {
          throw new Error("offline");
        }),
      },
      model: "jev-test",
      query: "write a report",
      candidates,
    });

    expect(result).toMatchObject({
      status: "unavailable",
      orderedIds: ["research", "writer"],
      reason: "provider_error",
    });
  });
});
