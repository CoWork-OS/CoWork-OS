import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadSettings: vi.fn(),
  createProvider: vi.fn(),
  getSelectedModel: vi.fn(),
  createConfiguredJevProvider: vi.fn(),
  recordLlmCallError: vi.fn(),
  recordLlmCallSuccess: vi.fn(),
}));

vi.mock("../../agent/llm/provider-factory", () => ({
  LLMProviderFactory: {
    loadSettings: mocks.loadSettings,
    createProvider: mocks.createProvider,
    getSelectedModel: mocks.getSelectedModel,
  },
}));

vi.mock("../../agent/jev", () => ({
  createConfiguredJevProvider: mocks.createConfiguredJevProvider,
}));

vi.mock("../../agent/llm/usage-telemetry", () => ({
  recordLlmCallError: mocks.recordLlmCallError,
  recordLlmCallSuccess: mocks.recordLlmCallSuccess,
}));

import { selectAgentsForTask } from "../capabilityMatcher";

function role(
  id: string,
  displayName: string,
  capabilities: string[],
  sortOrder: number,
  autonomyLevel: "lead" | "standard" = "standard",
) {
  return {
    id,
    name: id,
    displayName,
    description: displayName + " role",
    capabilities,
    sortOrder,
    autonomyLevel,
    isActive: true,
  };
}

const roles = [
  role("coder", "Coder", ["code"], 1, "lead"),
  role("researcher", "Researcher", ["research"], 2),
  role("writer", "Writer", ["write"], 3),
];

function jevResponse(
  leader: string,
  confidence = 0.95,
  leaderProbability = 0.9,
  memberProbabilities: Record<string, number> = {},
) {
  return {
    model: "jev-latest",
    usage: { input_tokens: 1, output_tokens: 1 },
    answers: {
      leader: {
        type: "choice",
        choice: leader,
        probabilities: { [leader]: leaderProbability, none: 1 - leaderProbability },
        confidence,
      },
      include_0: { type: "noul", noul: memberProbabilities.coder ?? 0.9 },
      include_1: { type: "noul", noul: memberProbabilities.researcher ?? 0.8 },
      include_2: { type: "noul", noul: memberProbabilities.writer ?? 0.1 },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadSettings.mockReturnValue({
    jev: {
      enabled: true,
      provider: "typesafe",
      teamSelectionEnabled: true,
      typesafe: { apiKey: "test-key" },
    },
    openrouter: {},
  });
  mocks.createConfiguredJevProvider.mockReturnValue({
    model: "jev-latest",
    provider: {
      decide: vi.fn().mockResolvedValue(jevResponse("coder")),
    },
  });
  mocks.createProvider.mockImplementation(() => {
    throw new Error("normal chat provider should not be needed");
  });
  mocks.getSelectedModel.mockReturnValue("test-model");
});

describe("selectAgentsForTask Jev adviser", () => {
  it("accepts a high-confidence structured team decision and enforces the cap", async () => {
    const result = await selectAgentsForTask("Implement and research this code change", roles, 2);

    expect(result.members.map((member) => member.id)).toEqual(["coder", "researcher"]);
    expect(result.leader.id).toBe("coder");
    expect(result.source).toBe("jev");
    expect(result.decisionModel).toBe("jev-latest");
    expect(mocks.createConfiguredJevProvider).toHaveBeenCalledTimes(1);
    expect(mocks.createProvider).not.toHaveBeenCalled();
  });

  it("falls back when the leader confidence is below the acceptance threshold", async () => {
    mocks.createConfiguredJevProvider.mockReturnValue({
      model: "jev-latest",
      provider: {
        decide: vi.fn().mockResolvedValue(jevResponse("coder", 0.5)),
      },
    });
    mocks.createProvider.mockImplementation(() => {
      throw new Error("chat provider unavailable");
    });

    const result = await selectAgentsForTask("Implement this code change", roles, 2);

    expect(result.members.length).toBe(2);
    expect(result.members.some((member) => member.id === "coder")).toBe(true);
    expect(result.source).toBe("keyword");
  });

  it("does not invoke Jev for the existing single-agent edge case", async () => {
    mocks.createConfiguredJevProvider.mockReturnValue(null);
    mocks.createProvider.mockImplementation(() => {
      throw new Error("chat provider unavailable");
    });

    const result = await selectAgentsForTask("Implement this code change", roles, 1);

    expect(mocks.createConfiguredJevProvider).not.toHaveBeenCalled();
    expect(result.members).toHaveLength(1);
  });

  it("keeps observe-only harness mode independent from team selection", async () => {
    mocks.loadSettings.mockReturnValue({
      jev: {
        enabled: true,
        provider: "typesafe",
        harnessEnabled: true,
        toolReviewMode: "observe",
        typesafe: { apiKey: "test-key" },
      },
    });
    mocks.createProvider.mockImplementation(() => {
      throw new Error("chat provider unavailable");
    });

    const result = await selectAgentsForTask("Implement this code change", roles, 2);

    expect(mocks.createConfiguredJevProvider).not.toHaveBeenCalled();
    expect(result.source).toBe("keyword");
  });

  it("falls back when Jev selects an unknown leader", async () => {
    mocks.createConfiguredJevProvider.mockReturnValue({
      model: "jev-latest",
      provider: {
        decide: vi.fn().mockResolvedValue(jevResponse("unknown")),
      },
    });
    mocks.createProvider.mockImplementation(() => {
      throw new Error("chat provider unavailable");
    });

    const result = await selectAgentsForTask("Implement this code change", roles, 2);

    expect(result.members.length).toBe(2);
    expect(
      result.members.every((member) => roles.some((candidate) => candidate.id === member.id)),
    ).toBe(true);
    expect(result.source).toBe("keyword");
  });

  it("does not spend a chat-model call when active harness Jev selection is unavailable", async () => {
    mocks.loadSettings.mockReturnValue({
      jev: {
        enabled: true,
        provider: "typesafe",
        harnessEnabled: true,
        toolReviewMode: "active",
        typesafe: { apiKey: "test-key" },
      },
    });
    mocks.createConfiguredJevProvider.mockReturnValue({
      model: "jev-latest",
      provider: {
        decide: vi.fn().mockRejectedValue(new Error("offline")),
      },
    });

    const result = await selectAgentsForTask("Implement this code change", roles, 2);

    expect(result.source).toBe("keyword_active");
    expect(mocks.createProvider).not.toHaveBeenCalled();
  });
});
