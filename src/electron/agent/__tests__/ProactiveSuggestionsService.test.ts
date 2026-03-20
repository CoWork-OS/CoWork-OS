import { beforeEach, describe, expect, it, vi } from "vitest";

const memorySearch = vi.fn();
const memoryCapture = vi.fn();
const repoLoad = vi.fn();
const repoSave = vi.fn();

vi.mock("../../memory/MemoryService", () => ({
  MemoryService: {
    search: (...args: unknown[]) => memorySearch(...args),
    capture: (...args: unknown[]) => memoryCapture(...args),
    getRecent: vi.fn(() => []),
  },
}));

vi.mock("../../memory/UserProfileService", () => ({
  UserProfileService: {
    getProfile: vi.fn(() => ({ facts: [] })),
  },
}));

vi.mock("../../knowledge-graph/KnowledgeGraphService", () => ({
  KnowledgeGraphService: {
    isInitialized: vi.fn(() => false),
    search: vi.fn(() => []),
    getObservations: vi.fn(() => []),
  },
}));

vi.mock("../../database/SecureSettingsRepository", () => ({
  SecureSettingsRepository: {
    isInitialized: vi.fn(() => true),
    getInstance: vi.fn(() => ({
      load: (...args: unknown[]) => repoLoad(...args),
      save: (...args: unknown[]) => repoSave(...args),
    })),
  },
}));

function makeSuggestion(id: string, title: string, createdAt = Date.now()) {
  return {
    id: `memory-${id}`,
    type: "insight",
    createdAt,
    snippet: `[SUGGESTION] ${JSON.stringify({
      id,
      type: "follow_up",
      title,
      description: `${title} description`,
      confidence: 0.6,
    })}`,
  };
}

describe("ProactiveSuggestionsService", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T15:00:00Z"));
    memorySearch.mockReset();
    memoryCapture.mockReset();
    repoLoad.mockReset();
    repoSave.mockReset();
    repoLoad.mockReturnValue({
      dismissed: [],
      actedOn: [],
      surfacedAt: {},
      telemetryEvents: [],
    });
  });

  it("records surface and dismiss telemetry for visible suggestions", async () => {
    memorySearch.mockReturnValue([makeSuggestion("s1", "Write tests")]);
    const { ProactiveSuggestionsService } = await import("../ProactiveSuggestionsService");

    const suggestions = ProactiveSuggestionsService.listActive("ws-1");
    expect(suggestions).toHaveLength(1);

    const savedAfterSurface = repoSave.mock.calls.at(-1)?.[1];
    expect(savedAfterSurface.telemetryEvents.some((event: { type: string }) => event.type === "surfaced")).toBe(
      true,
    );

    ProactiveSuggestionsService.dismiss("ws-1", "s1");
    const savedAfterDismiss = repoSave.mock.calls.at(-1)?.[1];
    expect(
      savedAfterDismiss.telemetryEvents.some(
        (event: { type: string; suggestionId: string }) =>
          event.type === "dismissed" && event.suggestionId === "s1",
      ),
    ).toBe(true);
  });

  it("defers low-signal suggestions from interactive surfaces but keeps them for briefings", async () => {
    memorySearch.mockReturnValue([makeSuggestion("s2", "Review backlog")]);
    repoLoad.mockReturnValue({
      dismissed: [],
      actedOn: [],
      surfacedAt: {},
      telemetryEvents: [
        { workspaceId: "ws-1", suggestionId: "old-1", type: "acted_on", at: 1, hour: 9 },
        { workspaceId: "ws-1", suggestionId: "old-2", type: "acted_on", at: 2, hour: 9 },
        { workspaceId: "ws-1", suggestionId: "old-3", type: "acted_on", at: 3, hour: 9 },
        { workspaceId: "ws-1", suggestionId: "old-4", type: "dismissed", at: 4, hour: 15 },
        { workspaceId: "ws-1", suggestionId: "old-5", type: "dismissed", at: 5, hour: 15 },
        { workspaceId: "ws-1", suggestionId: "old-6", type: "dismissed", at: 6, hour: 15 },
      ],
    });

    const { ProactiveSuggestionsService } = await import("../ProactiveSuggestionsService");

    expect(ProactiveSuggestionsService.listActive("ws-1")).toHaveLength(0);
    expect(ProactiveSuggestionsService.getTopForBriefing("ws-1", 3)).toHaveLength(1);
  });

  it("stores and parses companion suggestion metadata", async () => {
    memorySearch.mockReturnValue([]);
    memoryCapture.mockResolvedValue({});
    const { ProactiveSuggestionsService } = await import("../ProactiveSuggestionsService");

    const created = await ProactiveSuggestionsService.createCompanionSuggestion("ws-1", {
      title: "Companion summary",
      description: "Cross-workspace pressure detected.",
      confidence: 0.88,
      suggestionClass: "cross_workspace",
      urgency: "medium",
      learningSignalIds: ["sig-1", "sig-2"],
      workspaceScope: "all",
      sourceSignals: ["focus-1", "due-1"],
      recommendedDelivery: "inbox",
      companionStyle: "email",
    });

    expect(created).toMatchObject({
      title: "Companion summary",
      workspaceScope: "all",
      recommendedDelivery: "inbox",
      companionStyle: "email",
      suggestionClass: "cross_workspace",
    });
    expect(memoryCapture).toHaveBeenCalledWith(
      "ws-1",
      undefined,
      "insight",
      expect.stringContaining("\"workspaceScope\":\"all\""),
    );
  });

  it("aggregates briefing suggestions across multiple workspaces when requested", async () => {
    memorySearch.mockImplementation((workspaceId: string) => {
      if (workspaceId === "ws-1") {
        return [makeSuggestion("s1", "Workspace one")];
      }
      if (workspaceId === "ws-2") {
        return [makeSuggestion("s2", "Workspace two")];
      }
      return [];
    });

    const { ProactiveSuggestionsService } = await import("../ProactiveSuggestionsService");

    const suggestions = ProactiveSuggestionsService.getTopForBriefingForWorkspaces(
      "all",
      ["ws-1", "ws-2"],
      10,
    );

    expect(suggestions.map((s) => s.title).sort()).toEqual(["Workspace one", "Workspace two"]);
    expect(suggestions.map((s) => s.workspaceId).sort()).toEqual(["ws-1", "ws-2"]);
  });
});
