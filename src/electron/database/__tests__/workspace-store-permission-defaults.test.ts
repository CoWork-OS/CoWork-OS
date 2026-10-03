import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseManager } from "../schema";
import { WorkspaceStore } from "../repositories";

const nativeSqliteAvailable = (() => {
  try {
    new Database(":memory:").close();
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!nativeSqliteAvailable)("WorkspaceStore permission defaults", () => {
  let tempDir: string;
  let manager: DatabaseManager;
  let previousUserDataDir: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-workspace-defaults-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tempDir;
    manager = new DatabaseManager({ dbPath: path.join(tempDir, "test.db") });
  });

  afterEach(() => {
    manager?.close();
    if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
    else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const insertRaw = (id: string, permissions: string) =>
    manager
      .getDatabase()
      .prepare(
        "INSERT INTO workspaces (id, name, path, created_at, permissions) VALUES (?, ?, ?, ?, ?)",
      )
      .run(id, id, path.join(tempDir, id), Date.now(), permissions);

  it("turns delete on for a record that never stored it", () => {
    insertRaw("never-set", JSON.stringify({ read: true, write: true, network: true }));
    const workspace = new WorkspaceStore(manager.getDatabase()).findById("never-set");
    expect(workspace?.permissions).toMatchObject({ read: true, write: true, delete: true });
    expect(workspace?.permissions.shell).toBe(false);
  });

  it("keeps a stored delete value, including false", () => {
    insertRaw("stored-off", JSON.stringify({ read: true, write: true, delete: false }));
    insertRaw("stored-on", JSON.stringify({ read: true, write: true, delete: true }));
    const store = new WorkspaceStore(manager.getDatabase());
    expect(store.findById("stored-off")?.permissions.delete).toBe(false);
    expect(store.findById("stored-on")?.permissions.delete).toBe(true);
  });
});
