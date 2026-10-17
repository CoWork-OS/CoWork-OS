import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Task, TaskEvent } from "../../../shared/types";

// The dashboard normally loads its summary after mount. Render its visibility
// contract synchronously so server rendering exercises the parent's decision.
vi.mock("../SessionDashboardCard", () => ({
  SessionDashboardCard: ({ showSummary }: { showSummary: boolean }) =>
    React.createElement(
      "section",
      null,
      showSummary ? "Session dashboard summary" : null,
      React.createElement("button", null, "Local preview"),
    ),
}));

import { RightPanel } from "../RightPanel";

const task = {
  id: "chat-1",
  title: "Outline my afternoon",
  prompt: "Help me prioritize my afternoon.",
  status: "completed",
  agentConfig: { executionMode: "chat" },
} as Task;

describe("RightPanel conversational progress", () => {
  it.each(["executing", "completed", "failed"] as const)(
    "keeps tools without empty execution summaries for a %s chat turn",
    (status) => {
      const markup = renderToStaticMarkup(
        React.createElement(RightPanel, { task: { ...task, status }, workspace: null, events: [] }),
      );

      expect(markup).not.toContain("Session dashboard summary");
      expect(markup).not.toContain('class="cli-progress-list"');
      expect(markup).not.toContain('class="cli-status-badge');
      expect(markup).not.toContain("All done");
      expect(markup).toContain("Local preview");
    },
  );

  it("retains a real plan in a conversation session", () => {
    const events = [
      {
        id: "plan-1",
        taskId: task.id,
        type: "plan_created",
        timestamp: 1,
        schemaVersion: 2,
        payload: {
          plan: {
            steps: [{ id: "step-1", description: "Draft the schedule", status: "completed" }],
          },
        },
      },
    ] as TaskEvent[];
    const markup = renderToStaticMarkup(
      React.createElement(RightPanel, { task, workspace: null, events }),
    );

    expect(markup).toContain("Session dashboard summary");
    expect(markup).toContain("Draft the schedule");
  });

  it("retains execution status for work that has no plan yet", () => {
    const markup = renderToStaticMarkup(
      React.createElement(RightPanel, {
        task: { ...task, status: "executing", agentConfig: { executionMode: "execute" } },
        workspace: null,
        events: [],
      }),
    );

    expect(markup).toContain("Session dashboard summary");
    expect(markup).toContain("Working...");
  });
});
