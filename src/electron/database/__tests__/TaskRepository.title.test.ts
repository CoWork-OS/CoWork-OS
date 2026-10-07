import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseManager } from "../schema";
import { TaskRepository } from "../repository-facades";
import { WorkspaceStore } from "../repositories";

describe("TaskRepository generated title guard", () => {
  let directory: string;
  let previousUserDataDir: string | undefined;
  let manager: DatabaseManager;
  let repository: TaskRepository;
  let workspaceId: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-task-title-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = directory;
    manager = new DatabaseManager({ dbPath: path.join(directory, "test.db") });
    repository = new TaskRepository(manager.getDatabase());
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

  async function createTask() {
    return await repository.create({
      title: "what is 2+2?",
      prompt: "what is 2+2?",
      status: "pending",
      workspaceId,
    });
  }

  it("persists a generated name through the storage unit", async () => {
    const task = await createTask();
    expect(await repository.updateTitleIfUnchanged(task.id, task.title, "Add two numbers")).toBe(
      true,
    );
    expect((await repository.findById(task.id))?.title).toBe("Add two numbers");
  });

  it("preserves a manual rename even when a generator already read the placeholder", async () => {
    const task = await createTask();
    await repository.findById(task.id);
    await repository.update(task.id, { title: "My arithmetic check" });
    expect(await repository.updateTitleIfUnchanged(task.id, task.title, "Add two numbers")).toBe(
      false,
    );
    expect((await repository.findById(task.id))?.title).toBe("My arithmetic check");
  });

  it("does not recreate a deleted task", async () => {
    const task = await createTask();
    await repository.delete(task.id);
    expect(await repository.updateTitleIfUnchanged(task.id, task.title, "Add two numbers")).toBe(
      false,
    );
    expect(await repository.findById(task.id)).toBeUndefined();
  });
});
