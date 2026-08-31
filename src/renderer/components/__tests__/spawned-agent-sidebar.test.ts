import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Task, TaskEvent, Workspace } from "../../../shared/types";
import { resolveSpawnedAgentSidebarTask } from "../../utils/spawned-agent-sidebar";
import { SpawnedAgentSidebar } from "../SpawnedAgentSidebar";

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    parentTaskId: "parent-1",
    agentType: "sub",
    title: id === "child-1" ? "Euclid" : "Ada",
    prompt: "Inspect the codebase",
    status: "executing",
    createdAt: 1740840900000,
    updatedAt: 1740840960000,
    ...overrides,
  } as Task;
}

function makeEvent(taskId: string, id: string): TaskEvent {
  return {
    id,
    taskId,
    timestamp: 1740840960000,
    type: "assistant_message",
    payload: { message: "Working through the task." },
    schemaVersion: 2,
  } as TaskEvent;
}

function renderSidebar(props: {
  childTasks: Task[];
  childEvents?: TaskEvent[];
  selectedTaskId?: string | null;
}) {
  const workspace = { id: "workspace-1", path: "/tmp/workspace" } as Workspace;
  return renderToStaticMarkup(
    React.createElement(SpawnedAgentSidebar, {
      parentTask: { id: "parent-1", title: "Parent task" } as Task,
      childTasks: props.childTasks,
      childEvents: props.childEvents ?? [],
      selectedTaskId: props.selectedTaskId ?? props.childTasks[0]?.id ?? null,
      workspace,
      selectedModel: "opus-4-5",
      selectedProvider: "anthropic",
      availableModels: [],
      availableProviders: [],
      uiDensity: "focused",
      onSelectTask: () => undefined,
      onClose: () => undefined,
      onModelChange: () => undefined,
      showTranscript: false,
    }),
  );
}

describe("SpawnedAgentSidebar", () => {
  it("resolves the selected child without changing parent selection", () => {
    const first = makeTask("child-1");
    const second = makeTask("child-2");

    expect(resolveSpawnedAgentSidebarTask([first, second], "child-2")?.id).toBe("child-2");
    expect(resolveSpawnedAgentSidebarTask([first, second], "missing")?.id).toBe("child-1");
    expect(resolveSpawnedAgentSidebarTask([], "child-1")).toBeNull();
  });

  it("renders a single selected spawned agent without tabs", () => {
    const markup = renderSidebar({
      childTasks: [makeTask("child-1")],
      childEvents: [makeEvent("child-1", "evt-1")],
    });

    expect(markup).toContain("Spawned from Parent task");
    expect(markup).toContain("Euclid");
    expect(markup).toContain("1 event");
    expect(markup).not.toContain('role="tab"');
  });

  it("renders switchable tabs for multiple spawned agents", () => {
    const markup = renderSidebar({
      childTasks: [makeTask("child-1"), makeTask("child-2", { status: "completed" })],
      selectedTaskId: "child-2",
    });

    expect(markup).toContain('role="tablist"');
    expect(markup).toContain('aria-selected="true"');
    expect(markup).toContain("Ada");
    expect(markup).toContain("Done");
  });
});
