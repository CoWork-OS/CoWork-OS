import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseManager } from "../schema";
import { TaskStore } from "../repositories";
import { WorkSessionProtocolRepository } from "../WorkSessionProtocolRepository";
import { WorkSessionReliabilityService } from "../../sessions/WorkSessionReliabilityService";

const nativeSqliteAvailable = (() => {
  try {
    const probe = new Database(":memory:");
    probe.close();
    return true;
  } catch {
    return false;
  }
})();

const describeWithSqlite = nativeSqliteAvailable ? describe : describe.skip;

describeWithSqlite("activity lease recovery after a suspend", () => {
  let tempDir: string;
  let previousUserDataDir: string | undefined;
  let manager: DatabaseManager;
  let db: Database.Database;
  let now: number;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-lease-suspend-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tempDir;
    manager = new DatabaseManager();
    db = manager.getDatabase();
    now = 1_000_000;
    db.prepare(
      `INSERT INTO workspaces (id, name, path, created_at, permissions)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("workspace-1", "Workspace", path.join(tempDir, "workspace"), now, "{}");
  });

  afterEach(() => {
    manager.close();
    if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
    else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("reclaims leases that expired while asleep, but not ended or fresh ones", () => {
    const task = new TaskStore(db).create({
      title: "Sleepy task",
      prompt: "Keep running across a laptop sleep",
      status: "executing",
      workspaceId: "workspace-1",
      source: "test",
    });
    const aggregate = new WorkSessionProtocolRepository(db).ensureForTask({
      taskId: task.id,
      workspaceId: task.workspaceId,
      sessionId: "suspend-session",
      status: "executing",
    });
    const sessionId = aggregate.session.id;
    const turnId = aggregate.turns[0].id;
    const service = new WorkSessionReliabilityService(db, {
      now: () => now,
      leaseMaintenanceIntervalMs: 0,
    });
    const acquire = (operationKey: string) =>
      service.leases.acquire({ sessionId, turnId, kind: "tool", operationKey, ttlMs: 60_000 });

    acquire("op-running");
    const ended = acquire("op-ended");
    const snapshot = service.leases.listActive(sessionId).map((lease) => ({
      sessionId,
      turnId: lease.turnId,
      kind: lease.kind,
      operationKey: lease.operationKey,
    }));
    expect(snapshot).toHaveLength(2);

    // An hour of sleep: both leases expired; one operation ended right after waking.
    now += 60 * 60_000;
    service.leases.release(ended.id, ended.token!);
    const fresh = acquire("op-fresh");
    const entries = [
      ...snapshot,
      { sessionId, turnId, kind: "tool" as const, operationKey: "op-fresh" },
    ];

    expect(service.reclaimAfterSuspend(entries)).toBe(1);

    const running = service.leases.getByOperationKey(sessionId, "op-running");
    expect(running).toMatchObject({ status: "active" });
    expect(running!.expiresAt).toBeGreaterThan(now);
    expect(service.leases.getByOperationKey(sessionId, "op-ended")?.status).toBe("released");
    expect(service.leases.getByOperationKey(sessionId, "op-fresh")).toMatchObject({
      id: fresh.id,
      status: "active",
    });
    expect(service.leases.getByOperationKey(sessionId, "op-missing")).toBeUndefined();
  });
});
