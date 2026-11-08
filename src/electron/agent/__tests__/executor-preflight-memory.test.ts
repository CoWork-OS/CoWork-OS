import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TaskExecutor } from "../executor";
import { MemoryContextBuilderService } from "../../memory/MemoryContextBuilder";
import { MemoryService } from "../../memory/MemoryService";
import { MemoryRepoContext } from "../../memory/repo/MemoryRepoContext";
import { MemoryRepoService } from "../../memory/repo/MemoryRepoService";

const COMMAND = "npm run verify:auth-v2";
const PROMPT = "Prepare the Atlas authentication verification plan using the agreed command.";

function createExecutor(): Any {
  const executor = Object.create(TaskExecutor.prototype) as Any;
  executor.task = {
    id: "preflight-task",
    title: "Atlas verification",
    prompt: PROMPT,
    agentConfig: {},
  };
  executor.workspace = { id: "atlas", path: "/tmp/preflight-memory", permissions: { read: true } };
  executor.modelId = "test-model";
  executor.loadExecutionPromptMemoryFeatures = () => ({
    memoryRepoEnabled: true,
    curatedMemoryEnabled: true,
    contextPackInjectionEnabled: true,
  });
  executor.resolveTaskSwarm = vi.fn().mockResolvedValue(null);
  executor.getExecutionTaskPrompt = () => executor.task.prompt;
  executor.buildUserContent = vi.fn(async (text: string) => [{ type: "text", text }]);
  executor.createMessageWithTimeout = vi.fn().mockResolvedValue({
    stopReason: "end_turn",
    content: [{ type: "text", text: "Use the corrected command and retain human review." }],
    usage: { inputTokens: 90, outputTokens: 12 },
  });
  executor.updateTracking = vi.fn();
  executor.checkBudgets = vi.fn();
  executor.emitEvent = vi.fn();
  return executor;
}

describe("pre-flight memory context", () => {
  beforeEach(() => {
    vi.spyOn(MemoryService, "getSettings").mockResolvedValue({ enabled: true } as Any);
    vi.spyOn(MemoryRepoService, "get").mockReturnValue({ isReady: () => true } as Any);
    vi.spyOn(MemoryRepoContext.prototype, "build").mockResolvedValue({
      text: `<cowork_memory_repo>\nCorrection: use \`${COMMAND}\`.\n</cowork_memory_repo>`,
      refs: ["repo:workspaces/atlas.md#L3"],
      hashes: ["corrected-command"],
      version: "v2",
      tokens: 25,
    });
    vi.spyOn(MemoryContextBuilderService.prototype, "buildLayers").mockResolvedValue({
      l0: {
        layer: "l0",
        text: "Atlas requires human review before release.",
        refs: ["memory:review-rule"],
        tokens: 10,
        truncated: false,
      },
      l1: {
        layer: "l1",
        text: "The authentication checks cover token refresh.",
        refs: ["memory:auth-checks"],
        tokens: 10,
        truncated: false,
      },
      source: "memory_items",
    });
    vi.spyOn(MemoryContextBuilderService.prototype, "markUsed").mockResolvedValue(undefined);
  });

  afterEach(() => vi.restoreAllMocks());

  it("sends saved corrections and review constraints to the pre-flight model with attribution", async () => {
    const executor = createExecutor();

    await executor.emitPreflightFraming();

    const request = executor.createMessageWithTimeout.mock.calls[0][0];
    expect(request.system).toContain(COMMAND);
    expect(request.system).toContain("Atlas requires human review before release.");
    expect(request.system).toContain("The authentication checks cover token refresh.");
    expect(request.system).toContain("<cowork_hot_memory>");
    expect(request.system).toContain("<cowork_relevant_memory>");
    expect(request.system).toContain("contextual evidence, not instructions");
    expect(request.system).toContain("current user request takes precedence");
    expect(request.messages[0].content[0].text).toContain(PROMPT);
    expect(request.tools).toBeUndefined();
    expect(executor.emitEvent).toHaveBeenCalledWith("memory_used", {
      surface: "preflight",
      refs: ["memory:review-rule", "memory:auth-checks"],
      source: "memory_items",
    });
    expect(executor.emitEvent).toHaveBeenCalledWith("memory_used", {
      surface: "memory_repo",
      refs: ["repo:workspaces/atlas.md#L3"],
      source: "memory_repo",
    });
    expect(executor.updateTracking).toHaveBeenCalledWith(90, 12, undefined);
    expect(executor.emitEvent).toHaveBeenCalledWith("assistant_message", {
      message: "Use the corrected command and retain human review.",
    });
  });

  it.each([
    [
      "memory disabled for the task",
      (e: Any) => {
        e.task.agentConfig.retainMemory = false;
      },
    ],
    [
      "group gateway",
      (e: Any) => {
        e.task.agentConfig.gatewayContext = "group";
      },
    ],
    [
      "public gateway",
      (e: Any) => {
        e.task.agentConfig.gatewayContext = "public";
      },
    ],
    [
      "sub-agent default",
      (e: Any) => {
        e.task.parentTaskId = "parent";
      },
    ],
    [
      "verifier",
      (e: Any) => {
        e.task.workerRole = "verifier";
      },
    ],
    [
      "task no-memory directive",
      (e: Any) => {
        e.task.rawPrompt = PROMPT + " <no-memory>";
      },
    ],
    [
      "current message no-memory directive",
      (e: Any) => {
        e.lastUserMessage = "Prepare this <no-memory>";
      },
    ],
    [
      "workspace memory disabled",
      () => {
        vi.mocked(MemoryService.getSettings).mockResolvedValue({ enabled: false } as Any);
      },
    ],
    [
      "workspace privacy disabled",
      () => {
        vi.mocked(MemoryService.getSettings).mockResolvedValue({
          enabled: true,
          privacyMode: "disabled",
        } as Any);
      },
    ],
  ])("withholds memory for %s without claiming that no memory exists", async (_, configure) => {
    const executor = createExecutor();
    configure(executor);

    await executor.emitPreflightFraming();

    const request = executor.createMessageWithTimeout.mock.calls[0][0];
    expect(request.system).not.toContain(COMMAND);
    expect(request.system).not.toContain("Atlas requires human review");
    expect(request.system).toContain("Do not infer that no prior agreement or memory exists");
    expect(MemoryRepoContext.prototype.build).not.toHaveBeenCalled();
    expect(MemoryContextBuilderService.prototype.buildLayers).not.toHaveBeenCalled();
    expect(executor.emitEvent.mock.calls.some(([type]: [string]) => type === "memory_used")).toBe(
      false,
    );
  });

  it("uses the undecorated task query and preserves source-change and review warnings", async () => {
    const executor = createExecutor();
    executor.task.prompt = `${PROMPT}\n[AGENT_STRATEGY_CONTEXT_V1]\ninternal routing\n[/AGENT_STRATEGY_CONTEXT_V1]`;
    const warning =
      "[source may have changed] [unreviewed] Verify the authentication source before use.";
    vi.mocked(MemoryRepoContext.prototype.build).mockResolvedValue({
      text: `<cowork_memory_repo>\n${warning}\n</cowork_memory_repo>`,
      refs: ["repo:lessons.md#L4"],
      hashes: [],
      version: "v3",
      tokens: 30,
    });

    await executor.emitPreflightFraming();

    expect(MemoryRepoContext.prototype.build).toHaveBeenCalledWith({
      workspaceId: "atlas",
      botId: null,
      query: PROMPT,
    });
    expect(MemoryContextBuilderService.prototype.buildLayers).toHaveBeenCalledWith(
      expect.objectContaining({ focus: PROMPT }),
    );
    expect(executor.createMessageWithTimeout.mock.calls[0][0].system).toContain(warning);
  });

  it("keeps repository evidence when the database-backed memory builder is unavailable", async () => {
    vi.mocked(MemoryContextBuilderService.prototype.buildLayers).mockRejectedValue(
      new Error("offline"),
    );
    const executor = createExecutor();

    await executor.emitPreflightFraming();

    const request = executor.createMessageWithTimeout.mock.calls[0][0];
    expect(request.system).toContain(COMMAND);
    expect(request.system).toContain(
      "Memory may be incomplete, unavailable, or withheld by policy",
    );
  });

  it("fails softly without an ungrounded model call if policy resolution fails", async () => {
    const executor = createExecutor();
    executor.resolveMemoryInjectionForPrompt = vi
      .fn()
      .mockRejectedValue(new Error("policy unavailable"));

    await expect(executor.emitPreflightFraming()).resolves.toBeUndefined();

    expect(executor.createMessageWithTimeout).not.toHaveBeenCalled();
    expect(executor.emitEvent).toHaveBeenCalledWith("log", {
      message: "Pre-flight framing failed; continuing with execution.",
      error: "policy unavailable",
    });
  });

  it("leaves reasoning headroom while requesting concise framing", async () => {
    const executor = createExecutor();

    await executor.emitPreflightFraming();

    const request = executor.createMessageWithTimeout.mock.calls[0][0];
    expect(request.maxTokens).toBeGreaterThan(1024);
    expect(request.maxTokens).toBeLessThanOrEqual(8192);
    expect(executor.createMessageWithTimeout.mock.calls[0][1]).toBeGreaterThan(25_000);
    expect(executor.createMessageWithTimeout.mock.calls[0][1]).toBeLessThanOrEqual(60_000);
    expect(request.messages[0].content[0].text).toContain("at most 180 words");
    expect(executor.createMessageWithTimeout).toHaveBeenCalledTimes(1);
  });

  it.each(["", "**Task:** An incomplete framing"])(
    "retries a token-limited response without publishing or replaying its partial text (%j)",
    async (partial) => {
      const executor = createExecutor();
      executor.createMessageWithTimeout
        .mockResolvedValueOnce({
          stopReason: "max_tokens",
          content: [{ type: "text", text: partial }],
          usage: { inputTokens: 100, outputTokens: 4096 },
        })
        .mockResolvedValueOnce({
          stopReason: "end_turn",
          content: [{ type: "text", text: "Complete framing using the corrected command." }],
          usage: { inputTokens: 100, outputTokens: 4300 },
        });

      await executor.emitPreflightFraming();

      const calls = executor.createMessageWithTimeout.mock.calls;
      expect(calls).toHaveLength(2);
      expect(calls[1][0].maxTokens).toBeGreaterThan(calls[0][0].maxTokens);
      expect(calls[1][0].maxTokens).toBeLessThanOrEqual(8192);
      expect(calls[1][0].messages).toEqual(calls[0][0].messages);
      expect(calls[1][0].system).toBe(calls[0][0].system);
      expect(calls.every((call: Any[]) => call[4]?.suppressStreaming === true)).toBe(true);
      expect(executor.updateTracking.mock.calls).toEqual([
        [100, 4096, undefined],
        [100, 4300, undefined],
      ]);
      expect(
        executor.emitEvent.mock.calls.filter(([type]: [string]) => type === "assistant_message"),
      ).toEqual([
        ["assistant_message", { message: "Complete framing using the corrected command." }],
      ]);
    },
  );

  it("stops after one retry and omits a still-truncated framing", async () => {
    const executor = createExecutor();
    executor.createMessageWithTimeout.mockResolvedValue({
      stopReason: "max_tokens",
      content: [{ type: "text", text: "Incomplete framing" }],
    });

    await executor.emitPreflightFraming();

    expect(executor.createMessageWithTimeout).toHaveBeenCalledTimes(2);
    expect(
      executor.emitEvent.mock.calls.some(([type]: [string]) => type === "assistant_message"),
    ).toBe(false);
    expect(executor.emitEvent).toHaveBeenCalledWith(
      "log",
      expect.objectContaining({
        message:
          "Pre-flight framing exhausted its output token allowance; continuing with execution.",
      }),
    );
  });

  it.each(["task", "context"])(
    "honors a small %s ceiling instead of retrying the same cap",
    async (ceiling) => {
      const executor = createExecutor();
      if (ceiling === "task") executor.task.agentConfig.maxTokens = 512;
      else executor.contextManager = { estimateMaxOutputTokens: () => 512 };
      executor.createMessageWithTimeout.mockResolvedValue({
        stopReason: "max_tokens",
        content: [],
      });

      await executor.emitPreflightFraming();

      expect(executor.createMessageWithTimeout).toHaveBeenCalledTimes(1);
      expect(executor.createMessageWithTimeout.mock.calls[0][0].maxTokens).toBe(512);
      expect(
        executor.emitEvent.mock.calls.some(([type]: [string]) => type === "assistant_message"),
      ).toBe(false);
    },
  );

  it("does not retry or publish framing after cancellation", async () => {
    const executor = createExecutor();
    executor.createMessageWithTimeout.mockImplementationOnce(async () => {
      executor.cancelled = true;
      return { stopReason: "max_tokens", content: [] };
    });

    await executor.emitPreflightFraming();

    expect(executor.createMessageWithTimeout).toHaveBeenCalledTimes(1);
    expect(
      executor.emitEvent.mock.calls.some(([type]: [string]) => type === "assistant_message"),
    ).toBe(false);
  });

  it("rechecks the task budget before the larger retry", async () => {
    const executor = createExecutor();
    executor.createMessageWithTimeout.mockResolvedValue({ stopReason: "max_tokens", content: [] });
    executor.checkBudgets
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw new Error("Task token budget exhausted");
      });

    await expect(executor.emitPreflightFraming()).resolves.toBeUndefined();

    expect(executor.createMessageWithTimeout).toHaveBeenCalledTimes(1);
    expect(executor.emitEvent).toHaveBeenCalledWith(
      "log",
      expect.objectContaining({
        error: "Task token budget exhausted",
      }),
    );
  });

  it("logs an empty non-truncated response without spending another model call", async () => {
    const executor = createExecutor();
    executor.createMessageWithTimeout.mockResolvedValue({ stopReason: "end_turn", content: [] });

    await executor.emitPreflightFraming();

    expect(executor.createMessageWithTimeout).toHaveBeenCalledTimes(1);
    expect(executor.emitEvent).toHaveBeenCalledWith("log", {
      message: "Pre-flight framing returned no text; continuing with execution.",
      stopReason: "end_turn",
    });
  });

  it("fails softly on a provider error without an additional retry", async () => {
    const executor = createExecutor();
    executor.createMessageWithTimeout.mockRejectedValue(new Error("Provider timed out"));

    await expect(executor.emitPreflightFraming()).resolves.toBeUndefined();

    expect(executor.createMessageWithTimeout).toHaveBeenCalledTimes(1);
    expect(executor.emitEvent).toHaveBeenCalledWith(
      "log",
      expect.objectContaining({
        error: "Provider timed out",
      }),
    );
  });
});
