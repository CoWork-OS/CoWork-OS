import { describe, expect, it } from "vitest";

import type { Task } from "../../../../shared/types";
import type { AgentLifecycleRow } from "../../../utils/agent-lifecycle-rows";
import { getAgentLifecycleRowRevision } from "../MainContent";

const row: AgentLifecycleRow = {
  id: "agents:child-1",
  state: "finished",
  timestamp: 10,
  taskIds: ["child-1"],
};

function childTasks(updates: Partial<Task>): Map<string, Task> {
  const task = {
    id: "child-1",
    title: "Research agent",
    status: "completed",
    ...updates,
  } as Task;
  return new Map([[task.id, task]]);
}

describe("getAgentLifecycleRowRevision", () => {
  it("changes when a finished agent's summary or error arrives after its status", () => {
    const statusOnly = getAgentLifecycleRowRevision(row, childTasks({}));

    expect(getAgentLifecycleRowRevision(row, childTasks({}))).toBe(statusOnly);
    expect(
      getAgentLifecycleRowRevision(row, childTasks({ resultSummary: "Found three sources" })),
    ).not.toBe(statusOnly);
    expect(
      getAgentLifecycleRowRevision(row, childTasks({ status: "failed", error: "Timed out" })),
    ).not.toBe(getAgentLifecycleRowRevision(row, childTasks({ status: "failed" })));
  });

  it("changes when the agent is renamed or the row changes state", () => {
    const base = getAgentLifecycleRowRevision(row, childTasks({}));

    expect(getAgentLifecycleRowRevision(row, childTasks({ title: "Data agent" }))).not.toBe(base);
    expect(getAgentLifecycleRowRevision({ ...row, state: "failed" }, childTasks({}))).not.toBe(
      base,
    );
  });
});
