import { describe, expect, it } from "vitest";
import {
  attentionActorForTask,
  attentionFromApproval,
  attentionFromCalendarProposal,
  attentionFromMailReplyDraft,
  attentionMailReplyOffer,
  attentionFromCommitment,
  attentionFromFlowStep,
  attentionFromInputRequest,
  attentionFromSuggestion,
  attentionFromTask,
  indexDevicesByNode,
  isLocalTaskNode,
  sessionWaitReason,
  attentionOriginForTask,
  attentionPlaceForTask,
  attentionWaitingByTask,
  classifyTaskActivity,
  rankAttention,
  suggestsCalendarHold,
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
    expect(
      classifyTaskActivity(task("a", { status: "blocked", terminalStatus: "awaiting_approval" })),
    ).toEqual({
      category: "needs-you",
      label: "Approval needed",
    });
    expect(
      classifyTaskActivity(task("b", { status: "paused", terminalStatus: "needs_user_action" }))
        ?.label,
    ).toBe("Response needed");
    expect(classifyTaskActivity(task("c", { status: "interrupted" }))?.label).toBe(
      "Resume available",
    );
    expect(classifyTaskActivity(task("d", { status: "executing" }))?.category).toBe("running");
    expect(classifyTaskActivity(task("e", { status: "failed" }))).toBeNull();
    expect(classifyTaskActivity(task("f"))).toBeNull();
  });

  it("never counts a finished run as waiting, whatever outcome it ended with", () => {
    // A run whose approval timed out is finalized as completed with "needs user action";
    // its approval is closed, so there is nothing to reply to.
    const stoppedShort = task("s", {
      status: "completed",
      completedAt: 1,
      terminalStatus: "needs_user_action",
      error: "Approval request timed out",
    });
    expect(classifyTaskActivity(stoppedShort)).toBeNull();
    expect(
      classifyTaskActivity(task("a", { status: "completed", terminalStatus: "awaiting_approval" })),
    ).toBeNull();
    // An active status with a completion time is a finished run too.
    expect(
      classifyTaskActivity(
        task("x", { status: "executing", completedAt: 1, terminalStatus: "needs_user_action" }),
      ),
    ).toBeNull();
    expect(attentionFromTask(stoppedShort, context)).toBeNull();
  });
});

describe("devices", () => {
  it("names the device a task is routed to by any node id its tasks carry", () => {
    const devicesByNode = indexDevicesByNode([
      { id: "mini", name: "Mac mini" },
      { id: "studio", name: "Studio", taskNodeId: "node-studio", clientId: "client-7" },
      { id: "local:this-device", name: "This Mac" },
    ]);
    const placed = (targetNodeId: string) =>
      attentionPlaceForTask(task("r", { targetNodeId }), { ...context, devicesByNode });
    expect(placed("remote-gateway:mini")).toEqual({
      kind: "remote",
      label: "Mac mini",
      deviceId: "mini",
    });
    expect(placed("node-studio")).toMatchObject({ label: "Studio", deviceId: "studio" });
    expect(placed("client-7")).toMatchObject({ label: "Studio", deviceId: "studio" });
    expect(placed("mini")).toMatchObject({ label: "Mac mini", deviceId: "mini" });
    expect(placed("gone")).toEqual({ kind: "remote", label: "Another device", deviceId: "gone" });
    expect(isLocalTaskNode("local:this-device")).toBe(true);
    expect(devicesByNode.has("local:this-device")).toBe(false);
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
    // A task routed to this machine's own node id runs here.
    expect(
      attentionPlaceForTask(task("l", { targetNodeId: "local:this-device" }), context),
    ).toEqual({ kind: "local", label: "This Mac" });
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

  it("offers a single question's plain options as choices, never an approval's", () => {
    const request = (questions: InputRequest["questions"]): InputRequest => ({
      id: "q1",
      taskId: "t1",
      questions,
      status: "pending",
      requestedAt: NOW,
    });
    const question = (overrides: Partial<InputRequest["questions"][number]> = {}) => ({
      header: "Region",
      id: "region",
      question: "Which region?",
      options: [
        { label: "us-east (default)", description: "Closest to most users" },
        { label: "eu-west", description: "" },
      ],
      ...overrides,
    });
    expect(attentionFromInputRequest(request([question()]), task("t1"), context).choices).toEqual({
      questionId: "region",
      // Labels go back as the answer, so they stay exactly as written.
      options: [
        { label: "us-east (default)", description: "Closest to most users" },
        { label: "eu-west" },
      ],
    });
    const none = (questions: InputRequest["questions"]) =>
      attentionFromInputRequest(request(questions), task("t1"), context).choices;
    expect(none([question(), question({ id: "size" })])).toBeUndefined();
    expect(none([question({ id: "approval_decision" })])).toBeUndefined();
    expect(none([question({ id: "responsibility_action_review_decision" })])).toBeUndefined();
    expect(
      none([question({ preview: { label: "Script", text: "rm -rf build" } })]),
    ).toBeUndefined();
    expect(none([question({ options: [{ label: "Only one", description: "" }] })])).toBeUndefined();
  });

  it("only makes session items for sessions waiting on the user", () => {
    expect(
      attentionFromTask(
        task("w", { status: "interrupted", terminalStatus: "resume_available" }),
        context,
      ),
    ).toMatchObject({ id: "session:w", state: "Resume available" });
    expect(attentionFromTask(task("x", { status: "executing" }), context)).toBeNull();
  });

  it("says why a session stopped for the user, and only when the task records it", () => {
    const paused = (overrides: Partial<Task>) =>
      task("p", { status: "paused", terminalStatus: "needs_user_action", ...overrides });
    expect(sessionWaitReason(paused({ error: "Approval request timed out" }))).toBe(
      "Its approval request timed out, so it stopped before that step.",
    );
    expect(sessionWaitReason(paused({ awaitingUserInputReasonCode: "required_decision" }))).toBe(
      "It needs a decision from you before it can go on.",
    );
    expect(
      sessionWaitReason(paused({ awaitingUserInputReasonCode: "user_action_required_tool" })),
    ).toBe("It needs you to do something before it can go on.");
    expect(sessionWaitReason(paused({ awaitingUserInputReasonCode: "something_new" }))).toBe(
      "It's waiting for your input before it can go on.",
    );
    // No record, no reason: a dismissed question or a declined step leaves none.
    expect(sessionWaitReason(paused({}))).toBeUndefined();
    expect(
      attentionFromTask(paused({ error: "Approval request timed out" }), context),
    ).toMatchObject({
      state: "Response needed",
      detail: "Its approval request timed out, so it stopped before that step.",
    });
    expect(attentionFromTask(paused({}), context)?.detail).toBeUndefined();
    // Other states keep their own wording.
    expect(
      attentionFromTask(
        task("i", {
          status: "interrupted",
          terminalStatus: "resume_available",
          awaitingUserInputReasonCode: "required_decision",
        }),
        context,
      )?.detail,
    ).toBeUndefined();
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

  it("puts calendar conflicts with commitments and calendar offers with the offers, soonest first", () => {
    const ranked = rankAttention([
      item("idea", "suggestion", { urgent: false }),
      item("nudge", "suggestion"),
      item("prep-late", "calendar", { urgent: false, createdAt: NOW + 20 }),
      item("prep-soon", "calendar", { urgent: false, createdAt: NOW + 10 }),
      item("conflict", "calendar", { createdAt: NOW + 30 }),
      item("due", "commitment", { dueAt: NOW + 1, createdAt: NOW - 1 }),
    ]);
    expect(ranked.map((entry) => entry.id)).toEqual([
      "conflict",
      "due",
      "nudge",
      "prep-soon",
      "prep-late",
      "idea",
    ]);
  });
});

describe("mail reply items", () => {
  it("asks to send a drafted reply, and only offers to start drafting", () => {
    const draft = {
      draftId: "d1",
      threadId: "t1",
      accountId: "gmail:me@example.com",
      provider: "gmail" as const,
      subject: "Q3 proposal",
      to: ["Dana <dana@example.com>", "Lee", "Kim", "Ray"],
      copies: 2,
      attachments: 1,
      sender: "Dana",
      bodyText: "Thanks Dana, sending it Friday.",
      createdAt: NOW - 60_000,
    };
    expect(attentionFromMailReplyDraft(draft, context)).toMatchObject({
      id: "mail_reply:d1",
      kind: "mail_reply",
      state: "Reply drafted",
      title: "Q3 proposal",
      detail: "Dana is waiting on a reply.",
      urgent: true,
      actor: { kind: "background", name: "Mail" },
      ref: { type: "mail_draft", draftId: "d1" },
      mailDraft: draft,
    });
    expect(attentionMailReplyOffer(NOW, context)).toMatchObject({
      id: "mail_reply:offer",
      urgent: false,
      ref: { type: "mail_offer" },
    });
    const ranked = rankAttention([
      attentionMailReplyOffer(NOW, context),
      attentionFromMailReplyDraft(draft, context),
    ]);
    expect(ranked.map((item) => item.id)).toEqual(["mail_reply:d1", "mail_reply:offer"]);
  });
});

describe("calendar items", () => {
  const event = (eventId: string, start: number) => ({
    eventId,
    title: `Event ${eventId}`,
    start,
    end: start + 3_600_000,
  });

  it("asks about a conflict and only offers holds and prep", () => {
    expect(
      attentionFromCalendarProposal(
        {
          kind: "conflict",
          id: "conflict:a:b",
          first: event("a", NOW + 10),
          second: event("b", NOW + 20),
          canDeclineSecond: true,
        },
        context,
      ),
    ).toMatchObject({
      id: "calendar:conflict:a:b",
      kind: "calendar",
      state: "Conflict",
      title: "Event a overlaps Event b",
      createdAt: NOW + 10,
      urgent: true,
      actor: { kind: "background", name: "Calendar" },
      origin: { kind: "event", label: "From your calendar" },
      place: { kind: "local", label: "This Mac" },
      ref: { type: "calendar_proposal", proposalId: "conflict:a:b" },
    });
    expect(
      attentionFromCalendarProposal(
        {
          kind: "focus_hold",
          id: "hold:c1",
          title: "Send the SOW",
          commitmentId: "c1",
          dueAt: NOW + 100,
          start: NOW + 10,
          end: NOW + 20,
        },
        context,
      ),
    ).toMatchObject({
      state: "Suggested hold",
      title: "Send the SOW",
      urgent: false,
      dueAt: NOW + 100,
    });
    expect(
      attentionFromCalendarProposal(
        { kind: "meeting_prep", id: "prep:e:1", event: event("e", NOW + 50), attendees: ["Ana"] },
        context,
      ),
    ).toMatchObject({
      state: "Meeting soon",
      title: "Event e",
      urgent: false,
      createdAt: NOW + 50,
    });
  });

  it("recognizes suggestions about making time", () => {
    expect(suggestsCalendarHold({ title: "Block focus time for the launch deck" })).toBe(true);
    expect(suggestsCalendarHold({ title: "Plan", prompt: "Set aside time for deep work" })).toBe(
      true,
    );
    expect(suggestsCalendarHold({ title: "Reply to Ana about the invoice" })).toBe(false);
  });
});

describe("attentionWaitingByTask", () => {
  it("maps waiting sessions to a reason, approvals and questions first", () => {
    const base = {
      createdAt: NOW,
      urgent: true,
      actor: { kind: "you", name: "You" },
      origin: { kind: "you", label: "" },
      place: { kind: "local", label: "" },
    } as const;
    const items = [
      {
        ...base,
        id: "session:t1",
        kind: "session",
        state: "Paused",
        title: "",
        taskId: "t1",
        ref: { type: "task", taskId: "t1" },
      },
      {
        ...base,
        id: "approval:a1",
        kind: "approval",
        state: "Approval needed",
        title: "",
        taskId: "t1",
        ref: { type: "approval", approvalId: "a1", taskId: "t1" },
      },
      {
        ...base,
        id: "question:q1",
        kind: "question",
        state: "2 questions",
        title: "",
        taskId: "t2",
        ref: { type: "input_request", requestId: "q1", taskId: "t2" },
      },
      {
        ...base,
        id: "commitment:c1",
        kind: "commitment",
        state: "Overdue",
        title: "",
        ref: { type: "commitment", commitmentId: "c1" },
      },
    ] as AttentionItem[];
    expect([...attentionWaitingByTask(items)]).toEqual([
      ["t1", "Approval needed"],
      ["t2", "Response needed"],
    ]);
  });
});
