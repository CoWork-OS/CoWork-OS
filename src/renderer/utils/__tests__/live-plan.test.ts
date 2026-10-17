import { describe, expect, it } from "vitest";

import type {
  PlanStep,
  SessionChecklistState,
  TaskEvent,
  TaskStatusStripState,
} from "../../../shared/types";
import { GENERATED_HANDOFF_STEP_DESCRIPTION } from "../../../shared/generated-plan-steps";
import {
  collapsedLivePlanRow,
  deriveLivePlan,
  windowLivePlanRows,
  type LivePlanModel,
} from "../live-plan";

function event(type: string, timestamp: number): TaskEvent {
  return {
    id: `${type}-${timestamp}`,
    taskId: "task-1",
    type,
    timestamp,
    payload: {},
  } as TaskEvent;
}

function step(id: string, status: PlanStep["status"], description = `Step ${id}`): PlanStep {
  return { id, description, status };
}

function checklist(
  ...items: Array<[string, SessionChecklistState["items"][number]["status"]]>
): SessionChecklistState {
  return {
    items: items.map(([title, status], index) => ({
      id: `item-${index}`,
      title,
      kind: "implementation",
      status,
      createdAt: 1,
      updatedAt: 1,
    })),
    updatedAt: 1,
    verificationNudgeNeeded: false,
    nudgeReason: null,
  };
}

function derive(
  overrides: Partial<{
    state: TaskStatusStripState;
    planSteps: PlanStep[];
    checklistState: SessionChecklistState | null;
    events: TaskEvent[];
  }> = {},
) {
  return deriveLivePlan({
    state: "working",
    planSteps: [],
    checklistState: null,
    events: [],
    ...overrides,
  });
}

describe("deriveLivePlan", () => {
  it("lists the planner's steps while the task runs", () => {
    const plan = derive({
      planSteps: [step("a", "completed"), step("b", "in_progress"), step("c", "pending")],
      events: [event("plan_created", 10), event("step_started", 20)],
    });
    expect(plan).toEqual({
      source: "plan",
      items: [
        { id: "a", label: "Step a", status: "done", planStepId: "a" },
        { id: "b", label: "Step b", status: "active", planStepId: "b" },
        { id: "c", label: "Step c", status: "pending", planStepId: "c" },
      ],
      doneCount: 1,
      activeId: "b",
    });
  });

  it("prefers the agent's checklist over the planner's steps", () => {
    const plan = derive({
      planSteps: [step("a", "in_progress"), step("b", "pending")],
      checklistState: checklist(["Read code", "completed"], ["Write tests", "in_progress"]),
      events: [event("plan_created", 10), event("task_list_updated", 20)],
    });
    expect(plan?.source).toBe("checklist");
    expect(plan?.items.map((item) => [item.label, item.status])).toEqual([
      ["Read code", "done"],
      ["Write tests", "active"],
    ]);
    expect(plan?.activeId).toBe("item-1");
  });

  it.each<TaskStatusStripState>(["completed", "failed", "cancelled", "idle"])(
    "disappears once the task is %s",
    (state) => {
      expect(
        derive({
          state,
          planSteps: [step("a", "completed"), step("b", "completed")],
          events: [event("plan_created", 10)],
        }),
      ).toBeNull();
    },
  );

  it.each<TaskStatusStripState>(["paused", "blocked", "waiting_for_approval", "waiting_for_input"])(
    "stays while the task is %s",
    (state) => {
      expect(
        derive({
          state,
          planSteps: [step("a", "in_progress"), step("b", "pending")],
          events: [event("plan_created", 10)],
        }),
      ).not.toBeNull();
    },
  );

  it("ignores a single-item plan", () => {
    expect(
      derive({ planSteps: [step("a", "in_progress")], events: [event("plan_created", 10)] }),
    ).toBeNull();
  });

  it("drops a previous turn's plan when a follow-up runs without a new one", () => {
    const planSteps = [step("a", "completed"), step("b", "completed")];
    const checklistState = checklist(["One", "completed"], ["Two", "completed"]);
    expect(
      derive({
        planSteps,
        checklistState,
        events: [
          event("plan_created", 10),
          event("task_list_updated", 20),
          event("user_message", 30),
          event("tool_call", 40),
        ],
      }),
    ).toBeNull();
  });

  it("falls back to the planner when only the checklist is stale", () => {
    const plan = derive({
      planSteps: [step("a", "in_progress"), step("b", "pending")],
      checklistState: checklist(["Old", "completed"], ["Older", "completed"]),
      events: [
        event("task_list_updated", 10),
        event("user_message", 20),
        event("plan_revised", 30),
      ],
    });
    expect(plan?.source).toBe("plan");
  });

  it("shows a short label for steps the executor writes itself", () => {
    const plan = derive({
      planSteps: [
        step("a", "completed", "Draft the explainer"),
        step("b", "in_progress", GENERATED_HANDOFF_STEP_DESCRIPTION),
      ],
      events: [event("step_started", 10)],
    });
    expect(plan?.items.map((item) => item.label)).toEqual([
      "Draft the explainer",
      "Summarize the results",
    ]);
  });

  it("counts skipped steps as finished and maps failures", () => {
    const plan = derive({
      planSteps: [step("a", "skipped"), step("b", "failed"), step("c", "pending")],
      events: [event("step_failed", 10)],
    });
    expect(plan?.doneCount).toBe(1);
    expect(plan?.items.map((item) => item.status)).toEqual(["skipped", "failed", "pending"]);
    expect(plan?.activeId).toBe("b");
  });
});

function planOf(count: number, activeIndex: number | null): LivePlanModel {
  const items = Array.from({ length: count }, (_, index) => ({
    id: `s${index}`,
    label: `Step ${index}`,
    status:
      activeIndex === null || index > activeIndex
        ? ("pending" as const)
        : index === activeIndex
          ? ("active" as const)
          : ("done" as const),
  }));
  return {
    source: "plan",
    items,
    doneCount: activeIndex ?? 0,
    ...(activeIndex === null ? {} : { activeId: `s${activeIndex}` }),
  };
}

function describeRows(plan: LivePlanModel, expanded = false): string[] {
  return windowLivePlanRows(plan, expanded).map((row) =>
    row.kind === "item" ? String(row.index) : `${row.kind}:${row.count}`,
  );
}

describe("windowLivePlanRows", () => {
  it("shows short plans whole", () => {
    expect(describeRows(planOf(6, 3))).toEqual(["0", "1", "2", "3", "4", "5"]);
  });

  it("folds the tail of a long plan at the start", () => {
    expect(describeRows(planOf(10, 0))).toEqual(["0", "1", "2", "3", "4", "more-after:5"]);
  });

  it("keeps one finished step above the current one in the middle", () => {
    expect(describeRows(planOf(10, 5))).toEqual([
      "more-before:4",
      "4",
      "5",
      "6",
      "7",
      "more-after:2",
    ]);
  });

  it("fills the window near the end instead of leaving rows empty", () => {
    expect(describeRows(planOf(10, 9))).toEqual(["more-before:5", "5", "6", "7", "8", "9"]);
  });

  it("never exceeds the row budget", () => {
    for (let active = 0; active < 14; active += 1) {
      expect(windowLivePlanRows(planOf(14, active), false).length).toBeLessThanOrEqual(6);
    }
  });

  it("lists everything once expanded", () => {
    expect(describeRows(planOf(10, 5), true)).toHaveLength(10);
  });
});

describe("collapsedLivePlanRow", () => {
  const items = (statuses: LivePlanModel["items"][number]["status"][]) =>
    statuses.map((status, index) => ({ id: `i${index}`, label: `Item ${index}`, status }));
  const keptId = (plan: LivePlanModel) => {
    const row = collapsedLivePlanRow(plan);
    return row?.kind === "item" ? row.item.id : null;
  };

  it("keeps the current item", () => {
    expect(
      keptId({
        source: "plan",
        items: items(["done", "active", "pending"]),
        doneCount: 1,
        activeId: "i1",
      }),
    ).toBe("i1");
  });

  it("falls back to the next open item, then the last one", () => {
    expect(
      keptId({
        source: "plan",
        items: items(["done", "skipped", "blocked", "pending"]),
        doneCount: 1,
      }),
    ).toBe("i2");
    expect(keptId({ source: "plan", items: items(["done", "done"]), doneCount: 2 })).toBe("i1");
    expect(keptId({ source: "plan", items: [], doneCount: 0 })).toBeNull();
  });
});
