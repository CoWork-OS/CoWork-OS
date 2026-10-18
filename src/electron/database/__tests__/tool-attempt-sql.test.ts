import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseManager } from "../schema";
import { ToolAttemptRepository } from "../repository-facades";
import { ToolAttemptStore } from "../tool-attempt-sql";

vi.mock("../../utils/safe-storage", () => ({
  getSafeStorage: () => ({
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, "utf8"),
    decryptString: (value: Buffer) => value.toString("utf8"),
  }),
}));

const nativeSqliteAvailable = await import("better-sqlite3")
  .then((module) => {
    try {
      new module.default(":memory:").close();
      return true;
    } catch {
      return false;
    }
  })
  .catch(() => false);

const describeWithSqlite = nativeSqliteAvailable ? describe : describe.skip;

describeWithSqlite("tool attempts store", () => {
  let tmpDir: string;
  let previousUserDataDir: string | undefined;
  let manager: DatabaseManager;

  const begin = (store: ToolAttemptStore, id: string, taskId: string) =>
    store.begin({
      id,
      taskId,
      toolName: "write_file",
      argsHash: "hash",
      idempotencyKey: `key-${id}`,
      effect: "write",
      target: "report.md",
      startedAt: Date.now(),
    });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-tool-attempts-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tmpDir;
    manager = new DatabaseManager();
  });

  afterEach(() => {
    manager?.close();
    if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
    else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("records a call before dispatch and finishes it once", () => {
    const store = new ToolAttemptStore(manager.getDatabase());
    expect(begin(store, "a1", "t1")).toMatchObject({ status: "started", target: "report.md" });
    expect(store.finish("a1", "unknown", 10, "timed out")).toMatchObject({ status: "unknown" });
    // A late definite result replaces the guess; a finished row is not reopened.
    expect(store.finish("a1", "completed", 20)).toMatchObject({ status: "completed" });
    expect(store.finish("a1", "failed", 30)).toMatchObject({ status: "completed" });
  });

  it("marks calls left started by a previous process as unknown on restart", () => {
    const db = manager.getDatabase();
    begin(new ToolAttemptStore(db), "a1", "t1");
    begin(new ToolAttemptStore(db), "a2", "t-running");
    manager.close();

    manager = new DatabaseManager();
    const store = new ToolAttemptStore(manager.getDatabase());
    expect(store.recoverStartedAttempts(["t-running"], 99)).toEqual(["t1"]);
    expect(store.listForTask("t1")).toEqual([
      expect.objectContaining({ status: "unknown", reason: "process_restarted" }),
    ]);
    expect(store.listForTask("t-running")).toEqual([
      expect.objectContaining({ status: "started" }),
    ]);
    expect(store.recoverStartedAttempts(["t-running"], 99)).toEqual([]);
  });

  it("closes a stopped task's open calls and is reachable through the async facade", async () => {
    const repository = new ToolAttemptRepository(manager.getDatabase());
    await repository.begin({
      id: "a1",
      taskId: "t1",
      toolName: "mcp_jira_create_issue",
      argsHash: "hash",
      idempotencyKey: "key",
      effect: "unknown",
      startedAt: 1,
    });
    const closed = await repository.markStartedUnknown("t1", "stopped_while_running", 5);
    expect(closed).toEqual([
      expect.objectContaining({ id: "a1", status: "unknown", reason: "stopped_while_running" }),
    ]);
    expect(await repository.listForTask("t1")).toHaveLength(1);
  });
});
