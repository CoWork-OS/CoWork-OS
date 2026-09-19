import { describe, expect, it, vi } from "vitest";
import { MultitaskLanePlanner } from "../MultitaskLanePlanner";
import type { LLMProvider } from "../../agent/llm/types";
import type { DecisionProvider } from "../../agent/decisions";

describe("MultitaskLanePlanner", () => {
  it("uses explicit bullet lanes before calling the LLM", async () => {
    const provider: LLMProvider = {
      type: "openai",
      createMessage: vi.fn(),
      testConnection: vi.fn(),
    };

    const lanes = await MultitaskLanePlanner.plan(
      "- Frontend - implement the UI\n- Backend - add the API",
      { requestedLaneCount: 4, provider, modelId: "gpt-test" },
    );

    expect(provider.createMessage).not.toHaveBeenCalled();
    expect(lanes).toEqual([
      { title: "Frontend", description: "implement the UI" },
      { title: "Backend", description: "add the API" },
    ]);
  });

  it("uses LLM JSON lanes when no explicit list is present", async () => {
    const provider: LLMProvider = {
      type: "openai",
      createMessage: vi.fn(async () => ({
        id: "msg",
        content: [
          {
            type: "text",
            text: JSON.stringify([
              { title: "Inspect", description: "Inspect the current flow" },
              { title: "Implement", description: "Make the change" },
            ]),
          },
        ],
      })),
      testConnection: vi.fn(),
    };

    const lanes = await MultitaskLanePlanner.plan("fix the onboarding flow", {
      requestedLaneCount: 2,
      provider,
      modelId: "gpt-test",
    });

    expect(provider.createMessage).toHaveBeenCalledOnce();
    expect(lanes).toEqual([
      { title: "Inspect", description: "Inspect the current flow" },
      { title: "Implement", description: "Make the change" },
    ]);
  });

  it("falls back to bounded deterministic lanes when LLM planning fails", async () => {
    const provider: LLMProvider = {
      type: "openai",
      createMessage: vi.fn(async () => {
        throw new Error("offline");
      }),
      testConnection: vi.fn(),
    };

    const lanes = await MultitaskLanePlanner.plan("audit the repo", {
      requestedLaneCount: 3,
      provider,
      modelId: "gpt-test",
    });

    expect(lanes).toHaveLength(3);
    expect(lanes[0].title).toBe("Context and Scope");
  });

  it("uses active Jev to select bounded lane candidates without the LLM", async () => {
    const decisionProvider: DecisionProvider = {
      decide: vi.fn(async () => ({
        model: "jev-latest",
        usage: { input_tokens: 1, output_tokens: 1 },
        answers: {
          include_0: { type: "noul" as const, noul: 0.1 },
          include_1: { type: "noul" as const, noul: 0.1 },
          include_2: { type: "noul" as const, noul: 0.95 },
          include_3: { type: "noul" as const, noul: 0.9 },
          include_4: { type: "noul" as const, noul: 0.1 },
          include_5: { type: "noul" as const, noul: 0.1 },
          include_6: { type: "noul" as const, noul: 0.1 },
          include_7: { type: "noul" as const, noul: 0.1 },
        },
      })),
      testConnection: vi.fn(),
      health: vi.fn(),
    };
    const llmProvider: LLMProvider = {
      type: "openai",
      createMessage: vi.fn(),
      testConnection: vi.fn(),
    };

    const lanes = await MultitaskLanePlanner.plan("audit and verify the release", {
      requestedLaneCount: 2,
      provider: llmProvider,
      modelId: "gpt-test",
      decisionProvider,
      decisionModel: "jev-latest",
    });

    expect(lanes.map((lane) => lane.title)).toEqual(["Risk Review", "Verification"]);
    expect(decisionProvider.decide).toHaveBeenCalledOnce();
    expect(llmProvider.createMessage).not.toHaveBeenCalled();
  });
});
