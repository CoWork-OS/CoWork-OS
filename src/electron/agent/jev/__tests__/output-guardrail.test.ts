import { describe, expect, it, vi } from "vitest";
import type { DecisionProvider } from "../../decisions";
import { buildJevOutputGuardrailRequest, reviewOutputWithJev } from "../output-guardrail";

function provider(action: string, checkValue = 1): DecisionProvider {
  return {
    decide: vi.fn(async (request) => ({
      model: "jev-test",
      answers: Object.fromEntries(
        Object.keys(request.questions).map((key) =>
          key === "action"
            ? [
                key,
                {
                  type: "choice",
                  choice: action,
                  confidence: 0.9,
                  probabilities: { [action]: 0.9 },
                },
              ]
            : [key, { type: "noul", noul: checkValue }],
        ),
      ),
      usage: { input_tokens: 1, output_tokens: 1 },
    })),
    testConnection: vi.fn(),
    health: vi.fn(),
  } as unknown as DecisionProvider;
}

describe("reviewOutputWithJev", () => {
  it("selects pass for a supported output", async () => {
    const request = buildJevOutputGuardrailRequest({
      model: "jev-test",
      taskPrompt: "Implement the requested change",
      output: "The change is implemented and verified.",
      requiredCriteria: ["Tests pass"],
    });
    expect(request.state).toMatchObject({ schema: "cowork.jev.output-guardrail.v1" });
    expect(request.questions.action).toBeDefined();

    await expect(
      reviewOutputWithJev({
        provider: provider("pass"),
        model: "jev-test",
        taskPrompt: "Implement the requested change",
        output: "The change is implemented and verified.",
      }),
    ).resolves.toMatchObject({ status: "selected", action: "pass" });
  });

  it("forces publication blocking when secret or suspicious-instruction checks fail", async () => {
    await expect(
      reviewOutputWithJev({
        provider: provider("pass", 0),
        model: "jev-test",
        output: "Here is the result.",
      }),
    ).resolves.toMatchObject({
      status: "selected",
      action: "block_external_publication",
    });
  });

  it("abstains on incomplete typed responses", async () => {
    await expect(
      reviewOutputWithJev({
        provider: {
          ...provider("pass"),
          decide: vi.fn(async () => ({
            model: "jev-test",
            answers: {},
            usage: { input_tokens: 1, output_tokens: 1 },
          })),
        },
        model: "jev-test",
        output: "A candidate response.",
      }),
    ).resolves.toMatchObject({ status: "abstain", action: "abstain", reason: "invalid_answer" });
  });
});
