import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskExecutor } from "../executor";
import { AgentDaemon } from "../daemon";
import { AcpxChangedPathTracker } from "../AcpxRuntimeRunner";
import { classifyAcpPromptResult } from "../runtime/acp-prompt-outcome";

describe("classifyAcpPromptResult", () => {
  const classify = (stopReason: string | undefined, assistantText = "", artifacts: string[] = []) =>
    classifyAcpPromptResult({ stopReason, assistantText, verifiedArtifactPaths: artifacts });

  it("completes end_turn with a response or with only a verified artifact", () => {
    expect(classify("end_turn", "Done.")).toMatchObject({
      kind: "completed",
      evidence: "response",
    });
    expect(classify("end_turn", "", ["out.md"])).toMatchObject({
      kind: "completed",
      evidence: "artifact",
    });
  });

  it("does not treat an empty end_turn as success", () => {
    expect(classify("end_turn", "   ")).toMatchObject({ kind: "needs_user_action" });
  });

  it.each(["max_tokens", "max_turn_requests"])(
    "%s is partial success with usable output, otherwise needs a decision",
    (reason) => {
      expect(classify(reason, "half an answer")).toMatchObject({
        kind: "partial_success",
        failureClass: "budget_exhausted",
      });
      expect(classify(reason, "", ["draft.md"])).toMatchObject({ kind: "partial_success" });
      expect(classify(reason)).toMatchObject({ kind: "needs_user_action" });
    },
  );

  it("fails refusals and missing or unknown stop reasons", () => {
    expect(classify("refusal", "I can't do that")).toMatchObject({
      kind: "failed",
      stopReason: "refusal",
    });
    expect(classify(undefined, "text")).toMatchObject({
      kind: "failed",
      failureClass: "contract_error",
      stopReason: null,
    });
    expect(classify("made_up_reason", "text")).toMatchObject({
      kind: "failed",
      failureClass: "contract_error",
      stopReason: "made_up_reason",
    });
  });

  it("reports cancelled as cancelled", () => {
    expect(classify("cancelled", "partial")).toMatchObject({ kind: "cancelled" });
  });
});

describe("AcpxChangedPathTracker", () => {
  it("records only completed edit-kind calls, merging kind and locations across updates", () => {
    const tracker = new AcpxChangedPathTracker();
    tracker.observe({
      sessionUpdate: "tool_call",
      toolCallId: "a",
      kind: "edit",
      locations: [{ path: "notes.md" }],
    });
    tracker.observe({ sessionUpdate: "tool_call_update", toolCallId: "a", status: "completed" });
    tracker.observe({
      sessionUpdate: "tool_call",
      toolCallId: "b",
      kind: "read",
      status: "completed",
      locations: [{ path: "read-only.md" }],
    });
    tracker.observe({
      sessionUpdate: "tool_call",
      toolCallId: "c",
      kind: "edit",
      status: "failed",
      locations: [{ path: "failed.md" }],
    });
    expect(tracker.changedPaths()).toEqual(["notes.md"]);
  });
});

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function acpExecutor() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "acp-outcome-"));
  tempDirs.push(workspace);
  const executor = Object.create(TaskExecutor.prototype) as Any;
  executor.task = { id: "task-acp", title: "t", prompt: "p", status: "executing" };
  executor.workspace = { path: workspace };
  executor.cancelled = false;
  executor.emitEvent = vi.fn();
  executor.getAcpxRuntimeAgentDisplayName = () => "Codex";
  executor.finalizeTaskBestEffort = vi.fn();
  executor.capturePlaybookOutcome = vi.fn();
  executor.stopProgressJournal = vi.fn();
  executor.saveConversationSnapshot = vi.fn();
  executor.persistBestKnownOutcome = vi.fn(function (this: Any, summary: string) {
    this.bestKnownOutcome = { resultSummary: summary };
  });
  executor.buildResultSummary = () => "";
  executor.applyRuntimeTaskProjectionToTask = () => ({});
  executor.emitRunSummary = vi.fn();
  executor.emitTerminalFailureOnce = vi.fn();
  executor.closeAcpxRuntimeSession = vi.fn(async () => undefined);
  executor.daemon = {
    updateTask: vi.fn(),
    recordExternalTaskCancellation: vi.fn(),
  };
  return { executor, workspace };
}

describe("TaskExecutor.applyAcpPromptResult", () => {
  it.each(["initial", "follow_up"] as const)(
    "%s: end_turn with text finalizes best-effort without explicit ok metadata",
    (phase) => {
      const { executor } = acpExecutor();
      executor.applyAcpPromptResult({ assistantText: "All done.", stopReason: "end_turn" }, phase);
      expect(executor.finalizeTaskBestEffort).toHaveBeenCalledTimes(1);
      const [summary, , metadata] = executor.finalizeTaskBestEffort.mock.calls[0];
      expect(summary).toBe("All done.");
      // No forced terminal status: verification requirements still apply.
      expect(metadata).toBeUndefined();
      expect(executor.capturePlaybookOutcome).not.toHaveBeenCalled();
    },
  );

  it.each(["initial", "follow_up"] as const)(
    "%s: tool-only output completes when the reported file exists",
    (phase) => {
      const { executor, workspace } = acpExecutor();
      fs.writeFileSync(path.join(workspace, "report.md"), "# report");
      executor.applyAcpPromptResult(
        { assistantText: "", stopReason: "end_turn", changedPaths: ["report.md"] },
        phase,
      );
      const [summary, , metadata] = executor.finalizeTaskBestEffort.mock.calls[0];
      expect(summary).toContain("report.md");
      expect(metadata).toBeUndefined();
    },
  );

  it.each(["initial", "follow_up"] as const)(
    "%s: empty output or a missing reported artifact needs user action",
    (phase) => {
      const { executor } = acpExecutor();
      executor.applyAcpPromptResult(
        {
          assistantText: "",
          stopReason: "end_turn",
          changedPaths: ["missing.md", "../outside.md"],
        },
        phase,
      );
      const [, , metadata] = executor.finalizeTaskBestEffort.mock.calls[0];
      expect(metadata).toMatchObject({
        terminalKind: "needs_user_action",
        terminalStatus: "needs_user_action",
      });
    },
  );

  it.each([
    ["initial", "max_tokens"],
    ["follow_up", "max_turn_requests"],
  ] as const)("%s: %s with partial output is budget-exhausted partial success", (phase, reason) => {
    const { executor } = acpExecutor();
    executor.applyAcpPromptResult({ assistantText: "Part one.", stopReason: reason }, phase);
    const [summary, , metadata] = executor.finalizeTaskBestEffort.mock.calls[0];
    expect(summary).toContain("Part one.");
    expect(metadata).toMatchObject({
      terminalKind: "partial_success",
      terminalStatus: "partial_success",
      failureClass: "budget_exhausted",
    });
  });

  it.each(["initial", "follow_up"] as const)(
    "%s: a limit without usable output asks for a continuation decision",
    (phase) => {
      const { executor } = acpExecutor();
      executor.applyAcpPromptResult({ assistantText: "", stopReason: "max_tokens" }, phase);
      expect(executor.finalizeTaskBestEffort.mock.calls[0][2]).toMatchObject({
        terminalKind: "needs_user_action",
      });
    },
  );

  it.each([
    ["initial", "refusal"],
    ["follow_up", undefined],
    ["initial", "unexpected_value"],
  ] as const)("%s: stop reason %s fails the task and keeps output", (phase, reason) => {
    const { executor } = acpExecutor();
    executor.applyAcpPromptResult({ assistantText: "Some text", stopReason: reason }, phase);
    expect(executor.finalizeTaskBestEffort).not.toHaveBeenCalled();
    expect(executor.daemon.updateTask).toHaveBeenCalledWith(
      "task-acp",
      expect.objectContaining({
        status: "failed",
        terminalStatus: "failed",
        failureClass: "contract_error",
        bestKnownOutcome: { resultSummary: "Some text" },
      }),
    );
    expect(executor.emitEvent).toHaveBeenCalledWith(
      "log",
      expect.objectContaining({ acpStopReason: reason ?? null, acpOutcome: "failed" }),
    );
    expect(executor.capturePlaybookOutcome).not.toHaveBeenCalled();
  });

  it.each(["initial", "follow_up"] as const)(
    "%s: external cancellation persists through the daemon, not best-effort finalization",
    (phase) => {
      const { executor } = acpExecutor();
      executor.applyAcpPromptResult({ assistantText: "partial", stopReason: "cancelled" }, phase);
      expect(executor.finalizeTaskBestEffort).not.toHaveBeenCalled();
      expect(executor.daemon.recordExternalTaskCancellation).toHaveBeenCalledWith(
        "task-acp",
        expect.stringContaining("cancelled"),
      );
      expect(executor.daemon.updateTask).toHaveBeenCalledWith("task-acp", {
        bestKnownOutcome: { resultSummary: "partial" },
      });
    },
  );

  it("a local cancellation racing a zero-exit result wins", () => {
    const { executor } = acpExecutor();
    executor.cancelled = true;
    executor.applyAcpPromptResult({ assistantText: "Done.", stopReason: "end_turn" }, "initial");
    expect(executor.finalizeTaskBestEffort).not.toHaveBeenCalled();
    expect(executor.daemon.updateTask).not.toHaveBeenCalled();
    expect(executor.daemon.recordExternalTaskCancellation).not.toHaveBeenCalled();
  });

  it("executeWithAcpxRuntime classifies the prompt, not the session create result", async () => {
    const { executor } = acpExecutor();
    const runner = {
      // Session commands legitimately carry no stop reason.
      createSession: vi.fn(async () => ({ assistantText: "" })),
      ensureSession: vi.fn(),
      prompt: vi.fn(async () => {
        executor.cancelled = true; // user cancels while the prompt is running
        return { assistantText: "late", stopReason: "end_turn" };
      }),
    };
    executor.getAcpxRuntimeRunner = () => runner;
    executor.daemon.updateTaskStatus = vi.fn();
    executor.getContractPrompt = () => "do it";
    await executor.executeWithAcpxRuntime("do it");
    expect(runner.prompt).toHaveBeenCalledTimes(1);
    expect(executor.finalizeTaskBestEffort).not.toHaveBeenCalled();
  });
});

describe("AgentDaemon.recordExternalTaskCancellation", () => {
  it("persists cancelled status, releases the queue slot, and is not a user cancel", async () => {
    const task = { id: "task-ext", status: "executing", workspaceId: "w" };
    const executorCancel = vi.fn();
    const daemonLike = Object.assign(Object.create(AgentDaemon.prototype), {
      pendingContinuationTaskIds: new Set(["task-ext"]),
      pendingTaskImages: new Map(),
      activeTasks: new Map([["task-ext", { executor: { cancel: executorCancel } }]]),
      taskRepo: { findByParent: vi.fn(() => []) },
      cancelTaskRecord: vi.fn(),
      logEvent: vi.fn(),
      finishQueueSlot: vi.fn(),
    }) as Any;
    daemonLike.recordExternalTaskCancellation(task.id, "The external agent cancelled.");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(daemonLike.cancelTaskRecord).toHaveBeenCalledWith(
      "task-ext",
      "The external agent cancelled.",
    );
    expect(daemonLike.logEvent).toHaveBeenCalledWith(
      "task-ext",
      "agent_interrupt_confirmed",
      expect.objectContaining({ actor: "external_runtime", status: "cancelled" }),
    );
    expect(daemonLike.finishQueueSlot).toHaveBeenCalledWith("task-ext");
    expect(daemonLike.pendingContinuationTaskIds.has("task-ext")).toBe(false);
    expect(executorCancel).not.toHaveBeenCalled();
  });
});
