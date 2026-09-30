import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BrowserGitMutationReceiptRepository } from "../repository-facades";
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

describeWithSqlite("browser Git mutation receipt", () => {
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

  it("reserves one intent and reconciles its completed result after reopen", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-browser-git-receipt-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tempDir;
    manager = new DatabaseManager();
    const key = "a".repeat(64);
    const fingerprint = "b".repeat(64);
    const repository = new BrowserGitMutationReceiptRepository(manager.getDatabase());
    const intent = {
      action: "stage" as const,
      workspaceId: "workspace-1",
      expectedRevision: "c".repeat(64),
      expectedHead: "d".repeat(40),
      expectedTree: "",
      relativePaths: ["notes.txt"],
    };
    const reserved = await repository.reserve(key, fingerprint, intent);
    expect(reserved.created).toBe(true);
    expect(reserved.receipt).toMatchObject({ intent, state: "pending" });
    const replay = await repository.reserve(key, "e".repeat(64), {
      ...intent,
      relativePaths: ["other.txt"],
    });
    expect(replay.created).toBe(false);
    expect(replay.receipt).toEqual(reserved.receipt);

    await repository.complete(key, {
      workspaceId: intent.workspaceId,
      action: "stage",
      outcome: "applied",
      revision: "f".repeat(64),
      branch: "main",
      changedFiles: 1,
      stagedChanges: 1,
    });
    manager.close();
    manager = new DatabaseManager();
    const reopened = new BrowserGitMutationReceiptRepository(manager.getDatabase());
    await expect(reopened.get(key)).resolves.toMatchObject({
      fingerprint,
      intent,
      state: "completed",
      result: { action: "stage", outcome: "applied", branch: "main" },
    });
  });

  it("creates its receipt table when opening an older profile", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-browser-git-upgrade-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tempDir;
    manager = new DatabaseManager();
    manager.getDatabase().exec("DROP TABLE browser_git_mutation_receipts");
    manager.close();
    manager = new DatabaseManager();
    const repository = new BrowserGitMutationReceiptRepository(manager.getDatabase());
    await expect(repository.get("f".repeat(64))).resolves.toBeNull();
  });
});
