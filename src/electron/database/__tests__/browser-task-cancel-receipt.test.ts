import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BrowserTaskCancelReceiptRepository } from "../repository-facades";
import { DatabaseManager } from "../schema";
import { setStatementClient } from "../statements/statement-route";

const nativeSqliteAvailable = (() => {
  try {
    new Database(":memory:").close();
    return true;
  } catch {
    return false;
  }
})();

const describeWithSqlite = nativeSqliteAvailable ? describe : describe.skip;

describeWithSqlite("browser task cancellation receipt", () => {
  let tempDir: string | undefined;
  let manager: DatabaseManager | undefined;
  let previousUserDataDir: string | undefined;

  afterEach(() => {
    setStatementClient(null, null, null);
    manager?.close();
    manager = undefined;
    if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
    else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it("keeps one reserved key and its observed result across database reopen", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-browser-cancel-receipt-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tempDir;
    manager = new DatabaseManager();
    const key = "a".repeat(64);
    const fingerprint = "b".repeat(64);
    const first = new BrowserTaskCancelReceiptRepository(manager.getDatabase());
    const reserved = await first.reserve(key, fingerprint, "task-1", "workspace-1", "queued", 123);
    expect(reserved.created).toBe(true);
    expect(reserved.receipt).toMatchObject({ taskId: "task-1", state: "pending" });
    const replay = await first.reserve(key, "c".repeat(64), "task-2", "workspace-2", "queued", 456);
    expect(replay.created).toBe(false);
    expect(replay.receipt).toEqual(reserved.receipt);

    await first.complete(key, {
      taskId: "task-1",
      workspaceId: "workspace-1",
      operationKey: "browser-operation-1",
      outcome: "observed_terminal",
      status: "cancelled",
      updatedAt: 124,
    });
    manager.close();
    manager = new DatabaseManager();
    const reopened = new BrowserTaskCancelReceiptRepository(manager.getDatabase());
    await expect(reopened.get(key)).resolves.toMatchObject({
      fingerprint,
      taskId: "task-1",
      state: "completed",
      result: { status: "cancelled", outcome: "observed_terminal" },
    });
  });

  it("adds the receipt table when opening an older profile database", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-browser-cancel-upgrade-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tempDir;
    manager = new DatabaseManager();
    manager.getDatabase().exec("DROP TABLE browser_task_cancel_receipts");
    manager.close();
    manager = new DatabaseManager();
    const receipt = new BrowserTaskCancelReceiptRepository(manager.getDatabase());
    await expect(receipt.get("d".repeat(64))).resolves.toBeNull();
  });
});
