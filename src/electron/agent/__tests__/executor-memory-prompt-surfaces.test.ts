import { afterEach, describe, expect, it, vi } from "vitest";

import { TaskExecutor } from "../executor";
import { MemoryService } from "../../memory/MemoryService";
import { MemorySynthesizer } from "../../memory/MemorySynthesizer";
import { MemoryFeaturesManager } from "../../settings/memory-features-manager";
import { bumpHotMemoryVersion } from "../../memory/hot-memory-version";

function createExecutor(): Any {
  const executor = Object.create(TaskExecutor.prototype) as Any;
  executor.task = { id: "task-1", title: "Task", prompt: "Prompt", agentConfig: {} };
  executor.workspace = { id: "ws-1", path: "/tmp/cowork-none", permissions: { read: false } };
  executor.compactHotMemoryCache = null;
  return executor;
}

function mockFeatures(overrides: Record<string, unknown> = {}): void {
  vi.spyOn(MemoryFeaturesManager, "loadSettings").mockReturnValue({
    curatedMemoryEnabled: true,
    defaultArchiveInjectionEnabled: false,
    ...overrides,
  } as Any);
}

describe("per-turn hybrid memory recall", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("injects query matches only and skips memories captured by the current task", async () => {
    mockFeatures();
    vi.spyOn(MemoryService, "getSettings").mockResolvedValue({ enabled: true } as Any);
    const recent = vi.spyOn(MemoryService, "getRecentForPromptRecall").mockResolvedValue([]);
    vi.spyOn(MemoryService, "searchForPromptRecallFastAsync").mockResolvedValue([
      {
        id: "m-own",
        snippet: "Tool called: run_command",
        type: "observation",
        relevanceScore: 0.9,
        createdAt: Date.now(),
        taskId: "task-1",
        source: "db",
      },
      {
        id: "m-other",
        snippet: "Chose PostgreSQL for persistence",
        type: "decision",
        relevanceScore: 0.8,
        createdAt: Date.now(),
        taskId: "task-0",
        source: "db",
      },
    ] as Any);

    const block = await createExecutor().buildHybridMemoryRecallBlock("ws-1", "database choice");

    expect(recent).not.toHaveBeenCalled();
    expect(block).toContain("Chose PostgreSQL for persistence");
    expect(block).not.toContain("Tool called: run_command");
    expect(block).not.toContain("[recent:");
  });

  it("adds the recent lane only when default archive injection is on, minus this task", async () => {
    mockFeatures({ defaultArchiveInjectionEnabled: true });
    vi.spyOn(MemoryService, "getSettings").mockResolvedValue({ enabled: true } as Any);
    vi.spyOn(MemoryService, "getRecentForPromptRecall").mockResolvedValue([
      {
        id: "r-own",
        type: "observation",
        content: "Step completed",
        summary: "Step completed",
        taskId: "task-1",
        createdAt: Date.now(),
      },
      {
        id: "r-other",
        type: "insight",
        content: "Deploys run on Fridays",
        summary: "Deploys run on Fridays",
        taskId: "task-0",
        createdAt: Date.now(),
      },
    ] as Any);
    vi.spyOn(MemoryService, "searchForPromptRecallFastAsync").mockResolvedValue([]);

    const block = await createExecutor().buildHybridMemoryRecallBlock("ws-1", "deploy schedule");

    expect(block).toContain("[recent:insight]");
    expect(block).toContain("Deploys run on Fridays");
    expect(block).not.toContain("Step completed");
  });
});

describe("compact L0 hot memory block", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("respects the memory-injection gate", async () => {
    mockFeatures();
    const build = vi.spyOn(MemorySynthesizer, "buildHotMemoryContext");

    expect(await createExecutor().buildCompactHotMemoryBlock(false)).toBe("");
    expect(build).not.toHaveBeenCalled();
  });

  it("caches per task and rebuilds after a hot-memory write", async () => {
    mockFeatures();
    const build = vi
      .spyOn(MemorySynthesizer, "buildHotMemoryContext")
      .mockResolvedValueOnce({ text: "<cowork_hot_memory>\n- v1\n</cowork_hot_memory>" } as Any)
      .mockResolvedValueOnce({ text: "<cowork_hot_memory>\n- v2\n</cowork_hot_memory>" } as Any);
    const executor = createExecutor();

    expect(await executor.buildCompactHotMemoryBlock(true)).toContain("v1");
    expect(await executor.buildCompactHotMemoryBlock(true)).toContain("v1");
    expect(build).toHaveBeenCalledTimes(1);

    bumpHotMemoryVersion();
    expect(await executor.buildCompactHotMemoryBlock(true)).toContain("v2");
    expect(build).toHaveBeenCalledTimes(2);
  });

  it("leaves profile facts out for chat surfaces that already pin the profile", async () => {
    mockFeatures();
    const build = vi
      .spyOn(MemorySynthesizer, "buildHotMemoryContext")
      .mockResolvedValue({ text: "<cowork_hot_memory>\n- rule\n</cowork_hot_memory>" } as Any);

    await createExecutor().buildCompactHotMemoryBlock(true, { includeUserProfile: false });

    expect(build).toHaveBeenCalledWith("ws-1", expect.any(Number), { includeUserProfile: false });
  });

  it("is empty when curated memory is disabled", async () => {
    mockFeatures({ curatedMemoryEnabled: false });
    const build = vi.spyOn(MemorySynthesizer, "buildHotMemoryContext");

    expect(await createExecutor().buildCompactHotMemoryBlock(true)).toBe("");
    expect(build).not.toHaveBeenCalled();
  });
});
