/**
 * Recall tools report a failed search as an error instead of an empty result
 * list, so the model does not read "recall broke" as "nothing was recorded"
 * (audit RECALL-3).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  features: { progressiveRecallToolsEnabled: true } as Record<string, unknown>,
  searchAsync: vi.fn(),
  sessionSearch: vi.fn(),
  quoteSearch: vi.fn(),
}));

vi.mock("electron", () => ({
  app: { getAppPath: () => "/app", getPath: (name: string) => `/electron/${name}` },
  clipboard: { readText: () => "", writeText: vi.fn() },
  desktopCapturer: { getSources: vi.fn() },
  shell: { openExternal: vi.fn(), openPath: vi.fn(), showItemInFolder: vi.fn() },
}));

vi.mock("../../../settings/memory-features-manager", () => ({
  MemoryFeaturesManager: { loadSettings: () => mocks.features },
}));

vi.mock("../../../memory/MemoryService", () => ({
  MemoryService: { searchAsync: mocks.searchAsync, searchWorkspaceMarkdown: vi.fn(async () => []) },
}));

vi.mock("../../../memory/SessionRecallService", () => ({
  SessionRecallService: { search: mocks.sessionSearch },
}));

vi.mock("../../../memory/QuoteRecallService", () => ({
  QuoteRecallService: { search: mocks.quoteSearch },
}));

import { SystemTools } from "../system-tools";

function makeTools(): SystemTools {
  return new SystemTools(
    {
      id: "ws-1",
      name: "test",
      path: "/tmp/cowork-recall-errors",
      createdAt: 0,
      permissions: { read: true, write: true, delete: false, network: false, shell: false },
    } as Any,
    { logEvent: vi.fn(), requestApproval: vi.fn(), getDatabase: vi.fn() } as Any,
    "task-1",
  );
}

beforeEach(() => {
  mocks.features = { progressiveRecallToolsEnabled: true };
  mocks.searchAsync.mockReset();
  mocks.sessionSearch.mockReset();
  mocks.quoteSearch.mockReset();
});

describe("recall tool failures", () => {
  it("search_memories returns an error when the memory search fails", async () => {
    mocks.searchAsync.mockRejectedValue(new Error("memory search unavailable"));
    const result = await makeTools().searchMemories({ query: "deploy", lane: "archive" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("memory search unavailable");
    expect(result.error).toContain("Recall did not run");
    expect(result.results).toEqual([]);
  });

  it("search_sessions returns an error when session recall fails", async () => {
    mocks.sessionSearch.mockRejectedValue(new Error("checkpoint read failed"));
    const result = await makeTools().searchSessions({ query: "deploy" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("checkpoint read failed");
  });

  it("search_quotes returns an error when quote recall fails", async () => {
    mocks.quoteSearch.mockRejectedValue(new Error("fts offline"));
    const result = await makeTools().searchQuotes({ query: "deploy" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("fts offline");
  });

  it("keeps successful empty searches free of an error", async () => {
    mocks.searchAsync.mockResolvedValue([]);
    const result = await makeTools().searchMemories({ query: "deploy", lane: "archive" });

    expect(result.error).toBeUndefined();
    expect(result.totalFound).toBe(0);
  });
});

describe("search_memories description", () => {
  function searchMemoriesDescriptions(): string[] {
    return SystemTools.getToolDefinitions()
      .filter((tool) => tool.name === "search_memories")
      .map((tool) => tool.description);
  }

  it("points at progressive recall only when those tools are registered", () => {
    expect(searchMemoriesDescriptions().every((d) => d.includes("memory_search_index"))).toBe(true);

    mocks.features = { progressiveRecallToolsEnabled: false };
    const descriptions = searchMemoriesDescriptions();
    expect(descriptions.length).toBeGreaterThan(0);
    expect(descriptions.some((d) => d.includes("memory_search_index"))).toBe(false);
  });
});
