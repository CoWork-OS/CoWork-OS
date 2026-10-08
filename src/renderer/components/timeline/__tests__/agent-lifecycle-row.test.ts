import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Task } from "../../../../shared/types";
import { assignAgentGlyphs } from "../../../utils/agent-glyphs";
import { AgentLifecycleRow } from "../AgentLifecycleRow";

function makeTask(id: string, title: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title,
    prompt: "Inspect the renderer",
    status: "executing",
    workspaceId: "workspace-1",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as Task;
}

describe("AgentLifecycleRow", () => {
  const tasks = [
    makeTask("a", "Renderer workflows (explorer)"),
    makeTask("b", "Task data lifecycle"),
    makeTask("c", "Runtime permissions"),
    makeTask("d", "Connectors gateway"),
  ];
  const glyphs = assignAgentGlyphs(tasks);

  it("renders a glyph per agent and the roster line", () => {
    const html = renderToStaticMarkup(
      React.createElement(AgentLifecycleRow, {
        row: {
          id: "start:working:a",
          state: "working",
          timestamp: 1,
          taskIds: ["a", "b", "c", "d"],
        },
        tasks,
        glyphs,
        onOpenAgent: () => undefined,
      }),
    );
    expect(html).toContain("Renderer workflows, Task data lifecycle and 2 more started working");
    expect(html.match(/class="agent-glyph[ "]/g)).toHaveLength(4);
    // Running agents animate in a start row.
    expect(html).toContain("is-working");
    // Details stay folded until the row is opened.
    expect(html).not.toContain("agent-lifecycle-item");
  });

  it("names the outcome on end rows and does not animate them", () => {
    const done = tasks.slice(0, 1).map((task) => ({ ...task, status: "completed" as const }));
    const html = renderToStaticMarkup(
      React.createElement(AgentLifecycleRow, {
        row: { id: "end:finished:a", state: "finished", timestamp: 2, taskIds: ["a"] },
        tasks: done,
        glyphs,
      }),
    );
    expect(html).toContain("Renderer workflows finished");
    expect(html).not.toContain("is-working");
  });

  it("lists each agent with status and instructions when expanded", () => {
    const html = renderToStaticMarkup(
      React.createElement(AgentLifecycleRow, {
        row: { id: "start:working:a", state: "working", timestamp: 1, taskIds: ["a", "b"] },
        tasks: tasks.slice(0, 2),
        glyphs,
        onOpenAgent: () => undefined,
        defaultExpanded: true,
      }),
    );
    expect(html).toContain('aria-expanded="true"');
    expect(html.match(/class="agent-lifecycle-item"/g)).toHaveLength(2);
    expect(html).toContain("Inspect the renderer");
    expect(html).toContain("agent-status-running");
  });
});
