import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Memory, MemorySettings, MemoryType } from "../../database/repositories";

const mockProvider = {
  createMessage: vi.fn(async () => ({
    content: [{ type: "text" as const, text: "LLM batch digest" }],
  })),
};

const mockLLMProviderFactory = {
  createProvider: vi.fn(() => mockProvider),
  getSettings: vi.fn(() => ({
    modelKey: "mock-model",
    providerType: "openai",
    azure: {},
    ollama: {},
    gemini: {},
    openrouter: {},
    openai: {},
    groq: {},
    xai: {},
    kimi: {},
    customProviders: [],
    bedrock: {},
  })),
  getModelId: vi.fn(() => "mock-batch-model"),
};

vi.mock("../../agent/llm", () => ({
  LLMProviderFactory: mockLLMProviderFactory,
}));

let MemoryService: typeof import("../MemoryService").MemoryService;
let memoryIdCounter = 0;
let mockMemories: Map<string, Memory>;
let mockSettings: Map<string, MemorySettings>;

function createDefaultSettings(workspaceId: string): MemorySettings {
  return {
    workspaceId,
    enabled: true,
    autoCapture: true,
    compressionEnabled: true,
    retentionDays: 90,
    maxStorageMb: 100,
    privacyMode: "normal",
    excludedPatterns: [],
  };
}

function createMockRepos() {
  const memoryRepo = {
    create: (memory: Omit<Memory, "id" | "createdAt" | "updatedAt">): Memory => {
      const now = Date.now();
      const created: Memory = {
        ...memory,
        id: `memory-${++memoryIdCounter}`,
        createdAt: now,
        updatedAt: now,
      };
      mockMemories.set(created.id, created);
      return created;
    },
    update: (
      id: string,
      updates: Partial<Pick<Memory, "summary" | "tokens" | "isCompressed" | "content">>,
    ): void => {
      const current = mockMemories.get(id);
      if (!current) return;
      mockMemories.set(id, {
        ...current,
        ...updates,
        updatedAt: Date.now(),
      });
    },
    insertCaptured: (write: {
      memory: Omit<Memory, "summary" | "taskId"> & {
        summary: string | null;
        taskId: string | null;
      };
    }) => {
      mockMemories.set(write.memory.id, {
        ...write.memory,
        summary: write.memory.summary ?? undefined,
        taskId: write.memory.taskId ?? undefined,
      } as Memory);
      return { observationStored: false };
    },
    findById: (id: string): Memory | undefined => mockMemories.get(id),
    findByIds: (ids: string[]): Memory[] =>
      ids.map((id) => mockMemories.get(id)).filter(Boolean) as Memory[],
    getFullDetails: (ids: string[]): Memory[] =>
      ids.map((id) => mockMemories.get(id)).filter(Boolean) as Memory[],
    getRecentForWorkspace: (workspaceId: string, limit = 20): Memory[] =>
      Array.from(mockMemories.values())
        .filter((memory) => memory.workspaceId === workspaceId)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, limit),
    deleteByWorkspace: (workspaceId: string): number => {
      let count = 0;
      for (const [id, memory] of mockMemories.entries()) {
        if (memory.workspaceId === workspaceId) {
          mockMemories.delete(id);
          count += 1;
        }
      }
      return count;
    },
    getApproxStorageBytes: vi.fn((_workspaceId: string): number => 0),
    getOldestForWorkspace: (_workspaceId: string, _limit = 200) =>
      [] as Array<{ id: string; createdAt: number; approxBytes: number }>,
    deleteOlderThan: (_workspaceId: string, _cutoffTimestamp: number): number => 0,
    getStats: (workspaceId: string) => {
      const memories = Array.from(mockMemories.values()).filter(
        (memory) => memory.workspaceId === workspaceId,
      );
      const compressedCount = memories.filter((memory) => memory.isCompressed).length;
      return {
        count: memories.length,
        totalTokens: memories.reduce((sum, memory) => sum + memory.tokens, 0),
        compressedCount,
        compressionRatio: memories.length > 0 ? compressedCount / memories.length : 0,
      };
    },
    deleteByIds: (_workspaceId: string, ids: string[]): number => {
      let count = 0;
      for (const id of ids) {
        if (mockMemories.delete(id)) count += 1;
      }
      return count;
    },
    searchLocalForPromptRecall: vi.fn(() => []),
    search: vi.fn(() => []),
    searchImportedGlobal: vi.fn(() => []),
    searchByContentMarker: vi.fn(() => []),
  };

  const embeddingRepo = {
    upsert: vi.fn(),
    getByWorkspace: vi.fn(() => []),
    getImportedGlobal: vi.fn(() => []),
    findMissingOrStale: vi.fn(() => []),
    findMissingOrStaleImportedGlobal: vi.fn(() => []),
    deleteByWorkspace: vi.fn(),
    deleteByMemoryIds: vi.fn(),
    deleteImported: vi.fn(),
  };

  const settingsRepo = {
    getOrCreate: (workspaceId: string): MemorySettings => {
      const existing = mockSettings.get(workspaceId);
      if (existing) return existing;
      const created = createDefaultSettings(workspaceId);
      mockSettings.set(workspaceId, created);
      return created;
    },
    update: (workspaceId: string, updates: Partial<MemorySettings>): void => {
      const existing = settingsRepo.getOrCreate(workspaceId);
      const updated = { ...existing, ...updates };
      mockSettings.set(workspaceId, updated);
    },
  };

  const summaryRepo = {
    deleteByWorkspace: vi.fn(),
  };

  return { memoryRepo, embeddingRepo, settingsRepo, summaryRepo };
}

function setMemoryServiceState() {
  const { memoryRepo, embeddingRepo, settingsRepo, summaryRepo } = createMockRepos();
  const serviceState = MemoryService as Any;

  serviceState.memoryRepo = memoryRepo;
  serviceState.embeddingRepo = embeddingRepo;
  serviceState.summaryRepo = summaryRepo;
  serviceState.settingsRepo = settingsRepo;
  serviceState.markdownIndex = null;
  serviceState.ftsWorker = null;
  serviceState.promptRecallDiagnostics = {
    queries: 0,
    workerUnavailable: 0,
    workerFailures: 0,
    workerEmptyResults: 0,
    workerHits: 0,
    lastFailureAt: null,
    lastFailureMessage: null,
  };
  serviceState.memoryEmbeddingsByWorkspace = new Map();
  serviceState.importedEmbeddings = new Map();
  serviceState.importedEmbeddingsLoaded = true;
  serviceState.importedEmbeddingBackfillInProgress = false;
  serviceState.embeddingsLoadedForWorkspace = new Set();
  serviceState.embeddingBackfillInProgress = new Set();
  serviceState.initialized = true;
  serviceState.compressionQueue = [];
  serviceState.compressionQueueEntries = new Map();
  serviceState.compressionRetryCounts = new Map();
  serviceState.compressionInProgress = false;
  serviceState.compressionPauseCount = 0;
  serviceState.compressionDrainTimer = undefined;
  serviceState.compressionBudgetByWorkspace = new Map();
  serviceState.compressionDiagnosticsByWorkspace = new Map();
  serviceState.sideChannelPolicyDepth = 0;
  serviceState.sideChannelDuringExecution = "enabled";
  serviceState.sideChannelMaxCallsPerWindow = 2;
  serviceState.sideChannelCallsRemaining = null;
  serviceState.sideChannelPolicyPaused = false;
  serviceState.cleanupIntervalHandle = undefined;
  serviceState.db = undefined;
}

describe("MemoryService compression optimization", () => {
  const workspaceId = "workspace-opt";

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
    vi.clearAllMocks();
    memoryIdCounter = 0;
    mockMemories = new Map();
    mockSettings = new Map();

    const module = await import("../MemoryService");
    MemoryService = module.MemoryService;
    MemoryService.shutdown();
    setMemoryServiceState();
  });

  afterEach(() => {
    MemoryService.shutdown();
    mockMemories.clear();
    mockSettings.clear();
    vi.useRealTimers();
  });

  it("keeps low-signal heartbeat captures local without LLM calls", async () => {
    const memory = await MemoryService.capture(
      workspaceId,
      undefined,
      "observation",
      "Heartbeat checked status and found no work.",
      false,
      {
        origin: "heartbeat",
        batchable: false,
        priority: "low",
        batchKey: "heartbeat:workspace-opt:focus_state:0",
      },
    );

    expect(memory).not.toBeNull();
    expect(mockProvider.createMessage).not.toHaveBeenCalled();
    expect(memory?.summary).toBeTruthy();
    expect(memory?.isCompressed).toBe(true);
    expect(MemoryService.getCompressionDiagnostics(workspaceId).llmCalls).toBe(0);
  });

  it("batches related task captures into a single LLM digest", async () => {
    const taskId = "task-batch-1";
    const contentA = `Decision A ${"alpha ".repeat(80)}`;
    const contentB = `Decision B ${"beta ".repeat(80)}`;

    await MemoryService.capture(workspaceId, taskId, "decision", contentA);
    await MemoryService.capture(workspaceId, taskId, "decision", contentB);

    await vi.advanceTimersByTimeAsync(1000);
    await Promise.resolve();

    expect(mockProvider.createMessage).toHaveBeenCalledTimes(1);
    expect(MemoryService.getCompressionDiagnostics(workspaceId).llmCalls).toBe(1);

    const recent = await MemoryService.getRecent(workspaceId, 10);
    expect(recent.some((memory) => memory.type === "summary")).toBe(true);
  });

  it("does not fall back to synchronous prompt recall when the FTS worker fails", async () => {
    const serviceState = MemoryService as Any;
    const searchLocalSpy = serviceState.memoryRepo.searchLocalForPromptRecall;
    serviceState.ftsWorker = {
      searchLocalForPromptRecall: vi.fn(async () => {
        throw new Error("worker failed");
      }),
    };

    const results = await MemoryService.searchForPromptRecallFastAsync(
      workspaceId,
      "large task prompt",
      5,
    );

    expect(results).toEqual([]);
    expect(serviceState.ftsWorker.searchLocalForPromptRecall).toHaveBeenCalled();
    expect(searchLocalSpy).not.toHaveBeenCalled();
    expect(MemoryService.getPromptRecallDiagnostics()).toMatchObject({
      queries: 1,
      workerFailures: 1,
      lastFailureMessage: "worker failed",
    });
  });

  it("records prompt recall diagnostics when the FTS worker is unavailable", async () => {
    const serviceState = MemoryService as Any;
    const searchLocalSpy = serviceState.memoryRepo.searchLocalForPromptRecall;

    const results = await MemoryService.searchForPromptRecallFastAsync(
      workspaceId,
      "large task prompt",
      5,
    );

    expect(results).toEqual([]);
    expect(searchLocalSpy).not.toHaveBeenCalled();
    expect(MemoryService.getPromptRecallDiagnostics()).toMatchObject({
      queries: 1,
      workerUnavailable: 1,
      workerFailures: 0,
    });
  });

  describe("async search with the FTS worker", () => {
    const hostFtsSpies = () => {
      const repo = (MemoryService as Any).memoryRepo;
      return [repo.search, repo.searchImportedGlobal, repo.searchByContentMarker];
    };

    it("runs the whole hybrid search in the worker, with no host FTS or ranking", async () => {
      const hit = {
        id: "m-1",
        snippet: "hit",
        type: "observation",
        relevanceScore: 1,
        createdAt: 1,
        source: "db",
      };
      const worker = { hybridSearch: vi.fn(async () => [hit]) };
      (MemoryService as Any).ftsWorker = worker;
      const rankSpy = vi.spyOn(MemoryService as Any, "rankHybrid");

      await expect(MemoryService.searchAsync(workspaceId, "release notes", 5)).resolves.toEqual([
        hit,
      ]);
      expect(worker.hybridSearch).toHaveBeenCalledWith(workspaceId, "release notes", 5, true);
      for (const spy of hostFtsSpies()) expect(spy).not.toHaveBeenCalled();
      expect(rankSpy).not.toHaveBeenCalled();
    });

    it("raises a worker failure instead of searching on the host or returning nothing", async () => {
      (MemoryService as Any).ftsWorker = {
        hybridSearch: vi.fn(async () => {
          throw new Error("worker down");
        }),
      };
      const rankSpy = vi.spyOn(MemoryService as Any, "rankHybrid");

      await expect(MemoryService.searchAsync(workspaceId, "release notes", 5)).rejects.toThrow(
        "Memory search is unavailable: worker down",
      );
      for (const spy of hostFtsSpies()) expect(spy).not.toHaveBeenCalled();
      expect(rankSpy).not.toHaveBeenCalled();
    });

    it("treats an empty worker marker search as final", async () => {
      const worker = { searchByContentMarker: vi.fn(async () => []) };
      (MemoryService as Any).ftsWorker = worker;

      await expect(
        MemoryService.searchByContentMarkerAsync(workspaceId, "[suggestion-feedback:acted_on]", 2),
      ).resolves.toEqual([]);
      expect(worker.searchByContentMarker).toHaveBeenCalledTimes(1);
      for (const spy of hostFtsSpies()) expect(spy).not.toHaveBeenCalled();
    });

    it("propagates worker marker search failures instead of scanning on the host", async () => {
      (MemoryService as Any).ftsWorker = {
        searchByContentMarker: vi.fn(async () => {
          throw new Error("worker down");
        }),
      };

      await expect(
        MemoryService.searchByContentMarkerAsync(workspaceId, "[marker]", 2),
      ).rejects.toThrow("worker down");
      for (const spy of hostFtsSpies()) expect(spy).not.toHaveBeenCalled();
    });

    it("keeps the synchronous hybrid search when no worker is running", async () => {
      await MemoryService.searchAsync(workspaceId, "release notes", 5);
      const repo = (MemoryService as Any).memoryRepo;
      expect(repo.search).toHaveBeenCalledWith(workspaceId, "release notes", 5, true);
      expect(repo.searchImportedGlobal).toHaveBeenCalledWith("release notes", 5, true);
    });
  });

  describe("storage cap measurement", () => {
    const measure = () => (MemoryService as Any).memoryRepo.getApproxStorageBytes;
    const capture = (content: string) =>
      MemoryService.capture(workspaceId, undefined, "observation", content, false, {
        origin: "heartbeat",
        batchable: false,
        priority: "low",
      });

    it("measures once, then trusts the running estimate well below the cap", async () => {
      await capture("first observation");
      await capture("second observation");
      await capture("third observation");
      expect(measure()).toHaveBeenCalledTimes(1);
    });

    it("measures again once the estimate nears the cap", async () => {
      mockSettings.set(workspaceId, { ...createDefaultSettings(workspaceId), maxStorageMb: 0.001 });
      await capture("small");
      // 1,049-byte cap: 900 added bytes cross the 80% headroom.
      await capture("x".repeat(900));
      expect(measure()).toHaveBeenCalledTimes(2);
    });

    it("measures again after the estimate expires", async () => {
      await capture("first observation");
      vi.setSystemTime(Date.now() + 5 * 60 * 1000);
      await capture("second observation");
      expect(measure()).toHaveBeenCalledTimes(2);
    });
  });
});
