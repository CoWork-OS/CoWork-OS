/**
 * Progressive-recall tools never return memories deleted or redacted in the Memory Hub
 * Inspector, whatever privacy filters the model asks for (audit SEC-5).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  search: vi.fn(),
  details: vi.fn(),
  timeline: vi.fn(),
}));

vi.mock("electron", () => ({
  app: { getAppPath: () => "/app", getPath: (name: string) => `/electron/${name}` },
  clipboard: { readText: () => "", writeText: vi.fn() },
  desktopCapturer: { getSources: vi.fn() },
  shell: { openExternal: vi.fn(), openPath: vi.fn(), showItemInFolder: vi.fn() },
}));

vi.mock("../../../settings/memory-features-manager", () => ({
  MemoryFeaturesManager: { loadSettings: () => ({ progressiveRecallToolsEnabled: true }) },
}));

vi.mock("../../../memory/MemoryService", () => ({
  MemoryService: { searchAsync: vi.fn(async () => []), searchWorkspaceMarkdown: vi.fn() },
}));

vi.mock("../../../memory/MemoryObservationService", () => ({
  MemoryObservationService: mocks,
}));

import { SystemTools } from "../system-tools";

function makeTools(): SystemTools {
  return new SystemTools(
    {
      id: "ws-1",
      name: "test",
      path: "/tmp",
      createdAt: 0,
      permissions: { read: true, write: true, delete: false, network: false, shell: false },
    } as Any,
    { logEvent: vi.fn(), requestApproval: vi.fn() } as Any,
    "task-1",
  );
}

function detail(memoryId: string, privacyState: string) {
  return {
    memoryId,
    title: memoryId,
    observationType: "observation",
    origin: "task",
    narrative: "n",
    facts: [],
    concepts: [],
    filesRead: [],
    filesModified: [],
    tools: [],
    privacyState,
    content: `content of ${memoryId}`,
  };
}

beforeEach(() => {
  mocks.search.mockReset().mockResolvedValue([]);
  mocks.details.mockReset().mockResolvedValue([]);
  mocks.timeline.mockReset().mockResolvedValue([]);
});

describe("memory_search_index privacy", () => {
  it("ignores model-supplied suppressed/redacted privacy filters", async () => {
    await makeTools().searchMemoryIndex({
      query: "deploy",
      privacyStates: ["suppressed", "redacted"],
    });
    expect(mocks.search).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-1", privacyStates: ["normal", "private"] }),
    );
  });

  it("defaults to the agent-visible states and keeps a narrowing filter", async () => {
    await makeTools().searchMemoryIndex({ query: "deploy" });
    expect(mocks.search.mock.calls[0][0].privacyStates).toEqual(["normal", "private"]);

    await makeTools().searchMemoryIndex({
      query: "deploy",
      privacyStates: ["private", "suppressed"],
    });
    expect(mocks.search.mock.calls[1][0].privacyStates).toEqual(["private"]);
  });

  it("advertises only agent-visible states in the schema", () => {
    const def = SystemTools.getToolDefinitions({ headless: true }).find(
      (tool) => tool.name === "memory_search_index",
    ) as Any;
    expect(def.input_schema.properties.privacyStates.items.enum).toEqual(["normal", "private"]);
  });
});

describe("memory_details privacy", () => {
  it("refuses suppressed and redacted ids", async () => {
    mocks.details.mockResolvedValue([
      detail("ok", "normal"),
      detail("priv", "private"),
      detail("deleted", "suppressed"),
      detail("red", "redacted"),
    ]);
    const result = await makeTools().memoryDetails({ ids: ["ok", "priv", "deleted", "red"] });
    expect(result.results.map((r) => r.id)).toEqual(["ok", "priv"]);
    expect(JSON.stringify(result)).not.toContain("content of deleted");
  });
});
