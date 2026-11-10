import { describe, expect, it, vi } from "vitest";

import type { PlanStep, TaskEvent } from "../../../shared/types";
import { AGENT_DISPATCH_STEP_DESCRIPTION } from "../../../shared/generated-plan-steps";
import { TaskExecutor } from "../executor";
import {
  buildTaskKickoffSummary,
  responseHasAssistantText,
  taskSessionKickoffIsSettled,
  TASK_KICKOFF_PROMPT_RULES,
} from "../task-kickoff-summary";

function planStep(id: string, description: string, kind: PlanStep["kind"] = "primary"): PlanStep {
  return { id, description, kind, status: "pending" };
}

function taskEvent(type: string, payload: Record<string, unknown>): TaskEvent {
  return { type, payload } as TaskEvent;
}

function createEventExecutor() {
  const emitted: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const executor = Object.create(TaskExecutor.prototype) as Any;
  Object.assign(executor, {
    task: { id: "task-1", agentConfig: {} },
    workspace: { path: "/tmp", isTemp: false },
    plan: {
      description: "Improve the task opening",
      steps: [
        { ...planStep("inspect", "Inspect the current task timeline"), status: "in_progress" },
        planStep("verify", "Verify the rendered result", "verification"),
      ],
    },
    currentStepId: "inspect",
    sessionKickoffSummarySettled: false,
    emittingSessionKickoffSummary: false,
    currentToolBatchGroupId: null,
    eventEmitter: {
      emit: vi.fn((type: string, payload: Record<string, unknown>) => {
        emitted.push({ type, payload });
      }),
    },
  });
  return { executor, emitted };
}

describe("task kickoff summary", () => {
  it("builds a concise task-specific summary from the first actionable plan step", () => {
    const summary = buildTaskKickoffSummary({
      currentStepDescription: "Inspect the current task timeline",
      planSteps: [
        planStep("inspect", "Inspect the current task timeline"),
        planStep("verify", "Verify the rendered result", "verification"),
      ],
    });

    expect(summary).toBe(
      "I’ll start by inspecting the current task timeline, then continue through the remaining work and verify the result.",
    );
  });

  it("uses the first non-verification step when the current step is verification-only", () => {
    const summary = buildTaskKickoffSummary({
      currentStepDescription: "Verify the rendered result",
      planSteps: [
        planStep("inspect", "Review the session behavior"),
        planStep("verify", "Verify the rendered result", "verification"),
      ],
    });

    expect(summary).toContain("reviewing the session behavior");
    expect(summary).not.toContain("verifying the rendered result");
  });

  it("keeps underscores inside names while dropping markdown marks", () => {
    const summary = buildTaskKickoffSummary({
      currentStepDescription: "Run `du -sh .` with run_command and update **my_notes.md**",
    });

    expect(summary).toBe(
      "I’ll start by running du -sh . with run_command and update my_notes.md, then continue through the remaining work and verify the result.",
    );
  });

  it("falls back to the first tool category when no plan is available", () => {
    expect(buildTaskKickoffSummary({ firstToolName: "web_search" })).toContain(
      "gathering the relevant evidence",
    );
  });

  it("recognizes model responses that already contain assistant prose", () => {
    expect(
      responseHasAssistantText([{ type: "text", text: "I’ll inspect the relevant files." }]),
    ).toBe(true);
    expect(responseHasAssistantText([{ type: "tool_use", name: "read_file" }])).toBe(false);
  });

  it("treats only public assistant prose or prior tool activity as settled", () => {
    expect(
      taskSessionKickoffIsSettled([
        taskEvent("assistant_message", { message: "Internal planning", internal: true }),
      ]),
    ).toBe(false);
    expect(
      taskSessionKickoffIsSettled([
        taskEvent("assistant_message", { message: "I’ll inspect the flow.", internal: false }),
      ]),
    ).toBe(true);
    expect(taskSessionKickoffIsSettled([taskEvent("tool_call", { tool: "read_file" })])).toBe(true);
  });

  it("emits one public kickoff before the first technical activity", () => {
    const { executor, emitted } = createEventExecutor();

    executor.emitEvent("tool_call", { tool: "read_file" });
    executor.emitEvent("tool_call", { tool: "read_file" });

    expect(emitted.map((event) => event.type)).toEqual([
      "assistant_message",
      "tool_call",
      "tool_call",
    ]);
    expect(emitted[0]?.payload).toMatchObject({
      internal: false,
      kickoffSummary: true,
      runtimeGenerated: true,
      stepId: "inspect",
    });
  });

  it("places the kickoff before the activity group is opened", () => {
    const { executor } = createEventExecutor();
    const order: string[] = [];
    executor.eventEmitter = {
      emit: vi.fn((type: string) => {
        order.push(type);
      }),
    };
    executor.timelineEmitter = {
      startGroupLane: vi.fn(() => {
        order.push("activity_group");
      }),
    };
    executor.globalTurnCount = 0;

    executor.startToolBatchGroup("inspect", 1, "step");

    expect(order).toEqual(["assistant_message", "activity_group"]);
  });

  it("does not duplicate model-written kickoff prose", () => {
    const { executor, emitted } = createEventExecutor();

    executor.emitEvent("assistant_message", {
      message: "I’ll inspect the timeline first, then validate the interaction.",
      internal: false,
      kickoffSummary: true,
    });
    executor.emitEvent("tool_call", { tool: "read_file" });

    expect(emitted.map((event) => event.type)).toEqual(["assistant_message", "tool_call"]);
  });

  it("includes the kickoff contract in the execution prompt", () => {
    expect(TASK_KICKOFF_PROMPT_RULES).toContain("before the first tool call");
    expect(TASK_KICKOFF_PROMPT_RULES).toContain("one or two sentences");
  });
});

// Live 2026-11-09: "I'll start by using orchestrate_agents to dispatch the explicitly requested
// independent scopes to actual child agents and collect their results. Assign publ, then ..."
describe("kickoff wording for long or runtime-written steps", () => {
  it("names a runtime-written step by its label", () => {
    expect(
      buildTaskKickoffSummary({ currentStepDescription: AGENT_DISPATCH_STEP_DESCRIPTION }),
    ).toBe(
      "I’ll start by handing the separate parts to sub-agents, then continue through the remaining work and verify the result.",
    );
  });

  it("keeps whole words when a step is long", () => {
    const summary = buildTaskKickoffSummary({
      currentStepDescription:
        "Review the quarterly revenue workbook, every regional tab and the board notes so the forecast matches the signed plan and the auditors' comments from last week. Then draft a summary.",
    });
    expect(summary).toMatch(/^I’ll start by reviewing the quarterly revenue workbook, /);
    expect(summary).not.toMatch(/\b[a-z]{1,3}, then continue/);
    expect(summary).toContain("auditors'");
  });
});
