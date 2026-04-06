import { describe, expect, it, vi } from "vitest";
import { TaskExecutor } from "../executor";
import { AcpxRuntimeUnavailableError } from "../AcpxRuntimeRunner";

describe("TaskExecutor entrypoint guards", () => {
  it("serializes execute/sendMessage via lifecycle mutex wrappers", async () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    const runExclusive = vi.fn(async (fn: () => Promise<void>) => fn());

    executor.lifecycleMutex = { runExclusive };
    executor.executeUnlocked = vi.fn(async () => undefined);
    executor.sendMessageUnlocked = vi.fn(async () => undefined);

    await executor.execute();
    await executor.sendMessage("hi");

    expect(runExclusive).toHaveBeenCalledTimes(2);
    expect(executor.executeUnlocked).toHaveBeenCalledTimes(1);
    expect(executor.sendMessageUnlocked).toHaveBeenCalledWith("hi", undefined);
  });

  it("routes executeStep through the unified branch", async () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    const step = { id: "s1", description: "do work", status: "pending" };

    executor.executeStepUnified = vi.fn(async () => undefined);
    executor.executeStepLegacy = vi.fn(async () => undefined);
    await executor.executeStep(step);
    expect(executor.executeStepUnified).toHaveBeenCalledWith(step);
    expect(executor.executeStepLegacy).not.toHaveBeenCalled();
  });

  it("routes sendMessageUnlocked through the unified branch", async () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;

    executor.sendMessageUnified = vi.fn(async () => undefined);
    executor.sendMessageLegacy = vi.fn(async () => undefined);
    await executor.sendMessageUnlocked("hello");
    expect(executor.sendMessageUnified).toHaveBeenCalledWith("hello", undefined);
    expect(executor.sendMessageLegacy).not.toHaveBeenCalled();
  });

  it("routes sendMessageUnlocked through the acpx runtime branch when configured", async () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;

    executor.task = {
      agentConfig: {
        externalRuntime: {
          kind: "acpx",
          agent: "codex",
          sessionMode: "persistent",
          outputMode: "json",
          permissionMode: "approve-reads",
        },
      },
    };
    executor.isAcpxExternalRuntimeTask = vi.fn(() => true);
    executor.sendMessageWithAcpxRuntime = vi.fn(async () => undefined);
    executor.disableExternalRuntimeForFallback = vi.fn();
    executor.sendMessageUnified = vi.fn(async () => undefined);
    executor.sendMessageLegacy = vi.fn(async () => undefined);

    await executor.sendMessageUnlocked("hello");

    expect(executor.sendMessageWithAcpxRuntime).toHaveBeenCalledWith("hello", undefined);
    expect(executor.sendMessageUnified).not.toHaveBeenCalled();
    expect(executor.sendMessageLegacy).not.toHaveBeenCalled();
  });

  it("falls back to native sendMessage flow when acpx is unavailable", async () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;

    executor.task = {
      agentConfig: {
        externalRuntime: {
          kind: "acpx",
          agent: "codex",
          sessionMode: "persistent",
          outputMode: "json",
          permissionMode: "approve-reads",
        },
      },
    };
    executor.isAcpxExternalRuntimeTask = vi.fn(() => true);
    executor.sendMessageWithAcpxRuntime = vi.fn(async () => {
      throw new AcpxRuntimeUnavailableError();
    });
    executor.disableExternalRuntimeForFallback = vi.fn();
    executor.sendMessageUnified = vi.fn(async () => undefined);
    executor.sendMessageLegacy = vi.fn(async () => undefined);

    await executor.sendMessageUnlocked("hello");

    expect(executor.disableExternalRuntimeForFallback).toHaveBeenCalledTimes(1);
    expect(executor.sendMessageUnified).toHaveBeenCalledWith("hello", undefined);
  });

  it("deterministically delegates explicit Claude child-task requests via spawn_agent", async () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;

    executor.task = {
      id: "task-1",
      title: "Use Claude Code for this task. Create a child task...",
      prompt:
        "Use Claude Code for this task. Create a child task via acpx, have it inspect the repo and tell me what CoWork OS is at a high level. Read-only only, no edits.",
      rawPrompt:
        "Use Claude Code for this task. Create a child task via acpx, have it inspect the repo and tell me what CoWork OS is at a high level. Read-only only, no edits.",
      agentConfig: {},
    };
    executor.isAcpxExternalRuntimeTask = vi.fn(() => false);
    executor.toolRegistry = {
      executeTool: vi.fn(async () => ({
        success: true,
        task_id: "child-1",
        message: "Agent completed successfully",
        result: "CoWork OS is an Electron desktop app with agent orchestration.",
      })),
    };
    executor.emitEvent = vi.fn();
    executor.finalizeTaskBestEffort = vi.fn();

    const handled = await (TaskExecutor as Any).prototype.maybeHandleExplicitClaudeCodeDelegation.call(
      executor,
    );

    expect(handled).toBe(true);
    expect(executor.toolRegistry.executeTool).toHaveBeenCalledWith(
      "spawn_agent",
      expect.objectContaining({
        runtime: "acpx",
        runtime_agent: "claude",
        wait: true,
      }),
    );
    expect(executor.emitEvent).toHaveBeenCalledWith("assistant_message", {
      message: "CoWork OS is an Electron desktop app with agent orchestration.",
    });
    expect(executor.finalizeTaskBestEffort).toHaveBeenCalledWith(
      "CoWork OS is an Electron desktop app with agent orchestration.",
      "Explicit Claude child-task delegation completed.",
    );
  });

  it("does not delegate to Claude when the user prompt does not explicitly say Claude Code", async () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;

    executor.task = {
      id: "task-1",
      title: "Create an executive brief",
      prompt: "Internal prompt may mention Claude Code, but the user did not ask for it.",
      rawPrompt:
        "Create an executive brief on the competitive landscape and list the top 5 risks and actions by priority.",
      userPrompt:
        "Create an executive brief on the competitive landscape and list the top 5 risks and actions by priority.",
      agentConfig: {},
    };
    executor.isAcpxExternalRuntimeTask = vi.fn(() => false);
    executor.toolRegistry = {
      executeTool: vi.fn(),
    };
    executor.emitEvent = vi.fn();

    const handled = await (TaskExecutor as Any).prototype.maybeHandleExplicitClaudeCodeDelegation.call(
      executor,
    );

    expect(handled).toBe(false);
    expect(executor.toolRegistry.executeTool).not.toHaveBeenCalled();
  });

  it("does not delegate to Claude when only internal or title text mentions Claude Code", async () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;

    executor.task = {
      id: "task-1",
      title: "Use Claude Code for this task",
      prompt:
        "Use Claude Code for this task. Create a child task via acpx and do the work automatically.",
      rawPrompt: "Create an executive brief about the market and prioritize the main risks.",
      userPrompt: "Create an executive brief about the market and prioritize the main risks.",
      agentConfig: {},
    };
    executor.isAcpxExternalRuntimeTask = vi.fn(() => false);
    executor.toolRegistry = {
      executeTool: vi.fn(),
    };
    executor.emitEvent = vi.fn();

    const handled = await (TaskExecutor as Any).prototype.maybeHandleExplicitClaudeCodeDelegation.call(
      executor,
    );

    expect(handled).toBe(false);
    expect(executor.toolRegistry.executeTool).not.toHaveBeenCalled();
  });

  it("normalizes explicit Claude child task prompts into imperative instructions", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.extractCurrentTaskText = (value: unknown) =>
      typeof value === "string" ? value.trim() : "";

    const prompt = (TaskExecutor as Any).prototype.deriveClaudeChildTaskPrompt.call(
      executor,
      "Use Claude Code for this task. Create a child task via acpx that returns a single word: hello world.\n\n[AGENT_STRATEGY_CONTEXT_V1]\nintent=execution\n[/AGENT_STRATEGY_CONTEXT_V1]",
      "Use Claude Code for this task. Create a child task...",
    );

    expect(prompt).toBe("Return a single word: hello world.");
  });

  it("does not fall back when Claude acpx is unavailable", async () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;

    executor.task = {
      agentConfig: {
        externalRuntime: {
          kind: "acpx",
          agent: "claude",
          sessionMode: "persistent",
          outputMode: "json",
          permissionMode: "approve-reads",
        },
      },
    };
    executor.isAcpxExternalRuntimeTask = vi.fn(() => true);
    executor.sendMessageWithAcpxRuntime = vi.fn(async () => {
      throw new AcpxRuntimeUnavailableError();
    });
    executor.disableExternalRuntimeForFallback = vi.fn();
    executor.sendMessageUnified = vi.fn(async () => undefined);
    executor.sendMessageLegacy = vi.fn(async () => undefined);
    executor.getAcpxExternalRuntimeConfig = vi.fn(
      () => executor.task.agentConfig.externalRuntime,
    );

    await expect(executor.sendMessageUnlocked("hello")).rejects.toThrow(
      "Claude Code acpx runtime unavailable for follow-up",
    );
    expect(executor.disableExternalRuntimeForFallback).not.toHaveBeenCalled();
    expect(executor.sendMessageUnified).not.toHaveBeenCalled();
  });

  it("finalizeFollowUpCompletion syncs task row and in-memory task state", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.task = {
      id: "task-follow-up",
      status: "executing",
      error: "old error",
      terminalStatus: "failed",
      failureClass: "contract_error",
      resultSummary: "older summary",
      semanticSummary: "Opened canvas",
    };
    executor.bestKnownOutcome = {
      summary: "fresh summary",
      terminalStatus: "ok",
      failureClass: undefined,
      outputSummary: { outputCount: 1, fileCount: 1, files: [] },
    };
    executor.buildResultSummary = vi.fn(() => "fresh summary");
    executor.getContentFallback = vi.fn(() => "");
    executor.daemon = {
      updateTask: vi.fn(),
    };
    executor.emitEvent = vi.fn();

    (TaskExecutor as Any).prototype.finalizeFollowUpCompletion.call(
      executor,
      "Follow-up completed (24 tool calls)",
      { clearTerminalFailure: true },
    );

    expect(executor.task.status).toBe("completed");
    expect(typeof executor.task.completedAt).toBe("number");
    expect(executor.task.error).toBeUndefined();
    expect(executor.task.terminalStatus).toBeUndefined();
    expect(executor.task.failureClass).toBeUndefined();
    expect(executor.task.resultSummary).toBe("fresh summary");
    expect(executor.daemon.updateTask).toHaveBeenCalledWith(
      "task-follow-up",
      expect.objectContaining({
        status: "completed",
        error: null,
        terminalStatus: undefined,
        failureClass: undefined,
        resultSummary: "fresh summary",
        semanticSummary: "Opened canvas",
        bestKnownOutcome: executor.bestKnownOutcome,
      }),
    );
    expect(executor.emitEvent).toHaveBeenCalledWith(
      "task_completed",
      expect.objectContaining({
        message: "Follow-up completed (24 tool calls)",
        resultSummary: "fresh summary",
        semanticSummary: "Opened canvas",
      }),
    );
  });

  it("finalizeFollowUpFailure syncs task row and emits a terminal failed status", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.task = {
      id: "task-follow-up-failed",
      status: "executing",
      error: undefined,
      semanticSummary: "Verified markdown targets",
    };
    executor.bestKnownOutcome = {
      summary: "Verification failed after follow-up",
      terminalStatus: "failed",
      failureClass: "contract_error",
      outputSummary: { outputCount: 1, fileCount: 1, files: [] },
    };
    executor.applyRuntimeTaskProjectionToTask = vi.fn(() => ({
      continuationCount: 1,
      continuationWindow: 1,
      lifetimeTurnsUsed: 24,
      compactionCount: 0,
      noProgressStreak: 0,
    }));
    executor.getCompletionProjectionFields = vi.fn(() => ({
      semanticSummary: "Verified markdown targets",
    }));
    executor.daemon = {
      failTask: vi.fn(),
    };
    executor.emitEvent = vi.fn();

    (TaskExecutor as Any).prototype.finalizeFollowUpFailure.call(
      executor,
      new Error("Task failed: verification mismatch"),
    );

    expect(executor.task.status).toBe("failed");
    expect(typeof executor.task.completedAt).toBe("number");
    expect(executor.task.error).toBe("Task failed: verification mismatch");
    expect(executor.daemon.failTask).toHaveBeenCalledWith(
      "task-follow-up-failed",
      "Task failed: verification mismatch",
      expect.objectContaining({
        completedAt: expect.any(Number),
        semanticSummary: "Verified markdown targets",
        bestKnownOutcome: executor.bestKnownOutcome,
        continuationCount: 1,
        continuationWindow: 1,
        lifetimeTurnsUsed: 24,
      }),
    );
    expect(executor.emitEvent).toHaveBeenCalledWith(
      "task_status",
      expect.objectContaining({
        status: "failed",
        message: "Task failed: verification mismatch",
        terminalStatus: "failed",
        semanticSummary: "Verified markdown targets",
      }),
    );
  });

  it("prefers explicit step artifact extensions over broader task-level artifact hints", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.task = {
      title: "KB verification",
      prompt:
        'Reference text may mention markdown files, slide decks, and ".pptx" outputs, but this step verifies explicit Markdown targets only.',
      rawPrompt:
        'Reference text may mention markdown files, slide decks, and ".pptx" outputs, but this step verifies explicit Markdown targets only.',
    };
    executor.inferRequiredArtifactExtensions = vi.fn(() => [".md", ".pptx"]);

    const required = (TaskExecutor as Any).prototype.getRequiredArtifactExtensionsForStep.call(
      executor,
      {
        requiredExtensions: [".md"],
      },
    );

    expect(required).toEqual([".md"]);
    expect(executor.inferRequiredArtifactExtensions).not.toHaveBeenCalled();
  });

  it("does not re-inject the same pre-finalization reminder in a follow-up loop", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;

    const first = (TaskExecutor as Any).prototype.shouldInjectPreFinalizationReminder.call(
      executor,
      "\n\nPRE-FINALIZATION REMINDER:\n- Pending verification checklist items remain: Verify manuscript word count / completion state.",
      null,
    );
    const second = (TaskExecutor as Any).prototype.shouldInjectPreFinalizationReminder.call(
      executor,
      "\n\nPRE-FINALIZATION REMINDER:\n- Pending verification checklist items remain: Verify manuscript word count / completion state.",
      "\n\nPRE-FINALIZATION REMINDER:\n- Pending verification checklist items remain: Verify manuscript word count / completion state.",
    );
    const changed = (TaskExecutor as Any).prototype.shouldInjectPreFinalizationReminder.call(
      executor,
      "\n\nPRE-FINALIZATION REMINDER:\n- Pending verification checklist items remain: Confirm compiled manuscript file.",
      "\n\nPRE-FINALIZATION REMINDER:\n- Pending verification checklist items remain: Verify manuscript word count / completion state.",
    );

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(changed).toBe(true);
  });

  it("deduplicates repeated tool-batch semantic summaries", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;

    const summary = (TaskExecutor as Any).prototype.combineBatchSemanticSummaries.call(executor, [
      { semanticSummary: "I've Verified The Chapter Set Is Complete. Now I'm Doing The Exa" },
      { semanticSummary: "I've Verified The Chapter Set Is Complete. Now I'm Doing The Exa" },
      { semanticSummary: "Count Text" },
      { semanticSummary: "Count Text" },
      { semanticSummary: "Read Chapters" },
      { semanticSummary: "Count Text" },
    ]);

    expect(summary).toBe(
      "I've Verified The Chapter Set Is Complete. Now I'm Doing The Exa · Count Text · Read Chapters",
    );
  });
});
