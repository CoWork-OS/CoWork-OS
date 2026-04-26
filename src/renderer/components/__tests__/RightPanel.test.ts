import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  RightPanel,
  getProgressSectionMaterialSignature,
  getQueueSectionMaterialSignature,
  getVisibleProgressSteps,
} from "../RightPanel";

describe("RightPanel checklist rendering", () => {
  it("renders task feedback controls in the right panel for completed tasks", () => {
    const markup = renderToStaticMarkup(
      React.createElement(RightPanel, {
        task: {
          id: "task-1",
          status: "completed",
          title: "Task",
          prompt: "Prompt",
        } as Any,
        workspace: null,
        events: [] as Any,
      }),
    );

    expect(markup).toContain("Rate this result");
    expect(markup).toContain("Helps improve this agent and persona.");
    expect(markup).toContain("Dismiss");
  });

  it("renders the latest session checklist state and verification nudge", () => {
    const markup = renderToStaticMarkup(
      React.createElement(RightPanel, {
        task: {
          id: "task-1",
          status: "executing",
          title: "Task",
          prompt: "Prompt",
        } as Any,
        workspace: null,
        events: [
          {
            id: "evt-1",
            taskId: "task-1",
            timestamp: 100,
            schemaVersion: 2,
            type: "task_list_updated",
            payload: {
              checklist: {
                items: [
                  {
                    id: "item-1",
                    title: "Implement checklist primitive",
                    kind: "implementation",
                    status: "completed",
                    createdAt: 10,
                    updatedAt: 20,
                  },
                  {
                    id: "item-2",
                    title: "Run focused verification",
                    kind: "verification",
                    status: "pending",
                    createdAt: 10,
                    updatedAt: 20,
                  },
                ],
                updatedAt: 20,
                verificationNudgeNeeded: true,
                nudgeReason: "Add and run a verification checklist item before finishing.",
              },
            },
          },
        ] as Any,
      }),
    );

    expect(markup).toContain("Checklist");
    expect(markup).toContain("Implement checklist primitive");
    expect(markup).toContain("Run focused verification");
    expect(markup).toContain("Verification");
    expect(markup).toContain("Add and run a verification checklist item before finishing.");
  });

  it("keeps the checklist visible during live execution even when items are still pending", () => {
    const markup = renderToStaticMarkup(
      React.createElement(RightPanel, {
        task: {
          id: "task-1",
          status: "executing",
          title: "Task",
          prompt: "Prompt",
        } as Any,
        workspace: null,
        events: [
          {
            id: "evt-1",
            taskId: "task-1",
            timestamp: 100,
            schemaVersion: 2,
            type: "task_list_created",
            payload: {
              checklist: {
                items: [
                  {
                    id: "item-1",
                    title: "Draft chapter outline",
                    kind: "implementation",
                    status: "pending",
                    createdAt: 10,
                    updatedAt: 20,
                  },
                ],
                updatedAt: 20,
                verificationNudgeNeeded: false,
              },
            },
          },
        ] as Any,
      }),
    );

    expect(markup).toContain("Checklist");
    expect(markup).toContain("Draft chapter outline");
    expect(markup).toContain("Pending");
  });

  it("uses the live checklist item as fallback progress text when no plan exists", () => {
    const markup = renderToStaticMarkup(
      React.createElement(RightPanel, {
        task: {
          id: "task-1",
          status: "executing",
          title: "Task",
          prompt: "Prompt",
        } as Any,
        workspace: null,
        events: [
          {
            id: "evt-1",
            taskId: "task-1",
            timestamp: 100,
            schemaVersion: 2,
            type: "task_list_updated",
            payload: {
              checklist: {
                items: [
                  {
                    id: "item-1",
                    title: "Update canonical target settings",
                    kind: "implementation",
                    status: "in_progress",
                    createdAt: 10,
                    updatedAt: 20,
                  },
                ],
                updatedAt: 20,
                verificationNudgeNeeded: false,
              },
            },
          },
        ] as Any,
      }),
    );

    expect(markup).toContain("Working...");
    expect(markup).toContain("Update canonical target settings");
  });

  it("shows created files while a task is still executing", () => {
    const markup = renderToStaticMarkup(
      React.createElement(RightPanel, {
        task: {
          id: "task-1",
          status: "executing",
          title: "Write novel",
          prompt: "Prompt",
        } as Any,
        workspace: {
          id: "ws-1",
          name: "workspace",
          path: "/workspace",
        } as Any,
        events: [
          {
            id: "evt-1",
            taskId: "task-1",
            timestamp: 100,
            schemaVersion: 2,
            type: "artifact_created",
            payload: {
              path: "/workspace/artifacts/chapters/ch_01.md",
            },
          },
        ] as Any,
      }),
    );

    expect(markup).toContain("Files");
    expect(markup).toContain("ch_01.md");
  });

  it("strips inline markdown formatting from progress step labels", () => {
    const markup = renderToStaticMarkup(
      React.createElement(RightPanel, {
        task: {
          id: "task-1",
          status: "executing",
          title: "Write novel",
          prompt: "Prompt",
        } as Any,
        workspace: null,
        events: [
          {
            id: "evt-1",
            taskId: "task-1",
            timestamp: 100,
            schemaVersion: 2,
            type: "plan_created",
            payload: {
              plan: {
                description: "Plan",
                steps: [
                  {
                    id: "step-1",
                    description: "**Genre**: Science fiction (Dune universe)",
                    status: "pending",
                  },
                ],
              },
            },
          },
        ] as Any,
      }),
    );

    expect(markup).toContain("Genre: Science fiction (Dune universe)");
    expect(markup).not.toContain("**Genre**");
  });

  it("keeps the progress material signature stable when only array identity changes", () => {
    const planSteps = [
      { id: "step-1", description: "Inspect logs", status: "in_progress" },
      { id: "step-2", description: "Apply fix", status: "pending" },
    ] as Any;

    const signatureA = getProgressSectionMaterialSignature({
      expanded: true,
      planSteps,
      taskStatus: "executing",
      taskTerminalStatus: undefined,
      hasActiveChildren: false,
      emptyHintText: "Standing by.",
    });
    const signatureB = getProgressSectionMaterialSignature({
      expanded: true,
      planSteps: [...planSteps] as Any,
      taskStatus: "executing",
      taskTerminalStatus: undefined,
      hasActiveChildren: false,
      emptyHintText: "Standing by.",
    });

    expect(signatureA).toBe(signatureB);
  });

  it("compacts long progress plans around the current work", () => {
    const planSteps = [
      { id: "step-1", description: "Completed step 1", status: "completed" },
      { id: "step-2", description: "Completed step 2", status: "completed" },
      { id: "step-3", description: "Completed step 3", status: "completed" },
      { id: "step-4", description: "Current step", status: "in_progress" },
      { id: "step-5", description: "Pending step 5", status: "pending" },
      { id: "step-6", description: "Pending step 6", status: "pending" },
      { id: "step-7", description: "Pending step 7", status: "pending" },
      { id: "step-8", description: "Pending step 8", status: "pending" },
      { id: "step-9", description: "Pending step 9", status: "pending" },
      { id: "step-10", description: "Pending step 10", status: "pending" },
    ] as Any;

    const visible = getVisibleProgressSteps(planSteps);

    expect(visible.map((step) => step.description)).toEqual([
      "1 completed step",
      "Completed step 2",
      "Completed step 3",
      "Current step",
      "Pending step 5",
      "Pending step 6",
      "4 planned steps",
    ]);
  });

  it("changes the queue material signature only when queue content changes", () => {
    const runningTasks = [{ id: "task-1", status: "executing", title: "Build" }] as Any;
    const queuedTasks = [{ id: "task-2", status: "queued", title: "Verify" }] as Any;

    const signatureA = getQueueSectionMaterialSignature({
      expanded: true,
      runningTasks,
      queuedTasks,
      activeLabel: "ACTIVE",
      nextLabel: "NEXT",
    });
    const signatureB = getQueueSectionMaterialSignature({
      expanded: true,
      runningTasks: [...runningTasks] as Any,
      queuedTasks: [...queuedTasks] as Any,
      activeLabel: "ACTIVE",
      nextLabel: "NEXT",
    });
    const signatureC = getQueueSectionMaterialSignature({
      expanded: true,
      runningTasks,
      queuedTasks: [{ id: "task-3", status: "queued", title: "Ship" }] as Any,
      activeLabel: "ACTIVE",
      nextLabel: "NEXT",
    });

    expect(signatureA).toBe(signatureB);
    expect(signatureC).not.toBe(signatureA);
  });

  it("keeps the context section visible during live execution and shows skills/tools", () => {
    const markup = renderToStaticMarkup(
      React.createElement(RightPanel, {
        task: {
          id: "task-1",
          status: "executing",
          title: "Task",
          prompt: "Prompt",
        } as Any,
        workspace: null,
        events: [
          {
            id: "evt-1",
            taskId: "task-1",
            timestamp: 50,
            schemaVersion: 2,
            type: "skill_applied",
            payload: {
              skillName: "Novelist",
            },
          },
          {
            id: "evt-2",
            taskId: "task-1",
            timestamp: 100,
            schemaVersion: 2,
            type: "tool_call",
            payload: {
              tool: "read_file",
              input: { path: "src/index.ts" },
            },
          },
        ] as Any,
      }),
    );

    expect(markup).toContain("Context");
    expect(markup).toContain("Skills used");
    expect(markup).toContain("Novelist");
    expect(markup).toContain("Tools used");
    expect(markup).toContain("read_file");
  });
});
