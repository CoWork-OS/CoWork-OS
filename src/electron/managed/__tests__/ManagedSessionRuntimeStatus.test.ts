import { describe, expect, it } from "vitest";

import type { AgentTeamRun, Task } from "../../../shared/types";
import { deriveManagedSessionRuntimeStatus } from "../ManagedSessionService";

const task = (status: Task["status"]): Task => ({ status } as Task);
const team = (status: AgentTeamRun["status"]): AgentTeamRun => ({ status } as AgentTeamRun);

describe("deriveManagedSessionRuntimeStatus", () => {
  it("uses pending input and team terminal states instead of a stale running root task", () => {
    expect(deriveManagedSessionRuntimeStatus(task("executing"), team("running"), true)).toBe(
      "awaiting_input",
    );
    expect(deriveManagedSessionRuntimeStatus(task("executing"), team("failed"))).toBe("failed");
    expect(deriveManagedSessionRuntimeStatus(task("executing"), team("cancelled"))).toBe(
      "cancelled",
    );
  });

  it("treats a completed team as completed even if the root task has not reconciled", () => {
    expect(deriveManagedSessionRuntimeStatus(task("executing"), team("completed"))).toBe(
      "completed",
    );
  });
});
