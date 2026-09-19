import { describe, expect, it, vi } from "vitest";
import type { DecisionProvider } from "../../decisions";
import {
  compactContextWithJev,
  buildJevContextCompactionRequest,
} from "../context-compaction-decision";

function provider(answerFor: (key: string) => number): DecisionProvider {
  return {
    decide: vi.fn(async (request) => ({
      model: "jev-test",
      answers: Object.fromEntries(
        Object.keys(request.questions).map((key) => [key, { type: "noul", noul: answerFor(key) }]),
      ),
      usage: { input_tokens: 1, output_tokens: 1 },
    })),
    testConnection: vi.fn(),
    health: vi.fn(),
  } as unknown as DecisionProvider;
}

function messages() {
  return [
    { role: "user" as const, content: "Original request" },
    ...Array.from({ length: 5 }, (_, index) => ({
      role: index % 2 ? ("assistant" as const) : ("user" as const),
      content: `Historical context ${index}`,
    })),
    ...Array.from({ length: 8 }, (_, index) => ({
      role: index % 2 ? ("assistant" as const) : ("user" as const),
      content: `Recent context ${index}`,
    })),
  ];
}

describe("compactContextWithJev", () => {
  it("builds bounded retention questions and drops only discretionary history", async () => {
    const input = {
      provider: provider(() => 0),
      model: "jev-test",
      messages: messages(),
      availableTokens: 20,
      targetTokens: 10,
      taskPrompt: "Do the task",
    };
    const request = buildJevContextCompactionRequest(input);

    expect(request.candidates.length).toBeGreaterThan(0);
    expect(request.candidates.length).toBeLessThanOrEqual(12);
    expect(Object.keys(request.request.questions)).toHaveLength(request.candidates.length);
    expect(request.request.state).toMatchObject({
      schema: "cowork.jev.context-compaction.v1",
      trusted: { candidateCount: request.candidates.length },
    });

    const result = await compactContextWithJev(input);

    expect(result.status).toBe("applied");
    expect(result.droppedIndices.length).toBeGreaterThan(0);
    expect(result.messages[0]).toEqual(messages()[0]);
    expect(result.messages.length).toBeLessThan(messages().length);
  });

  it("preserves the original transcript when Jev abstains", async () => {
    const original = messages();
    const result = await compactContextWithJev({
      provider: provider(() => 1),
      model: "jev-test",
      messages: original,
      availableTokens: 20,
      targetTokens: 10,
    });

    expect(result).toMatchObject({
      status: "abstain",
      reason: "no_discretionary_drop",
      droppedIndices: [],
    });
    expect(result.messages).toBe(original);
  });

  it("fails closed on provider errors", async () => {
    const result = await compactContextWithJev({
      provider: {
        ...provider(() => 0),
        decide: vi.fn(async () => {
          throw new Error("offline");
        }),
      },
      model: "jev-test",
      messages: messages(),
      availableTokens: 20,
      targetTokens: 10,
    });

    expect(result).toMatchObject({ status: "unavailable", reason: "provider_error" });
    expect(result.messages).toHaveLength(messages().length);
  });
});
