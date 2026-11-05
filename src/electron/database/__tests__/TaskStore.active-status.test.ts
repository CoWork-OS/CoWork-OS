import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseManager } from "../schema";
import { TaskStore, WorkspaceStore } from "../repositories";

describe("TaskStore status change to a running state", () => {
  let directory: string;
  let previousUserDataDir: string | undefined;
  let manager: DatabaseManager;
  let tasks: TaskStore;
  let workspaceId: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-task-active-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = directory;
    manager = new DatabaseManager({ dbPath: path.join(directory, "test.db") });
    tasks = new TaskStore(manager.getDatabase());
    workspaceId = new WorkspaceStore(manager.getDatabase()).create("Workspace", directory, {
      read: true,
      write: true,
      delete: false,
      network: false,
      shell: false,
    }).id;
  });

  afterEach(() => {
    manager.close();
    if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
    else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("drops the pause reason with the rest of the waiting state", () => {
    const task = tasks.create({
      title: "Explain this config",
      prompt: "Explain this config",
      status: "pending",
      workspaceId,
    });
    tasks.update(task.id, {
      status: "paused",
      terminalStatus: "needs_user_action",
      awaitingUserInputReasonCode: "workspace_required",
    });
    expect(tasks.findById(task.id)?.awaitingUserInputReasonCode).toBe("workspace_required");

    // The user's reply restarts the task with only a status change.
    tasks.update(task.id, { status: "executing" });
    const running = tasks.findById(task.id);
    expect(running?.terminalStatus).toBeUndefined();
    expect(running?.awaitingUserInputReasonCode).toBeUndefined();

    // A running state that names its own reason keeps it.
    tasks.update(task.id, { status: "executing", awaitingUserInputReasonCode: "skill_parameters" });
    expect(tasks.findById(task.id)?.awaitingUserInputReasonCode).toBe("skill_parameters");
  });
});
