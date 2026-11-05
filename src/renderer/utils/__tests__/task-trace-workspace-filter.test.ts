import { describe, expect, it } from "vitest";

import { resolveTaskTraceWorkspaceFilter, TASK_TRACE_ALL_WORKSPACES } from "../task-trace-debugger";

const listed = [{ id: "ws-project" }, { id: "ws-company" }];

describe("resolveTaskTraceWorkspaceFilter", () => {
  it("opens on all workspaces for a session's temporary workspace", () => {
    expect(resolveTaskTraceWorkspaceFilter("__temp_workspace__:ui-session-4xwv39", null)).toBe(
      TASK_TRACE_ALL_WORKSPACES,
    );
    expect(resolveTaskTraceWorkspaceFilter("__temp_workspace__:ui-session-4xwv39", listed)).toBe(
      TASK_TRACE_ALL_WORKSPACES,
    );
  });

  it("keeps a listed workspace and drops one the picker does not offer", () => {
    expect(resolveTaskTraceWorkspaceFilter("ws-project", null)).toBe("ws-project");
    expect(resolveTaskTraceWorkspaceFilter("ws-project", listed)).toBe("ws-project");
    expect(resolveTaskTraceWorkspaceFilter("ws-removed", listed)).toBe(TASK_TRACE_ALL_WORKSPACES);
  });

  it("defaults to all workspaces", () => {
    expect(resolveTaskTraceWorkspaceFilter(undefined, null)).toBe(TASK_TRACE_ALL_WORKSPACES);
    expect(resolveTaskTraceWorkspaceFilter(TASK_TRACE_ALL_WORKSPACES, listed)).toBe(
      TASK_TRACE_ALL_WORKSPACES,
    );
  });
});
