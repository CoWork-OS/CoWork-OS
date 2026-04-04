import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RightPanel } from "../RightPanel";

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
});
