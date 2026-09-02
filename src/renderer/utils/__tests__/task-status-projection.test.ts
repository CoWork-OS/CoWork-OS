import { describe, expect, it } from "vitest";

import type { TaskEvent } from "../../../shared/types";
import {
  deriveActivityGroups,
  deriveRevisionAwarePlanSteps,
  deriveTaskStatusStrip,
} from "../task-status-projection";

function event(
  id: string,
  seq: number,
  type: TaskEvent["type"],
  payload: Record<string, unknown> = {},
): TaskEvent {
  return {
    id,
    taskId: "task-1",
    timestamp: 1_000 + seq,
    type,
    payload,
    schemaVersion: 2,
    seq,
  };
}

describe("deriveRevisionAwarePlanSteps", () => {
  it("selects the newest full revision and ignores stale late status events", () => {
    const steps = deriveRevisionAwarePlanSteps([
      event("plan-1", 1, "plan_created", {
        plan: {
          steps: [
            { id: "research", description: "Research competitors", status: "in_progress" },
            { id: "write", description: "Write report", status: "pending" },
          ],
        },
      }),
      event("stale-complete", 2, "step_completed", { step: { id: "write" } }),
      event("plan-2", 5, "plan_revised", {
        revisionNumber: 2,
        plan: {
          steps: [
            { id: "research", description: "Research competitors", status: "completed" },
            { id: "compare", description: "Compare findings", status: "in_progress" },
            { id: "write", description: "Draft report", status: "pending" },
            {
              id: "verify",
              kind: "verification",
              description: "Verify output",
              status: "pending",
            },
          ],
        },
      }),
      event("late-stale-packet", 3, "step_completed", { step: { id: "compare" } }),
      event("current-update", 6, "step_started", { step: { id: "compare" } }),
    ]);

    expect(steps.map((step) => [step.id, step.description, step.status])).toEqual([
      ["research", "Research competitors", "completed"],
      ["compare", "Compare findings", "in_progress"],
      ["write", "Draft report", "pending"],
    ]);
  });

  it("applies legacy delta revisions deterministically", () => {
    const steps = deriveRevisionAwarePlanSteps([
      event("plan", 1, "plan_created", {
        plan: {
          steps: [
            { id: "one", description: "First", status: "in_progress" },
            { id: "two", description: "Second", status: "pending" },
          ],
        },
      }),
      event("revision", 2, "plan_revised", {
        revisionNumber: 1,
        clearRemaining: true,
        newSteps: ["Replacement"],
      }),
    ]);

    expect(steps.map((step) => step.description)).toEqual(["First", "Replacement"]);
    expect(steps[1].id).toBe("revision:revision:0");
  });

  it("keeps old plan_updated histories readable", () => {
    const steps = deriveRevisionAwarePlanSteps([
      event("plan", 1, "plan_created", {
        plan: { steps: [{ id: "one", description: "First", status: "in_progress" }] },
      }),
      event("legacy-update", 2, "plan_updated" as TaskEvent["type"], {
        plan: { steps: [{ id: "one", description: "Renamed", status: "completed" }] },
      }),
    ]);

    expect(steps).toMatchObject([{ id: "one", description: "Renamed", status: "completed" }]);
  });
});

describe("activity and status projections", () => {
  it("keeps the latest group running and uses sanitized typed labels", () => {
    const planSteps = [
      { id: "one", description: "Research competitors", status: "in_progress" as const },
    ];
    const groups = deriveActivityGroups({
      timelineItems: [
        {
          kind: "action_block",
          blockId: "group-1",
          timestamp: 1_001,
          events: [
            event("tool", 1, "tool_call", {
              tool: "web_search",
              input: { query: "must not become a label" },
            }),
          ],
        },
      ],
      planSteps,
      task: { id: "task-1", status: "executing" } as Any,
    });

    expect(groups).toMatchObject([
      {
        id: "group-1",
        status: "running",
        summary: "Working",
        latestActivityLabel: "Searching the web",
      },
    ]);
    expect(groups[0].latestActivityLabel).not.toContain("must not become");
  });

  it("lets approval and input waits override ordinary progress", () => {
    const planSteps = [
      { id: "one", description: "Open browser", status: "in_progress" as const },
      { id: "two", description: "Finish", status: "pending" as const },
    ];
    const events = [
      event("approval", 1, "approval_requested", {
        approval: { type: "browser_access" },
      }),
    ];
    const model = deriveTaskStatusStrip({
      task: { id: "task-1", status: "executing", updatedAt: 1_001 } as Any,
      events,
      planSteps,
      activityGroups: [],
      outcomeMetrics: [],
      outputSummary: null,
    });

    expect(model.state).toBe("waiting_for_approval");
    expect(model.primaryLabel).toBe("Needs approval");
    expect(model.blockingLabel).toBe("Browser access");
    expect(model.activeStepOrdinal).toBe(1);
  });

  it("keeps the remaining concurrent approval blocking after another is granted", () => {
    const events = [
      event("approval-a", 1, "approval_requested", {
        approval: { id: "approval-a", type: "browser_access", status: "pending" },
      }),
      event("approval-b", 2, "approval_requested", {
        approval: { id: "approval-b", type: "send_email", status: "pending" },
      }),
      event("grant-a", 3, "approval_granted", { approvalId: "approval-a" }),
    ];
    const model = deriveTaskStatusStrip({
      task: { id: "task-1", status: "executing", updatedAt: 1_003 } as Any,
      events,
      planSteps: [],
      activityGroups: [],
      outcomeMetrics: [],
      outputSummary: null,
    });

    expect(model.state).toBe("waiting_for_approval");
    expect(model.blockingEventId).toBe("approval-b");
    expect(model.blockingLabel).toBe("Send email");
  });
});
