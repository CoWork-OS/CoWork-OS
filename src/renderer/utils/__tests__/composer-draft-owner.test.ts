import { describe, expect, it } from "vitest";

import { resolveComposerDraftOwnerContext } from "../composer-draft-owner";

describe("resolveComposerDraftOwnerContext", () => {
  it("uses the selected task workspace while workspace state catches up", () => {
    expect(
      resolveComposerDraftOwnerContext({
        currentWorkspaceId: "workspace-before-switch",
        selectedTaskId: "task-2",
        selectedTask: { id: "task-2", workspaceId: "workspace-after-switch" },
      }),
    ).toEqual({
      workspaceId: "workspace-after-switch",
      taskId: "task-2",
      ready: true,
    });
  });

  it("waits for a selected task that has not been hydrated", () => {
    expect(
      resolveComposerDraftOwnerContext({
        currentWorkspaceId: "workspace-before-switch",
        selectedTaskId: "task-2",
      }),
    ).toEqual({ workspaceId: "", taskId: null, ready: false });
  });

  it("uses the current workspace for a new task draft", () => {
    expect(
      resolveComposerDraftOwnerContext({ currentWorkspaceId: "workspace-1", selectedTaskId: null }),
    ).toEqual({ workspaceId: "workspace-1", taskId: null, ready: true });
  });

  it("prefers the remote task owner", () => {
    expect(
      resolveComposerDraftOwnerContext({
        currentWorkspaceId: "local-workspace",
        selectedTaskId: "local-task",
        selectedTask: { id: "local-task", workspaceId: "local-workspace" },
        remoteTask: { id: "remote-task", workspaceId: "remote-workspace" },
      }),
    ).toEqual({ workspaceId: "remote-workspace", taskId: "remote-task", ready: true });
  });
});
