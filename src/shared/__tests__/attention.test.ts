import { describe, expect, it } from "vitest";
import {
  attentionActorForTask,
  attentionFromApproval,
  attentionFromCommitment,
  attentionFromFlowStep,
  attentionFromInputRequest,
  attentionFromSuggestion,
  attentionFromTask,
  attentionOriginForTask,
  attentionPlaceForTask,
  classifyTaskActivity,
  rankAttention,
  type AttentionItem,
} from "../attention";
import type { ApprovalRequest, InputRequest, ProactiveSuggestion, Task } from "../types";

const NOW = 1_800_000_000_000;
const context = { localLabel: "This Mac", agentNames: new Map([["role-ops", "Ops bot"]]) };

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: `Session ${id}`,
    prompt: "",
    status: "completed",
    workspaceId: "ws",
    createdAt: NOW - 1000,
    updatedAt: NOW,
    ...overrides,
  } as Task;
}

function approval(id: string, overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id,
    taskId: "t1",
    type: "run_command",
    description: "Run npm publish",
    details: {},
    status: "pending",
    requestedAt: NOW - 60_000,
    ...overrides,
  };
}

describe("classifyTaskActivity", () => {
  it("names why a session waits on the user", () => {
    expect(classifyTaskActivity(task("a", { terminalStatus: "awaiting_approval" }))).toEqual({
      category: "needs-you",
      label: "Approval needed",
    });
    expect(classifyTaskActivity(task("b", { terminalStatus: "needs_user_action" }))?.label).toBe(
      "Response needed",
    );
    expect(classifyTaskActivity(task("c", { status: "interrupted" }))?.label).toBe(
      "Resume available",
    );
    expect(classifyTaskActivity(task("d", { status: "executing" }))?.category).toBe("running");
    expect(classifyTaskActivity(task("e", { status: "failed" }))).toBeNull();
    expect(classifyTaskActivity(task("f"))).toBeNull();
  });
});

describe("task context", () => {
  it("names the agent, what started the work and where it runs", () => {
    const remote = task("r", {
      assignedAgentRoleId: "role-ops",
      source: "cron",
      targetNodeId: "node-1",
      agentConfig: { botConversation: true },
    });
    expect(attentionActorForTask(remote, context)).toEqual({ kind: "bot", name: "Ops bot" });
    expect(attentionOriginForTask(remote)).toEqual({
      kind: "schedule",
      label: "Started by a schedule",
    });
    expect(attentionPlaceForTask(remote, context)).toEqual({
      kind: "remote",
      label: "Another device",
      deviceId: "node-1",
    });
    const mine = task("m");
    expect(attentionActorForTask(mine, context)).toEqual({ kind: "you", name: "You" });
    expect(attentionOriginForTask(mine).kind).toBe("you");
    expect(attentionPlaceForTask(mine, context)).toEqual({ kind: "local", label: "This Mac" });
    expect(attentionActorForTask(task("h", { heartbeatRunId: "run" }), context).name).toBe(
      "Heartbeat",
    );
  });
});

describe("attention mappers", () => {
  it("turns an approval into a blocking item and flags destructive kinds", () => {
    const item = attentionFromApproval(approval("a1"), task("t1"), context);
    expect(item).toMatchObject({
      id: "approval:a1",
      kind: "approval",
      state: "Approval needed",
      title: "Run npm publish",
      detail: "Session t1 is paused until you decide.",
      urgent: true,
      taskId: "t1",
      ref: { type: "approval", approvalId: "a1", taskId: "t1" },
    });
    expect(item.risk).toBeUndefined();
    expect(
      attentionFromApproval(approval("a2", { type: "delete_multiple" }), undefined, context).risk,
    ).toBe("high");
  });

  it("uses the first question as the title and counts the rest", () => {
    const request: InputRequest = {
      id: "q1",
      taskId: "t1",
      status: "pending",
      requestedAt: NOW,
      questions: [
        { id: "a", header: "Scope", question: "Which contacts?", options: [] },
        { id: "b", header: "Tone", question: "Formal?", options: [] },
      ],
    };
    expect(attentionFromInputRequest(request, task("t1"), context)).toMatchObject({
      id: "question:q1",
      state: "2 questions",
      title: "Which contacts?",
    });
  });

  it("only makes session items for sessions waiting on the user", () => {
    expect(
      attentionFromTask(task("w", { terminalStatus: "resume_available" }), context),
    ).toMatchObject({ id: "session:w", state: "Resume available" });
    expect(attentionFromTask(task("x", { status: "executing" }), context)).toBeNull();
  });

  it("describes a waiting flow step", () => {
    expect(
      attentionFromFlowStep(
        {
          routineId: "r1",
          routineName: "Weekly report",
          runId: "run1",
          stepId: "s1",
          message: "Send email to leadership",
          waitingSince: NOW,
        },
        context,
      ),
    ).toMatchObject({
      id: "flow_approval:s1",
      title: "Weekly report is waiting for your approval",
      detail: "Send email to leadership",
      actor: { kind: "flow", name: "Weekly report" },
      ref: { type: "workflow_step", routineId: "r1", runId: "run1", stepId: "s1" },
    });
  });

  it("marks overdue commitments and skips undated ones", () => {
    expect(
      attentionFromCommitment({ id: "c1", text: "Send SOW", dueAt: NOW - 1 }, NOW, context),
    ).toMatchObject({ state: "Overdue", dueAt: NOW - 1 });
    expect(attentionFromCommitment({ id: "c2", text: "Undated" }, NOW, context)).toBeNull();
  });

  it("keeps only suggestions with a prompt and marks urgent ones", () => {
    const base = {
      id: "s1",
      type: "follow_up",
      title: "Reply to Dana",
      description: "She asked yesterday.",
      actionPrompt: "Draft a reply to Dana",
      confidence: 0.8,
      createdAt: NOW,
      expiresAt: NOW + 1,
    } as ProactiveSuggestion;
    expect(attentionFromSuggestion({ ...base, urgency: "high" }, "ws", context)).toMatchObject({
      urgent: true,
      state: "Needs you",
      prompt: "Draft a reply to Dana",
      suggestionType: "follow_up",
      ref: { type: "suggestion", suggestionId: "s1", workspaceId: "ws" },
    });
    expect(attentionFromSuggestion(base, "ws", context)?.urgent).toBe(false);
    expect(attentionFromSuggestion({ ...base, actionPrompt: " " }, "ws", context)).toBeNull();
  });
});

describe("rankAttention", () => {
  const item = (id: string, kind: AttentionItem["kind"], extra: Partial<AttentionItem> = {}) =>
    ({
      id,
      kind,
      state: "",
      title: id,
      createdAt: NOW,
      urgent: true,
      actor: { kind: "you", name: "You" },
      origin: { kind: "you", label: "" },
      place: { kind: "local", label: "" },
      ref: { type: "task", taskId: id },
      ...extra,
    }) as AttentionItem;

  it("drops a session already covered by its approval and orders by urgency", () => {
    const ranked = rankAttention([
      item("idea", "suggestion", { urgent: false }),
      item("later", "commitment", { dueAt: NOW + 2 }),
      item("soon", "commitment", { dueAt: NOW + 1 }),
      item("nudge", "suggestion"),
      item("session:t1", "session", { taskId: "t1" }),
      item("session:t2", "session", { taskId: "t2", createdAt: NOW - 5 }),
      item("approval:a1", "approval", { taskId: "t1", createdAt: NOW - 10 }),
    ]);
    expect(ranked.map((entry) => entry.id)).toEqual([
      "approval:a1",
      "session:t2",
      "soon",
      "later",
      "nudge",
      "idea",
    ]);
  });
});
