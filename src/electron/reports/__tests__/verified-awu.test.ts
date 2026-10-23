import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskStore } from "../../database/repositories";
import { DatabaseManager } from "../../database/schema";
import { WorkSessionContractService } from "../../sessions/WorkSessionContractService";
import { usageLocalDateKey } from "../../../shared/usageInsightsDates";
import { UsageInsightsProjector } from "../UsageInsightsProjector";
import { UsageInsightsService } from "../UsageInsightsService";

vi.mock("../../utils/safe-storage", () => ({
  getSafeStorage: () => ({
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, "utf8"),
    decryptString: (value: Buffer) => value.toString("utf8"),
  }),
}));

const Database = await import("better-sqlite3")
  .then((module) => {
    try {
      new module.default(":memory:").close();
      return module.default;
    } catch {
      return null;
    }
  })
  .catch(() => null);

const describeWithSqlite = Database ? describe : describe.skip;

/** Verified AWU on a real profile: the live report and the day rollup agree. */
describeWithSqlite("verified agentic work units", () => {
  let tmpDir: string;
  let previousUserDataDir: string | undefined;
  let manager: DatabaseManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-verified-awu-"));
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

  function seed() {
    const db = manager.getDatabase();
    const workspaceId = "ws-awu";
    db.prepare(
      "INSERT INTO workspaces (id, name, path, created_at, permissions) VALUES (?, ?, ?, ?, ?)",
    ).run(workspaceId, "awu", tmpDir, Date.now(), JSON.stringify({ read: true, write: true }));
    const tasks = new TaskStore(db);
    const contracts = new WorkSessionContractService(db);
    const completedAt = Date.now() - 60_000;
    const make = (
      title: string,
      terminalStatus: "ok" | "partial_success" | "needs_user_action",
    ) => {
      const task = tasks.create({
        title,
        prompt: title,
        status: "pending",
        workspaceId,
      });
      tasks.update(task.id, { status: "completed", terminalStatus, completedAt });
      return tasks.findById(task.id)!;
    };
    const verified = make("Verified by contract", "ok");
    const { contract } = contracts.ensureForTask(verified);
    contracts.getRepository().updateOutcomeContract(contract!.id, { status: "satisfied" });
    const okButUnmet = make("Ok but contract unmet", "ok");
    const unmet = contracts.ensureForTask(okButUnmet).contract!;
    contracts.getRepository().updateOutcomeContract(unmet.id, { status: "unmet" });
    make("Plain ok", "ok");
    make("Partial", "partial_success");
    make("Needs action", "needs_user_action");
    return { db, workspaceId, completedAt };
  }

  it("adds the split columns to a day rollup created before them", () => {
    manager.close();
    const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-awu-upgrade-"));
    process.env.COWORK_USER_DATA_DIR = legacyDir;
    const legacy = new Database!(path.join(legacyDir, "cowork-os.db"));
    legacy.exec(`
      CREATE TABLE usage_insights_day (
        workspace_id TEXT NOT NULL,
        date_key TEXT NOT NULL,
        awu_completed_ok INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (workspace_id, date_key)
      );
      INSERT INTO usage_insights_day (workspace_id, date_key, awu_completed_ok) VALUES ('w', '2026-10-01', 4);
    `);
    legacy.close();
    manager = new DatabaseManager();
    const row = manager
      .getDatabase()
      .prepare("SELECT awu_completed_ok, awu_verified_ok, rework_runs FROM usage_insights_day")
      .get();
    expect(row).toEqual({ awu_completed_ok: 4, awu_verified_ok: 0, rework_runs: 0 });
    manager.close();
    fs.rmSync(legacyDir, { recursive: true, force: true });
    process.env.COWORK_USER_DATA_DIR = tmpDir;
    manager = new DatabaseManager();
  });

  it("counts verified, partial and needs-action units in the live report", () => {
    const { db, workspaceId } = seed();
    const awu = new UsageInsightsService(db).generate(workspaceId, 7).awuMetrics;
    expect(awu).toMatchObject({
      awuCount: 5,
      verifiedCount: 2,
      verifiedByContractCount: 1,
      partialCount: 1,
      needsUserActionCount: 1,
    });
  });

  it("writes the same split into the day rollup", () => {
    const { db, workspaceId, completedAt } = seed();
    const dateKey = usageLocalDateKey(completedAt);
    UsageInsightsProjector.createDetached(db).rebuildWorkspaceDates([{ workspaceId, dateKey }]);
    const row = db
      .prepare(
        `SELECT awu_completed_ok, awu_verified_ok, awu_verified_by_contract, awu_partial,
                awu_needs_user_action
           FROM usage_insights_day WHERE workspace_id = ? AND date_key = ?`,
      )
      .get(workspaceId, dateKey);
    expect(row).toEqual({
      awu_completed_ok: 5,
      awu_verified_ok: 2,
      awu_verified_by_contract: 1,
      awu_partial: 1,
      awu_needs_user_action: 1,
    });
  });
});
