import { describe, expect, it, vi } from "vitest";
import { TaskExecutor } from "../executor";
import { CsvArithmeticVerifier } from "../csv-arithmetic-verifier";
import { AcpxRuntimeUnavailableError } from "../AcpxRuntimeRunner";
import { PlaybookService } from "../../memory/PlaybookService";
import { SessionRecallService } from "../../memory/SessionRecallService";
import type { Task, TaskBestKnownOutcome } from "../../../shared/types";

describe("TaskExecutor entrypoint guards", () => {
  it("catches saved CSV arithmetic through real mutation/read hooks and prevents clean completion", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.workspace = { path: "/workspace" };
    executor.lastUserMessage = "Update the quantity and grand total, then verify the saved CSV.";
    executor.fileOperationTracker = {
      invalidateFileRead: vi.fn(),
      invalidateDirectoryListing: vi.fn(),
    };
    executor.toolCallDeduplicator = { clearReadOnlyHistory: vi.fn() };
    executor.recordWebEvidence = vi.fn();
    executor.trackFileRead = vi.fn();
    executor.summarizeToolResult = vi.fn();
    executor.getSessionRuntime = () => ({ getTaskListState: () => ({ items: [] }) });
    executor.recordFileOperation("edit_file", { path: "budget.csv" }, { success: true });
    const csv =
      "item,quantity,unit_cost,total\nBooks,12,8,96\nPosters,6,3.5,21\nRefreshments,8,2.25,18\nTOTAL,,,135.50\n";
    executor.recordToolResult("read_file", { path: "budget.csv", content: csv, truncated: false });
    expect(executor.getFinalOutcomeGuardError()).toContain("expected 135.00");
    expect(executor.buildPreFinalizationReminder(undefined, Date.now())).toContain(
      "expected 135.00",
    );

    executor.task = { id: "csv-followup", status: "executing" };
    executor.applyRuntimeTaskProjectionToTask = () => ({});
    executor.daemon = { updateTask: vi.fn() };
    executor.emitEvent = vi.fn();
    executor.buildFollowUpResultSummary = () => "Updated and verified the budget.";
    executor.finalizeFollowUpCompletion("Completed");
    expect(executor.task.terminalStatus).toBe("partial_success");
    expect(executor.task.resultSummary).toContain("expected 135.00");
    expect(executor.daemon.updateTask).toHaveBeenCalledWith(
      "csv-followup",
      expect.objectContaining({
        terminalStatus: "partial_success",
        failureClass: "contract_error",
      }),
    );

    executor.recordFileOperation("edit_file", { path: "budget.csv" }, { success: true });
    executor.recordToolResult("read_file", {
      path: "budget.csv",
      content: csv.replace("135.50", "135.00"),
      truncated: false,
    });
    expect(executor.csvArithmeticVerifier.getWarning()).toBeNull();
    expect(executor.buildPreFinalizationReminder(undefined, Date.now())).toBe("");
    executor.finalizeFollowUpCompletion("Corrected");
    expect(executor.task.terminalStatus).toBeUndefined();
    executor.csvArithmeticVerifier = undefined;
    executor.lastUserMessage = "Copy the supplied CSV verbatim.";
    executor.recordFileOperation("edit_file", { path: "budget.csv" }, { success: true });
    expect(executor.csvArithmeticVerifier).toBeUndefined();
  });

  it("failed mutations and failed reads cannot establish or clear CSV verification", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.workspace = { path: "/workspace" };
    executor.recordFileOperation("edit_file", { path: "budget.csv" }, { success: false });
    expect(executor.csvArithmeticVerifier).toBeUndefined();
    executor.csvArithmeticVerifier = new CsvArithmeticVerifier("/workspace");
    executor.csvArithmeticVerifier.recordMutation("budget.csv");
    executor.csvArithmeticVerifier.recordRead(
      "budget.csv",
      "item,quantity,unit_cost,total\na,1,1,2\n",
      false,
    );
    executor.recordWebEvidence = vi.fn();
    executor.trackFileRead = vi.fn();
    executor.summarizeToolResult = vi.fn();
    executor.recordToolResult("read_file", {
      success: false,
      path: "budget.csv",
      content: "item,quantity,unit_cost,total\na,1,1,1\n",
    });
    expect(executor.csvArithmeticVerifier.getWarning()).toContain("expected 1.00");
  });

  it.each(["cancelled", "failed", "completed"])(
    "completes a successful text-only follow-up after %s",
    (previousStatus) => {
      const executor = Object.create(TaskExecutor.prototype) as Any;
      executor.task = { id: "recovery" };
      executor.daemon = { updateTaskStatus: vi.fn() };
      executor.emitEvent = vi.fn();
      executor.finalizeFollowUpCompletion = vi.fn();
      executor.finalizeSuccessfulFollowUp(previousStatus);
      expect(executor.finalizeFollowUpCompletion).toHaveBeenCalledWith("Completed via follow-up", {
        clearTerminalFailure: true,
      });
      expect(executor.daemon.updateTaskStatus).not.toHaveBeenCalled();
    },
  );

  it("preserves a paused task after an informational follow-up", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.task = { id: "paused-task" };
    executor.daemon = { updateTaskStatus: vi.fn() };
    executor.emitEvent = vi.fn();
    executor.finalizeFollowUpCompletion = vi.fn();
    executor.finalizeSuccessfulFollowUp("paused");
    expect(executor.daemon.updateTaskStatus).toHaveBeenCalledWith("paused-task", "paused");
    expect(executor.finalizeFollowUpCompletion).not.toHaveBeenCalled();
  });

  it("completes a blocked bot handoff after consuming its correlated reply", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.task = {
      id: "atlas-task",
      agentConfig: { botConversation: true },
      error: "Waiting for Scribe to reply before finishing this conversation.",
    };
    executor.daemon = { updateTaskStatus: vi.fn() };
    executor.emitEvent = vi.fn();
    executor.finalizeFollowUpCompletion = vi.fn();

    executor.finalizeSuccessfulFollowUp("blocked", 0, false, true);

    expect(executor.finalizeFollowUpCompletion).toHaveBeenCalledWith("Completed via follow-up", {
      clearTerminalFailure: true,
    });
    expect(executor.daemon.updateTaskStatus).not.toHaveBeenCalled();
  });

  it("keeps an unrelated blocked status after a text-only follow-up", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.task = {
      id: "blocked-task",
      agentConfig: { botConversation: true },
      error: "Waiting for user approval.",
    };
    executor.daemon = { updateTaskStatus: vi.fn() };
    executor.emitEvent = vi.fn();
    executor.finalizeFollowUpCompletion = vi.fn();

    executor.finalizeSuccessfulFollowUp("blocked", 0, false, true);

    expect(executor.daemon.updateTaskStatus).toHaveBeenCalledWith("blocked-task", "blocked");
    expect(executor.finalizeFollowUpCompletion).not.toHaveBeenCalled();
  });

  it("keeps the verified bot reply tool through a narrow task-intent filter", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.task = { id: "scribe-task", agentConfig: { taskIntent: "advice" } };
    executor.getEffectiveTaskDomain = () => "auto";
    executor.getToolPolicyContext = () => ({ botMessagingAuthorized: true });
    executor.hasMessagingChannelIntent = () => false;
    executor.capToolCount = (tools: Any[]) => tools;
    const tools = [{ name: "read_file" }, { name: "send_agent_message" }];

    expect(executor.applyIntentFilter(tools).map((tool: Any) => tool.name)).toEqual([
      "read_file",
      "send_agent_message",
    ]);

    executor.getToolPolicyContext = () => ({ botMessagingAuthorized: false });
    expect(executor.applyIntentFilter(tools).map((tool: Any) => tool.name)).toEqual(["read_file"]);
  });

  it("keeps verified bot messaging available for an inbound handoff without delegation keywords", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.task = {
      id: "scribe-task",
      title: "Scribe",
      prompt: "Write and edit content.",
      agentConfig: { botConversation: true, taskIntent: "chat" },
    };
    executor.lastUserMessage = "Calculate 15 times 3.5 and give the short calculation.";
    executor.hasTaskToolAllowlistConfigured = () => false;
    executor.getToolPolicyContext = () => ({
      botConversation: true,
      botTeamId: "team-1",
      botMessagingAuthorized: true,
      executionMode: "execute",
      taskDomain: "general",
      taskIntent: "chat",
    });
    executor.emitEvent = vi.fn();
    const tools = [{ name: "read_file" }, { name: "send_agent_message" }];

    expect(
      executor.applyAdaptiveToolAvailabilityFilter(tools).map((tool: Any) => tool.name),
    ).toEqual(["read_file", "send_agent_message"]);

    executor.getToolPolicyContext = () => ({
      botConversation: true,
      botTeamId: "team-1",
      botMessagingAuthorized: false,
      executionMode: "execute",
      taskDomain: "general",
      taskIntent: "chat",
    });
    expect(
      executor.applyAdaptiveToolAvailabilityFilter(tools).map((tool: Any) => tool.name),
    ).toEqual(["read_file"]);
  });

  it("does not complete a follow-up cancelled during execution", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.cancelled = true;
    executor.finalizeFollowUpCompletion = vi.fn();
    executor.finalizeSuccessfulFollowUp("completed", 2);
    expect(executor.finalizeFollowUpCompletion).not.toHaveBeenCalled();
  });

  it("scopes inherited verification requirements to the current follow-up", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    const oldItem = {
      title: "Verify cancelled command",
      kind: "verification",
      status: "pending",
      updatedAt: 100,
    };
    const state = {
      items: [oldItem],
      verificationNudgeNeeded: true,
      nudgeReason: "Old checklist needs verification",
    };
    executor.getSessionRuntime = () => ({ getTaskListState: () => state });
    executor.requiresTestRun = true;
    executor.requiresExecutionToolRun = true;
    executor.shouldEnforceVisualQARequirement = () => true;
    expect(executor.buildPreFinalizationReminder(undefined, 200)).toBe("");
    expect(state.items).toEqual([oldItem]);
    expect(executor.buildPreFinalizationReminder()).toContain("Verify cancelled command");
    expect(executor.buildPreFinalizationReminder()).toContain("real test run");
    state.items.push({ ...oldItem, title: "Verify new output", updatedAt: 201 });
    const reminder = executor.buildPreFinalizationReminder(undefined, 200);
    expect(reminder).toContain("Verify new output");
    expect(reminder).not.toContain("Verify cancelled command");
    expect(reminder).not.toContain("real test run");
  });

  it("serializes execute/sendMessage via lifecycle mutex wrappers", async () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    const runExclusive = vi.fn(async (fn: () => Promise<void>) => fn());

    executor.lifecycleMutex = { runExclusive };
    executor.executeUnlocked = vi.fn(async () => undefined);
    executor.sendMessageUnlocked = vi.fn(async () => undefined);
    executor.task = { id: "test-task" };
    executor.daemon = { getTask: vi.fn(() => undefined) };

    await executor.execute();
    await executor.sendMessage("hi");

    expect(runExclusive).toHaveBeenCalledTimes(2);
    expect(executor.executeUnlocked).toHaveBeenCalledTimes(1);
    expect(executor.sendMessageUnlocked).toHaveBeenCalledWith(
      "hi",
      undefined,
      undefined,
      undefined,
    );
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

  it("maps loop budget stops to precise step failure telemetry reasons", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    const taskStopReasons: Pick<Task, "stopReasons"> = {
      stopReasons: ["max_llm_calls", "max_recovered_responses", "max_repeated_iterations"],
    };

    expect(
      (TaskExecutor.prototype as Any).deriveStepStopReason.call(executor, {
        stepFailed: true,
        failureReason: "Step loop budget exhausted: reached the total LLM call limit.",
        awaitingUserInput: false,
        iterationCount: 4,
        maxIterations: 32,
        loopBudgetStopReason: "max_llm_calls",
      }),
    ).toBe("max_llm_calls");

    expect(
      (TaskExecutor.prototype as Any).getStepLoopBudgetFailureReason.call(
        executor,
        "max_recovered_responses",
      ),
    ).toBe("Step loop budget exhausted: reached the recovered response limit.");
    expect(taskStopReasons.stopReasons).toEqual([
      "max_llm_calls",
      "max_recovered_responses",
      "max_repeated_iterations",
    ]);
  });

  it("routes sendMessageUnlocked through the unified branch", async () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;

    executor.sendMessageUnified = vi.fn(async () => undefined);
    executor.sendMessageLegacy = vi.fn(async () => undefined);
    await executor.sendMessageUnlocked("hello");
    expect(executor.sendMessageUnified).toHaveBeenCalledWith("hello", undefined, undefined, {
      messageContext: undefined,
    });
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

    expect(executor.sendMessageWithAcpxRuntime).toHaveBeenCalledWith(
      "hello",
      undefined,
      undefined,
      undefined,
    );
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
    expect(executor.sendMessageUnified).toHaveBeenCalledWith("hello", undefined, undefined, {
      messageContext: undefined,
    });
  });

  it("cancels an admitted acpx runner even after authority is narrowed", async () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    const cancelRunner = vi.fn(async () => undefined);

    executor.abortController = new AbortController();
    executor.acpxRuntimeRunner = { cancel: cancelRunner };
    executor.isAcpxExternalRuntimeTask = vi.fn(() => true);
    executor.getAcpxRuntimeRunner = vi.fn(() => {
      throw new Error("start/follow-up authority must not gate cancellation");
    });
    executor.endDebugRuntimeSessionIfNeeded = vi.fn();
    executor.stopProgressJournal = vi.fn();
    executor.killShellProcess = vi.fn();
    executor.toolRegistry = { cancelShellSession: vi.fn(async () => undefined) };
    executor.closeAcpxRuntimeSession = vi.fn(async () => undefined);
    executor.discardProvisionalBootstrapArtifacts = vi.fn();
    executor.sandboxRunner = { cleanup: vi.fn() };

    await (TaskExecutor.prototype as Any).cancel.call(executor, "user");

    expect(executor.toolRegistry.cancelShellSession).toHaveBeenCalledTimes(1);
    expect(cancelRunner).toHaveBeenCalledTimes(1);
    expect(executor.getAcpxRuntimeRunner).not.toHaveBeenCalled();
    expect(executor.killShellProcess).toHaveBeenCalledWith(true);
  });

  it("preserves quoted assistant metadata when routing user messages through the timeline emitter", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    const updateStep = vi.fn();

    executor.task = { id: "task-1", agentConfig: {} };
    executor.timelineEmitter = { startStep: vi.fn(), updateStep };
    executor.getExternalRuntimeEventMetadata = vi.fn(() => null);

    (TaskExecutor.prototype as Any).emitEvent.call(executor, "user_message", {
      message: "Can you revise that?",
      quotedAssistantMessage: {
        eventId: "assistant-1",
        taskId: "11111111-1111-1111-1111-111111111111",
        message: "Original assistant reply",
      },
    });

    expect(updateStep).toHaveBeenCalledWith(
      {
        id: "turn:task-1",
        description: "Can you revise that?",
      },
      expect.objectContaining({
        actor: "user",
        legacyType: "user_message",
        message: "Can you revise that?",
        extraPayload: expect.objectContaining({
          quotedAssistantMessage: expect.objectContaining({
            eventId: "assistant-1",
            message: "Original assistant reply",
          }),
        }),
      }),
    );
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

    const handled = await (
      TaskExecutor as Any
    ).prototype.maybeHandleExplicitClaudeCodeDelegation.call(executor);

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

    const handled = await (
      TaskExecutor as Any
    ).prototype.maybeHandleExplicitClaudeCodeDelegation.call(executor);

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

    const handled = await (
      TaskExecutor as Any
    ).prototype.maybeHandleExplicitClaudeCodeDelegation.call(executor);

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
    executor.getAcpxExternalRuntimeConfig = vi.fn(() => executor.task.agentConfig.externalRuntime);

    await expect(executor.sendMessageUnlocked("hello")).rejects.toThrow(
      "Claude Code acpx runtime unavailable for follow-up",
    );
    expect(executor.disableExternalRuntimeForFallback).not.toHaveBeenCalled();
    expect(executor.sendMessageUnified).not.toHaveBeenCalled();
  });

  it("uses the refreshed workspace registry for execution and cancellation", async () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    const oldExecute = vi.fn(async () => ({ result: { success: true } }));
    const refreshedRegistry = {
      executeToolWithRuntime: vi.fn(async () => ({ result: { success: true } })),
      killShellProcess: vi.fn(() => true),
    };
    executor.toolExecutionCoordinator = { executeTool: oldExecute };
    executor.buildToolRegistry = vi.fn(() => refreshedRegistry);
    executor.reloadAgentPolicy = vi.fn();
    executor.getSessionRuntime = vi.fn(() => ({
      applyWorkspaceUpdate: vi.fn(),
      setPermissionMode: vi.fn(),
    }));
    executor.getDefaultPermissionMode = vi.fn(() => "default");
    executor.task = { id: "workspace-refresh" };
    executor.abortController = new AbortController();
    executor.getSchedulerSpecForTool = vi.fn(() => ({
      concurrencyClass: "exclusive",
      idempotent: false,
    }));
    executor.getToolPolicyContext = vi.fn(() => ({}));
    executor.beginToolExecutionHeartbeat = vi.fn();
    executor.emitEvent = vi.fn();
    executor.updateWorkspace({ id: "workspace", permissions: { shell: true } });
    await executor.executeToolWithHeartbeat("run_command", { command: "echo test" }, 1000);
    executor.killShellProcess(true);
    expect(oldExecute).not.toHaveBeenCalled();
    expect(refreshedRegistry.executeToolWithRuntime).toHaveBeenCalledWith(
      "run_command",
      { command: "echo test" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(refreshedRegistry.killShellProcess).toHaveBeenCalledWith(true);
  });

  it("does not finalize cancelled follow-up work as completed", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.cancelled = true;
    executor.task = { id: "cancelled-follow-up", status: "cancelled" };
    executor.applyRuntimeTaskProjectionToTask = vi.fn();
    executor.buildFollowUpResultSummary = vi.fn(() => "I will run the command");
    executor.daemon = { updateTask: vi.fn() };
    executor.emitEvent = vi.fn();
    executor.finalizeFollowUpCompletion("Follow-up completed (2 tool calls)");
    expect(executor.task.status).toBe("cancelled");
    expect(executor.daemon.updateTask).not.toHaveBeenCalled();
    expect(executor.emitEvent).not.toHaveBeenCalled();
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
    const freshSummary = "Fresh follow-up summary with useful completion details.";
    executor.bestKnownOutcome = {
      capturedAt: 1,
      resultSummary: freshSummary,
      terminalStatus: "ok",
      failureClass: undefined,
      outputSummary: { outputCount: 1, fileCount: 1, files: [] },
    } satisfies TaskBestKnownOutcome;
    executor.buildResultSummary = vi.fn(() => freshSummary);
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
    expect(executor.task.resultSummary).toBe(freshSummary);
    expect(executor.daemon.updateTask).toHaveBeenCalledWith(
      "task-follow-up",
      expect.objectContaining({
        status: "completed",
        error: null,
        terminalStatus: undefined,
        failureClass: undefined,
        resultSummary: freshSummary,
        semanticSummary: "Opened canvas",
        bestKnownOutcome: executor.bestKnownOutcome,
      }),
    );
    expect(executor.emitEvent).toHaveBeenCalledWith(
      "task_completed",
      expect.objectContaining({
        message: "Follow-up completed (24 tool calls)",
        resultSummary: freshSummary,
        semanticSummary: "Opened canvas",
      }),
    );
  });

  it("clears stale approval/input terminal markers after a completed follow-up", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.task = {
      id: "task-follow-up-approval-state",
      status: "executing",
      terminalStatus: "awaiting_approval",
      failureClass: undefined,
      resultSummary: "old result",
    };
    executor.buildResultSummary = vi.fn(() => "Approval was denied; no command was run.");
    executor.getContentFallback = vi.fn(() => "");
    executor.daemon = { updateTask: vi.fn() };
    executor.emitEvent = vi.fn();

    (TaskExecutor as Any).prototype.finalizeFollowUpCompletion.call(
      executor,
      "Follow-up completed with an approval blocker",
    );

    expect(executor.task.status).toBe("completed");
    expect(executor.task.terminalStatus).toBeUndefined();
    expect(executor.task.failureClass).toBeUndefined();
    expect(executor.daemon.updateTask).toHaveBeenCalledWith(
      "task-follow-up-approval-state",
      expect.objectContaining({
        status: "completed",
        terminalStatus: undefined,
        failureClass: undefined,
      }),
    );
  });

  it("does not bypass the bot handoff gate when a completed conversation is reopened", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.task = {
      id: "task-follow-up-bot-handoff",
      status: "executing",
      agentConfig: { botConversation: true },
    };
    executor.lastAssistantText = "Partial teammate work";
    executor.getContentFallback = vi.fn(() => "");
    executor.daemon = {
      reconcileBotHandoffBeforeFollowUpCompletion: vi.fn(() => ({
        deferred: true,
        replySent: false,
      })),
      getTask: vi.fn(() => ({
        id: "task-follow-up-bot-handoff",
        status: "blocked",
        error: "Waiting for Scribe to reply before finishing this conversation.",
      })),
      updateTask: vi.fn(),
    };
    executor.emitEvent = vi.fn();

    (TaskExecutor as Any).prototype.finalizeFollowUpCompletion.call(
      executor,
      "Follow-up completed (chat reply)",
    );

    expect(executor.daemon.reconcileBotHandoffBeforeFollowUpCompletion).toHaveBeenCalledWith(
      "task-follow-up-bot-handoff",
      "Partial teammate work",
    );
    expect(executor.task.status).toBe("blocked");
    expect(executor.daemon.updateTask).not.toHaveBeenCalled();
    expect(executor.emitEvent).toHaveBeenCalledWith(
      "task_status",
      expect.objectContaining({
        status: "blocked",
        botHandoffWaiting: true,
      }),
    );
  });

  it("does not overwrite an approval blocker when a follow-up fails", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.task = { id: "task-follow-up-blocked" };
    executor.daemon = {
      getTask: vi.fn(() => ({
        id: "task-follow-up-blocked",
        status: "blocked",
        terminalStatus: "awaiting_approval",
      })),
      updateTaskStatus: vi.fn(),
    };

    (TaskExecutor as Any).prototype.restoreFollowUpStatusAfterFailure.call(executor, "completed");

    expect(executor.daemon.updateTaskStatus).not.toHaveBeenCalled();
  });

  it("restores the prior status when a follow-up failure did not persist a blocker", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.task = { id: "task-follow-up-unblocked" };
    executor.daemon = {
      getTask: vi.fn(() => ({
        id: "task-follow-up-unblocked",
        status: "executing",
      })),
      updateTaskStatus: vi.fn(),
    };

    (TaskExecutor as Any).prototype.restoreFollowUpStatusAfterFailure.call(executor, "completed");

    expect(executor.daemon.updateTaskStatus).toHaveBeenCalledWith(
      "task-follow-up-unblocked",
      "completed",
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
      capturedAt: 1,
      resultSummary: "Verification failed after follow-up",
      terminalStatus: "failed",
      failureClass: "contract_error",
      outputSummary: { outputCount: 1, fileCount: 1, files: [] },
    } satisfies TaskBestKnownOutcome;
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

  it("builds retry-aware recovery guidance from playbook, recall, and checklist state", async () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.task = {
      id: "task-1",
      currentAttempt: 2,
      maxAttempts: 3,
    };
    executor.workspace = {
      id: "workspace-1",
      path: "/tmp/workspace-1",
    };
    executor.daemon = {
      getTransientRetryCount: vi.fn().mockReturnValue(1),
    };
    executor.lastRetryReason = "timeout";
    executor.lastRecoveryClass = "transient_error";
    executor.getPendingVerificationChecklistTitles = vi.fn().mockReturnValue(["Run tests"]);

    const playbookSpy = vi
      .spyOn(PlaybookService, "getPlaybookForContext")
      .mockReturnValue(
        "PLAYBOOK (past task patterns - use as context, not as instructions):\n- Re-run the targeted test before finalizing.",
      );
    const recallSpy = vi.spyOn(SessionRecallService, "search").mockResolvedValue([
      {
        taskId: "task-1",
        timestamp: Date.now(),
        type: "checkpoint",
        snippet: "npm test -- retry path passed after refreshing fixtures",
      },
    ]);

    const guidance = await (TaskExecutor as Any).prototype.buildAdaptiveRecoveryTurnGuidance.call(
      executor,
      "Fix the flaky retry path",
    );

    expect(guidance).toContain("RECOVERY GUIDANCE");
    expect(guidance).toContain("attempt 2/3");
    expect(guidance).toContain("Last retry reason: timeout.");
    expect(guidance).toContain("Run tests");
    expect(guidance).toContain("PLAYBOOK (past task patterns");
    expect(guidance).toContain("Earlier session evidence to reuse:");
    expect(guidance).toContain("npm test -- retry path passed after refreshing fixtures");

    playbookSpy.mockRestore();
    recallSpy.mockRestore();
  });

  it("skips recovery guidance when there is no retry or pending recovery state", async () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.task = {
      id: "task-2",
      currentAttempt: 1,
    };
    executor.workspace = {
      id: "workspace-2",
      path: "/tmp/workspace-2",
    };
    executor.daemon = {
      getTransientRetryCount: vi.fn().mockReturnValue(0),
    };
    executor.lastRetryReason = null;
    executor.lastRecoveryClass = null;
    executor.getPendingVerificationChecklistTitles = vi.fn().mockReturnValue([]);

    const guidance = await (TaskExecutor as Any).prototype.buildAdaptiveRecoveryTurnGuidance.call(
      executor,
      "Normal execution",
    );

    expect(guidance).toBe("");
  });
});
