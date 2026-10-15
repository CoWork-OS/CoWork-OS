import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { AgentRoleData } from "../../../../electron/preload";
import type { Task } from "../../../../shared/types";
import { MCBoardTab } from "../MCBoardTab";
import { resolveMissionColumnForTask, type MissionControlData } from "../useMissionControlData";

function renderBoard(data: MissionControlData): string {
  return renderToStaticMarkup(React.createElement(MCBoardTab, { data }));
}

function makeAgent(overrides: Partial<AgentRoleData> = {}): AgentRoleData {
  return {
    id: "agent-1",
    name: "agent-1",
    displayName: "Project Manager",
    description: "Keeps work moving",
    icon: "Bot",
    color: "#8b5cf6",
    isActive: true,
    isSystem: false,
    capabilities: ["plan"],
    autonomyLevel: "lead",
    systemPrompt: "",
    createdAt: Date.UTC(2026, 3, 11, 12, 0, 0),
    updatedAt: Date.UTC(2026, 3, 11, 12, 0, 0),
    ...overrides,
  } as AgentRoleData;
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Subconscious: Project Manager",
    prompt: "Review the backlog",
    status: "queued",
    boardColumn: "backlog",
    assignedAgentRoleId: "agent-1",
    createdAt: Date.UTC(2026, 3, 11, 12, 0, 0),
    updatedAt: Date.UTC(2026, 3, 11, 12, 15, 0),
    workspaceId: "ws-1",
    labels: [],
    priority: 0,
    estimatedMinutes: 30,
    source: "subconscious",
    ...overrides,
  } as Task;
}

function makeData(taskOverrides: Partial<Task> = {}): MissionControlData {
  const agent = makeAgent();
  const task = makeTask(taskOverrides);

  return {
    agents: [agent],
    tasks: [task],
    taskLabels: [],
    workspaces: [{ id: "ws-1", name: "Workspace One" }],
    detailPanel: null,
    dragOverColumn: null,
    setDetailPanel: () => {},
    setDragOverColumn: () => {},
    getAgent: (agentRoleId?: string | null) => (agentRoleId === agent.id ? agent : null),
    getAgentStatus: () => "idle",
    handleMoveTask: async () => {},
    handleTriggerHeartbeat: async () => {},
    handleSetTaskPriority: async () => {},
    formatRelativeTime: () => "just now",
    formatTaskEstimate: () => "30m",
    getTaskDueInfo: () => null,
    getTaskPriorityMeta: () => ({ value: 0, label: "None", color: "#6b7280", shortLabel: "P0" }),
    getMissionColumnForTask: () => "assigned",
    getTaskLabels: () => [],
    getTaskAttentionReason: () => null,
    getTaskNextMissionColumn: () => "in_progress",
    isTaskTerminal: () => false,
    isTaskStale: () => false,
    isTaskAttentionRequired: () => false,
    agentContext: {
      getUiCopy: (_key: string) => "No tasks yet",
    },
    isAllWorkspacesSelected: false,
    getWorkspaceName: () => "Workspace One",
  } as unknown as MissionControlData;
}

function makeDataWithTasks(tasks: Task[]): MissionControlData {
  return {
    ...makeData(),
    tasks,
    getMissionColumnForTask: (task: Task) => resolveMissionColumnForTask(task),
  } as MissionControlData;
}

function kanbanMarkup(markup: string): string {
  return markup.slice(markup.indexOf('<div class="mc-v2-kanban">'));
}

describe("MCBoardTab", () => {
  it("renders task action icons and draws the assignee as its character", () => {
    const markup = renderBoard(makeData());

    expect(markup).toContain("lucide-eye");
    expect(markup).toContain("lucide-flag");
    expect(markup).toContain("lucide-zap");
    expect(markup).toContain("lucide-arrow-right");
    expect(markup).toMatch(/mc-v2-task-assignee"><svg class="bot-mascot"[^>]*data-mascot="/);
  });

  it("keeps unassigned tasks to the three non-owner action icons", () => {
    const markup = renderBoard(makeData({ assignedAgentRoleId: undefined }));

    expect(markup).toContain("lucide-eye");
    expect(markup).toContain("lucide-flag");
    expect(markup).toContain("lucide-arrow-right");
    expect(markup).not.toContain("lucide-zap");
  });

  it("offers no New task or Link existing actions in any lane", () => {
    const markup = renderBoard(
      makeDataWithTasks([
        makeTask({ id: "t-inbox", boardColumn: "backlog", assignedAgentRoleId: undefined }),
        makeTask({ id: "t-ready", boardColumn: "todo" }),
        makeTask({ id: "t-working", boardColumn: "in_progress", status: "executing" }),
        makeTask({ id: "t-review", boardColumn: "review" }),
      ]),
    );

    expect(markup).not.toContain("New task");
    expect(markup).not.toContain("Link existing");
    expect(markup).not.toContain("mc-v2-column-footer");
    expect(markup).not.toContain("lucide-plus");
    expect(markup).not.toContain("lucide-arrow-up-right");
    expect(markup).not.toContain("__new__");
    expect(markup).not.toContain("__link__");
  });

  it("keeps every button inside the lanes on a task card", () => {
    const markup = kanbanMarkup(
      renderBoard(
        makeDataWithTasks([
          makeTask({ id: "t-inbox", boardColumn: "backlog", assignedAgentRoleId: undefined }),
          makeTask({ id: "t-ready", boardColumn: "todo" }),
        ]),
      ),
    );
    const buttonClasses = [...markup.matchAll(/<button[^>]*class="([^"]*)"/g)].map(
      (match) => match[1],
    );

    // Unassigned card: details, priority, next stage. Assigned card adds Wake owner.
    expect(buttonClasses).toHaveLength(7);
    expect(new Set(buttonClasses)).toEqual(new Set(["mc-v2-task-action-btn"]));
  });

  it("ends an empty lane with its empty copy", () => {
    const markup = renderBoard(
      makeDataWithTasks([
        makeTask({ id: "t-inbox", boardColumn: "backlog", assignedAgentRoleId: undefined }),
      ]),
    );

    for (const label of ["Ready to start", "Working", "Needs review"]) {
      expect(markup).toContain(`<span class="mc-v2-column-label">${label}</span>`);
    }
    // Ready to start, Working and Needs review are empty; Done is hidden in the Active view.
    const emptyLaneEnd =
      '<div class="mc-v2-column-tasks"><div class="mc-v2-column-empty">No tasks yet</div></div></div>';
    expect(markup.split(emptyLaneEnd)).toHaveLength(4);
    expect(markup).not.toContain('<span class="mc-v2-column-label">Done</span>');
  });
});
