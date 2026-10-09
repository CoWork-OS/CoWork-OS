import { afterEach, describe, expect, it, vi } from "vitest";

import { TaskExecutor } from "../executor";
import { MemoryService } from "../../memory/MemoryService";
import { MemoryFeaturesManager } from "../../settings/memory-features-manager";
import { MemoryContextBuilderService } from "../../memory/MemoryContextBuilder";
import {
  resolveMemoryInjection,
  type MemoryLayerDecision,
} from "../../memory/MemoryInjectionPolicy";
import { buildSalientTaskEventCapture } from "../../memory/memory-capture-salience";
import { MemoryRepoContext } from "../../memory/repo/MemoryRepoContext";

function createExecutor(): Any {
  const executor = Object.create(TaskExecutor.prototype) as Any;
  executor.task = { id: "task-1", title: "Task", prompt: "Prompt", agentConfig: {} };
  executor.workspace = { id: "ws-1", path: "/tmp/cowork-none", permissions: { read: false } };
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

function allowAll(overrides: Partial<MemoryLayerDecision> = {}): MemoryLayerDecision {
  return { ...resolveMemoryInjection({}), ...overrides };
}

describe("memory layers for prompt surfaces", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds nothing when the injection policy denies memory", async () => {
    const executor = createExecutor();
    const build = vi.spyOn(MemoryContextBuilderService.prototype, "buildLayers");

    const result = await executor.buildMemoryLayersForPrompt(
      resolveMemoryInjection({ gatewayContext: "group" }),
      { surface: "chat", focus: "hello", l0: true, l1Tokens: 200 },
    );

    expect(result).toEqual({ l0: "", l1: "", repo: "" });
    expect(build).not.toHaveBeenCalled();
  });

  it("wraps L0/L1 in their own tags and records one memory_used event per ref set", async () => {
    const executor = createExecutor();
    executor.emitEvent = vi.fn();
    vi.spyOn(MemoryContextBuilderService.prototype, "buildLayers").mockResolvedValue({
      l0: { layer: "l0", text: "MEMORY\n- rule", refs: ["memory:a"], tokens: 4, truncated: false },
      l1: {
        layer: "l1",
        text: "Relevant\n- fact",
        refs: ["memory:b"],
        tokens: 4,
        truncated: false,
      },
      source: "memory_items",
    });
    const markUsed = vi
      .spyOn(MemoryContextBuilderService.prototype, "markUsed")
      .mockResolvedValue(undefined);
    const options = { surface: "plan", focus: "deploy", l0: true, l1Tokens: 200 };

    const first = await executor.buildMemoryLayersForPrompt(allowAll(), options);
    await executor.buildMemoryLayersForPrompt(allowAll(), options);

    expect(first.l0).toMatch(/^<cowork_hot_memory>\nMEMORY/);
    expect(first.l1).toMatch(/^<cowork_relevant_memory>\nRelevant/);
    expect(executor.emitEvent).toHaveBeenCalledTimes(1);
    expect(executor.emitEvent).toHaveBeenCalledWith("memory_used", {
      surface: "plan",
      refs: ["memory:a", "memory:b"],
      source: "memory_items",
    });
    expect(markUsed).toHaveBeenCalledTimes(1);
    expect(markUsed).toHaveBeenCalledWith(["memory:a", "memory:b"]);
  });

  it("adds the memory folder block next to L0 and has L0/L1 skip its facts", async () => {
    const executor = createExecutor();
    executor.emitEvent = vi.fn();
    const repoBuild = vi.spyOn(MemoryRepoContext.prototype, "build").mockResolvedValue({
      text: "<cowork_memory_repo>\n- Prefers tea\n</cowork_memory_repo>",
      refs: ["repo:MEMORY.md#L3"],
      hashes: ["h-tea"],
      version: "v1",
      tokens: 10,
    });
    const build = vi.spyOn(MemoryContextBuilderService.prototype, "buildLayers").mockResolvedValue({
      l0: { layer: "l0", text: "MEMORY\n- rule", refs: ["memory:a"], tokens: 4, truncated: false },
      l1: null,
      source: "memory_items",
    });
    vi.spyOn(MemoryContextBuilderService.prototype, "markUsed").mockResolvedValue(undefined);
    const decision = resolveMemoryInjection({ memoryRepoEnabled: true });

    const chat = await executor.buildMemoryLayersForPrompt(decision, {
      surface: "chat",
      focus: "tea",
      l0: true,
      l1Tokens: 200,
    });
    expect(repoBuild).toHaveBeenCalledWith({ workspaceId: "ws-1" });
    expect(chat.repo).toMatch(/^<cowork_memory_repo>/);
    expect(build).toHaveBeenCalledWith(expect.objectContaining({ excludeHashes: ["h-tea"] }));
    expect(executor.emitEvent).toHaveBeenCalledWith("memory_used", {
      surface: "memory_repo",
      refs: ["repo:MEMORY.md#L3"],
      source: "memory_repo",
    });

    // Step turns pin the block instead: no repo text, but L1 still skips its facts.
    const step = await executor.buildMemoryLayersForPrompt(decision, {
      surface: "step",
      focus: "tea",
      l0: false,
      l1Tokens: 200,
    });
    expect(step.repo).toBe("");
    expect(build).toHaveBeenLastCalledWith(expect.objectContaining({ excludeHashes: ["h-tea"] }));

    // Without the layer the folder is never read.
    repoBuild.mockClear();
    const off = await executor.buildMemoryLayersForPrompt(allowAll(), {
      surface: "chat",
      focus: "tea",
      l0: true,
      l1Tokens: 200,
    });
    expect(off.repo).toBe("");
    expect(repoBuild).not.toHaveBeenCalled();
  });

  it("reports the same refs again in a new turn, so each reply can show what it used", async () => {
    const executor = createExecutor();
    executor.emitEvent = vi.fn();
    vi.spyOn(MemoryContextBuilderService.prototype, "buildLayers").mockResolvedValue({
      l0: { layer: "l0", text: "MEMORY\n- rule", refs: ["memory:a"], tokens: 4, truncated: false },
      l1: null,
      source: "memory_items",
    });
    vi.spyOn(MemoryContextBuilderService.prototype, "markUsed").mockResolvedValue(undefined);
    const options = { surface: "step", focus: "deploy", l0: true, l1Tokens: 200 };

    await executor.buildMemoryLayersForPrompt(allowAll(), options);
    await executor.buildMemoryLayersForPrompt(allowAll(), options);
    expect(executor.emitEvent).toHaveBeenCalledTimes(1);
    executor.resetMemoryUsedAttribution();
    await executor.buildMemoryLayersForPrompt(allowAll(), options);
    expect(executor.emitEvent).toHaveBeenCalledTimes(2);
  });

  it("uses the undecorated prompt as the memory query", () => {
    const executor = createExecutor();
    executor.task.rawPrompt = "";
    executor.task.prompt =
      "Fix the login bug\n\n[AGENT_STRATEGY_CONTEXT_V1]\nintent=execution\n[/AGENT_STRATEGY_CONTEXT_V1]";

    expect(executor.getMemoryQueryPrompt()).toBe("Fix the login bug");
  });

  it("never captures memory_used events into the archive", () => {
    expect(
      buildSalientTaskEventCapture("memory_used", { surface: "step", refs: ["memory:a"] }),
    ).toBeNull();
  });
});

describe("pinned profile block", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the builder's L0 in the profile tag, and nothing for a group chat", async () => {
    mockFeatures();
    vi.spyOn(MemoryService, "getSettings").mockResolvedValue({ enabled: true } as Any);
    vi.spyOn(MemoryContextBuilderService.prototype, "buildLayers").mockResolvedValue({
      l0: {
        layer: "l0",
        text: "MEMORY\n- Prefers tea",
        refs: ["memory:x"],
        tokens: 5,
        truncated: false,
      },
      l1: null,
      source: "memory_items",
    });
    const executor = createExecutor();
    executor.emitEvent = vi.fn();

    const block = await executor.buildUserProfileBlock();
    expect(block.startsWith("<cowork_user_profile>")).toBe(true);
    expect(block).toContain("Prefers tea");
    expect(block.endsWith("</cowork_user_profile>")).toBe(true);

    executor.task.agentConfig = { gatewayContext: "group" };
    expect(await executor.buildUserProfileBlock()).toBe("");
  });

  it("is empty for a <no-memory> task and for a memory-off workspace", async () => {
    mockFeatures();
    const build = vi.spyOn(MemoryContextBuilderService.prototype, "buildLayers");
    const executor = createExecutor();

    vi.spyOn(MemoryService, "getSettings").mockResolvedValue({ enabled: true } as Any);
    executor.task.rawPrompt = "Draft the email <no-memory>";
    expect(await executor.buildUserProfileBlock()).toBe("");

    executor.task.rawPrompt = "Draft the email";
    executor.memoryPolicySettingsCache = undefined;
    vi.spyOn(MemoryService, "getSettings").mockResolvedValue({
      enabled: true,
      privacyMode: "disabled",
    } as Any);
    expect(await executor.buildUserProfileBlock()).toBe("");
    expect(build).not.toHaveBeenCalled();
  });
});
