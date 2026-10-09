/**
 * MemoryService privacy (audit SEC-5, SEC-6, SEC-10, PROMPT-4): secrets are redacted at
 * capture, topic words no longer privatize memories, only importers write imported
 * rows, prompt recall skips private/deleted rows, and caches drop deleted rows.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Memory, MemorySettings } from "../../database/repositories";

vi.mock("electron", () => ({ app: { getPath: () => "/tmp/cowork-test" } }));
vi.mock("../../agent/llm", () => ({
  LLMProviderFactory: {
    createProvider: vi.fn(),
    getSettings: vi.fn(() => ({ modelKey: "m", providerType: "openai" })),
    getModelId: vi.fn(() => "m"),
  },
}));

let MemoryService: typeof import("../MemoryService").MemoryService;
let MemoryObservationService: typeof import("../MemoryObservationService").MemoryObservationService;
let memories: Map<string, Memory>;
let settings: MemorySettings;
let hidden: Set<string>;
let counter = 0;

function installState() {
  const memoryRepo = {
    insertCaptured: vi.fn((write: { memory: Memory & { summary: string | null } }) => {
      memories.set(write.memory.id, {
        ...write.memory,
        summary: write.memory.summary ?? undefined,
      } as Memory);
      return { observationStored: false };
    }),
    findById: vi.fn((id: string) => memories.get(id)),
    getFullDetails: vi.fn((ids: string[]) => ids.map((id) => memories.get(id)).filter(Boolean)),
    getRecentForWorkspace: vi.fn((workspaceId: string, limit: number, includePrivate: boolean) =>
      Array.from(memories.values())
        .filter((m) => m.workspaceId === workspaceId && (includePrivate || !m.isPrivate))
        .slice(0, limit),
    ),
    update: vi.fn(),
    deleteByWorkspaceAndId: vi.fn(async (_ws: string, id: string) => (memories.delete(id) ? 1 : 0)),
    getApproxStorageBytes: vi.fn(() => 0),
    getOldestForWorkspace: vi.fn(() => []),
    search: vi.fn(() => []),
    searchImportedGlobal: vi.fn(() => []),
    searchLocalForPromptRecall: vi.fn(() => []),
  };
  const state = MemoryService as Any;
  state.memoryRepo = memoryRepo;
  state.embeddingRepo = {
    upsert: vi.fn(),
    deleteByMemoryIds: vi.fn(),
    getByWorkspace: vi.fn(() => []),
    getImportedGlobal: vi.fn(() => []),
    findMissingOrStale: vi.fn(() => []),
    findMissingOrStaleImportedGlobal: vi.fn(() => []),
  };
  state.settingsRepo = { getOrCreate: vi.fn(() => settings) };
  state.summaryRepo = { deleteByWorkspace: vi.fn() };
  state.markdownIndex = null;
  state.ftsWorker = null;
  state.workspaceRepo = undefined;
  state.initialized = true;
  state.compressionQueue = [];
  state.compressionQueueEntries = new Map();
  state.compressionDiagnosticsByWorkspace = new Map();
  state.compressionBudgetByWorkspace = new Map();
  state.embeddingBackfillInProgress = new Set(["ws-1"]);
  state.importedEmbeddingBackfillInProgress = true;
  state.promptRecallCache = new Map();
  (MemoryObservationService as Any).store = {
    suppressedIds: vi.fn(async (ids: string[]) => ids.filter((id) => hidden.has(id))),
    delete: vi.fn(async () => true),
  };
  return memoryRepo;
}

function addMemory(id: string, content: string, isPrivate = false): Memory {
  const memory = {
    id,
    workspaceId: "ws-1",
    type: "observation",
    content,
    tokens: 5,
    isCompressed: false,
    isPrivate,
    createdAt: ++counter,
    updatedAt: counter,
  } as Memory;
  memories.set(id, memory);
  return memory;
}

beforeEach(async () => {
  memories = new Map();
  hidden = new Set();
  settings = {
    workspaceId: "ws-1",
    enabled: true,
    autoCapture: true,
    compressionEnabled: false,
    retentionDays: 90,
    maxStorageMb: 100,
    privacyMode: "normal",
    excludedPatterns: [],
  };
  MemoryService = (await import("../MemoryService")).MemoryService;
  MemoryObservationService = (await import("../MemoryObservationService")).MemoryObservationService;
  installState();
});

afterEach(() => {
  (MemoryObservationService as Any).store = null;
  vi.restoreAllMocks();
});

describe("MemoryService capture privacy", () => {
  const capture = (content: string, origin: string = "task") =>
    MemoryService.capture("ws-1", "task-1", "observation", content, false, {
      origin: origin as Any,
      skipMemoryWriteGate: true,
    });

  it("redacts secret values before storage and keeps the memory visible", async () => {
    const memory = await capture(
      "Configured deploy with GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789 today",
    );
    expect(memory?.content).toContain("[REDACTED_SECRET]");
    expect(memory?.content).not.toContain("ghp_abcdefghijklmnop");
    expect(memory?.isPrivate).toBe(false);
    expect(memories.get(memory!.id)?.content).not.toContain("ghp_");
  });

  it("does not hide memories that only mention auth, tokens or .env", async () => {
    const memory = await capture("Fixed the OAuth token refresh in auth.ts and documented .env");
    expect(memory?.isPrivate).toBe(false);
    expect(memory?.content).toBe("Fixed the OAuth token refresh in auth.ts and documented .env");
  });

  it("keeps explicit private blocks and strict mode private", async () => {
    expect((await capture("note <private>hidden</private>"))?.isPrivate).toBe(true);
    settings.privacyMode = "strict";
    expect((await capture("ordinary note"))?.isPrivate).toBe(true);
  });

  it("neutralizes a planted [Imported from prefix for non-import captures", async () => {
    const planted = await capture("[Imported from ChatGPT] visible everywhere", "tool");
    expect(planted?.content.startsWith("[Imported from")).toBe(false);
    expect(planted?.content).toBe("(saved) [Imported from ChatGPT] visible everywhere");

    const real = await capture("[Imported from Box Brain] doc", "import");
    expect(real?.content.startsWith("[Imported from Box Brain]")).toBe(true);
  });
});

describe("MemoryService recall privacy", () => {
  it("excludes private, deleted and redacted rows from recent prompt recall", async () => {
    const repo = (MemoryService as Any).memoryRepo;
    addMemory("normal", "visible note");
    addMemory("private", "private note", true);
    addMemory("deleted", "deleted note");
    hidden.add("deleted");

    const recent = await MemoryService.getRecentForPromptRecall("ws-1", 10);
    expect(recent.map((m) => m.id)).toEqual(["normal"]);
    expect(repo.getRecentForWorkspace).toHaveBeenCalledWith("ws-1", 10, false);
  });

  it("drops private rows from searchForPromptRecall", async () => {
    addMemory("normal", "deploy notes");
    addMemory("private", "deploy private", true);
    (MemoryService as Any).memoryRepo.search.mockReturnValue([
      { id: "normal", snippet: "a", type: "observation", relevanceScore: 1, createdAt: 1 },
      { id: "private", snippet: "b", type: "observation", relevanceScore: 1, createdAt: 2 },
    ]);
    const results = await MemoryService.searchForPromptRecall("ws-1", "deploy", 5);
    expect(results.map((r) => r.id)).toEqual(["normal"]);
  });

  it("filters suppressed and redacted rows out of worker search results", async () => {
    hidden.add("gone");
    const worker = {
      hybridSearch: vi.fn(async () => [
        { id: "kept", snippet: "a", type: "observation", relevanceScore: 1, createdAt: 1 },
        { id: "gone", snippet: "b", type: "observation", relevanceScore: 1, createdAt: 2 },
      ]),
    };
    (MemoryService as Any).ftsWorker = worker;
    (MemoryService as Any).sql = undefined;
    const results = await MemoryService.searchAsync("ws-1", "deploy notes", 5);
    expect(results.map((r) => r.id)).toEqual(["kept"]);
  });

  it("keeps cross-workspace private semantic candidates out of the host hybrid rank", async () => {
    addMemory("own", "kubernetes rollout plan cluster");
    memories.set("foreign-private", {
      ...addMemory("tmp", "[Imported from ChatGPT] kubernetes rollout plan cluster", true),
      id: "foreign-private",
      workspaceId: "ws-2",
    });
    memories.delete("tmp");
    memories.set("foreign-local", {
      ...addMemory("tmp2", "kubernetes rollout plan cluster other"),
      id: "foreign-local",
      workspaceId: "ws-2",
    });
    memories.delete("tmp2");
    const { createLocalEmbedding } = await import("../local-embedding");
    const state = MemoryService as Any;
    state.embeddingsLoadedForWorkspace = new Set(["ws-1"]);
    state.importedEmbeddingsLoaded = true;
    state.memoryEmbeddingsByWorkspace = new Map([
      [
        "ws-1",
        new Map(
          ["own", "foreign-local"].map((id) => [
            id,
            {
              updatedAt: 1,
              embedding: Float32Array.from(createLocalEmbedding(memories.get(id)!.content)),
            },
          ]),
        ),
      ],
    ]);
    state.importedEmbeddings = new Map([
      [
        "foreign-private",
        {
          updatedAt: 1,
          workspaceId: "ws-2",
          embedding: Float32Array.from(
            createLocalEmbedding(memories.get("foreign-private")!.content),
          ),
        },
      ],
    ]);
    state.sql = undefined;
    const ids = (await MemoryService.search("ws-1", "kubernetes rollout plan cluster", 10)).map(
      (r) => r.id,
    );
    expect(ids).toContain("own");
    expect(ids).not.toContain("foreign-private");
    expect(ids).not.toContain("foreign-local");
  });
});

describe("MemoryService deletion consistency", () => {
  it("replaceMemory leaves a deleted or redacted memory untouched", async () => {
    const repo = (MemoryService as Any).memoryRepo;
    const current = addMemory("box-1", "[Imported from Box Brain] old");
    hidden.add("box-1");
    const result = await MemoryService.replaceMemory("ws-1", "box-1", "new secret content");
    expect(result).toBe(current);
    expect(repo.update).not.toHaveBeenCalled();
  });

  it("replaceMemory redacts secrets in refreshed content", async () => {
    const repo = (MemoryService as Any).memoryRepo;
    addMemory("box-2", "[Imported from Box Brain] old");
    await MemoryService.replaceMemory(
      "ws-1",
      "box-2",
      "[Imported from Box Brain] password=hunter2222 in doc",
    );
    const patch = repo.update.mock.calls[0][1] as { content: string };
    expect(patch.content).toContain("[REDACTED_SECRET]");
    expect(patch.content).not.toContain("hunter2222");
  });

  it("drops the prompt-recall cache on Inspector delete and on entry delete", async () => {
    const cache = (MemoryService as Any).promptRecallCache as Map<string, unknown>;
    const unsubscribe = MemoryObservationService.onVisibilityChanged(() =>
      MemoryService.clearPromptRecallCache(),
    );
    try {
      cache.set("k", { results: [], createdAt: Date.now() });
      await MemoryObservationService.delete("ws-1", "m-1");
      expect(cache.size).toBe(0);

      addMemory("m-2", "note");
      cache.set("k", { results: [], createdAt: Date.now() });
      await MemoryService.deleteEntries("ws-1", ["m-2"]);
      expect(cache.size).toBe(0);
    } finally {
      unsubscribe();
    }
  });
});
