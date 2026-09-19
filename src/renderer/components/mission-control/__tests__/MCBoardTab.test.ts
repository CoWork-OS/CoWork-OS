import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { AgentRoleData } from "../../../../electron/preload";
import type { Task } from "../../../../shared/types";
import { MCBoardTab } from "../MCBoardTab";
import type { MissionControlData } from "../useMissionControlData";

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

describe("MCBoardTab", () => {
  it("renders task action icons and resolves the assignee icon component", () => {
    const markup = renderBoard(makeData());

    expect(markup).toContain("lucide-eye");
    expect(markup).toContain("lucide-flag");
    expect(markup).toContain("lucide-zap");
    expect(markup).toContain("lucide-arrow-right");
    expect(markup).toContain("mc-v2-task-assignee-avatar");
    // The default assignee glyph is the shared Phosphor bot mark (a 256 unit
    // viewBox), not a lucide icon.
    expect(markup).toMatch(/mc-v2-task-assignee-avatar[^>]*>\s*<svg[^>]*viewBox="0 0 256 256"/);
  });

  it("keeps unassigned tasks to the three non-owner action icons", () => {
    const markup = renderBoard(makeData({ assignedAgentRoleId: undefined }));

    expect(markup).toContain("lucide-eye");
    expect(markup).toContain("lucide-flag");
    expect(markup).toContain("lucide-arrow-right");
    expect(markup).not.toContain("lucide-zap");
  });
});
