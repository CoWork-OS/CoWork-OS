import { describe, expect, it } from "vitest";

import {
  ALL_WORKSPACES_ID,
  createMissionControlWorkspaceDataLoadPlan,
} from "../useMissionControlData";

describe("Mission Control workspace data load plan", () => {
  const workspaces = [
    { id: "workspace-a", name: "Workspace A" },
    { id: "workspace-b", name: "Workspace B" },
    { id: "workspace-c", name: "Workspace C" },
  ];

  it("keeps all-workspaces launch loads on the critical path only", () => {
    const plan = createMissionControlWorkspaceDataLoadPlan(ALL_WORKSPACES_ID, workspaces, "critical");

    expect(plan).toMatchObject({
      includeAgents: true,
      includeHeartbeatStatuses: true,
      includeTasks: true,
      includeActivities: false,
      includeMentions: false,
      includeTaskLabels: false,
      taskListOptions: { limit: 2000 },
      supplementalWorkspaceIds: [],
    });
  });

  it("moves per-workspace fanout into a supplemental load", () => {
    const plan = createMissionControlWorkspaceDataLoadPlan(ALL_WORKSPACES_ID, workspaces, "supplemental");

    expect(plan).toMatchObject({
      includeAgents: false,
      includeHeartbeatStatuses: false,
      includeTasks: false,
      includeActivities: true,
      includeMentions: true,
      includeTaskLabels: true,
      supplementalWorkspaceIds: ["workspace-a", "workspace-b", "workspace-c"],
    });
  });
});
